import express from 'express';
import { createClient } from '@libsql/client';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import fs from 'fs';

// Load local environment variables from .env file
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Connect to SQLite / Turso Database
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'fdi_lineage.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Helper: Slugify names
const slugify = (text) => {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '_');
};

// ── CACHES ──────────────────────────────────────────────────────────────────
// All caches prevent re-reads on duplicate requests
let cachedSubjectAreas = null;
let cachedOtbiSubjectAreas = null;
const fdiLineageDataCache = {};
const otbiLineageDataCache = {};
const searchCache = {};                // key=query → results
const serverMatchCache = {};           // key=pvo||col → match results
const pvoFinderCache = {};             // key=otbisa||fdisa||explanation → plan
const otbiPvoListCache = {};           // key=saName → PVO list (avoid repeat DB calls in pvo-finder)

// ── STATIC SUBJECT AREA METADATA ─────────────────────────────────────────────
// Loaded from JSON file to avoid DISTINCT DB scans on startup
const metadataPath = path.join(__dirname, 'subject_areas_metadata.json');
let staticMetadata = { fdi: [], otbi: [] };
try {
  if (fs.existsSync(metadataPath)) {
    staticMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    console.log(`Loaded ${staticMetadata.fdi.length} FDI and ${staticMetadata.otbi.length} OTBI subject areas from static metadata file.`);
  }
} catch (err) {
  console.error('Failed to load static subject areas metadata:', err.message);
}

// ── STATIC SEARCH INDEX ─────────────────────────────────────────────────────
// Loaded from search_index.json (pre-baked locally, zero DB reads on server start)
// Format: [{ p, sa, ss, pt, pc, xt, xc }, ...] (see generate_search_index.js)
let staticSearchEntries = [];
const searchIndexMap = new Map(); // term -> [entry]

