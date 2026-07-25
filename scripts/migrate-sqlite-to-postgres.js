#!/usr/bin/env node
//
// One-shot SQLite -> PostgreSQL data migration.
//
// RUN THIS MANUALLY. It is deliberately NOT wired into container startup: a
// migration that fires on boot is a migration that fires again on the next
// restart. The operator runs it once, reads the report, and moves on.
//
//   node scripts/migrate-sqlite-to-postgres.js --sqlite /path/to/gametracker.db
//
// Flags:
//   --sqlite <path>        Source database (default: ./gametracker.db)
//   --dry-run              Analyse and report; write nothing. Do this first.
//   --allow-orphans=skip   Proceed, skipping rows whose parent user is gone.
//   --allow-orphans=quarantine
//                          Proceed, copying orphans into migration_orphans.
//
// SAFETY PROPERTIES:
//   * Idempotent. Re-running loads nothing twice (ON CONFLICT DO NOTHING) and
//     reports the same counts. Safe to run again if it is interrupted.
//   * Transactional. Everything happens in ONE transaction; any failure rolls
//     the whole thing back and leaves Postgres exactly as it was.
//   * It NEVER silently drops a row. Referential problems stop the migration
//     and print a full breakdown unless the operator explicitly opts in.
//   * It never writes to, or even opens for writing, the SQLite source.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const db = require('../db');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1 && argv[exact + 1]) return argv[exact + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split('=').slice(1).join('=') : fallback;
};
const hasFlag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const SQLITE_PATH = path.resolve(argValue('sqlite', path.join(__dirname, '..', 'gametracker.db')));
const DRY_RUN = hasFlag('dry-run');
const ORPHAN_MODE = argValue('allow-orphans', 'halt'); // halt | skip | quarantine

if (!['halt', 'skip', 'quarantine'].includes(ORPHAN_MODE)) {
  console.error(`[FATAL] --allow-orphans must be one of: skip, quarantine (got "${ORPHAN_MODE}")`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// SQLite reader (read-only)
// ---------------------------------------------------------------------------
function openSqlite() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`[FATAL] SQLite database not found: ${SQLITE_PATH}`);
    process.exit(2);
  }
  return new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      console.error(`[FATAL] Cannot open SQLite database read-only: ${err.message}`);
      process.exit(2);
    }
  });
}

const sqliteAll = (sdb, sql) => new Promise((resolve, reject) => {
  sdb.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows)));
});

