const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

function configuredDatabaseUrl() {
  return String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
}

function safeFilePath(file) {
  return path.resolve(String(file));
}

function writeJsonAtomically(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryFile, file);
  } catch (error) {
    try { fs.unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}

function readJson(file, fallback) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const value = fallback();
    writeJsonAtomically(file, value);
    return value;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createJsonStateStore({
  namespace,
  filePath,
  initialState,
  normalize = value => value,
  blobDirectory,
}) {
  const databaseUrl = configuredDatabaseUrl();
  const databaseEnabled = Boolean(databaseUrl);
  const context = new AsyncLocalStorage();
  let pool;
  let localLock = Promise.resolve();

  function getPool() {
    if (!databaseEnabled) return null;
    if (!pool) {
      let PgPool;
      try {
        ({ Pool: PgPool } = require('pg'));
      } catch (error) {
        throw new Error('DATABASE_URL is configured but the pg package is unavailable. Run npm install.');
      }
      const sslDisabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'false';
      pool = new PgPool({
        connectionString: databaseUrl,
        max: Math.max(1, Math.min(10, Number(process.env.DATABASE_POOL_MAX || 4))),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
        application_name: `phantom-cards-${namespace}`,
      });
    }
    return pool;
  }

  async function withRequest(task) {
    const active = context.getStore();
    if (active) return task();
    return context.run({ state: null, version: null }, task);
  }

  async function load() {
    const active = context.getStore();
    if (databaseEnabled) {
      const result = await getPool().query(
        'SELECT state, state_version FROM app_state WHERE namespace = $1',
        [namespace],
      );
      if (!result.rowCount) {
        throw new Error(`Database state '${namespace}' is not initialized. Run the migration/import command before starting the service.`);
      }
      const state = normalize(result.rows[0].state);
      if (active) {
        active.state = state;
        active.version = Number(result.rows[0].state_version);
      }
      return state;
    }

    return normalize(readJson(safeFilePath(filePath), initialState));
  }

  async function save(state) {
    if (databaseEnabled) {
      const active = context.getStore();
      if (!active || active.version === null) throw new Error(`Cannot save '${namespace}' outside a request context.`);
      const result = await getPool().query(
        `UPDATE app_state
            SET state = $1::jsonb,
                state_version = state_version + 1,
                updated_at = now()
          WHERE namespace = $2 AND state_version = $3
          RETURNING state_version`,
        [JSON.stringify(state), namespace, active.version],
      );
      if (!result.rowCount) {
        throw new Error(`Concurrent update detected for '${namespace}'. The operation was not committed; retry the request.`);
      }
      active.state = state;
      active.version = Number(result.rows[0].state_version);
      return;
    }

    writeJsonAtomically(safeFilePath(filePath), state);
  }

  async function putBlob({ userId, storageKey, content, contentType, size }) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (bytes.length !== Number(size)) throw new Error('Stored document size does not match its content.');
    if (databaseEnabled) {
      await getPool().query(
        `INSERT INTO app_blobs (namespace, user_id, storage_key, content_type, byte_size, sha256, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (namespace, user_id, storage_key) DO NOTHING`,
        [namespace, String(userId), String(storageKey), String(contentType || 'application/octet-stream'), bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), bytes],
      );
      return;
    }
    const targetDirectory = path.join(safeFilePath(blobDirectory || path.dirname(filePath)), String(userId));
    fs.mkdirSync(targetDirectory, { recursive: true });
    const target = path.join(targetDirectory, String(storageKey));
    if (!target.startsWith(`${targetDirectory}${path.sep}`)) throw new Error('Invalid blob storage key.');
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }

  async function readBlob({ userId, storageKey }) {
    if (databaseEnabled) {
      const result = await getPool().query(
        'SELECT content, content_type, byte_size FROM app_blobs WHERE namespace = $1 AND user_id = $2 AND storage_key = $3',
        [namespace, String(userId), String(storageKey)],
      );
      if (!result.rowCount) return null;
      return { content: result.rows[0].content, contentType: result.rows[0].content_type, size: Number(result.rows[0].byte_size) };
    }
    const base = safeFilePath(blobDirectory || path.dirname(filePath));
    const targetDirectory = path.join(base, String(userId));
    const target = path.join(targetDirectory, String(storageKey));
    if (!target.startsWith(`${targetDirectory}${path.sep}`) || !fs.existsSync(target)) return null;
    const content = fs.readFileSync(target);
    return { content, contentType: null, size: content.length };
  }

  async function withAdvisoryLock(key, task) {
    if (!databaseEnabled) {
      const previous = localLock;
      let release;
      localLock = new Promise(resolve => { release = resolve; });
      await previous.catch(() => {});
      try { return await task(); } finally { release(); }
    }
    const client = await getPool().connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [String(key)]);
      return await task();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [String(key)]); } finally { client.release(); }
    }
  }

  async function close() {
    if (pool) await pool.end();
  }

  return {
    databaseEnabled,
    namespace,
    filePath: safeFilePath(filePath),
    load,
    save,
    withRequest,
    withAdvisoryLock,
    putBlob,
    readBlob,
    close,
    getPool,
  };
}

module.exports = { createJsonStateStore, configuredDatabaseUrl };
