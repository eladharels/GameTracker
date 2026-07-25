// PostgreSQL data layer.
//
// This module deliberately exposes the SAME callback surface that node-sqlite3
// did -- db.run / db.get / db.all with (sql, params, cb) -- so that the ~65
// existing call sites in index.js could be ported without being rewritten.
//
// WHY A SHIM AND NOT A REWRITE: index.js is a 4,000-line monolith and the project
// has no test suite. A diff that rewrites every call site into promises is not
// reviewable by a human; a diff that leaves the call sites alone and swaps the
// engine underneath is. The promise-based pg API is available to new code via
// `pool` and `query` below -- new work should prefer those.
//
// Two behavioural notes for anyone touching a call site:
//   * `?` placeholders are rewritten to `$1..$n` here. Write `?` as before.
//   * `this.lastID` only works if the SQL ends with `RETURNING id`. SQLite
//     handed it back for free; Postgres does not. `this.changes` always works.

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
// Credentials come from the environment only -- never from a file in the image
// and never hard-coded. DATABASE_URL wins if present so the deployment can hand
// over a single opaque string; otherwise the discrete PG* variables are used.
function buildPoolConfig() {
  const base = {
    // Fail a hung connect rather than wedging a request forever.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    // Recycle idle sockets so a restarted database does not leave stale handles.
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    // Small pool: this is a handful-of-users deployment, and every connection
    // costs the server a backend process.
    max: Number(process.env.PG_POOL_MAX || 10),
    // Ceiling on any single statement, enforced server-side. Stops a pathological
    // query from pinning a connection for the life of the process.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
  };

  if (process.env.DATABASE_URL) {
    return { ...base, connectionString: process.env.DATABASE_URL };
  }
  return {
    ...base,
    host: process.env.PGHOST || 'db',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'gametracker',
    user: process.env.PGUSER || 'gametracker',
    password: process.env.PGPASSWORD,
  };
}

const pool = new Pool(buildPoolConfig());

// A connection error must never surface the DSN (it contains the password) into
// logs. Log the driver's short code and message only.
pool.on('error', (err) => {
  console.error(`[DB] Idle client error: ${err.code || 'ERR'} ${err.message}`);
});

// ---------------------------------------------------------------------------
// Placeholder translation
// ---------------------------------------------------------------------------
// Rewrites SQLite's positional `?` into Postgres' `$1..$n`.
//
// A naive .replace() would also rewrite a `?` that appears inside a quoted
// string literal or a comment, silently corrupting the statement. This scanner
// tracks quoting state so only real placeholders are touched.
function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inSingle = false;   // '...'
  let inDouble = false;   // "..." (quoted identifier)
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') { out += next; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      out += ch;
      // '' is an escaped quote inside a string, not a terminator.
      if (ch === "'" && next === "'") { out += next; i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') { out += next; i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; out += ch; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; out += ch; continue; }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }

    if (ch === '?') { out += '$' + (++n); continue; }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core query helper (promise-based -- preferred for new code)
// ---------------------------------------------------------------------------
async function query(sql, params = []) {
  return pool.query(toPgPlaceholders(sql), params);
}

// ---------------------------------------------------------------------------
// node-sqlite3 compatible callback surface
// ---------------------------------------------------------------------------
// Normalises the (sql, params, cb) / (sql, cb) overloads that node-sqlite3
// accepted, since existing call sites use both.
function normalizeArgs(params, cb) {
  if (typeof params === 'function') return { params: [], cb: params };
  return { params: params || [], cb: cb || (() => {}) };
}

// db.run -- INSERT / UPDATE / DELETE / DDL.
//
// The callback is invoked with `this` bound to { lastID, changes } so the
// existing `function (err) { ... this.changes ... }` call sites keep working.
// Arrow-function callbacks cannot see `this` -- that was already true under
// node-sqlite3, so no call site changes behaviour.
function run(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  query(sql, a.params).then((res) => {
    const ctx = {
      changes: res.rowCount,
      // Only populated when the statement carried a RETURNING id clause.
      lastID: res.rows && res.rows[0] ? res.rows[0].id : undefined,
    };
    a.cb.call(ctx, null);
  }).catch((err) => {
    a.cb.call({ changes: 0, lastID: undefined }, err);
  });
}

// db.get -- first row, or undefined when there are none.
// Returning `undefined` (not null) matches node-sqlite3 exactly; call sites
// test with `if (!row)`, so either would work, but matching avoids surprises.
function get(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  query(sql, a.params)
    .then((res) => a.cb(null, res.rows[0]))
    .catch((err) => a.cb(err));
}

// db.all -- every row, always an array.
function all(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  query(sql, a.params)
    .then((res) => a.cb(null, res.rows))
    .catch((err) => a.cb(err));
}

// Runs `fn` inside a single transaction on one dedicated connection.
// Used by the shares batch-write and by the migration runner.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (sql, params = []) => client.query(toPgPlaceholders(sql), params),
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  run,
  get,
  all,
  withTransaction,
  // Exported for unit-level checking of the placeholder scanner.
  toPgPlaceholders,
};
