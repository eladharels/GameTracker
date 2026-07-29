// services/stats.js against a REAL Postgres. Run by the smoke-test job inside the
// backend container; NOT part of `npm test`.
//
// The pairing logic is why this cannot be a unit test. "How long did that take" is a
// correlated subquery picking the most recent `playing` BEFORE each `done`, and the
// case it exists for — a game finished, replayed and finished again — is a property of
// what Postgres returns, not of any JavaScript this file could stub. A test that
// asserted the SQL string would pass on a query that produces the wrong rows.

const assert = require('assert');
const db = require('../../db');
const lib = require('../../services/library');
const stats = require('../../services/stats');

let n = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); n++; console.log('  ok  ' + label); }
  catch (e) { n++; failed++; console.log('  FAIL ' + label + ' -> ' + e.message); }
}

// changed_at defaults to now(), so ordering is controlled by moving rows afterwards.
const shift = (userId, gameId, toStatus, daysAgo) => db.promises.run(
  `UPDATE user_game_status_events SET changed_at = now() - (? || ' days')::interval
    WHERE id = (SELECT MAX(id) FROM user_game_status_events
                 WHERE user_id = ? AND game_id = ? AND to_status = ?)`,
  [String(daysAgo), userId, gameId, toStatus]);

(async () => {
  await db.promises.run("DELETE FROM users WHERE username = 'statstest'");
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('statstest','x',0,'now','local')");
  const { id: uid } = await db.promises.get("SELECT id FROM users WHERE username='statstest'");
  const past = '2020-01-01';

  await check('an empty log reports zero coverage, not a fabricated start date', async () => {
    const s = await stats.summary(uid);
    assert.strictEqual(s.trackingSince, null, 'invented a tracking start with no events');
    assert.deepStrictEqual(s.completions, []);
    assert.deepStrictEqual(s.durations, []);
    assert.strictEqual(s.coverage.recordedCompletions, 0);
  });

  // One game played straight through.
  await lib.upsertGame(uid, { gameId: 'igdb_a', gameName: 'Alpha', releaseDate: past, status: 'wishlist' });
  await lib.setStatus(uid, 'igdb_a', 'playing');
  await shift(uid, 'igdb_a', 'playing', 20);
  await lib.setStatus(uid, 'igdb_a', 'done');
  await shift(uid, 'igdb_a', 'done', 5);

  await check('a finished game reports a duration from playing -> done', async () => {
    const s = await stats.summary(uid);
    assert.strictEqual(s.durations.length, 1, `expected 1 duration, got ${s.durations.length}`);
    assert.strictEqual(s.durations[0].name, 'Alpha');
    assert.strictEqual(s.durations[0].days, 15, `expected 15 days, got ${s.durations[0].days}`);
  });

  // The case the correlated MAX exists for: replayed and finished again.
  await lib.setStatus(uid, 'igdb_a', 'playing');
  await shift(uid, 'igdb_a', 'playing', 3);
  await lib.setStatus(uid, 'igdb_a', 'done');

  await check('a REPLAYED game pairs each done with the playing that preceded IT', async () => {
    const s = await stats.summary(uid);
    assert.strictEqual(s.durations.length, 2, `expected 2 durations, got ${s.durations.length}`);
    const [first, second] = s.durations;
    assert.strictEqual(first.days, 15, 'the first run changed');
    // Second run: playing 3 days ago -> done now. NOT 20 days, which is what pairing
    // against the earliest `playing` would give.
    assert.ok(second.days >= 2.9 && second.days <= 3.1,
      `second run should be ~3 days, got ${second.days} — it paired with the wrong start`);
  });

  await check('a done with no preceding playing is DROPPED, not guessed from added_at', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_b', gameName: 'Beta', releaseDate: past, status: 'done' });
    const s = await stats.summary(uid);
    assert.strictEqual(s.completions.length, 3, 'the completion itself should still count');
    assert.strictEqual(s.durations.length, 2, 'a duration was invented for a game never marked playing');
  });

  await check('the release sweep does NOT appear as a completion', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_c', gameName: 'Gamma', releaseDate: '2099-01-01', status: 'wishlist' });
    await db.promises.run(
      `INSERT INTO user_game_status_events (user_id, game_id, from_status, to_status, source)
       VALUES (?, 'igdb_c', 'unreleased', 'done', 'release_sweep')`, [uid]);
    const s = await stats.summary(uid);
    assert.strictEqual(s.completions.length, 3,
      'a release_sweep event was counted as the user finishing a game');
    assert.ok(s.coverage.totalEvents > s.coverage.userEvents,
      'system events should still be counted in the total, for provenance');
  });

  await check('removing a game KEEPS its completion, with a null name', async () => {
    await lib.removeGame(uid, 'igdb_b');
    const s = await stats.summary(uid);
    assert.strictEqual(s.completions.length, 3, 'tidying the library destroyed a completion');
    const orphan = s.completions.find((c) => c.gameId === 'igdb_b');
    assert.ok(orphan, 'the removed game vanished from history');
    assert.strictEqual(orphan.name, null, 'expected a null name for a removed game');
  });

  await check('another user\'s completions are NEVER visible', async () => {
    // stats.js calls `WHERE user_id = ?` "the entire authorization boundary" and
    // nothing asserted it. Dropping that predicate from completions(), durations() or
    // the libraryDone count would show one account another's history with CI green —
    // the LEFT JOINs carry the user predicate too, so this covers those as well.
    await db.promises.run("DELETE FROM users WHERE username = 'statsother'");
    await db.promises.run(
      "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('statsother','x',0,'now','local')");
    const other = await db.promises.get("SELECT id FROM users WHERE username='statsother'");
    await lib.upsertGame(other.id, { gameId: 'igdb_zz', gameName: 'NotYours', releaseDate: past, status: 'wishlist' });
    await lib.setStatus(other.id, 'igdb_zz', 'playing');
    await lib.setStatus(other.id, 'igdb_zz', 'done');

    const mine = await stats.summary(uid);
    assert.ok(!mine.completions.some((c) => c.gameId === 'igdb_zz'),
      "another account's completion appeared in this user's statistics");
    assert.ok(!mine.durations.some((d) => d.gameId === 'igdb_zz'),
      "another account's duration appeared in this user's statistics");
    assert.ok(!mine.completions.some((c) => c.name === 'NotYours'),
      "another account's game_name leaked through the LEFT JOIN");

    const theirs = await stats.summary(other.id);
    assert.strictEqual(theirs.completions.length, 1, 'the other user should see exactly their own');
    assert.strictEqual(theirs.coverage.libraryDone, 1, 'libraryDone counted across accounts');
    await db.promises.run('DELETE FROM users WHERE id = ?', [other.id]);
  });

  await check('a duration ignores a non-user `playing` between start and finish', async () => {
    // durations() filters p.source = 'user' on the inner scan. Without it a
    // metadata_refresh landing between a real start and the finish would be picked as
    // the start and report a much shorter time than the user actually spent.
    await lib.upsertGame(uid, { gameId: 'igdb_src', gameName: 'Src', releaseDate: past, status: 'wishlist' });
    await lib.setStatus(uid, 'igdb_src', 'playing');
    await shift(uid, 'igdb_src', 'playing', 10);
    await db.promises.run(
      `INSERT INTO user_game_status_events (user_id, game_id, from_status, to_status, source, changed_at)
       VALUES (?, 'igdb_src', 'playing', 'playing', 'metadata_refresh', now() - interval '1 day')`, [uid]);
    await lib.setStatus(uid, 'igdb_src', 'done');
    const s = await stats.summary(uid);
    const d = s.durations.find((x) => x.gameId === 'igdb_src');
    assert.ok(d, 'no duration recorded for the game');
    assert.ok(d.days >= 9.5, `paired with a non-user event: got ${d.days} days, expected ~10`);
  });

  await check('coverage states what the log does NOT know', async () => {
    const s = await stats.summary(uid);
    assert.ok(typeof s.coverage.libraryDone === 'number');
    assert.ok(typeof s.coverage.recordedCompletions === 'number');
    assert.ok(s.trackingSince, 'trackingSince missing once events exist');
    assert.ok(!Number.isNaN(Date.parse(s.trackingSince)), 'trackingSince is not a valid ISO date');
  });

  await check('counts are NUMBERS, not the strings Postgres returns for bigint', async () => {
    const s = await stats.summary(uid);
    // `truncated` is a boolean by design; every other coverage field is a count and
    // must be a NUMBER. Postgres returns bigint as a string (db.js divergence #8), so a
    // dropped ::int cast turns `3 + 4` into '34' on the page.
    for (const [k, v] of Object.entries(s.coverage)) {
      const expected = k === 'truncated' ? 'boolean' : 'number';
      assert.strictEqual(typeof v, expected,
        `coverage.${k} is ${typeof v}, expected ${expected}` +
        (expected === 'number' ? ' — the ::int cast is missing' : ''));
    }
    assert.strictEqual(s.coverage.truncated, false, 'a small fixture reported as truncated');
  });

  await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);
  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
