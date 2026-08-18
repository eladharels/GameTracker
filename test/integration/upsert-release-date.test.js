// D7 — which release date decides a stored status. Needs a REAL Postgres, and is run by
// the smoke-test job inside the backend container. NOT part of `npm test`.
//
// WHY THIS CANNOT BE A UNIT TEST, given test/helpers.test.js already covers the rule.
// The fix has two halves and they fail independently:
//
//   1. the DECISION — status derived from effectiveReleaseDate rather than the request.
//      A unit test with a stubbed transaction sees this, because it is visible in the
//      parameters bound to the INSERT.
//   2. the WRITE — `release_date=excluded.release_date` in the ON CONFLICT DO UPDATE
//      list. A stubbed transaction CANNOT see this. The bound parameter is identical
//      whether or not that clause exists; only a database decides what the row ends up
//      holding. Delete the clause and every unit assertion still passes while a game
//      stored before its date was known stays pinned to 'unreleased' forever.
//
// So the unit suite proves the rule and this proves the rule reaches the row. The
// second half is the one nobody would notice was missing.
//
// THE BUG, reproduced here in full because the sequence is the point rather than any
// single assertion:
//
//   POST {gameId, gameName, status:'done'}          -- no releaseDate, as a script sends
//     -> validReleaseDate(undefined) is null
//     -> isReleased(null) is false
//     -> row written 'unreleased', while release_date KEEPS its value (the column was
//        not in the DO UPDATE list)
//   POST {..., releaseDate:'2020-12-10', status:'done'}   -- the next correct write
//     -> prior status is now 'unreleased'
//     -> decideEvents emits RELEASED
//     -> "Cyberpunk 2077 has been released!" to four channels, in 2026
//
// And the part that outlives the notification: both writes land rows in
// user_game_status_events with source='user' — a playing->unreleased demotion nobody
// performed, and an unreleased->done "completion" on the wrong date. The statistics page
// counts exactly those. Unrecorded history cannot be backfilled and neither can false
// history be told from true afterwards, which is why this has a CI slot.
//
// Connection comes from the PG* environment, same as db.js.
const assert = require('assert');
const db = require('../../db');
const lib = require('../../services/library');

let n = 0, failed = 0;
const ok = (label) => { n++; console.log('  ok  ' + label); };
const fail = (label, e) => { failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
async function check(label, fn) { try { await fn(); ok(label); } catch (e) { fail(label, e); } }

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  await db.promises.run("DELETE FROM users WHERE username = 'd7test'");
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('d7test','x',0,'now','local')");
  const { id: uid } = await db.promises.get("SELECT id FROM users WHERE username='d7test'");

  const row = (gameId) => db.promises.get(
    'SELECT status, release_date FROM user_games WHERE user_id = ? AND game_id = ?', [uid, gameId]);
  const events = () => db.promises.all(
    'SELECT from_status, to_status, source FROM user_game_status_events WHERE user_id = ? ORDER BY id', [uid]);

  console.log('\nD7 — a request that omits the release date:');

  await check('the stored status is not demoted, and the stored date is not lost', async () => {
    await lib.upsertGame(uid, {
      gameId: 'igdb_d7', gameName: 'Cyberpunk 2077', releaseDate: '2020-12-10', status: 'playing' });

    const result = await lib.upsertGame(uid, {
      gameId: 'igdb_d7', gameName: 'Cyberpunk 2077', status: 'done' });   // no releaseDate

    const r = await row('igdb_d7');
    assert.strictEqual(r.status, 'done',
      `omitting the date demoted the game to '${r.status}' — D7 is back`);
    assert.strictEqual(r.release_date, '2020-12-10', 'the stored release date was lost');
    assert.strictEqual(result.coerced, false, 'a coercion was reported for a released game');
    // The incoherent row D7 produced, asserted directly: no coherent input to this file
    // can write a past release_date next to 'unreleased', so its existence IS the bug.
    assert.ok(!(r.status === 'unreleased' && lib.isReleased(r.release_date)),
      'the row holds a past release date next to status=unreleased');
  });

  await check('the next correct write does NOT announce a six-year-old game', async () => {
    const result = await lib.upsertGame(uid, {
      gameId: 'igdb_d7', gameName: 'Cyberpunk 2077', releaseDate: '2020-12-10', status: 'done' });
    assert.ok(!result.events.includes(lib.EVENTS.RELEASED),
      'a "has been released!" notification fired for a game released in 2020');
  });

  await check('and no false history was written for either', async () => {
    // Before the fix this read [null->playing, playing->unreleased, unreleased->done]:
    // two of the three invented, both source='user', both counted by the statistics page.
    const e = await events();
    assert.deepStrictEqual(
      e.map((x) => `${x.from_status}->${x.to_status}`),
      ['null->playing', 'playing->done'],
      'the event log records a transition nobody performed');
    assert.ok(e.every((x) => x.source === 'user'), 'source is no longer user');
  });

  console.log('\nthe same disagreement from the other side:');

  await check('a row stored WITHOUT a date is filled by the request', async () => {
    // THE HALF ONLY A DATABASE CAN SEE. This is the ON CONFLICT DO UPDATE clause: the
    // parameter bound to release_date is '2001-11-15' either way, and only the row
    // afterwards says whether the clause was there.
    await db.promises.run(
      "INSERT INTO user_games (user_id, game_id, game_name, status) VALUES (?, 'igdb_nodate', 'Halo', 'unreleased')",
      [uid]);

    await lib.upsertGame(uid, {
      gameId: 'igdb_nodate', gameName: 'Halo', releaseDate: '2001-11-15', status: 'playing' });

    const r = await row('igdb_nodate');
    assert.strictEqual(r.release_date, '2001-11-15',
      'the DO UPDATE no longer writes release_date, so a dateless row is pinned to unreleased');
    assert.strictEqual(r.status, 'playing');
  });

  await check('a stored date is never overwritten by a client', async () => {
    // The reason writing release_date at all is safe: the value bound IS the stored one
    // whenever there is one, so the clause can only ever fill.
    await lib.upsertGame(uid, {
      gameId: 'igdb_d7', gameName: 'Cyberpunk 2077', releaseDate: '1999-09-09', status: 'done' });
    assert.strictEqual((await row('igdb_d7')).release_date, '2020-12-10',
      'a client rewrote the row\'s release date');
  });

  console.log('\nthe control this path exists to enforce still fires:');

  await check('a future-dated game is still coerced to unreleased', async () => {
    const result = await lib.upsertGame(uid, {
      gameId: 'igdb_future', gameName: 'Half-Life 3', releaseDate: iso(30), status: 'playing' });
    assert.strictEqual((await row('igdb_future')).status, 'unreleased');
    assert.strictEqual(result.coerced, true, 'the coercion stopped being reported');
  });

  await check('a future-dated game already stored stays coerced when the date is omitted', async () => {
    // The mirror of the first case: reading the STORED date has to be able to say no,
    // not only yes, or the fix would just be "trust the caller" wearing a new name.
    const result = await lib.upsertGame(uid, {
      gameId: 'igdb_future', gameName: 'Half-Life 3', status: 'done' });
    assert.strictEqual((await row('igdb_future')).status, 'unreleased');
    assert.strictEqual(result.coerced, true);
  });

  await check('an unparseable date is still never written', async () => {
    await lib.upsertGame(uid, {
      gameId: 'igdb_junk', gameName: 'Junk', releaseDate: 'not-a-date', status: 'done' });
    const r = await row('igdb_junk');
    assert.strictEqual(r.release_date, null, 'an unparseable date reached the column');
    assert.strictEqual(r.status, 'unreleased');
  });

  await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