// A column may be absent in older databases (e.g. can_create_users). Read the
// actual table shape rather than assuming, so the script works against any
// vintage of the file.
async function columnsOf(sdb, table) {
  const rows = await sqliteAll(sdb, `PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}
const pick = (row, cols) => cols.reduce((acc, c) => (acc[c] = row[c] !== undefined ? row[c] : null, acc), {});

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------
const hr = () => console.log('-'.repeat(74));
const section = (t) => { console.log(''); hr(); console.log(t); hr(); };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('');
  console.log('GameTracker SQLite -> PostgreSQL migration');
  console.log(`  source : ${SQLITE_PATH}`);
  console.log(`  target : ${process.env.PGDATABASE || 'gametracker'} @ ${process.env.PGHOST || 'db'}`);
  console.log(`  mode   : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'} / orphans=${ORPHAN_MODE}`);

  const sdb = openSqlite();

  // --- Read source -------------------------------------------------------
  const userCols = await columnsOf(sdb, 'users');
  const gameCols = await columnsOf(sdb, 'user_games');
  const shareCols = await columnsOf(sdb, 'user_shares');

  const users = await sqliteAll(sdb, 'SELECT * FROM users');
  const games = await sqliteAll(sdb, 'SELECT * FROM user_games');
  const shares = await sqliteAll(sdb, 'SELECT * FROM user_shares');

  section('SOURCE');
  console.log(`  users        ${users.length}`);
  console.log(`  user_games   ${games.length}`);
  console.log(`  user_shares  ${shares.length}`);

  // --- Referential integrity analysis ------------------------------------
  // Postgres will enforce the foreign keys SQLite declared but never checked.
  // Find every violation BEFORE attempting to write anything.
  const userIds = new Set(users.map((u) => u.id));
  // Usernames are stored lowercased by the application, but user_shares has
  // historically captured whatever case the client sent. Compare case-insensitively
  // so a pure case mismatch is reported as repairable rather than as a dead row.
  const usernamesExact = new Set(users.map((u) => u.username));
  const usernamesLower = new Map(users.map((u) => [String(u.username).toLowerCase(), u.username]));

  const orphanGames = games.filter((g) => !userIds.has(g.user_id));
  const orphanShares = [];
  const repairableShares = [];

  for (const s of shares) {
    const problems = [];
    for (const side of ['from_user', 'to_user']) {
      const v = s[side];
      if (usernamesExact.has(v)) continue;
      const lower = String(v).toLowerCase();
      if (usernamesLower.has(lower)) problems.push({ side, kind: 'case', canonical: usernamesLower.get(lower) });
      else problems.push({ side, kind: 'missing' });
    }
    if (problems.length === 0) continue;
    if (problems.every((p) => p.kind === 'case')) repairableShares.push({ row: s, problems });
    else orphanShares.push({ row: s, problems });
  }

  section('REFERENTIAL INTEGRITY');
  if (orphanGames.length) {
    const byUser = orphanGames.reduce((m, g) => (m[g.user_id] = (m[g.user_id] || 0) + 1, m), {});
    console.log(`  user_games rows whose user_id no longer exists: ${orphanGames.length}`);
    for (const [uid, n] of Object.entries(byUser).sort((a, b) => a[0] - b[0])) {
      console.log(`     user_id=${uid}  ${n} game(s)`);
    }
  } else {
    console.log('  user_games: no orphans');
  }

  if (repairableShares.length) {
    console.log(`  user_shares rows fixable by case-normalisation: ${repairableShares.length}`);
    for (const r of repairableShares) {
      const detail = r.problems.map((p) => `${p.side}="${r.row[p.side]}" -> "${p.canonical}"`).join(', ');
      console.log(`     ${r.row.from_user} -> ${r.row.to_user}   (${detail})`);
    }
    console.log('     These will be repaired automatically (lowercased to match users.username).');
  } else {
    console.log('  user_shares: no case mismatches');
  }

  if (orphanShares.length) {
    console.log(`  user_shares rows referencing a user that does not exist at all: ${orphanShares.length}`);
    for (const r of orphanShares) {
      const detail = r.problems.filter((p) => p.kind === 'missing').map((p) => `${p.side}="${r.row[p.side]}"`).join(', ');
      console.log(`     ${r.row.from_user} -> ${r.row.to_user}   (missing: ${detail})`);
    }
  } else {
    console.log('  user_shares: no dead references');
  }

  const totalBlocking = orphanGames.length + orphanShares.length;

  if (totalBlocking > 0 && ORPHAN_MODE === 'halt') {
    section('HALTED — OPERATOR DECISION REQUIRED');
    console.log(`  ${totalBlocking} row(s) violate foreign keys that PostgreSQL will enforce.`);
    console.log('  Nothing has been written. These rows belong to users that no longer');
    console.log('  exist, so they are unreachable through the API — but they are still');
    console.log('  data, and this script will not delete data on your behalf.');
    console.log('');
    console.log('  Choose one and re-run:');
    console.log('    --allow-orphans=quarantine   copy them into migration_orphans, then load');
    console.log('                                 the rest (recommended: nothing is lost)');
    console.log('    --allow-orphans=skip         load the rest and discard them');
    console.log('');
    sdb.close();
    await db.pool.end();
    process.exit(3);
  }

  if (DRY_RUN) {
    section('DRY RUN COMPLETE');
    console.log('  No changes were written. Re-run without --dry-run to load.');
    sdb.close();
    await db.pool.end();
    return;
  }

  // --- Load --------------------------------------------------------------
  // Column lists are intersected with what the target schema actually has, so a
  // source column that was dropped from the schema does not break the insert.
  const TARGET_USER_COLS = ['id', 'username', 'password', 'can_create_users', 'can_manage_users',
    'email', 'ntfy_url', 'ntfy_topic', 'gotify_url', 'gotify_token', 'telegram_chat_id',
    'created_at', 'origin', 'display_name', 'shares_library', 'notification_days'];
  const TARGET_GAME_COLS = ['id', 'user_id', 'game_id', 'game_name', 'cover_url', 'release_date',
    'status', 'steam_app_id', 'last_price', 'last_price_updated', 'crack_status', 'backlog_order'];

  const uCols = TARGET_USER_COLS.filter((c) => userCols.includes(c));
  const gCols = TARGET_GAME_COLS.filter((c) => gameCols.includes(c));

  const counts = { users: 0, games: 0, shares: 0, quarantined: 0, skipped: 0 };

  await db.withTransaction(async (tx) => {
    if (ORPHAN_MODE === 'quarantine' && totalBlocking > 0) {
      await tx.query(`CREATE TABLE IF NOT EXISTS migration_orphans (
        id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source_table TEXT NOT NULL,
        reason       TEXT NOT NULL,
        payload      JSONB NOT NULL,
        captured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      // Clear any previous capture before re-populating.
      //
      // Without this the table accumulates a duplicate set of orphans on every
      // re-run, which would break the idempotency this script promises. Each run
      // re-derives the full orphan set from the source, so replacing wholesale is
      // correct: the end state depends only on the source file, never on how many
      // times the script has been executed.
      await tx.query('DELETE FROM migration_orphans');
    }

    // users ---------------------------------------------------------------
    for (const u of users) {
      const row = pick(u, uCols);
      const ph = uCols.map(() => '?').join(', ');
      const r = await tx.query(
        `INSERT INTO users (${uCols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        uCols.map((c) => row[c])
      );
      counts.users += r.rowCount;
    }

    // user_games ----------------------------------------------------------
    for (const g of games) {
      const isOrphan = !userIds.has(g.user_id);
      if (isOrphan) {
        if (ORPHAN_MODE === 'quarantine') {
          await tx.query(
            'INSERT INTO migration_orphans (source_table, reason, payload) VALUES (?, ?, ?)',
            ['user_games', `user_id ${g.user_id} not present in users`, JSON.stringify(g)]
          );
          counts.quarantined++;
        } else {
          counts.skipped++;
        }
        continue;
      }
      const row = pick(g, gCols);
      // game_id is TEXT in the target. Every production row is already a string
      // like 'igdb_19564', but coerce defensively in case an older row is numeric.
      if (row.game_id !== null && row.game_id !== undefined) row.game_id = String(row.game_id);
      const ph = gCols.map(() => '?').join(', ');
      const r = await tx.query(
        `INSERT INTO user_games (${gCols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        gCols.map((c) => row[c])
      );
      counts.games += r.rowCount;
    }

    // user_shares ---------------------------------------------------------
    for (const s of shares) {
      const dead = orphanShares.find((o) => o.row === s);
      if (dead) {
        if (ORPHAN_MODE === 'quarantine') {
          await tx.query(
            'INSERT INTO migration_orphans (source_table, reason, payload) VALUES (?, ?, ?)',
            ['user_shares', 'references a username not present in users', JSON.stringify(s)]
          );
          counts.quarantined++;
        } else {
          counts.skipped++;
        }
        continue;
      }
      // Normalise case to the canonical username so the foreign key resolves.
      const from = usernamesLower.get(String(s.from_user).toLowerCase()) || s.from_user;
      const to = usernamesLower.get(String(s.to_user).toLowerCase()) || s.to_user;
      const r = await tx.query(
        'INSERT INTO user_shares (from_user, to_user, shared_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [from, to, s.shared_at]
      );
      counts.shares += r.rowCount;
    }

    // Identity sequences were bypassed by the explicit ids above. Resynchronise
    // them or the next INSERT will collide with an existing primary key.
    await tx.query(`SELECT setval(pg_get_serial_sequence('users', 'id'),
                                 GREATEST((SELECT COALESCE(MAX(id), 0) FROM users), 1))`);
    await tx.query(`SELECT setval(pg_get_serial_sequence('user_games', 'id'),
                                 GREATEST((SELECT COALESCE(MAX(id), 0) FROM user_games), 1))`);
  });

  // --- Verify ------------------------------------------------------------
  const finalCount = async (t) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);

  section('LOADED');
  console.log(`  users        inserted ${counts.users}`);
  console.log(`  user_games   inserted ${counts.games}`);
  console.log(`  user_shares  inserted ${counts.shares}`);
  if (counts.quarantined) console.log(`  quarantined  ${counts.quarantined}  (see table migration_orphans)`);
  if (counts.skipped) console.log(`  SKIPPED      ${counts.skipped}  (discarded at operator request)`);

  section('VERIFICATION (source vs target)');
  const expectedGames = games.length - orphanGames.length;
  const expectedShares = shares.length - orphanShares.length;
  const rows = [
    ['users', users.length, await finalCount('users'), users.length],
    ['user_games', games.length, await finalCount('user_games'), expectedGames],
    ['user_shares', shares.length, await finalCount('user_shares'), expectedShares],
  ];
  let ok = true;
  console.log('  table         sqlite   postgres   expected   result');
  for (const [t, src, tgt, exp] of rows) {
    const good = tgt === exp;
    if (!good) ok = false;
    console.log(`  ${t.padEnd(12)} ${String(src).padStart(6)} ${String(tgt).padStart(10)} ${String(exp).padStart(10)}   ${good ? 'OK' : 'MISMATCH'}`);
  }

  console.log('');
  if (ok) {
    console.log('  Row counts reconcile. Migration complete.');
    console.log('  Keep the SQLite file untouched until you are confident — it is the rollback.');
  } else {
    console.log('  ROW COUNTS DO NOT RECONCILE. Investigate before starting the backend.');
  }
  hr();

  sdb.close();
  await db.pool.end();
  if (!ok) process.exit(4);
}

main().catch(async (err) => {
  console.error('');
  console.error(`[FATAL] Migration aborted and rolled back: ${err.message}`);
  console.error('        PostgreSQL is unchanged. The SQLite source was never written to.');
  try { await db.pool.end(); } catch { /* pool may not be up */ }
  process.exit(1);
});
