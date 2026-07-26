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
//   * Safe to re-run ONLY after a failure. An aborted run rolls back completely,
//     so nothing is left behind and the script can simply be run again.
//     A run that COMPLETED cannot be repeated: the target is no longer empty and
//     the script will refuse with exit 5. That is deliberate -- it is not
//     idempotent, it is single-shot, which is the stronger property here.
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
// Deletes the single bootstrap `root` row the backend creates on first boot, so
// the REAL root row from SQLite can be loaded in its place. Only ever applies
// when that row is the sole occupant and has no games or shares attached.
const REPLACE_BOOTSTRAP_ROOT = hasFlag('replace-bootstrap-root');

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
// Sentinel used to force a ROLLBACK at the end of a --dry-run transaction. It is
// not an error condition, so it is unwrapped immediately outside withTransaction.
class DryRunRollback extends Error {
  constructor() { super('dry run — rolling back'); this.name = 'DryRunRollback'; }
}

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

  // --- Target must be empty ------------------------------------------------
  //
  // Every INSERT below carries an EXPLICIT primary key, so the target must be
  // empty or ids collide. If the backend has booted against this database even
  // once, ensureRootUser() has already seeded a 'root' row at id=1.
  //
  // This gate is the FIRST of two defences. It is inherently TOCTOU -- it runs on
  // the pool, the load runs on its own connection -- so a backend that comes back
  // up in between (`restart: unless-stopped` will do it) can still seed a row
  // afterwards. The second defence is that the inserts deliberately carry NO
  // `ON CONFLICT ... DO NOTHING`: a collision therefore ABORTS and rolls the whole
  // migration back, rather than silently skipping the row and committing.
  //
  // That silent skip was a real bug. It discarded the genuine root account --
  // bcrypt hash, email and permissions -- leaving the operator with a generated
  // password printed into a CI log nobody reads. And if some account other than
  // root held id=1 in SQLite, that user was dropped while their entire library
  // inserted successfully and re-parented onto whoever occupied id=1 here.
  //
  // The old row-count verification could not detect any of this: one
  // pre-existing row plus (N-1) inserted still totals N, so it printed OK.
  const targetUsers = (await db.query('SELECT id, username FROM users ORDER BY id')).rows;
  const targetGames = Number((await db.query('SELECT COUNT(*) AS n FROM user_games')).rows[0].n);
  const targetShares = Number((await db.query('SELECT COUNT(*) AS n FROM user_shares')).rows[0].n);

  const isBootstrapRootOnly =
    targetUsers.length === 1 && targetUsers[0].username === 'root' &&
    targetGames === 0 && targetShares === 0;

  if ((targetUsers.length || targetGames || targetShares) &&
      !(isBootstrapRootOnly && REPLACE_BOOTSTRAP_ROOT)) {
    section('HALTED — TARGET DATABASE IS NOT EMPTY');
    console.log(`  users ${targetUsers.length}, user_games ${targetGames}, user_shares ${targetShares} already present.`);
    if (targetUsers.length) {
      console.log('  Existing users:');
      for (const u of targetUsers) console.log(`     id=${u.id}  ${u.username}`);
    }
    console.log('');
    if (isBootstrapRootOnly) {
      console.log('  This is the bootstrap `root` account the backend creates on first boot.');
      console.log('  Loading on top of it would SILENTLY DISCARD the real root row from SQLite,');
      console.log('  leaving you with a generated password you may never have seen.');
      console.log('');
      console.log('  Re-run with --replace-bootstrap-root to delete that single row and load');
      console.log('  the genuine one. (Safe: it has no games or shares attached.)');
    } else {
      console.log('  Refusing to load into a populated database — this script cannot merge.');
      console.log('');
      console.log('  STOP. Work out WHY it is populated before doing anything else:');
      console.log('    * A previous run of this script already succeeded -> you are done,');
      console.log('      do NOT run it again. Verify with: SELECT COUNT(*) FROM user_games;');
      console.log('    * The backend was left running and auto-provisioned LDAP users');
      console.log('      -> stop the backend, then decide whether those accounts matter.');
      console.log('');
      console.log('  Destroying the volume and starting over is only correct in the SECOND');
      console.log('  case, and only once you are certain the data in it is disposable.');
      console.log('  It PERMANENTLY DELETES the database, including a completed migration:');
      console.log('    docker compose -f docker-compose.yaml down');
      console.log('    docker volume rm gametracker_gametracker-pgdata   # CHECK: docker volume ls');
      console.log('    docker compose -f docker-compose.yaml up -d db');
    }
    console.log('');
    sdb.close();
    await db.pool.end();
    process.exit(5);
  }

  // NOTE: a dry run deliberately does NOT return here. It performs the ENTIRE load
  // and then rolls it back (see DryRunRollback below), because returning early meant
  // the rehearsal never executed a single INSERT — so NOT NULL violations, type
  // mismatches and constraint failures against the tightened schema were discovered
  // for the first time during the LIVE cutover, with the app down.

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

  const counts = { users: 0, games: 0, shares: 0, quarantined: 0, skipped: 0, sharesCollapsed: 0 };

  await db.withTransaction(async (tx) => {
    if (isBootstrapRootOnly && REPLACE_BOOTSTRAP_ROOT) {
      // Safe by the checks above: exactly one row, username 'root', no games,
      // no shares. Inside the transaction, so a later failure restores it.
      const del = await tx.query("DELETE FROM users WHERE username = 'root'");
      console.log(`[migrate] Removed ${del.rowCount} bootstrap root row to make way for the real one.`);
    }
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
        // NO `ON CONFLICT (id) DO NOTHING`. With the emptiness gate above it would be
        // dead code, and it is exactly what caused the original silent-data-loss bug:
        // the gate runs on the pool, the load runs on a different connection, so a
        // backend that came back up in between could seed a row and make an id collide.
        // With the clause, that row was silently skipped and the transaction COMMITTED.
        // Without it, a collision aborts and rolls the whole migration back.
        `INSERT INTO users (${uCols.join(', ')}) VALUES (${ph})`,
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
        `INSERT INTO user_games (${gCols.join(', ')}) VALUES (${ph})`,   // see the note on the users insert above
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
      // Case repair can COLLAPSE two source rows onto one target row: production
      // holds both 'Orelsh'->x and 'orelsh'->x, which normalise to the same pair,
      // and the second is absorbed by ON CONFLICT DO NOTHING. That is correct
      // de-duplication, not a lost row — count it so verification does not report a
      // false MISMATCH *after* the transaction has already committed.
      if (r.rowCount === 0) counts.sharesCollapsed++;
    }

    // Identity sequences were bypassed by the explicit ids above. Resynchronise
    // them or the next INSERT will collide with an existing primary key.
    // setval() is STRICT: if pg_get_serial_sequence ever returns NULL it returns
    // NULL *without erroring*, leaving the counter at 1 so the next user creation
    // dies with a duplicate-key 23505. Assert we actually set something.
    for (const t of ['users', 'user_games']) {
      const r = await tx.query(
        // `?`, NOT `$1`. Everything here goes through the db.js shim, which counts
        // `?` markers and rewrites them to $n. A hand-written `$1` is invisible to
        // that counter, so the statement declared 0 placeholders against 1 param
        // and the arity guard aborted the whole migration.
        `SELECT setval(pg_get_serial_sequence(?, 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1)) AS newval`,
        [t]
      );
      if (r.rows[0].newval == null) {
        throw new Error(`Could not resolve the identity sequence for ${t}.id — refusing to ` +
          'commit, because the next insert would collide with an existing primary key.');
      }
    }

    // Everything above has now been exercised for real. On a dry run, throw so
    // withTransaction issues ROLLBACK and Postgres is left exactly as it was.
    if (DRY_RUN) throw new DryRunRollback();
  }).catch((err) => {
    if (!(err instanceof DryRunRollback)) throw err;
  });

  // --- Verify ------------------------------------------------------------
  // After a dry run the transaction was rolled back, so the tables are empty again.
  // Compare against what WOULD have been committed rather than what is on disk.
  const finalCount = DRY_RUN
    ? async (t) => ({ users: counts.users, user_games: counts.games, user_shares: counts.shares })[t]
    : async (t) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);

  section(DRY_RUN ? 'DRY RUN — LOADED THEN ROLLED BACK' : 'LOADED');
  console.log(`  users        inserted ${counts.users}`);
  console.log(`  user_games   inserted ${counts.games}`);
  console.log(`  user_shares  inserted ${counts.shares}`);
  if (counts.quarantined) console.log(`  quarantined  ${counts.quarantined}  (see table migration_orphans)`);
  if (counts.skipped) console.log(`  SKIPPED      ${counts.skipped}  (discarded at operator request)`);
  if (counts.sharesCollapsed) {
    console.log(`  de-duplicated ${counts.sharesCollapsed} share(s) whose only difference was username case`);
  }

  section('VERIFICATION (source vs target)');
  const expectedGames = games.length - orphanGames.length;
  const expectedShares = shares.length - orphanShares.length - counts.sharesCollapsed;
  // Verify BOTH the final table count AND the number of rows this run actually
  // inserted. Checking only the totals is what allowed a skipped row to pass:
  // one pre-existing row plus (N-1) inserted still totals N, so the old check
  // printed OK while the real production `root` account had been discarded.
  const rows = [
    ['users', users.length, await finalCount('users'), users.length, counts.users],
    ['user_games', games.length, await finalCount('user_games'), expectedGames, counts.games],
    ['user_shares', shares.length, await finalCount('user_shares'), expectedShares, counts.shares],
  ];
  let ok = true;
  console.log('  table         sqlite   postgres   expected   inserted   result');
  for (const [t, src, tgt, exp, ins] of rows) {
    const good = tgt === exp && ins === exp;
    if (!good) ok = false;
    console.log(`  ${t.padEnd(12)} ${String(src).padStart(6)} ${String(tgt).padStart(10)} ${String(exp).padStart(10)} ${String(ins).padStart(10)}   ${good ? 'OK' : 'MISMATCH'}`);
  }
  if (!ok) {
    console.log('');
    console.log('  A MISMATCH in the "inserted" column means rows were skipped rather than');
    console.log('  loaded — usually because the target was not empty. Nothing was committed');
    console.log('  if this run aborted; otherwise investigate before starting the backend.');
  }

  console.log('');
  if (ok && DRY_RUN) {
    console.log('  DRY RUN PASSED. Every row was actually inserted and then rolled back,');
    console.log('  so the schema accepts this data. PostgreSQL is unchanged and still empty.');
    console.log('  Re-run without --dry-run to commit.');
  } else if (ok) {
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
