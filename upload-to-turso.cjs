const { createClient } = require('@libsql/client');
const path = require('path');

async function main() {
  const url = process.argv[2] || process.env.TURSO_DATABASE_URL;
  const token = process.argv[3] || process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    console.error('Error: Please provide Turso URL and Auth Token.');
    console.log('\nUsage:');
    console.log('  node upload-to-turso.js <turso-db-url> <turso-auth-token>\n');
    console.log('Example:');
    console.log('  node upload-to-turso.js libsql://fdi-explorer-username.turso.io prod_auth_token_string\n');
    process.exit(1);
  }

  console.log('Connecting to local SQLite database...');
  const localDb = createClient({
    url: 'file:' + path.join(__dirname, 'fdi_lineage.db')
  });

  console.log('Connecting to remote Turso database...');
  const remoteDb = createClient({
    url: url,
    authToken: token
  });

  try {
    // 1. Initialize remote schema
    console.log('Initializing database schema on Turso...');
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS subject_areas (
          slug TEXT PRIMARY KEY,
          name TEXT,
          pillars TEXT,
          metrics_count INTEGER DEFAULT 0,
          lineage_count INTEGER DEFAULT 0
      )
    `);
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS lineage_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_area_slug TEXT,
          presentation_table TEXT,
          presentation_column TEXT,
          physical_table TEXT,
          physical_column TEXT
      )
    `);
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_area_slug TEXT,
          metric_name TEXT,
          logic TEXT,
          description TEXT
      )
    `);
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS augmentations (
          table_name TEXT PRIMARY KEY,
          entity_name TEXT,
          domain_code TEXT,
          entity_keys TEXT,
          table_column TEXT
      )
    `);
    await remoteDb.execute(`
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

    // 2. Clear remote tables for clean update
    console.log('Clearing existing remote database records...');
    await remoteDb.execute('DELETE FROM lineage_mappings');
    await remoteDb.execute('DELETE FROM metrics');
    await remoteDb.execute('DELETE FROM subject_areas');
    await remoteDb.execute('DELETE FROM augmentations');
    await remoteDb.execute('DELETE FROM otbi_lineage_mappings');

    // Helper: Bulk uploader function
    async function uploadTable(tableName, rows, columns, batchSize = 500) {
      console.log(`Uploading ${rows.length} rows to remote ${tableName} table...`);
      const placeholders = columns.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const statements = chunk.map(row => {
          const args = columns.map(col => row[col]);
          return { sql: insertSql, args };
        });
        
        await remoteDb.batch(statements);
        console.log(`  Progress: ${Math.min(i + batchSize, rows.length)} / ${rows.length} rows uploaded...`);
      }
      console.log(`Finished uploading ${tableName}.\n`);
    }

    // 3. Fetch and Upload Data
    // A. Augmentations
    const augsRes = await localDb.execute('SELECT * FROM augmentations');
    await uploadTable('augmentations', augsRes.rows, ['table_name', 'entity_name', 'domain_code', 'entity_keys', 'table_column']);

    // B. Subject Areas
    const saRes = await localDb.execute('SELECT * FROM subject_areas');
    await uploadTable('subject_areas', saRes.rows, ['slug', 'name', 'pillars', 'metrics_count', 'lineage_count']);

    // C. Metrics
    const metricsRes = await localDb.execute('SELECT * FROM metrics');
    await uploadTable('metrics', metricsRes.rows, ['subject_area_slug', 'metric_name', 'logic', 'description']);

    // D. Lineage Mappings
    const lineageRes = await localDb.execute('SELECT * FROM lineage_mappings');
    await uploadTable('lineage_mappings', lineageRes.rows, ['subject_area_slug', 'presentation_table', 'presentation_column', 'physical_table', 'physical_column'], 1000);

    // E. OTBI Lineage Mappings
    try {
      const otbiRes = await localDb.execute('SELECT * FROM otbi_lineage_mappings');
      if (otbiRes.rows.length > 0) {
        await uploadTable('otbi_lineage_mappings', otbiRes.rows, ['subject_area_slug', 'otbi_subject_area', 'otbi_presentation_table', 'otbi_presentation_column', 'pvo_name', 'pvo_attribute']);
      }
    } catch (e) {
      console.log('Skipping OTBI upload: local table does not exist or is empty.');
    }

    // 4. Build Indexes
    console.log('Building query indexes on remote database...');
    await remoteDb.execute('CREATE INDEX IF NOT EXISTS idx_lineage_sa ON lineage_mappings(subject_area_slug)');
    await remoteDb.execute('CREATE INDEX IF NOT EXISTS idx_metrics_sa ON metrics(subject_area_slug)');
    await remoteDb.execute('CREATE INDEX IF NOT EXISTS idx_otbi_sa ON otbi_lineage_mappings(subject_area_slug)');

    console.log('\n=========================================');
    console.log('🎉 Turso Cloud Database Sync Completed! 🎉');
    console.log('=========================================\n');

  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    localDb.close();
    remoteDb.close();
  }
}

main();
