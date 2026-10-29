#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createJsonStateStore, configuredDatabaseUrl } = require('../storage');

const ROOT = path.resolve(__dirname, '..');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

function usage() {
  console.error('Usage: DATABASE_URL=... node scripts/migrate-json-to-postgres.js --source <json-file> --namespace <site_a|site_b|bundle> [--blobs <kyc-directory>]');
  process.exitCode = 2;
}

function canonical(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function countShape(state) {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? value.length : typeof value]));
}

function validateState(namespace, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Source JSON must contain an object state.');
  if (namespace === 'site_a') {
    const arrays = ['cards', 'users', 'sessions', 'deposits', 'purchases', 'codes', 'methods', 'withdrawals', 'transactions', 'receipts', 'kycBypassPayments'];
    for (const key of arrays) if (!Array.isArray(state[key])) throw new Error(`Site A state is missing its '${key}' array.`);
    for (const user of state.users) {
      if (!user.id || !Number.isFinite(Number(user.walletBalance)) || Number(user.walletBalance) < 0 || !Number.isFinite(Number(user.redeemedBalance)) || Number(user.redeemedBalance) < 0) {
        throw new Error(`Invalid user balance record for ${String(user.id || 'unknown user')}.`);
      }
    }
    for (const [key, rows] of [['transactions', state.transactions], ['receipts', state.receipts], ['deposits', state.deposits], ['withdrawals', state.withdrawals], ['purchases', state.purchases]]) {
      const references = rows.map(row => row.reference).filter(Boolean);
      if (new Set(references).size !== references.length) throw new Error(`Duplicate references detected in ${key}; no import was performed.`);
    }
    const userIds = new Set(state.users.map(user => user.id));
    for (const row of [...state.deposits, ...state.purchases, ...state.withdrawals, ...state.transactions, ...state.receipts, ...state.kycBypassPayments]) {
      if (row.userId && !userIds.has(row.userId)) throw new Error(`Record ${String(row.reference || row.id)} points to a missing user.`);
    }
  } else if (namespace === 'site_b') {
    if (!Array.isArray(state.transactions) || !Array.isArray(state.webhookEvents) || !Array.isArray(state.requestIds)) throw new Error('Site B state must contain transactions, webhookEvents, and requestIds arrays.');
  } else if (namespace === 'bundle') {
    if (!Array.isArray(state.orders) || !Array.isArray(state.requestIds)) throw new Error('Bundle state must contain orders and requestIds arrays.');
  }
}

async function main() {
  if (!configuredDatabaseUrl()) throw new Error('DATABASE_URL (or SUPABASE_DB_URL) is required.');
  const source = argument('source');
  const namespace = argument('namespace');
  const blobs = argument('blobs');
  if (!source || !namespace || !['site_a', 'site_b', 'bundle'].includes(namespace)) return usage();
  const sourceFile = path.resolve(ROOT, source);
  if (!fs.existsSync(sourceFile)) throw new Error(`Source file was not found: ${source}`);
  const state = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  validateState(namespace, state);

  const store = createJsonStateStore({ namespace, filePath: sourceFile, initialState: () => state });
  const pool = store.getPool();
  const migration = fs.readFileSync(path.join(ROOT, 'migrations', '001_app_state.sql'), 'utf8');
  await pool.query(migration);

  const raw = canonical(state);
  const fingerprint = sha256(raw);
  const existing = await pool.query('SELECT state, state_version FROM app_state WHERE namespace = $1', [namespace]);
  if (existing.rowCount) {
    const existingFingerprint = sha256(canonical(existing.rows[0].state));
    if (existingFingerprint !== fingerprint) throw new Error(`Namespace '${namespace}' already contains different data. Nothing was overwritten.`);
    console.log(JSON.stringify({ namespace, status: 'already-present', stateVersion: String(existing.rows[0].state_version), fingerprint, counts: countShape(state) }));
  } else {
    await pool.query('INSERT INTO app_state (namespace, state_version, state) VALUES ($1, 1, $2::jsonb)', [namespace, raw]);
    console.log(JSON.stringify({ namespace, status: 'imported', stateVersion: '1', fingerprint, counts: countShape(state) }));
  }

  if (namespace === 'site_a' && blobs) {
    const blobRoot = path.resolve(ROOT, blobs);
    let imported = 0;
    for (const user of state.users) {
      for (const document of user.kycSubmission?.documents || []) {
        if (!/^[A-Za-z0-9_-]+\.bin$/.test(String(document.storageKey || ''))) throw new Error(`Invalid KYC storage key for user ${user.id}.`);
        const file = path.join(blobRoot, user.id, document.storageKey);
        if (!file.startsWith(`${blobRoot}${path.sep}`) || !fs.existsSync(file)) throw new Error(`KYC document is missing: ${file}`);
        const content = fs.readFileSync(file);
        if (content.length !== Number(document.size)) throw new Error(`KYC document size mismatch: ${file}`);
        const digest = sha256(content);
        const result = await pool.query(
          `INSERT INTO app_blobs (namespace, user_id, storage_key, content_type, byte_size, sha256, content)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (namespace, user_id, storage_key) DO NOTHING
           RETURNING storage_key`,
          [namespace, user.id, document.storageKey, document.type || 'application/octet-stream', content.length, digest, content],
        );
        if (result.rowCount) imported += 1;
        const check = await pool.query('SELECT byte_size, sha256 FROM app_blobs WHERE namespace = $1 AND user_id = $2 AND storage_key = $3', [namespace, user.id, document.storageKey]);
        if (!check.rowCount || Number(check.rows[0].byte_size) !== content.length || check.rows[0].sha256 !== digest) throw new Error(`KYC document conflict detected: ${file}`);
      }
    }
    console.log(JSON.stringify({ namespace, blobs: 'verified', imported }));
  }
  await store.close();
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