function loadSearchIndex() {
  const idxPath = path.join(__dirname, 'search_index.json');
  if (!fs.existsSync(idxPath)) {
    console.warn('WARNING: search_index.json not found. Search will return no results. Run generate_search_index.js to create it.');
    return;
  }
  try {
    staticSearchEntries = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    // Build term → entry map
    for (const entry of staticSearchEntries) {
      const terms = [
        ...(entry.pc || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2),
        ...(entry.pt || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
      ];
      for (const term of terms) {
        if (!searchIndexMap.has(term)) searchIndexMap.set(term, []);
        const arr = searchIndexMap.get(term);
        if (arr.length < 200) arr.push(entry);
      }
    }
    console.log(`Loaded search index: ${staticSearchEntries.length} entries, ${searchIndexMap.size} unique terms.`);
  } catch (err) {
    console.error('Failed to load search_index.json:', err.message);
  }
}

// ── SUBJECT AREA LOADERS ──────────────────────────────────────────────────────
async function loadSubjectAreas() {
  cachedSubjectAreas = staticMetadata.fdi;
  return staticMetadata.fdi;
}

async function loadOtbiSubjectAreas() {
  cachedOtbiSubjectAreas = staticMetadata.otbi;
  return staticMetadata.otbi;
}


// Search function using in-memory index — ZERO database reads
function searchInMemory(query) {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];

  const terms = q.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (!terms.length) return [];

  // Score each candidate entry
  const scoreMap = new Map();
  for (const term of terms) {
    for (const [key, entries] of searchIndexMap.entries()) {
      if (key.includes(term) || term.includes(key)) {
        for (const e of entries) {
          const id = `${e.sa}|${e.pt}|${e.pc}`;
          scoreMap.set(id, { entry: e, score: (scoreMap.get(id)?.score || 0) + (key === term ? 2 : 1) });
        }
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(x => ({
      pillar: x.entry.p,
      subjectArea: x.entry.sa,
      subjectAreaSlug: x.entry.ss,
      presTable: x.entry.pt,
      presColumn: x.entry.pc,
      physTable: x.entry.xt,
      physColumn: x.entry.xc
    }));
}

// ── ROUTE 1: GET /api/subject-areas ──────────────────────────────────────────
app.get('/api/subject-areas', async (req, res) => {
  try {
    const sas = cachedSubjectAreas || await loadSubjectAreas();
    res.json(sas);
  } catch (err) {
    console.error('Error fetching subject areas:', err);
    res.status(500).json({ error: 'Failed to fetch subject areas' });
  }
});

// ── ROUTE 2: GET /api/augmentations (stub) ───────────────────────────────────
app.get('/api/augmentations', (req, res) => {
  res.json({});
});

// ── ROUTE 3: GET /api/metrics/:slug (stub) ───────────────────────────────────
app.get('/api/metrics/:slug', (req, res) => {
  res.json([]);
});

// ── ROUTE 4: GET /api/search?q=... ───────────────────────────────────────────
// Uses in-memory search index — ZERO database reads after startup
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const cacheKey = q.toLowerCase();
  if (searchCache[cacheKey]) {
    return res.json(searchCache[cacheKey]);
  }

  const results = searchInMemory(q);
  searchCache[cacheKey] = results;
  res.json(results);
});

// ── ROUTE 5: GET /api/lineage/:slug ──────────────────────────────────────────
// 100% static file read — ZERO database reads
app.get('/api/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const cacheKey = slug.toLowerCase();
    
    // Check in-memory cache first
    if (fdiLineageDataCache[cacheKey]) {
      return res.json(fdiLineageDataCache[cacheKey]);
    }

    // Load from pre-baked static file
    const filePath = path.join(__dirname, 'static_lineage', 'fdi', `${cacheKey}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fdiLineageDataCache[cacheKey] = data;
      return res.json(data);
    }

    // Fallback: If not pre-baked (should not happen), return 404
    return res.status(404).json({ error: `Subject Area lineage not found for ${slug}` });
  } catch (err) {
    console.error('Error loading FDI lineage:', err.message);
    res.status(500).json({ error: 'Failed to load lineage data' });
  }
});

// ── HELPER: Call Groq API ─────────────────────────────────────────────────────
async function callGrok(systemPrompt, userPrompt) {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('Groq API Key (GROK_API_KEY) is missing in .env file');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── ROUTE 6: POST /api/ai/explain ────────────────────────────────────────────
app.post('/api/ai/explain', async (req, res) => {
  try {
    const { subjectArea, presentationTable, presentationColumn, mappings } = req.body;
    if (!presentationColumn) {
      return res.status(400).json({ error: 'Missing column parameter' });
    }

    const systemPrompt = "You are a senior data architect specializing in Oracle Fusion Data Intelligence (FDI) data models. Write a brief, expert business-oriented explanation of the lineage.";
    const userPrompt = `Explain the data lineage for presentation column "${presentationColumn}" in table "${presentationTable}" (Subject Area: "${subjectArea}").
Physical mappings:
${(mappings || []).map(m => `- Table: ${m.physicalTable}, Column: ${m.physicalColumn}`).join('\n')}

Explain:
1. What this presentation column represents.
2. How the data flows from these physical source columns.
3. The business purpose.
Keep it under 150 words, structured, and easy to read.`;

    const explanation = await callGrok(systemPrompt, userPrompt);
    res.json({ explanation });
  } catch (err) {
    console.error('AI Explainer error:', err.message);
    res.status(500).json({ error: err.message || 'AI explanation failed' });
  }
});

// ── CONSOLIDATED OTBI TABLES ──────────────────────────────────────────────────
const OTBI_TABLES = ['"OTBI-Finance"', '"OTBI-HCM"', '"OTBI-SCM"', '"OTBI-CX"', '"OTBI-Project"'];

// ── ROUTE 7: GET /api/otbi/subject-areas ─────────────────────────────────────
app.get('/api/otbi/subject-areas', async (req, res) => {
  try {
    const sas = cachedOtbiSubjectAreas || await loadOtbiSubjectAreas();
    res.json(sas);
  } catch (err) {
    console.error('Error fetching OTBI subject areas:', err.message);
    res.status(500).json({ error: 'Failed to fetch OTBI subject areas' });
  }
});

// ── ROUTE 8: GET /api/otbi/lineage/:slug ─────────────────────────────────────
// 100% static file read — ZERO database reads
app.get('/api/otbi/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const cacheKey = slug.toLowerCase();

    // Check in-memory cache first
    if (otbiLineageDataCache[cacheKey]) {
      return res.json(otbiLineageDataCache[cacheKey]);
    }

    // Load from pre-baked static file
    const filePath = path.join(__dirname, 'static_lineage', 'otbi', `${cacheKey}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      otbiLineageDataCache[cacheKey] = data;
      return res.json(data);
    }

    // Fallback
    return res.status(404).json({ error: `OTBI Subject Area lineage not found for ${slug}` });
  } catch (err) {
    console.error('Error loading OTBI lineage:', err.message);
    res.status(500).json({ error: 'Failed to load OTBI lineage data' });
  }
});

