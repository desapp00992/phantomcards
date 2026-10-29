#!/usr/bin/env node
const path = require('node:path');
const { createJsonStateStore, configuredDatabaseUrl } = require('../storage');

async function main() {
  if (!configuredDatabaseUrl()) throw new Error('DATABASE_URL (or SUPABASE_DB_URL) is required.');
  const store = createJsonStateStore({ namespace: 'database-check', filePath: path.join(__dirname, '.unused.json'), initialState: () => ({}) });
  const pool = store.getPool();
  const states = await pool.query('SELECT namespace, state_version, jsonb_typeof(state) AS state_type, updated_at FROM app_state ORDER BY namespace');
  const blobs = await pool.query('SELECT namespace, count(*)::integer AS count, coalesce(sum(byte_size), 0)::bigint AS bytes FROM app_blobs GROUP BY namespace ORDER BY namespace');
  console.log(JSON.stringify({ ok: true, states: states.rows.map(row => ({ namespace: row.namespace, stateVersion: String(row.state_version), stateType: row.state_type, updatedAt: row.updated_at })), blobs: blobs.rows.map(row => ({ namespace: row.namespace, count: row.count, bytes: String(row.bytes) })) }));
  await store.close();
}

main().catch(error => {
  console.error(`Database check failed: ${error.message}`);
  process.exitCode = 1;
});
