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

  await check('coverage states what the log does NOT know', async () => {
    const s = await stats.summary(uid);
    assert.ok(typeof s.coverage.libraryDone === 'number');
    assert.ok(typeof s.coverage.recordedCompletions === 'number');
    assert.ok(s.trackingSince, 'trackingSince missing once events exist');
    assert.ok(!Number.isNaN(Date.parse(s.trackingSince)), 'trackingSince is not a valid ISO date');
  });

  await check('counts are NUMBERS, not the strings Postgres returns for bigint', async () => {
    const s = await stats.summary(uid);
    for (const [k, v] of Object.entries(s.coverage)) {
      assert.strictEqual(typeof v, 'number', `coverage.${k} is ${typeof v} — the ::int cast is missing`);
    }
  });

  await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);
  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
