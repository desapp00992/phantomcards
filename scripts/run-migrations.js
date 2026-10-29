#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createJsonStateStore, configuredDatabaseUrl } = require('../storage');

async function main() {
  if (!configuredDatabaseUrl()) throw new Error('DATABASE_URL (or SUPABASE_DB_URL) is required.');
  const store = createJsonStateStore({ namespace: 'migration-runner', filePath: path.join(__dirname, '.unused.json'), initialState: () => ({}) });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_app_state.sql'), 'utf8');
  await store.getPool().query(sql);
  const result = await store.getPool().query('SELECT namespace, state_version, jsonb_object_keys(state) AS top_level_key FROM app_state ORDER BY namespace, top_level_key');
  const namespaces = [...new Set(result.rows.map(row => `${row.namespace}@${row.state_version}`))];
  console.log(JSON.stringify({ ok: true, migration: '001_app_state', namespaces }));
  await store.close();
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
