import express from 'express';
import { createClient } from '@libsql/client';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

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

// Caches for loaded subject areas and response data to minimize database reads
let cachedSubjectAreas = null;
const fdiLineageDataCache = {};
const otbiLineageDataCache = {};
const searchCache = {};
const serverMatchCache = {};

async function loadSubjectAreas() {
  const pillars = ['erp', 'hcm', 'scm', 'cx'];
  const allSAs = [];
  
  for (const p of pillars) {
    try {
      const res = await db.execute(`SELECT DISTINCT subject_area FROM ${p}_semantic_model_lineage`);
      for (const row of res.rows) {
        const name = row.subject_area;
        if (!name || name.trim().startsWith('Common')) continue; // Exclude Common related subject areas
        
        const slug = slugify(name);
        let existing = allSAs.find(x => x.slug === slug);
        if (existing) {
          if (!existing.pillars.includes(p.toUpperCase())) {
            existing.pillars.push(p.toUpperCase());
          }
        } else {
          allSAs.push({
            slug,
            name,
            pillar: p.toUpperCase(),
            pillars: [p.toUpperCase()],
            metricsCount: 0,
            lineageCount: 0
          });
        }
      }
    } catch (err) {
      console.error(`Error loading subject areas for table ${p}_semantic_model_lineage:`, err.message);
    }
  }
  
  // Sort alphabetically
  allSAs.sort((a, b) => a.name.localeCompare(b.name));
  cachedSubjectAreas = allSAs;
  return allSAs;
}

// 1. GET /api/subject-areas
app.get('/api/subject-areas', async (req, res) => {
  try {
    const sas = cachedSubjectAreas || await loadSubjectAreas();
    res.json(sas);
  } catch (err) {
    console.error('Error fetching subject areas:', err);
    res.status(500).json({ error: 'Failed to fetch subject areas' });
  }
});

// 2. GET /api/augmentations (Backward compatibility stub)
app.get('/api/augmentations', (req, res) => {
  res.json({});
});

// 3. GET /api/metrics/:slug (Backward compatibility stub)
app.get('/api/metrics/:slug', (req, res) => {
  res.json([]);
});

// 5. GET /api/search?q=... - Global column search across all 4 tables
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const cacheKey = q.toLowerCase();
  if (searchCache[cacheKey]) {
    return res.json(searchCache[cacheKey]);
  }

  const pillars = ['erp', 'hcm', 'scm', 'cx'];
  const results = [];
  const seen = new Set();

  for (const p of pillars) {
    try {
      const r = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM ${p}_semantic_model_lineage
              WHERE presentation_column LIKE ? OR physical_column LIKE ? OR physical_table LIKE ?
              LIMIT 30`,
        args: [`%${q}%`, `%${q}%`, `%${q}%`]
      });
      for (const row of r.rows) {
        const key = `${row.subject_area}|${row.presentation_table}|${row.presentation_column}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            pillar: p.toUpperCase(),
            subjectArea: row.subject_area,
            subjectAreaSlug: slugify(row.subject_area || ''),
            presTable: row.presentation_table,
            presColumn: row.presentation_column,
            physTable: row.physical_table,
            physColumn: row.physical_column
          });
        }
        if (results.length >= 50) break;
      }
    } catch (err) {
      // table may not exist, skip
    }
    if (results.length >= 50) break;
  }

  searchCache[cacheKey] = results;
  res.json(results);
});

// 4. GET /api/lineage/:slug
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

    const mappingsRows = [];
    for (const pillar of saInfo.pillars) {
      const table = `${pillar.toLowerCase()}_semantic_model_lineage`;
      try {
        const res = await db.execute({
          sql: `SELECT presentation_table, presentation_column, physical_table, physical_column 
                FROM ${table} 
                WHERE subject_area = ?`,
          args: [saInfo.name]
        });
        mappingsRows.push(...res.rows);
      } catch (err) {
        console.error(`Failed to query lineage from ${table}:`, err.message);
      }
    }

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
        // Still register the presentation table/columns so they render
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
      
      // Accumulate mapping info
      mappings.push({
        presentationTable: presTable,
        presentationColumn: presCol,
        physicalTable: physTable,
        physicalColumn: physCol
      });
      
      // Collect physical table nodes
      if (!nodesDict[physTable]) {
        nodesDict[physTable] = { type: 'Physical Table', columns: new Set() };
      }
      nodesDict[physTable].columns.add(physCol);
      
      // Collect presentation table nodes
      if (!nodesDict[presTable]) {
        nodesDict[presTable] = { type: 'Presentation Table', columns: new Set() };
      }
      nodesDict[presTable].columns.add(presCol);
      
      // Record connection
      connectionsSet.add(`${physTable}|||${presTable}`);
    });
    
    // Calculate layout coordinates
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
    
    // Build edges list
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

// Helper: Call Groq API
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

// 6. POST /api/ai/explain - AI Column Lineage Explainer
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

