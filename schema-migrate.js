// Ordered, transactional schema migrations.
//
// This replaces the old initializeSchema() in index.js. That version issued a
// pile of CREATE TABLE / ALTER TABLE statements whose error callbacks discarded
// everything that was not "duplicate column name" -- which is how four missing
// columns shipped to fresh installs without anyone noticing for months.
//
// The contract here is the opposite: every migration runs inside a transaction,
// is recorded in schema_migrations so it runs exactly once, and ANY failure is
// fatal. A backend that cannot prove its schema is correct does not start.

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Applied migrations are tracked by filename. Files are applied in lexical
// order, which is why they are numbered 001_, 002_, ...
const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// Arbitrary but fixed application-wide key for the advisory lock below. Any other
// process taking this same key is, by definition, also migrating this schema.
const MIGRATION_LOCK_KEY = 4127710501;

// Applies any migration files not yet recorded in schema_migrations.
// Resolves when the schema is known-good. Rejects -- loudly -- otherwise.
async function runMigrations() {
  const client = await pool.connect();
  let locked = false;
  try {
    // Serialise migration across processes. CREATE TABLE IF NOT EXISTS is NOT
    // race-free in Postgres, so two backends starting together would both see the
    // same migration pending, both run it, and the loser would die on the
    // schema_migrations primary key. Single-replica today, but `restart:
    // unless-stopped` would turn that into a crash-loop rather than a clean start.
    // The lock is session-scoped, so it is released EXPLICITLY in `finally` -- see there.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await client.query(TRACKING_TABLE);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log(`[DB] Schema up to date (${files.length} migration(s) already applied)`);
      return;
    }

    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      console.log(`[DB] Applying migration: ${filename}`);
      try {
        // One transaction per migration: a failure leaves the database exactly
        // as it was, with the migration still marked pending.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log(`[DB] Applied: ${filename}`);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        // Rethrow with the filename attached. Never swallow.
        throw new Error(`Migration ${filename} failed and was rolled back: ${err.message}`);
      }
    }

    console.log(`[DB] Schema migrations complete (${pending.length} applied)`);
  } finally {
    // UNLOCK, then release. `client.release()` alone does NOT free the lock: it hands
    // the connection back to the POOL, and a session-level advisory lock lives as long
    // as the SESSION -- which the pool keeps open. The comment here used to say release
    // freed it; it did not (ROADMAP CC-7). The lock then sat on an idle pooled
    // connection, and a second process starting up (an overlapping deploy, a rolled-back
    // image, a maintenance script) blocked in pg_advisory_lock until that connection
    // happened to be closed. If the unlock itself fails the connection is suspect, so it
    // is DESTROYED rather than pooled: ending the session ends the lock.
    let broken;
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch (err) {
        broken = err;
      }
    }
    client.release(broken);
  }
}

// Boot entry point. Any failure exits the process rather than letting the app
// serve traffic against an unknown schema.
async function migrateOrExit() {
  try {
    await runMigrations();
  } catch (err) {
    console.error(`[FATAL] Schema migration failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { runMigrations, migrateOrExit };
