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

// Cache for loaded subject areas
let cachedSubjectAreas = null;

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

  res.json(results);
});

// 4. GET /api/lineage/:slug
app.get('/api/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
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
    
    res.json({
      subjectArea: saInfo.name,
      pillar: saInfo.pillars[0],
      pillars: saInfo.pillars,
      nodes: reactNodes,
      edges: reactEdges,
      mappings: mappings
    });
    
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

// Ensure otbi_lineage_mappings table exists and has seed data
async function ensureOtbiTableExists() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS otbi_lineage_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_area_slug TEXT,
        otbi_subject_area TEXT,
        otbi_presentation_table TEXT,
        otbi_presentation_column TEXT,
        pvo_name TEXT,
        pvo_attribute TEXT
      )
    `);
    
    // Check if table is empty
    const res = await db.execute(`SELECT COUNT(*) as count FROM otbi_lineage_mappings`);
    const count = res.rows[0]?.count || 0;
    if (count === 0) {
      // Seed with some mock data so the user can test the UI immediately
      await db.execute({
        sql: `INSERT INTO otbi_lineage_mappings (subject_area_slug, otbi_subject_area, otbi_presentation_table, otbi_presentation_column, pvo_name, pvo_attribute) VALUES
          (?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?)`,
        args: [
          'receivables_ar_transactions', 'Receivables - Transactions Real Time', 'Transaction Details', 'Transaction Number', 'ArTransactionHeaderPVO', 'TrxNumber',
          'receivables_ar_transactions', 'Receivables - Transactions Real Time', 'Transaction Details', 'Transaction Date', 'ArTransactionHeaderPVO', 'TrxDate',
          'receivables_ar_transactions', 'Receivables - Transactions Real Time', 'Transaction Details', 'Transaction Status', 'ArTransactionHeaderPVO', 'TrxStatus',
          'receivables_ar_transactions', 'Receivables - Transactions Real Time', 'Customer Details', 'Customer Name', 'ArCustomerAccountPVO', 'AccountName',
          'receivables_ar_transactions', 'Receivables - Transactions Real Time', 'Customer Details', 'Customer Number', 'ArCustomerAccountPVO', 'AccountNumber'
        ]
      });
      console.log('Seeded otbi_lineage_mappings table with mock data.');
    }
  } catch (err) {
    console.error('Error creating/seeding otbi_lineage_mappings table:', err.message);
  }
}

// 7. GET /api/otbi/subject-areas
app.get('/api/otbi/subject-areas', async (req, res) => {
  try {
    await ensureOtbiTableExists();
    const result = await db.execute(`
      SELECT DISTINCT subject_area_slug, otbi_subject_area 
      FROM otbi_lineage_mappings 
      ORDER BY otbi_subject_area ASC
    `);
    const sas = result.rows.map(r => ({
      slug: r.subject_area_slug,
      name: r.otbi_subject_area
    }));
    res.json(sas);
  } catch (err) {
    console.error('Error fetching OTBI subject areas:', err.message);
    res.status(500).json({ error: 'Failed to fetch OTBI subject areas' });
  }
});

// 8. GET /api/otbi/lineage/:slug
app.get('/api/otbi/lineage/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    await ensureOtbiTableExists();
    const result = await db.execute({
      sql: `SELECT otbi_presentation_table, otbi_presentation_column, pvo_name, pvo_attribute 
            FROM otbi_lineage_mappings 
            WHERE subject_area_slug = ?`,
      args: [slug]
    });
    
    const mappings = result.rows.map(r => ({
      presentationTable: r.otbi_presentation_table,
      presentationColumn: r.otbi_presentation_column,
      pvoName: r.pvo_name,
      pvoAttribute: r.pvo_attribute
    }));
    
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
        source,
        target,
        animated: true,
        style: { stroke: '#F97316', strokeWidth: 2, opacity: 0.8 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#F97316' }
      });
    });
    
    res.json({
      nodes: reactNodes,
      edges: reactEdges,
      mappings: mappings
    });
  } catch (err) {
    console.error('Error fetching OTBI lineage:', err.message);
    res.status(500).json({ error: 'Failed to fetch OTBI lineage data' });
  }
});

// 9. POST /api/ai/match-fdi
app.post('/api/ai/match-fdi', async (req, res) => {
  try {
    const { otbiColumn, otbiTable, pvoName, pvoAttribute } = req.body;
    if (!otbiColumn || !pvoName) {
      return res.status(400).json({ error: 'Missing matching parameters' });
    }
    
    const pvoSearch = `%${pvoName.replace(/PVO$/i, '')}%`;
    const attrSearch = `%${pvoAttribute}%`;
    
    let candidatesRows = [];
    try {
      const dbRes = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM lineage_mappings
              WHERE physical_table LIKE ? OR physical_column LIKE ? OR physical_table LIKE ?
              LIMIT 25`,
        args: [pvoSearch, attrSearch, `%${pvoName}%`]
      });
      candidatesRows = dbRes.rows;
    } catch (dbErr) {
      console.error('Candidate fetch error:', dbErr.message);
    }
    
    if (candidatesRows.length === 0) {
      try {
        const dbRes = await db.execute({
          sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
                FROM lineage_mappings
                WHERE presentation_column LIKE ?
                LIMIT 15`,
          args: [`%${otbiColumn}%`]
        });
        candidatesRows = dbRes.rows;
      } catch (e) {}
    }
    
    const systemPrompt = "You are a senior data architect specializing in Oracle BI (OTBI) and Fusion Data Intelligence (FDI) schemas. Your task is to match an OTBI presentation column to the most likely FDI database warehouse columns.";
    const userPrompt = `Target OTBI Column to Match:
- OTBI Presentation Table: "${otbiTable}"
- OTBI Column Name: "${otbiColumn}"
- Source PVO: "${pvoName}"
- PVO Attribute: "${pvoAttribute}"

Candidate FDI Columns found in database:
${candidatesRows.map((c, i) => `${i+1}. Subject Area: "${c.subject_area}", Table: "${c.presentation_table}", Column: "${c.presentation_column}" (Physical Table: "${c.physical_table}", Column: "${c.physical_column}")`).join('\n')}

Task:
Analyze the candidates and select/rank the top 3 most likely matching FDI columns.
For each of the top 3 matches, output:
1. Rank (1st, 2nd, 3rd)
2. FDI Column Identifier: "Subject Area › Table › Column"
3. Match Confidence Score (percentage, e.g. 95%)
4. Brief Explanation of the match reason.

Keep the output concise, structured, and in clean, readable text format. If no candidates match, explain why and suggest what the theoretical FDI mapping should be.`;
    
    const result = await callGrok(systemPrompt, userPrompt);
    res.json({ matches: result });
  } catch (err) {
    console.error('AI match error:', err.message);
    res.status(500).json({ error: err.message || 'AI matching failed' });
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
