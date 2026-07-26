// A user's game library (`user_games`).
//
// Promise-based, no req/res. See services/shares.js for why the service layer
// exists at all.
//
// Reminders that bite every query in this file:
//   * `game_id` is TEXT — 'igdb_12345', never a number. Never coerce or compare it
//     numerically, and never let it reach an OpenAPI schema as `integer`.
//   * A SELECT with no ORDER BY has no stable order in Postgres, and an UPDATE
//     physically moves the row. Invisible while every read is unpaginated; it
//     produces duplicated and missing rows the moment one is paged. Order
//     explicitly, and tie-break on `id`.

const db = require('../db');

const norm = (v) => (v ? String(v).toLowerCase() : '');

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

// Every game row for a user, by username.
//
// An unknown user is an empty library, never a reason to provision an account —
// this once called getOrCreateUser and did exactly that. Orphaned share rows make
// that a live case: user_shares' foreign keys went unenforced under SQLite, so a
// share may name an account that no longer exists.
//
// NOTE: deliberately unordered, preserving the existing v1 response. The callers
// (the cron sweep and the shared-library view) do not rely on order, and the two
// frontends re-sort client-side. v2's library endpoint will order explicitly.
async function listGamesFor(username) {
  return all(
    'SELECT ug.* FROM user_games ug JOIN users u ON u.id = ug.user_id WHERE u.username = ?',
    [norm(username)]
  );
}

module.exports = { listGamesFor };
