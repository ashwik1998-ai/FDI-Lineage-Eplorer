/**
 * generate_search_index.js
 *
 * Reads ALL FDI lineage tables once and bakes a compact search_index.json file.
 * Run this script locally (not on server startup) to pre-compute the search index.
 * This means the server NEVER reads from the DB for search - it just loads the JSON file.
 *
 * Usage: node generate_search_index.js
 */

import { createClient } from '@libsql/client';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const slugify = (text = '') =>
  text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '_');

async function run() {
  console.log('Generating search_index.json from FDI lineage tables...\n');
  const pillars = ['erp', 'hcm', 'scm', 'cx'];
  const entries = [];
  const seen = new Set();

  for (const p of pillars) {
    console.log(`  Scanning ${p}_semantic_model_lineage...`);
    try {
      const r = await db.execute({
        sql: `SELECT DISTINCT subject_area, presentation_table, presentation_column, physical_table, physical_column
              FROM ${p}_semantic_model_lineage`,
        args: []
      });
      for (const row of r.rows) {
        const key = `${row.subject_area}|${row.presentation_table}|${row.presentation_column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          p: p.toUpperCase(),             // pillar (short)
          sa: row.subject_area,           // subject area name
          ss: slugify(row.subject_area),  // subject area slug
          pt: row.presentation_table,     // presentation table
          pc: row.presentation_column,    // presentation column
          xt: row.physical_table,         // physical table
          xc: row.physical_column         // physical column
        });
      }
      console.log(`    ${r.rows.length} rows -> ${entries.length} unique entries so far`);
    } catch (err) {
      console.error(`  Error scanning ${p}:`, err.message);
    }
  }

  const outPath = path.join(__dirname, 'search_index.json');
  fs.writeFileSync(outPath, JSON.stringify(entries));
  console.log(`\nDone! Wrote ${entries.length} entries to search_index.json (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