// Consolidated list of OTBI tables
const OTBI_TABLES = ['"OTBI-Finance"', '"OTBI-HCM"', '"OTBI-SCM"', '"OTBI-CX"', '"OTBI-Project"'];

// Cache for loaded OTBI subject areas
let cachedOtbiSubjectAreas = null;

async function loadOtbiSubjectAreas() {
  const sas = [];
  for (const table of OTBI_TABLES) {
    try {
      const result = await db.execute(`
        SELECT DISTINCT subject_area 
        FROM ${table} 
        ORDER BY subject_area ASC
      `);
      result.rows.forEach(r => {
        if (r.subject_area && !sas.some(x => x.name === r.subject_area)) {
          sas.push({
            slug: slugify(r.subject_area),
            name: r.subject_area,
            sourceTable: table
          });
        }
      });
    } catch (err) {
      console.error(`Error loading subject areas from ${table}:`, err.message);
    }
  }
  sas.sort((a, b) => a.name.localeCompare(b.name));
  cachedOtbiSubjectAreas = sas;
  return sas;
}

// 7. GET /api/otbi/subject-areas - Consolidated list of subject areas from the 5 tables (cached)
app.get('/api/otbi/subject-areas', async (req, res) => {
  try {
    const sas = cachedOtbiSubjectAreas || await loadOtbiSubjectAreas();
    res.json(sas);
  } catch (err) {
    console.error('Error fetching OTBI subject areas:', err.message);
    res.status(500).json({ error: 'Failed to fetch OTBI subject areas' });
  }
});

