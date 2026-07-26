// A user's game library (`user_games`).
//
// Promise-based, no req/res. See services/shares.js for why the service layer
// exists at all.
//
// Reminders that bite every query in this file:
//   * `game_id` is TEXT — 'igdb_12345', never a number. Never coerce or compare it
//     numerically, and never let it reach an OpenAPI schema as `integer`. Compare
//     with String() on both sides, as the backlog lookup below does.
//   * A SELECT with no ORDER BY has no stable order in Postgres, and an UPDATE
//     physically moves the row to the end. Invisible while every read is
//     unpaginated; it produces duplicated and missing rows the moment one is paged.
//   * `backlog_order` may be NULL on rows predating the column. Postgres sorts NULL
//     LAST on ASC where SQLite sorted it FIRST, so ordered reads must say
//     NULLS FIRST explicitly or those rows silently jump to the bottom.

const db = require('../db');
const { serviceError, CODES } = require('./errors');

const norm = (v) => (v ? String(v).toLowerCase() : '');

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
});

// Every game row for a user, by username.
//
// An unknown user is an empty library, never a reason to provision an account —
// this once called getOrCreateUser and did exactly that. Orphaned share rows make
// that a live case: user_shares' foreign keys went unenforced under SQLite, so a
// share may name an account that no longer exists.
//
// NOTE: deliberately unordered, preserving the existing v1 response. The callers
// (the cron sweep and the shared-library view) do not rely on order, and both
// frontends re-sort client-side. v2's library endpoint will order explicitly.
async function listGamesFor(username) {
  return all(
    'SELECT ug.* FROM user_games ug JOIN users u ON u.id = ug.user_id WHERE u.username = ?',
    [norm(username)]
  );
}

// Trimmed projection for the authenticated user's own library, by user id.
async function listOwnGames(userId) {
  return all(
    `SELECT game_id, game_name, cover_url, release_date, status
       FROM user_games
      WHERE user_id = ?
      ORDER BY game_name ASC`,
    [userId]
  );
}

// Full rows for a user id, plus the two camelCase aliases the current API emits
// alongside their snake_case originals.
//
// The duplication is intentional here and ONLY here: it is v1's published shape and
// the SPA reads both spellings. v2 emits camelCase once, from a single mapper.
async function listGamesWithAliases(userId) {
  const rows = await all('SELECT * FROM user_games WHERE user_id = ?', [userId]);
  return rows.map((row) => ({
    ...row,
    steamAppId: row.steam_app_id || null,
    crackStatus: row.crack_status || null,
  }));
}

// Remove one game. `removed` reports whether a row actually went; v1 reports success
// either way, so the adapter ignores it. v2 should not.
async function removeGame(userId, gameId) {
  const ctx = await run(
    'DELETE FROM user_games WHERE user_id = ? AND game_id = ?',
    [userId, String(gameId)]
  );
  return { removed: ctx.changes };
}

// The backlog, in display order.
async function listBacklog(userId) {
  return all(
    'SELECT id, game_id, backlog_order FROM user_games WHERE user_id = ? AND status = ? ORDER BY backlog_order ASC NULLS FIRST, id ASC',
    [userId, 'backlog']
  );
}

// Move one game up or down one place in the backlog, swapping positions with its
// neighbour. Returns { moved: false } at a boundary — v1 reports success for that,
// making a no-op indistinguishable from a move, which v2 should fix.
//
// Throws NOT_IN_BACKLOG (as a plain code on the error) when the game is not there.
//
// TRANSACTIONAL, unlike v1. It previously issued two sequential UPDATEs through the
// shim, which db.js divergence #9 says run on DIFFERENT pooled connections and
// therefore cannot be rolled back together: a failure between them left two games
// holding the same backlog_order. The success path is unchanged; only the failure
// path is now all-or-nothing.
async function moveBacklogItem(userId, gameId, direction) {
  const rows = await listBacklog(userId);
  const idx = rows.findIndex((r) => String(r.game_id) === String(gameId));
  if (idx === -1) {
    throw serviceError(CODES.NOT_IN_BACKLOG, 'Game not in backlog');
  }
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return { moved: false };

  const game = rows[idx];
  const swap = rows[swapIdx];
  await db.withTransaction(async (tx) => {
    await tx.query('UPDATE user_games SET backlog_order = ? WHERE id = ?', [swap.backlog_order, game.id]);
    await tx.query('UPDATE user_games SET backlog_order = ? WHERE id = ?', [game.backlog_order, swap.id]);
  });
  return { moved: true };
}

// Replace the backlog order wholesale from an ordered list of game ids.
//
// TRANSACTIONAL, unlike v1. It previously dispatched one fire-and-forget db.run per
// element inside a forEach and replied once a counter reached the array length —
// so a partial failure returned 500 over a HALF-APPLIED order that stayed on disk,
// and per db.js divergence #6 the writes were not even ordered with respect to one
// another. All-or-nothing now.
//
// Ids not in the user's library match nothing and are silently ignored, as before;
// `updated` reports how many rows actually moved so a caller can notice.
async function reorderBacklog(userId, order) {
  let updated = 0;
  await db.withTransaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      const result = await tx.query(
        'UPDATE user_games SET backlog_order = ? WHERE user_id = ? AND game_id = ?',
        [i + 1, userId, String(order[i])]
      );
      updated += result.rowCount;
    }
  });
  return { updated, requested: order.length };
}

module.exports = {
  listGamesFor,
  listOwnGames,
  listGamesWithAliases,
  removeGame,
  listBacklog,
  moveBacklogItem,
  reorderBacklog,
};
