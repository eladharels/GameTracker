// Status-history integration test — needs a REAL Postgres, and is run by the
// smoke-test job inside the backend container against the throwaway smoke database.
// NOT part of `npm test`.
//
// It lives outside the unit suites deliberately. test/helpers.test.js's scope rule is
// pure functions with no database, and CLAUDE.md says anything needing a real Postgres
// belongs in the smoke test. That is not a technicality here: the five write paths in
// services/library.js are the entire foundation of the statistics feature, and NO unit
// test can observe them — stubbing db.promises proves a statement was issued, not that
// a row landed with the right `source` under a CHECK constraint.
//
// The reason it earns a CI slot rather than being a by-hand script: a regression here
// is PERMANENTLY destructive. An ordinary bug is fixed and the code moves on; history
// that was never recorded cannot be backfilled, and honest backfilling is exactly what
// migrations 004 and 005 refuse to do. Every day this silently stops writing is a day
// of the user's data that no later fix recovers.
//
// Connection comes from the PG* environment, same as db.js.
const assert = require('assert');
const db = require('../../db');
const lib = require('../../services/library');

let n = 0, failed = 0;
const ok = (label) => { n++; console.log('  ok  ' + label); };
const fail = (label, e) => { n++; failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
async function check(label, fn) { try { await fn(); ok(label); } catch (e) { fail(label, e); } }

const events = (userId) => db.promises.all(
  'SELECT game_id, from_status, to_status, source FROM user_game_status_events WHERE user_id = ? ORDER BY id',
  [userId]);

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  await db.promises.run("DELETE FROM users WHERE username = 'evtest'");
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('evtest','x',0,'now','local')");
  const u = await db.promises.get("SELECT id FROM users WHERE username='evtest'");
  const uid = u.id;

  console.log('\nadding and re-saving:');
  await check('adding a game logs NULL -> status, source=user', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_1', gameName: 'A', releaseDate: iso(-100), status: 'wishlist' });
    const e = await events(uid);
    assert.strictEqual(e.length, 1, `expected 1 event, got ${e.length}`);
    assert.deepStrictEqual(
      { f: e[0].from_status, t: e[0].to_status, s: e[0].source },
      { f: null, t: 'wishlist', s: 'user' });
  });

  await check('re-saving the SAME status logs nothing', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_1', gameName: 'A', releaseDate: iso(-100), status: 'wishlist' });
    const e = await events(uid);
    assert.strictEqual(e.length, 1, `a no-op re-save wrote an event (now ${e.length})`);
  });

  console.log('\nstatus changes:');
  await check('setStatus done logs wishlist -> done, source=user', async () => {
    await lib.setStatus(uid, 'igdb_1', 'done');
    const e = await events(uid);
    assert.strictEqual(e.length, 2);
    assert.deepStrictEqual({ f: e[1].from_status, t: e[1].to_status, s: e[1].source },
      { f: 'wishlist', t: 'done', s: 'user' });
  });

  await check('setStatus backlog (the transactional branch) logs too', async () => {
    await lib.setStatus(uid, 'igdb_1', 'backlog');
    const e = await events(uid);
    assert.strictEqual(e.length, 3);
    assert.deepStrictEqual({ f: e[2].from_status, t: e[2].to_status, s: e[2].source },
      { f: 'done', t: 'backlog', s: 'user' });
  });

  await check('done -> playing -> done produces TWO done events', async () => {
    await lib.setStatus(uid, 'igdb_1', 'done');
    await lib.setStatus(uid, 'igdb_1', 'playing');
    await lib.setStatus(uid, 'igdb_1', 'done');
    const e = await events(uid);
    const dones = e.filter((x) => x.to_status === 'done');
    assert.strictEqual(dones.length, 3, `a replayed game must log each completion, got ${dones.length}`);
  });

  console.log('\nthe release sweep must NOT look like the user:');
  await check('promoteReleased logs source=release_sweep', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_2', gameName: 'B', releaseDate: iso(30), status: 'wishlist' });
    const before = (await events(uid)).length;
    const r = await lib.promoteReleased('evtest', 'igdb_2');
    assert.strictEqual(r.promoted, true, 'promoteReleased reported no move');
    const e = await events(uid);
    assert.strictEqual(e.length, before + 1);
    assert.deepStrictEqual({ f: e.at(-1).from_status, t: e.at(-1).to_status, s: e.at(-1).source },
      { f: 'unreleased', t: 'wishlist', s: 'release_sweep' });
  });

  await check('promoting an ALREADY-promoted game logs nothing and reports false', async () => {
    const before = (await events(uid)).length;
    const r = await lib.promoteReleased('evtest', 'igdb_2');
    assert.strictEqual(r.promoted, false, 'a second sweep claimed it moved a row');
    assert.strictEqual((await events(uid)).length, before, 'a no-op sweep wrote an event');
  });

  console.log('\nthe data-loss bug, end to end:');
  await check('a provider pushing the date forward does NOT demote a finished game', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_3', gameName: 'C', releaseDate: iso(-100), status: 'done' });
    const row = await lib.findGame(uid, 'igdb_3');
    assert.strictEqual(row.status, 'done', 'setup failed: game is not done');
    // A delay/re-release/bad record moves the date into the future.
    await lib.applyRefreshedMetadata(uid, row, { releaseDate: iso(400) });
    const after = await lib.findGame(uid, 'igdb_3');
    assert.strictEqual(after.status, 'done',
      `a refresh demoted a finished game to '${after.status}' — the bug is back`);
  });

  await check('a refresh DOES still move the unreleased/wishlist pair, source=metadata_refresh', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_4', gameName: 'D', releaseDate: iso(30), status: 'wishlist' });
    const row = await lib.findGame(uid, 'igdb_4');
    assert.strictEqual(row.status, 'unreleased', 'setup: a future date should store unreleased');
    const before = (await events(uid)).length;
    await lib.applyRefreshedMetadata(uid, row, { releaseDate: iso(-5) });
    const e = await events(uid);
    assert.strictEqual(e.length, before + 1, 'the refresh logged no event');
    assert.deepStrictEqual({ f: e.at(-1).from_status, t: e.at(-1).to_status, s: e.at(-1).source },
      { f: 'unreleased', t: 'wishlist', s: 'metadata_refresh' });
  });

  console.log('\nwhat the statistics page will actually count:');
  await check('filtering source=user excludes every system transition', async () => {
    const all = await events(uid);
    const user = all.filter((e) => e.source === 'user');
    const system = all.filter((e) => e.source !== 'user');
    assert.ok(system.length >= 2, 'expected system events in the fixture');
    assert.ok(user.every((e) => e.source === 'user'));
    console.log(`      ${all.length} events total: ${user.length} user, ${system.length} system`);
    // 4, not 3: three from igdb_1's replay, plus ONE from igdb_3 being ADDED directly
    // as 'done' (NULL -> done). That is a real completion the user stated, on the date
    // they stated it, and it counts. Pinned because it is the non-obvious case — a
    // naive reading expects only setStatus transitions to register.
    const finished = user.filter((e) => e.to_status === 'done').length;
    assert.strictEqual(finished, 4, `finished-count should be 4, got ${finished}`);
  });

  await check('deleting the game keeps its history; deleting the account removes it', async () => {
    await lib.removeGame(uid, 'igdb_1');
    assert.ok((await events(uid)).length > 0, 'removing a game destroyed its history');
    await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);
    assert.strictEqual((await events(uid)).length, 0, 'deleting the account left history behind');
  });

  // ---- Concurrency: the read that decides a status, and the write, must be one ----
  // (ROADMAP CC-1, CC-2.) A separate account so the counts above are untouched.
  console.log('\nconcurrent writers (CC-1, CC-2):');
  await db.promises.run("DELETE FROM users WHERE username = 'evrace'");
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('evrace','x',0,'now','local')");
  const rid = (await db.promises.get("SELECT id FROM users WHERE username='evrace'")).id;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const statusOf = async (gid) => (await db.promises.get(
    'SELECT status FROM user_games WHERE user_id = ? AND game_id = ?', [rid, gid])).status;

  await check('setStatus records the status the row HAD when it changed, not an earlier read', async () => {
    // Another transaction holds the row and moves it wishlist -> playing. setStatus
    // starts while that is uncommitted. It used to read the row BEFORE its own
    // transaction, see `wishlist`, and log `wishlist -> done` -- a transition that
    // never happened, written permanently into history.
    await lib.upsertGame(rid, { gameId: 'igdb_r1', gameName: 'R1', releaseDate: iso(-10), status: 'wishlist' });
    let release;
    const gate = new Promise((r) => { release = r; });
    const other = db.withTransaction(async (tx) => {
      await tx.query("SELECT 1 FROM user_games WHERE user_id = ? AND game_id = 'igdb_r1' FOR UPDATE", [rid]);
      await tx.query("UPDATE user_games SET status = 'playing' WHERE user_id = ? AND game_id = 'igdb_r1'", [rid]);
      await gate;
    });
    await sleep(100);
    const pending = lib.setStatus(rid, 'igdb_r1', 'done');
    await sleep(200);
    release();
    await other;
    await pending;
    const last = (await events(rid)).filter((e) => e.game_id === 'igdb_r1').pop();
    assert.deepStrictEqual({ f: last.from_status, t: last.to_status }, { f: 'playing', t: 'done' },
      `logged ${last.from_status} -> ${last.to_status}`);
  });

  await check('setStatus on a game removed meanwhile is NOT_FOUND and writes no event', async () => {
    // A REAL interleaving: another transaction holds the row and deletes it while
    // setStatus is already running. The old code had read the row first, so it went on
    // to an UPDATE matching nothing and STILL inserted an event for a game that no
    // longer existed, returning game: undefined.
    await lib.upsertGame(rid, { gameId: 'igdb_r2', gameName: 'R2', releaseDate: iso(-10), status: 'wishlist' });
    const before = (await events(rid)).length;
    let release;
    const gate = new Promise((r) => { release = r; });
    const other = db.withTransaction(async (tx) => {
      await tx.query("SELECT 1 FROM user_games WHERE user_id = ? AND game_id = 'igdb_r2' FOR UPDATE", [rid]);
      await tx.query("DELETE FROM user_games WHERE user_id = ? AND game_id = 'igdb_r2'", [rid]);
      await gate;
    });
    await sleep(100);
    let code = null;
    const pending = lib.setStatus(rid, 'igdb_r2', 'done').catch((e) => { code = e.code; });
    await sleep(200);
    release();
    await other;
    await pending;
    assert.strictEqual(code, 'not_found');
    assert.strictEqual((await events(rid)).length, before, 'an event was written for a game that no longer exists');
  });

  await check('a metadata refresh never overwrites a status set after its snapshot', async () => {
    // The bulk refresh snapshots the library at the start of a minutes-long sweep.
    // Here: snapshot says wishlist, the user then moves the game to playing, and the
    // provider reports a later (future) date. The date may update; the status may not.
    await lib.upsertGame(rid, { gameId: 'igdb_r3', gameName: 'R3', releaseDate: iso(-10), status: 'wishlist' });
    const snapshot = await db.promises.get(
      "SELECT * FROM user_games WHERE user_id = ? AND game_id = 'igdb_r3'", [rid]);
    await lib.setStatus(rid, 'igdb_r3', 'playing');
    const before = (await events(rid)).length;
    const r = await lib.applyRefreshedMetadata(rid, snapshot, { releaseDate: iso(60) });
    assert.strictEqual(await statusOf('igdb_r3'), 'playing', 'the refresh overwrote a status the user had just set');
    assert.ok(r.changes.includes('release_date') && !r.changes.includes('status'), JSON.stringify(r.changes));
    const after = await events(rid);
    assert.strictEqual(after.length, before, `the refresh logged ${JSON.stringify(after[after.length - 1])}`);
  });

  await check('...and still re-syncs the date-derived pair when the row really is wishlist', async () => {
    // The control: without it the test above passes for a refresh that never moves status.
    await lib.upsertGame(rid, { gameId: 'igdb_r4', gameName: 'R4', releaseDate: iso(-10), status: 'wishlist' });
    const snapshot = await db.promises.get(
      "SELECT * FROM user_games WHERE user_id = ? AND game_id = 'igdb_r4'", [rid]);
    await lib.applyRefreshedMetadata(rid, snapshot, { releaseDate: iso(60) });
    assert.strictEqual(await statusOf('igdb_r4'), 'unreleased');
    const last = (await events(rid)).pop();
    assert.deepStrictEqual({ f: last.from_status, t: last.to_status, s: last.source },
      { f: 'wishlist', t: 'unreleased', s: 'metadata_refresh' });
  });
  await check('a backlog move waiting on a reorder uses the positions AFTER it (CC-10)', async () => {
    // A reorder holds the backlog lock and rewrites A,B,C = 1,2,3 to 3,2,1. A move of
    // A "down" starts meanwhile. It used to read positions BEFORE the lock (A=1, B=2),
    // then swap those stale values in: A=2, B=1 -- and C also 1. Two games on one slot.
    for (const [g, n] of [['igdb_b1', 'A'], ['igdb_b2', 'B'], ['igdb_b3', 'C']]) {
      await lib.upsertGame(rid, { gameId: g, gameName: n, releaseDate: iso(-10), status: 'backlog' });
    }
    await lib.reorderBacklog(rid, ['igdb_b1', 'igdb_b2', 'igdb_b3']);
    let release;
    const gate = new Promise((r) => { release = r; });
    const other = db.withTransaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(?, ?)', [db.LOCKS.BACKLOG_ORDER, rid]);
      for (const [g, pos] of [['igdb_b1', 3], ['igdb_b2', 2], ['igdb_b3', 1]]) {
        await tx.query('UPDATE user_games SET backlog_order = ? WHERE user_id = ? AND game_id = ?', [pos, rid, g]);
      }
      await gate;
    });
    await sleep(100);
    const pending = lib.moveBacklogItem(rid, 'igdb_b1', 'down');
    await sleep(200);
    release();
    await other;
    await pending;
    const rows = await db.promises.all(
      "SELECT game_id, backlog_order FROM user_games WHERE user_id = ? AND status = 'backlog'", [rid]);
    const orders = rows.map((r) => r.backlog_order);
    assert.strictEqual(new Set(orders).size, orders.length, `duplicate backlog positions: ${JSON.stringify(rows)}`);
  });
  await db.promises.run('DELETE FROM users WHERE id = ?', [rid]);

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