// 8. GET /api/otbi/lineage/:slug - Get mappings across the 5 tables for a subject area (cached checks)
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
    
    // Find which table contains this subject area slug from cache mapping
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
        // Extract PVO name from full definition (e.g. FscmTopModelAM.ContractsCoreAM.ResourceP -> ResourcePVO / ResourceP)
        let pvoRaw = r.physical_table || '';
        let pvoName = pvoRaw.split('.').pop() || '';
        // Standardize PVO suffix if it's a PVO path
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
    
    // Process React Flow nodes and edges
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
    
    // React Flow edges from left (Presentation Table) to right (PVO extraction)
    const reactEdges = [];
    let edgeIdx = 1;
    connectionsSet.forEach(conn => {
      const [source, target] = conn.split('|||');
      // For OTBI bridge flow: Presentation Table is source (left), PVO is target (right)
      reactEdges.push({
        id: `otbi-e-${edgeIdx++}`,
        source: target, // Pres Table
        target: source, // PVO Table
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

// 9. POST /api/ai/match-fdi - Hybrid exact-match and Grok AI ranker
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
    const pvoSearch = `%${pvoClean}%`;
    const attrSearch = `%${pvoAttribute}%`;
    
    // 1. Fetch EXACT matches from the 4 FDI mappings tables
    let exactMatches = [];
    const pillars = ['erp', 'hcm', 'scm', 'cx'];
    
    for (const p of pillars) {
      try {
        const exactRes = await db.execute({
          sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
                FROM ${p}_semantic_model_lineage
                WHERE (physical_table LIKE ? OR physical_table = ?) AND physical_column = ?`,
          args: [pvoSearch, pvoName, pvoAttribute]
        });
        exactRes.rows.forEach(r => {
          exactMatches.push({
            subjectArea: r.subject_area,
            presentationTable: r.presentation_table,
            presentationColumn: r.presentation_column,
            physicalTable: r.physical_table,
            physicalColumn: r.physical_column
          });
        });
      } catch (exactErr) {
        console.error(`Exact DB Match error for ${p}:`, exactErr.message);
      }
    }

    // 2. Fetch wider candidates for Grok semantic matching
    let candidatesRows = [];
    for (const p of pillars) {
      try {
        const dbRes = await db.execute({
          sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
                FROM ${p}_semantic_model_lineage
                WHERE physical_table LIKE ? OR physical_column LIKE ? OR physical_table LIKE ?
                LIMIT 10`,
          args: [pvoSearch, attrSearch, `%${pvoName}%`]
        });
        candidatesRows.push(...dbRes.rows);
        if (candidatesRows.length >= 25) break;
      } catch (dbErr) {
        console.error(`Candidate fetch error for ${p}:`, dbErr.message);
      }
    }
    
    if (candidatesRows.length === 0) {
      for (const p of pillars) {
        try {
          const dbRes = await db.execute({
            sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
                  FROM ${p}_semantic_model_lineage
                  WHERE presentation_column LIKE ?
                  LIMIT 5`,
            args: [`%${otbiColumn}%`]
          });
          candidatesRows.push(...dbRes.rows);
          if (candidatesRows.length >= 15) break;
        } catch (e) {}
      }
    }
    
    // 3. Ask Grok to explain semantic suggestions
    const systemPrompt = "You are a senior data architect specializing in Oracle BI (OTBI) and Fusion Data Intelligence (FDI) schemas. Your task is to match an OTBI presentation column to the most likely FDI database warehouse columns. You must respond ONLY with a valid JSON array of objects representing the top 3 matches.";
    const userPrompt = `Target OTBI Column to Match:
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
      // Fallback: parse markdown list if JSON fails (rare for llama-3.3-70b)
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

// 10. POST /api/ai/pvo-finder - Database-aware PVO Finder and FDI Semantic Extender
app.post('/api/ai/pvo-finder', async (req, res) => {
  try {
    const { otbiSubjectArea, fdiSubjectArea, explanation } = req.body;
    if (!otbiSubjectArea || !fdiSubjectArea || !explanation) {
      return res.status(400).json({ error: 'Missing parameters. Provide otbiSubjectArea, fdiSubjectArea, and explanation.' });
    }

    const cacheKey = `${otbiSubjectArea}||${fdiSubjectArea}||${explanation.toLowerCase().trim()}`;
    if (serverMatchCache[cacheKey]) {
      return res.json(serverMatchCache[cacheKey]);
    }

    // Fetch actual PVOs associated with this OTBI subject area from the database
    let relatedPvos = [];
    if (cachedOtbiSubjectAreas) {
      const match = cachedOtbiSubjectAreas.find(x => slugify(x.name) === slugify(otbiSubjectArea) || slugify(x.slug) === slugify(otbiSubjectArea));
      if (match) {
        const table = match.sourceTable;
        try {
          const pvoRes = await db.execute({
            sql: `SELECT DISTINCT physical_table 
                  FROM ${table} 
                  WHERE subject_area = ? AND physical_table IS NOT NULL AND physical_table != 'NaN' AND physical_table != ''`,
            args: [match.name]
          });
          relatedPvos = pvoRes.rows.map(r => r.physical_table);
        } catch (err) {
          console.error('Error fetching PVOs for PVO finder:', err.message);
        }
      }
    }

    const systemPrompt = `You are a senior data architect specializing in Oracle Analytics Cloud (OAC), Oracle Fusion Applications, and Oracle Fusion Data Intelligence (FDI) logical models.
Your task is to analyze a missing data business case and design a step-by-step Semantic Extension plan inside the FDI Sandbox framework using Fusion physical source PVOs.`;

    const userPrompt = `User Customization Case:
- Missing Data Business Scenario: "${explanation}"
- Target OTBI Subject Area in Fusion: "${otbiSubjectArea}"
- Target FDI Subject Area in Warehouse: "${fdiSubjectArea}"

Actual PVOs associated with OTBI Subject Area "${otbiSubjectArea}" in our database:
${relatedPvos.length > 0 ? relatedPvos.map(p => `- ${p}`).join('\n') : '(No direct PVO mappings found. Suggest the standard Fusion PVO based on your knowledge.)'}

Task:
Provide a detailed customization plan using the following structure:

### 1. Recommended PVO
Specify the best Fusion PVO to augment (e.g. FscmTopModelAM.FinAmModelAM.CreditCardTransactionPVO). Explain what this PVO represents and why it solves the user's missing data problem.

### 2. Suggested Columns
List the critical attributes or columns we need to select from this PVO (e.g. CardholderId, TransactionAmount).

### 3. Join Configuration
Specify:
- Extensibility Pattern: Choose either "Extend a Dimension", "Add a Dimension", or "Add a Fact".
- Target FDI Warehouse Table: Which standard FDI table (e.g. DW_PARTY_D, DW_AP_INVOICES_F) we should join it with.
- Join Key Mapping: Define the primary and foreign keys used to link the PVO with the FDI target table.

### 4. Sandbox Framework Guide
Write a concise step-by-step guide on how to configure this in the FDI Console using the Sandbox Framework:
1. Create and open a customization Sandbox.
2. Augment the PVO data source (Data Augmentation).
3. Open the Logical Star and establish the join configuration.
4. Add custom presentation columns to the "${fdiSubjectArea}" subject area.
5. Validate, merge, and publish the Sandbox.

Make your response technical, highly structured, clean, and in standard markdown format.`;

    const result = await callGrok(systemPrompt, userPrompt);
    const responseData = { plan: result };
    serverMatchCache[cacheKey] = responseData;
    res.json(responseData);
  } catch (err) {
    console.error('PVO Finder error:', err.message);
    res.status(500).json({ error: err.message || 'PVO Finder plan generation failed' });
  }
});

// Serve frontend React static build files (production mode)
app.use(express.static(path.join(__dirname, 'dist')));

// Wildcard SPA route handler for Express 5 (returns index.html for all frontend routes)
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Warm up caches on startup asynchronously to save initial database reads
(async () => {
  try {
    console.log('Warming up subject area caches on startup...');
    await loadSubjectAreas();
    await loadOtbiSubjectAreas();
    console.log('Cache warmup completed successfully.');
  } catch (err) {
    console.error('Error warming up caches on startup:', err.message);
  }
})();