// ── ROUTE 9: POST /api/ai/match-fdi ─────────────────────────────────────────
// 100% in-memory: uses staticSearchEntries from search_index.json — ZERO DB reads
// staticSearchEntries format: { p, sa, ss, pt, pc, xt, xc }
//   xt = physical_table (PVO name in FDI), xc = physical_column (PVO attribute)
app.post('/api/ai/match-fdi', async (req, res) => {
  try {
    const { otbiColumn, otbiTable, pvoName, pvoAttribute } = req.body;
    if (!otbiColumn || !pvoName) {
      return res.status(400).json({ error: 'Missing matching parameters' });
    }

    const cacheKey = `${otbiTable}||${otbiColumn}||${pvoName}||${pvoAttribute}`;
    if (serverMatchCache[cacheKey]) {
      return res.json(serverMatchCache[cacheKey]);
    }

    const pvoClean = pvoName.replace(/PVO$/i, '').toLowerCase();
    const pvoAttrLower = (pvoAttribute || '').toLowerCase();
    const otbiColLower = (otbiColumn || '').toLowerCase();

    // ── EXACT MATCHES: physical_column = pvoAttribute AND physical_table contains pvoClean
    // Pure in-memory filter over 133K entries — ZERO DB reads
    const exactSet = new Set();
    const exactMatches = staticSearchEntries
      .filter(e => {
        const colMatch = (e.xc || '').toLowerCase() === pvoAttrLower;
        const tableMatch = (e.xt || '').toLowerCase().includes(pvoClean) || (e.xt || '') === pvoName;
        return colMatch && tableMatch;
      })
      .filter(e => {
        const k = `${e.sa}|${e.pt}|${e.pc}`;
        if (exactSet.has(k)) return false;
        exactSet.add(k);
        return true;
      })
      .slice(0, 30)
      .map(e => ({
        subjectArea: e.sa,
        presentationTable: e.pt,
        presentationColumn: e.pc,
        physicalTable: e.xt,
        physicalColumn: e.xc
      }));

    // ── CANDIDATES for Grok: broader match by physical_column, then by physical_table, then by pres col prefix
    const seen = new Set();
    let candidatesRows = [];

    // Layer 1: exact physical_column match (most reliable)
    const byPhysCol = staticSearchEntries
      .filter(e => (e.xc || '').toLowerCase() === pvoAttrLower)
      .slice(0, 40);
    candidatesRows = [...byPhysCol];

    // Layer 2: physical_table contains pvoClean (different column, same PVO)
    if (candidatesRows.length < 15) {
      const byPhysTable = staticSearchEntries
        .filter(e => (e.xt || '').toLowerCase().includes(pvoClean) || (e.xt || '') === pvoName)
        .slice(0, 30);
      candidatesRows = [...candidatesRows, ...byPhysTable];
    }

    // Layer 3: presentation_column starts with OTBI column name (prefix — uses index logic)
    if (candidatesRows.length < 10) {
      const byPresCol = staticSearchEntries
        .filter(e => (e.pc || '').toLowerCase().startsWith(otbiColLower))
        .slice(0, 20);
      candidatesRows = [...candidatesRows, ...byPresCol];
    }

    // Layer 4: presentation_column contains OTBI column name (fuzzy)
    if (candidatesRows.length < 8) {
      const byPresColFuzzy = staticSearchEntries
        .filter(e => (e.pc || '').toLowerCase().includes(otbiColLower) && otbiColLower.length >= 4)
        .slice(0, 15);
      candidatesRows = [...candidatesRows, ...byPresColFuzzy];
    }

    // Deduplicate and limit
    candidatesRows = candidatesRows.filter(e => {
      const k = `${e.sa}|${e.pt}|${e.pc}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 25);

    // ── GROK: ask for top 3 matches with scores ───────────────────────────────
    const systemPrompt = "You are a senior data architect specializing in Oracle BI (OTBI) and Fusion Data Intelligence (FDI) schemas. Your task is to match an OTBI presentation column to the most likely FDI database warehouse columns. You must respond ONLY with a valid JSON array of objects representing the top 3 matches.";
    const userPrompt = `OTBI Column to Match:
- OTBI Presentation Table: "${otbiTable}"
- OTBI Column Name: "${otbiColumn}"
- Source PVO: "${pvoName}"
- PVO Attribute: "${pvoAttribute}"

Candidate FDI Columns (from in-memory search index):
${candidatesRows.map((c, i) => `${i+1}. Subject Area: "${c.sa}", Table: "${c.pt}", Column: "${c.pc}" (Physical Table: "${c.xt}", Column: "${c.xc}")`).join('\n')}

Task:
Analyze the candidates and select/rank the top 3 most likely matching FDI columns.
You MUST output a valid JSON array containing exactly 3 objects (or fewer if there are not enough candidates).
Each object in the array must contain these exact keys:
- "rank": string (e.g., "1st", "2nd", "3rd")
- "subjectArea": string (Verbatim full FDI Subject Area name from the candidates list. DO NOT shorten or generalize!)
- "presentationTable": string (Verbatim FDI Presentation Table name from candidates list)
- "presentationColumn": string (Verbatim FDI Presentation Column name from candidates list)
- "score": string (Confidence percentage, e.g., "95%")
- "explanation": string (Brief explanation of why it matches)

You MUST use the exact, verbatim values as they appear in the candidate list.
Do not include any conversational filler, markdown formatting (like \`\`\`json ... \`\`\`) or text outside the JSON array. Output only the raw valid JSON.`;
    
    const aiResult = await callGrok(systemPrompt, userPrompt);
    let parsedMatches = [];
    try {
      let cleanJson = aiResult.trim();
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      }
      parsedMatches = JSON.parse(cleanJson);
      
      // Ensure the subject area name is the official full name from the catalog
      if (Array.isArray(parsedMatches)) {
        parsedMatches = parsedMatches.map(m => {
          const ptLower = (m.presentationTable || '').toLowerCase().trim();
          const pcLower = (m.presentationColumn || '').toLowerCase().trim();
          
          // Search in our index for the matching table and column
          const matched = staticSearchEntries.find(entry => 
            (entry.pt || '').toLowerCase().trim() === ptLower &&
            (entry.pc || '').toLowerCase().trim() === pcLower
          );
          
          if (matched && matched.sa) {
            m.subjectArea = matched.sa; // Overwrite with official full name
          }
          return m;
        });
      }
    } catch (parseErr) {
      console.error('Failed to parse AI matches as JSON:', parseErr.message);
    }
    
    const responseData = {
      exactMatches,
      matches: parsedMatches
    };
    serverMatchCache[cacheKey] = responseData;
    res.json(responseData);
  } catch (err) {
    console.error('AI match error:', err.message);
    res.status(500).json({ error: err.message || 'AI matching failed' });
  }
});

// ── ROUTE 10: POST /api/ai/pvo-finder ────────────────────────────────────────
// Returns top 3 PVOs with match scores instead of a single PVO recommendation
app.post('/api/ai/pvo-finder', async (req, res) => {
  try {
    const { otbiSubjectArea, fdiSubjectArea, explanation } = req.body;
    if (!otbiSubjectArea || !fdiSubjectArea || !explanation) {
      return res.status(400).json({ error: 'Missing parameters. Provide otbiSubjectArea, fdiSubjectArea, and explanation.' });
    }

    const cacheKey = `${otbiSubjectArea}||${fdiSubjectArea}||${explanation.toLowerCase().trim()}`;
    if (pvoFinderCache[cacheKey]) {
      return res.json(pvoFinderCache[cacheKey]);
    }

    // PVO list: check in-memory OTBI lineage cache FIRST (zero DB reads if already loaded)
    // Then check otbiPvoListCache, then fall back to DB query
    let relatedPvos = [];
    const sas = cachedOtbiSubjectAreas || await loadOtbiSubjectAreas();
    const match = sas.find(x => slugify(x.name) === slugify(otbiSubjectArea) || slugify(x.slug) === slugify(otbiSubjectArea));
    
    if (match) {
      const cacheSlug = match.slug;
      
      // Option 1: extract from already-loaded OTBI lineage cache (FREE — 0 reads)
      if (otbiLineageDataCache[cacheSlug]) {
        const cachedMappings = otbiLineageDataCache[cacheSlug].mappings || [];
        const pvoSet = new Set(cachedMappings.map(m => m.pvoName).filter(p => p && p !== 'UnknownPVO'));
        relatedPvos = Array.from(pvoSet);
      }
      // Option 2: check the PVO-specific cache
      else if (otbiPvoListCache[otbiSubjectArea]) {
        relatedPvos = otbiPvoListCache[otbiSubjectArea];
      }
      // Option 3: static file fallback — ZERO database reads
      else {
        const filePath = path.join(__dirname, 'static_lineage', 'otbi', `${cacheSlug}.json`);
        try {
          if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const cachedMappings = data.mappings || [];
            const pvoSet = new Set(cachedMappings.map(m => m.pvoName).filter(p => p && p !== 'UnknownPVO'));
            relatedPvos = Array.from(pvoSet);
            otbiPvoListCache[otbiSubjectArea] = relatedPvos;
          }
        } catch (err) {
          console.error('Error reading PVOs from static OTBI file:', err.message);
        }
      }
    }

    const systemPrompt = `You are a senior data architect specializing in Oracle Analytics Cloud (OAC), Oracle Fusion Applications, and Oracle Fusion Data Intelligence (FDI) logical models.
Your task is to analyze a missing data business case and design a step-by-step Semantic Extension plan inside the FDI Sandbox framework using Fusion physical source PVOs.`;

    const userPrompt = `User Customization Case:
- Missing Data Business Scenario: "${explanation}"
- Source OTBI Subject Area in Fusion: "${otbiSubjectArea}"
- Target FDI Subject Area in Warehouse: "${fdiSubjectArea}"

PVOs actually associated with OTBI Subject Area "${otbiSubjectArea}" in our database:
${relatedPvos.length > 0 ? relatedPvos.map(p => `- ${p}`).join('\n') : '(No direct PVO mappings found. Suggest the standard Fusion PVO based on your knowledge.)'}

Task:
Identify the TOP 3 most relevant Fusion PVOs for the user's missing data scenario. For EACH of the 3 PVOs, provide the following structure:

---

### PVO [N]: [PVO Full Name]
**Match Score: [X]%**
**Why this PVO:** Brief explanation of why this PVO is relevant to the business scenario.

#### Suggested Columns
List the critical attributes/columns to select from this PVO (e.g., CardholderId, TransactionAmount).

#### Join Configuration
- **Extensibility Pattern:** Choose either "Extend a Dimension", "Add a Dimension", or "Add a Fact".
- **Target FDI Warehouse Table:** Which standard FDI table (e.g., DW_PARTY_D, DW_AP_INVOICES_F) to join with.
- **Join Key:** Primary and foreign keys used to link the PVO with the FDI target table.

---

After the 3 PVO recommendations, provide:

### Sandbox Framework Guide
Write a concise step-by-step guide on how to configure this extension using the FDI Console Sandbox Framework for the recommended (highest-scoring) PVO:
1. Create and open a customization Sandbox.
2. Augment the PVO data source (Data Augmentation).
3. Open the Logical Star and establish the join configuration.
4. Add custom presentation columns to the "${fdiSubjectArea}" subject area.
5. Validate, merge, and publish the Sandbox.

Make your response technical, highly structured, clean, and in standard markdown format.`;

    const result = await callGrok(systemPrompt, userPrompt);
    const responseData = { plan: result };
    pvoFinderCache[cacheKey] = responseData;
    res.json(responseData);
  } catch (err) {
    console.error('PVO Finder error:', err.message);
    res.status(500).json({ error: err.message || 'PVO Finder plan generation failed' });
  }
});

// ── STATIC FILES & SPA FALLBACK ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ── SERVER START ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// ── STARTUP WARMUP ────────────────────────────────────────────────────────────
// Loads static files only — ZERO database reads on startup
(async () => {
  try {
    console.log('Loading static metadata and search index...');
    await loadSubjectAreas();
    await loadOtbiSubjectAreas();
    loadSearchIndex(); // reads from search_index.json — zero DB reads
    console.log('Startup complete. No database reads performed on startup.');
  } catch (err) {
    console.error('Error during startup:', err.message);
  }
})();
