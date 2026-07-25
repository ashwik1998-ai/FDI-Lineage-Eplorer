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

// In-memory search index built once on startup — prevents all search DB reads
// Structure: { term: [{ pillar, subjectArea, subjectAreaSlug, presTable, presColumn }] }
const searchIndex = new Map();

// Build search index from a set of columns
function addToSearchIndex(entry) {
  // Index by words in presentation column name and presentation table name
  const terms = [
    ...(entry.presColumn || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2),
    ...(entry.presTable || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
  ];
  for (const term of terms) {
    if (!searchIndex.has(term)) searchIndex.set(term, []);
    const arr = searchIndex.get(term);
    // Cap per-term entries to 200 to avoid huge memory
    if (arr.length < 200) arr.push(entry);
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

// Build search index by scanning FDI lineage tables ONCE on startup
async function buildSearchIndex() {
  if (searchIndex.size > 0) return; // already built
  console.log('Building in-memory search index from FDI tables...');
  const pillars = ['erp', 'hcm', 'scm', 'cx'];
  let total = 0;
  for (const p of pillars) {
    try {
      // SELECT only unique (presTable, presColumn) combinations — no full scan needed
      const r = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM ${p}_semantic_model_lineage`,
        args: []
      });
      for (const row of r.rows) {
        addToSearchIndex({
          pillar: p.toUpperCase(),
          subjectArea: row.subject_area,
          subjectAreaSlug: slugify(row.subject_area || ''),
          presTable: row.presentation_table,
          presColumn: row.presentation_column,
          physTable: row.physical_table,
          physColumn: row.physical_column
        });
        total++;
      }
    } catch (err) {
      console.error(`Search index build error for ${p}:`, err.message);
    }
  }
  console.log(`Search index built: ${total} entries indexed across ${searchIndex.size} unique terms.`);
}

// Search function: use in-memory index, zero DB reads
function searchInMemory(query) {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return [];

  const terms = q.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (!terms.length) return [];

  // Score each candidate
  const scoreMap = new Map();
  for (const term of terms) {
    for (const [key, entries] of searchIndex.entries()) {
      if (key.includes(term) || term.includes(key)) {
        for (const e of entries) {
          const id = `${e.subjectArea}|${e.presTable}|${e.presColumn}`;
          scoreMap.set(id, { entry: e, score: (scoreMap.get(id)?.score || 0) + (key === term ? 2 : 1) });
        }
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(x => x.entry);
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
// Each lineage is read ONCE then cached in memory, subsequent = 0 reads
app.get('/api/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const cacheKey = slug.toLowerCase();
    if (fdiLineageDataCache[cacheKey]) {
      return res.json(fdiLineageDataCache[cacheKey]);
    }

    const sas = cachedSubjectAreas || await loadSubjectAreas();
    const saInfo = sas.find(x => x.slug === slug);
    if (!saInfo) {
      return res.status(404).json({ error: 'Subject Area not found' });
    }

    // Run all pillar queries in PARALLEL using Promise.all instead of sequential loops
    const pillarQueries = saInfo.pillars.map(pillar => {
      const table = `${pillar.toLowerCase()}_semantic_model_lineage`;
      return db.execute({
        sql: `SELECT presentation_table, presentation_column, physical_table, physical_column 
              FROM ${table} 
              WHERE subject_area = ?`,
        args: [saInfo.name]
      }).then(r => r.rows).catch(err => {
        console.error(`Failed to query lineage from ${table}:`, err.message);
        return [];
      });
    });

    const pillarResults = await Promise.all(pillarQueries);
    const mappingsRows = pillarResults.flat();

    // Build Nodes and Edges dynamically
    const nodesDict = {};
    const connectionsSet = new Set();
    const mappings = [];
    
    mappingsRows.forEach(r => {
      const presTable = r.presentation_table;
      const presCol = r.presentation_column;
      const physTable = r.physical_table;
      const physCol = r.physical_column;

      const isPhysValInvalid = !physTable || physTable === 'NaN' || String(physTable).toLowerCase() === 'null' ||
                              !physCol || physCol === 'NaN' || String(physCol).toLowerCase() === 'null';

      if (isPhysValInvalid) {
        if (presTable && presTable !== 'NaN') {
          if (!nodesDict[presTable]) {
            nodesDict[presTable] = { type: 'Presentation Table', columns: new Set() };
          }
          if (presCol && presCol !== 'NaN') {
            nodesDict[presTable].columns.add(presCol);
          }
        }
        return;
      }
      
      mappings.push({
        presentationTable: presTable,
        presentationColumn: presCol,
        physicalTable: physTable,
        physicalColumn: physCol
      });
      
      if (!nodesDict[physTable]) {
        nodesDict[physTable] = { type: 'Physical Table', columns: new Set() };
      }
      nodesDict[physTable].columns.add(physCol);
      
      if (!nodesDict[presTable]) {
        nodesDict[presTable] = { type: 'Presentation Table', columns: new Set() };
      }
      nodesDict[presTable].columns.add(presCol);
      
      connectionsSet.add(`${physTable}|||${presTable}`);
    });
    
    const reactNodes = [];
    let physIdx = 0;
    let presIdx = 0;
    
    Object.keys(nodesDict).sort().forEach(name => {
      const info = nodesDict[name];
      const isPhys = info.type === 'Physical Table';
      
      const x = isPhys ? 100 : 700;
      const y = 120 * (isPhys ? physIdx++ : presIdx++);
      
      reactNodes.push({
        id: name,
        type: 'tableNode',
        position: { x, y },
        data: {
          label: name,
          type: info.type,
          columns: Array.from(info.columns).sort(),
          isExtensible: false
        }
      });
    });
    
    const reactEdges = [];
    let edgeIdx = 1;
    connectionsSet.forEach(conn => {
      const [source, target] = conn.split('|||');
      reactEdges.push({
        id: `e-${edgeIdx++}`,
        source,
        target,
        animated: true,
        style: { stroke: 'rgba(255, 255, 255, 0.15)', strokeWidth: 2 }
      });
    });
    
    const responseData = {
      subjectArea: saInfo.name,
      pillar: saInfo.pillars[0],
      pillars: saInfo.pillars,
      nodes: reactNodes,
      edges: reactEdges,
      mappings: mappings
    };
    fdiLineageDataCache[cacheKey] = responseData;
    res.json(responseData);
    
  } catch (err) {
    console.error('Error compiling lineage data:', err);
    res.status(500).json({ error: 'Database compilation failed' });
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
// Each OTBI SA lineage is read ONCE then cached — subsequent = 0 reads
app.get('/api/otbi/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const cacheKey = slug.toLowerCase();
    if (otbiLineageDataCache[cacheKey]) {
      return res.json(otbiLineageDataCache[cacheKey]);
    }

    let mappings = [];
    let targetTable = null;
    let targetSAName = null;
    
    const sas = cachedOtbiSubjectAreas || await loadOtbiSubjectAreas();
    const match = sas.find(x => x.slug === slug);
    if (match) {
      targetTable = match.sourceTable;
      targetSAName = match.name;
    }
    
    if (targetTable && targetSAName) {
      const result = await db.execute({
        sql: `SELECT presentation_table, presentation_column, physical_table, physical_column 
              FROM ${targetTable} 
              WHERE subject_area = ?`,
        args: [targetSAName]
      });
      
      mappings = result.rows.map(r => {
        let pvoRaw = r.physical_table || '';
        let pvoName = pvoRaw.split('.').pop() || '';
        if (pvoName && !pvoName.endsWith('PVO') && pvoRaw.toLowerCase().includes('publicview')) {
          pvoName = pvoName + 'PVO';
        }
        
        return {
          presentationTable: r.presentation_table,
          presentationColumn: r.presentation_column,
          pvoName: pvoName || 'UnknownPVO',
          pvoAttribute: r.physical_column || 'UnknownAttribute'
        };
      });
    }
    
    const nodesDict = {};
    const connectionsSet = new Set();
    
    mappings.forEach(m => {
      const presTable = m.presentationTable;
      const presCol = m.presentationColumn;
      const pvo = m.pvoName;
      const pvoAttr = m.pvoAttribute;
      
      if (!nodesDict[pvo]) {
        nodesDict[pvo] = { type: 'Physical Table', columns: new Set() };
      }
      nodesDict[pvo].columns.add(pvoAttr);
      
      if (!nodesDict[presTable]) {
        nodesDict[presTable] = { type: 'Presentation Table', columns: new Set() };
      }
      nodesDict[presTable].columns.add(presCol);
      
      connectionsSet.add(`${pvo}|||${presTable}`);
    });
    
    const reactNodes = [];
    let pvoIdx = 0;
    let presIdx = 0;
    
    Object.keys(nodesDict).sort().forEach(name => {
      const info = nodesDict[name];
      const isPvo = info.type === 'Physical Table';
      const x = isPvo ? 450 : 0;
      const y = 120 * (isPvo ? pvoIdx++ : presIdx++);
      
      reactNodes.push({
        id: name,
        type: 'tableNode',
        position: { x, y },
        data: {
          label: name,
          type: info.type,
          columns: Array.from(info.columns).sort(),
          isExtensible: false
        }
      });
    });
    
    const reactEdges = [];
    let edgeIdx = 1;
    connectionsSet.forEach(conn => {
      const [source, target] = conn.split('|||');
      reactEdges.push({
        id: `otbi-e-${edgeIdx++}`,
        source: target,
        target: source,
        animated: true,
        style: { stroke: '#F97316', strokeWidth: 2, opacity: 0.8 },
        markerEnd: { type: 'arrowclosed', color: '#F97316' }
      });
    });
    
    const responseData = {
      nodes: reactNodes,
      edges: reactEdges,
      mappings: mappings
    };
    otbiLineageDataCache[cacheKey] = responseData;
    res.json(responseData);
  } catch (err) {
    console.error('Error fetching OTBI lineage:', err.message);
    res.status(500).json({ error: 'Failed to fetch OTBI lineage data' });
  }
});

// ── ROUTE 9: POST /api/ai/match-fdi ─────────────────────────────────────────
// Optimized: Uses UNION ALL across all 4 tables in ONE query instead of 4 sequential loops
// Composite indexes on (physical_table, physical_column) make exact match near-instant
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
    
    const pvoClean = pvoName.replace(/PVO$/i, '');
    
    // ── EXACT MATCH: Single UNION ALL query across all 4 pillars (1 round trip vs 4)
    // Uses composite index on (physical_table, physical_column) — nearly instant
    const exactRes = await db.execute({
      sql: `SELECT DISTINCT 'ERP' as pillar, subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM erp_semantic_model_lineage
            WHERE physical_column = ? AND (physical_table LIKE ? OR physical_table = ?)
            UNION ALL
            SELECT DISTINCT 'HCM', subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM hcm_semantic_model_lineage
            WHERE physical_column = ? AND (physical_table LIKE ? OR physical_table = ?)
            UNION ALL
            SELECT DISTINCT 'SCM', subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM scm_semantic_model_lineage
            WHERE physical_column = ? AND (physical_table LIKE ? OR physical_table = ?)
            UNION ALL
            SELECT DISTINCT 'CX', subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM cx_semantic_model_lineage
            WHERE physical_column = ? AND (physical_table LIKE ? OR physical_table = ?)
            LIMIT 30`,
      args: [
        pvoAttribute, `%${pvoClean}%`, pvoName,
        pvoAttribute, `%${pvoClean}%`, pvoName,
        pvoAttribute, `%${pvoClean}%`, pvoName,
        pvoAttribute, `%${pvoClean}%`, pvoName
      ]
    });

    const exactMatches = exactRes.rows.map(r => ({
      subjectArea: r.subject_area,
      presentationTable: r.presentation_table,
      presentationColumn: r.presentation_column,
      physicalTable: r.physical_table,
      physicalColumn: r.physical_column
    }));

    // ── CANDIDATES for Grok: Single UNION ALL for exact physical_column match (1 round trip)
    // Uses single-column index on physical_column — index scan only
    let candidatesRes = await db.execute({
      sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM erp_semantic_model_lineage WHERE physical_column = ? LIMIT 10
            UNION ALL
            SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM hcm_semantic_model_lineage WHERE physical_column = ? LIMIT 10
            UNION ALL
            SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM scm_semantic_model_lineage WHERE physical_column = ? LIMIT 10
            UNION ALL
            SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
            FROM cx_semantic_model_lineage WHERE physical_column = ? LIMIT 10`,
      args: [pvoAttribute, pvoAttribute, pvoAttribute, pvoAttribute]
    });

    let candidatesRows = [...candidatesRes.rows];

    // Fallback: if not enough candidates, try physical_table match (still index-supported)
    if (candidatesRows.length < 8) {
      const fbRes = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM erp_semantic_model_lineage WHERE physical_table = ? LIMIT 8
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM hcm_semantic_model_lineage WHERE physical_table = ? LIMIT 8
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM scm_semantic_model_lineage WHERE physical_table = ? LIMIT 8
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM cx_semantic_model_lineage WHERE physical_table = ? LIMIT 8`,
        args: [pvoName, pvoName, pvoName, pvoName]
      });
      candidatesRows = [...candidatesRows, ...fbRes.rows];
    }

    // Last fallback: presentation_column prefix match for the OTBI column name
    if (candidatesRows.length < 5) {
      const prefix = `${otbiColumn}%`;
      const fbRes2 = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM erp_semantic_model_lineage WHERE presentation_column LIKE ? LIMIT 6
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM hcm_semantic_model_lineage WHERE presentation_column LIKE ? LIMIT 6
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM scm_semantic_model_lineage WHERE presentation_column LIKE ? LIMIT 6
              UNION ALL
              SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM cx_semantic_model_lineage WHERE presentation_column LIKE ? LIMIT 6`,
        args: [prefix, prefix, prefix, prefix]
      });
      candidatesRows = [...candidatesRows, ...fbRes2.rows];
    }

    // Deduplicate candidates
    const seen = new Set();
    candidatesRows = candidatesRows.filter(r => {
      const k = `${r.subject_area}|${r.presentation_table}|${r.presentation_column}`;
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

Candidate FDI Columns found in database:
${candidatesRows.map((c, i) => `${i+1}. Subject Area: "${c.subject_area}", Table: "${c.presentation_table}", Column: "${c.presentation_column}" (Physical Table: "${c.physical_table}", Column: "${c.physical_column}")`).join('\n')}

Task:
Analyze the candidates and select/rank the top 3 most likely matching FDI columns.
You MUST output a valid JSON array containing exactly 3 objects (or fewer if there are not enough candidates).
Each object in the array must contain these exact keys:
- "rank": string (e.g., "1st", "2nd", "3rd")
- "subjectArea": string (Verbatim full FDI Subject Area name from the candidates list, e.g., "Financials - AP Invoices". DO NOT shorten, generalize, or summarize this name under any circumstances!)
- "presentationTable": string (Verbatim FDI Presentation Table name from candidates list)
- "presentationColumn": string (Verbatim FDI Presentation Column name from candidates list)
- "score": string (Confidence percentage, e.g., "95%")
- "explanation": string (Brief explanation of why it matches)

You MUST use the exact, verbatim values for "subjectArea", "presentationTable", and "presentationColumn" as they appear in the candidate list.
Do not include any conversational filler, markdown formatting (like \`\`\`json ... \`\`\`) or text outside the JSON array. Output only the raw valid JSON.`;
    
    const aiResult = await callGrok(systemPrompt, userPrompt);
    let parsedMatches = [];
    try {
      let cleanJson = aiResult.trim();
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      }
      parsedMatches = JSON.parse(cleanJson);
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

    // Fetch PVOs for this OTBI subject area — cached per SA name to avoid repeat DB reads
    let relatedPvos = [];
    if (otbiPvoListCache[otbiSubjectArea]) {
      relatedPvos = otbiPvoListCache[otbiSubjectArea];
    } else {
      const sas = cachedOtbiSubjectAreas || await loadOtbiSubjectAreas();
      const match = sas.find(x => slugify(x.name) === slugify(otbiSubjectArea) || slugify(x.slug) === slugify(otbiSubjectArea));
      if (match) {
        const table = match.sourceTable;
        try {
          // Use composite index on (subject_area, physical_table) — single fast scan
          const pvoRes = await db.execute({
            sql: `SELECT DISTINCT physical_table 
                  FROM ${table} 
                  WHERE subject_area = ? AND physical_table IS NOT NULL AND physical_table != 'NaN' AND physical_table != ''`,
            args: [match.name]
          });
          relatedPvos = pvoRes.rows.map(r => r.physical_table);
          otbiPvoListCache[otbiSubjectArea] = relatedPvos;
        } catch (err) {
          console.error('Error fetching PVOs for PVO finder:', err.message);
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

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ── SERVER START ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// ── STARTUP WARMUP ────────────────────────────────────────────────────────────
// Warms subject area caches and builds the in-memory search index ONCE
(async () => {
  try {
    console.log('Warming up caches and building search index on startup...');
    await loadSubjectAreas();
    await loadOtbiSubjectAreas();
    // Build search index in background — doesn't block startup
    buildSearchIndex().catch(err => console.error('Search index build failed:', err.message));
    console.log('Cache warmup complete. Search index building in background...');
  } catch (err) {
    console.error('Error during startup warmup:', err.message);
  }
})();
