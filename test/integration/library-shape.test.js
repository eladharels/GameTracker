// The v1 library row as it ACTUALLY leaves the database. Needs a REAL Postgres; run by the
// smoke-test job inside the backend container. NOT part of `npm test`.
//
// WHY NOT A UNIT TEST: listGamesWithAliases is `SELECT *` plus two aliases. The unit pin in
// api-contract.test.js runs withAliases over a hand-built row, so it cannot see a column a
// migration adds -- which is exactly how `added_at` joined the frozen v1 response without
// anyone deciding it (CLAUDE.md, "SELECT * feeds the frozen v1 library response"). The
// Android app deserialises this row, so its key set is pinned here against a real one.
const assert = require('assert');
const db = require('../../db');
const lib = require('../../services/library');
const { LIBRARY_ROW_WIRE_KEYS } = require('../v1-shapes');

let n = 0, failed = 0;
async function check(label, fn) {
  n++;
  try { await fn(); console.log('  ok  ' + label); } catch (e) { failed++; console.log('  FAIL ' + label + ' -> ' + e.message); }
}

(async () => {
  await db.promises.run("DELETE FROM users WHERE username = 'shapetest'");
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin) VALUES ('shapetest','x',0,'now','local')");
  const { id: uid } = await db.promises.get("SELECT id FROM users WHERE username='shapetest'");

  await check('a real library row carries EXACTLY the published v1 keys', async () => {
    await lib.upsertGame(uid, { gameId: 'igdb_shape1', gameName: 'Shape', status: 'wishlist', releaseDate: '2020-01-01', steamAppId: '440' });
    const rows = await lib.listGamesWithAliases(uid);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), [...LIBRARY_ROW_WIRE_KEYS].sort(),
      'the real row\'s keys changed: a user_games column was added or removed. That is a change to the frozen '
      + 'v1 response the Android app reads -- decide it, then update test/v1-shapes.js');
  });
  await check('game_id is a string, and the aliases carry the originals', async () => {
    const [row] = await lib.listGamesWithAliases(uid);
    assert.strictEqual(typeof row.game_id, 'string');
    assert.strictEqual(row.steamAppId, row.steam_app_id);
    assert.strictEqual(row.crackStatus, row.crack_status);
  });

  await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);
  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
