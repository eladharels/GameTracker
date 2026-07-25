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
// ===========================================================================
// THE SHIM IS NOT FULLY SOURCE-COMPATIBLE. Known divergences, in full:
//
//  1. `?` placeholders are rewritten to `$1..$n` here. Write `?` as before.
//     A mismatch between placeholder count and parameter count now THROWS
//     rather than binding the wrong value -- see query().
//  2. `this.lastID` only works if the SQL ends with `RETURNING id`. SQLite
//     handed it back for free; Postgres does not. `this.changes` always works.
//  3. **Postgres folds unquoted identifiers to lower case.** `SELECT x AS fooBar`
//     yields a `foobar` property, NOT `fooBar`. Always double-quote a camelCase
//     alias ("fooBar") or use snake_case. This silently produced `undefined`
//     and broke backlog ordering once already.
//  4. `ORDER BY col ASC` puts NULLs LAST in Postgres and FIRST in SQLite.
//     Spell the intent out with NULLS FIRST / NULLS LAST.
//  5. A non-numeric value compared against an INTEGER column raises 22P02
//     rather than simply not matching. Validate `:id` route params.
//  6. `db.serialize`, `db.prepare` and `db.each` DO NOT EXIST. There is no
//     global statement ordering: a fire-and-forget `db.run` with no callback
//     is not guaranteed to complete before a later query on another pooled
//     connection. Await anything whose effect you then read back.
//  7. The JSONB `?` / `?|` / `?&` operators cannot be written in SQL passed
//     through this shim -- the rewriter would consume them. Use the
//     jsonb_exists() function form instead.
//  8. **bigint comes back as a STRING.** COUNT(), SUM() and any int8 column
//     yield '12', not 12. Under SQLite these were numbers, so `+` concatenates
//     where it used to add. Wrap them in Number().
//  9. **Every run/get/all uses a DIFFERENT pooled connection.** A multi-statement
//     logical operation therefore spans connections and CANNOT be made atomic or
//     rolled back through this shim -- use withTransaction(). Session-scoped
//     state (SET, temp tables, advisory locks) is unusable here for the same
//     reason: the next call will not see it.
// 10. A `statement_timeout` (default 15s) is now in force. A long query aborts
//     with SQLSTATE 57014 where SQLite would simply have kept going.
// 11. `err.code` is a 5-character SQLSTATE ('23505', '22P02'), not a string like
//     'SQLITE_CONSTRAINT'. Nothing currently branches on it -- keep it that way,
//     or match on SQLSTATE deliberately.
// 12. Sorting uses the DATABASE's collation, not SQLite's byte order, so
//     `ORDER BY game_name` orders mixed case differently. The frontend re-sorts
//     with localeCompare, which is why this is currently invisible.
// 13. **A SELECT with no ORDER BY has no stable order.** SQLite returned rowid
//     order; Postgres returns heap order, and an UPDATE physically moves a row
//     to the end. Add an explicit ORDER BY wherever order is meaningful.
//
// Anything not on this list behaves as it did under node-sqlite3.
// ===========================================================================

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

  // Deliberately NO DATABASE_URL branch. A malformed DSN makes Node raise
  // ERR_INVALID_URL with the whole string -- password included -- on err.input,
  // and several call sites log the entire error object. Discrete PG* variables
  // cannot leak that way, and nothing in this deployment sets DATABASE_URL.
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

// Log the driver's short code and message only -- never the error object, which
// can carry connection details. Note this handler covers IDLE-client errors only;
// connect and query errors are delivered to the caller.
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
// Returns { sql, count }. The count is used to assert that the number of
// placeholders matches the number of bound parameters -- see query() below.
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
  return { sql: out, count: n };
}

