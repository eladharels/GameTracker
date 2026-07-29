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
const fail = (label, e) => { failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
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

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