// ---------------------------------------------------------------------------
// Core query helper (promise-based -- preferred for new code)
// ---------------------------------------------------------------------------
async function query(sql, params = []) {
  const { sql: text, count } = toPgPlaceholders(sql);
  // Arity invariant -- a useful net, but NOT a complete one. Be precise about what
  // it does and does not catch, because an overstated guarantee is how the last two
  // bugs got through.
  //
  // CATCHES: a `?` the scanner mis-parsed such that the resulting placeholder COUNT
  // no longer matches the parameter count -- E'' escapes and the JSONB `?` operator
  // in the cases tested.
  //
  // DOES NOT CATCH (count still matches, wrong value still binds):
  //   * Mixing `?` with a literal `$n`: `WHERE a = $1 AND b = ?` with one parameter
  //     rewrites to `a = $1 AND b = $1` and binds the same value twice.
  //   * Dollar-quoted blocks: `SELECT $$a ? b$$, ?` rewrites INSIDE the string
  //     literal. The scanner has no dollar-quote state.
  // Neither pattern exists in this codebase. Do not introduce one: write `?`
  // exclusively, and never `$n` by hand.
  if (count !== params.length) {
    throw new Error(
      `Placeholder/parameter arity mismatch: SQL declares ${count} placeholder(s) ` +
      `but ${params.length} parameter(s) were supplied. ` +
      `Check for a literal '?' the rewriter could not classify.`
    );
  }
  return pool.query(text, params);
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
// NOTE ON .then(onOk, onErr) VS .then(onOk).catch(onErr) -- this matters.
// The chained form catches exceptions thrown by the SUCCESS handler itself and
// re-enters the callback with the handler's own error dressed up as a database
// error. A route handler that throws after sending its response (a double
// res.json, say) would be invoked a second time, throw again, and take the
// process down via an unhandled rejection. node-sqlite3 invoked the callback
// exactly once. The two-argument form keeps the handlers disjoint and preserves
// that guarantee -- an exception from the callback propagates as an unhandled
// rejection, which is what it did before, instead of looping back in here.
function run(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  query(sql, a.params).then(
    (res) => {
      const ctx = {
        changes: res.rowCount,
        // Only populated when the statement carried a RETURNING id clause.
        lastID: res.rows && res.rows[0] ? res.rows[0].id : undefined,
      };
      a.cb.call(ctx, null);
    },
    (err) => {
      a.cb.call({ changes: 0, lastID: undefined }, err);
    }
  );
}

// db.get -- first row, or undefined when there are none.
// Returning `undefined` (not null) matches node-sqlite3 exactly; call sites
// test with `if (!row)`, so either would work, but matching avoids surprises.
function get(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  // Two-argument .then -- see the note above run().
  query(sql, a.params).then((res) => a.cb(null, res.rows[0]), (err) => a.cb(err));
}

// db.all -- every row, always an array.
function all(sql, params, cb) {
  const a = normalizeArgs(params, cb);
  // Two-argument .then -- see the note above run().
  query(sql, a.params).then((res) => a.cb(null, res.rows), (err) => a.cb(err));
}

// Runs `fn` inside a single transaction on one dedicated connection.
// Used by the shares batch-write and by the migration runner.
async function withTransaction(fn) {
  const client = await pool.connect();
  // Tracks whether the connection's transaction state is still known-good. If
  // ROLLBACK itself fails the client is returned to the pool POISONED -- it may
  // still be inside an open transaction -- so it must be destroyed instead.
  let poisoned;
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (sql, params = []) => {
        const { sql: text, count } = toPgPlaceholders(sql);
        if (count !== params.length) {
          throw new Error(
            `Placeholder/parameter arity mismatch inside transaction: ` +
            `${count} placeholder(s) vs ${params.length} parameter(s).`
          );
        }
        return client.query(text, params);
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      poisoned = rollbackErr;
    }
    throw err;
  } finally {
    // release(err) destroys the connection rather than recycling it.
    client.release(poisoned);
  }
}

// Shut the pool down. Exists so the one-shot operator scripts (which are not
// long-lived servers) can exit instead of hanging on idle sockets.
async function close() {
  return pool.end();
}

module.exports = {
  pool,
  query,
  run,
  get,
  all,
  withTransaction,
  close,
  // Exported for unit-level checking of the placeholder scanner.
  toPgPlaceholders,
};
