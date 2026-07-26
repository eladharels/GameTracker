// Library sharing.
//
// First slice of the service-layer extraction. Promise-based, no req/res, no HTTP
// status codes — the route adapters in index.js translate. This is what allows the
// current /api routes and the coming /api/v2 routes to be two thin skins over ONE
// implementation; without it the two surfaces drift apart the first time either
// gains a rule the other lacks.
//
// AUTHORIZATION IS NOT DONE HERE. The sharing routes are self-only (no admin
// bypass, unlike every other /api/user/:username/* route) and that check stays in
// the adapter, next to req.user, where test/api-surface.test.js can see it.

const db = require('../db');
const { serviceError, CODES } = require('./errors');
// One implementation of "this user's games" — see services/library.js.
const libraryService = require('./library');

const norm = (v) => (v ? String(v).toLowerCase() : '');

// Promise wrappers over the node-sqlite3-shaped callback shim. New code should
// prefer db.query(); these exist so this module reads as one style throughout.
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
});

// Usernames this user shares their library WITH.
async function listOutgoing(fromUser) {
  const rows = await all('SELECT to_user FROM user_shares WHERE from_user = ? ORDER BY to_user ASC', [norm(fromUser)]);
  return rows.map((r) => r.to_user);
}

// Who shares their library with this user.
async function listIncoming(toUser) {
  return all(
    'SELECT from_user, shared_at FROM user_shares WHERE to_user = ? ORDER BY from_user ASC',
    [norm(toUser)]
  );
}

// Replace the whole outgoing share list, atomically.
//
// Throws UNKNOWN_USERS listing exactly which recipients do not exist. Postgres now
// enforces the foreign keys for real, so without this pre-check an unknown recipient
// would surface as a bare constraint violation instead of a usable message.
async function replaceOutgoing(fromUser, toUsers) {
  const owner = norm(fromUser);
  if (!Array.isArray(toUsers)) {
    throw serviceError(CODES.VALIDATION, 'toUsers must be an array.');
  }

  // Usernames are stored lowercase and every lookup compares lowercase, so a
  // mixed-case entry would be written and then never match — a share the user sees
  // as active that silently does nothing. Normalise, drop blanks and self-shares,
  // de-duplicate, before touching the table.
  const requested = [...new Set(
    toUsers
      .filter((u) => typeof u === 'string')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u && u !== owner)
  )];

  let existing = [];
  if (requested.length) {
    // Placeholders are GENERATED, never interpolated values — the one safe form of
    // dynamic SQL through the ?-to-$n shim, whose arity guard throws rather than
    // mis-binding if the counts ever diverge.
    const placeholders = requested.map(() => '?').join(',');
    const rows = await all(`SELECT username FROM users WHERE username IN (${placeholders})`, requested);
    existing = rows.map((r) => r.username);
    const unknown = requested.filter((u) => !existing.includes(u));
    if (unknown.length) {
      throw serviceError(CODES.UNKNOWN_USERS, `Unknown user(s): ${unknown.join(', ')}`, { unknown });
    }
  }

  // All-or-nothing. The SQLite version issued the DELETE and the INSERTs as separate
  // un-transactioned statements, so a failure between them left the user with NO
  // shares at all.
  const now = new Date().toISOString();
  await db.withTransaction(async (tx) => {
    await tx.query('DELETE FROM user_shares WHERE from_user = ?', [owner]);
    for (const toUser of existing) {
      await tx.query(
        'INSERT INTO user_shares (from_user, to_user, shared_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [owner, toUser, now]
      );
    }
  });
  return { shared: existing };
}

// Read a library someone shared with you. Throws NOT_SHARED when no grant exists —
// deliberately the same answer as "that user does not exist", so this cannot be used
// to probe for account names.
async function readSharedLibrary(ownerUsername, viewerUsername) {
  const owner = norm(ownerUsername);
  const viewer = norm(viewerUsername);
  const grant = await get(
    'SELECT 1 AS ok FROM user_shares WHERE from_user = ? AND to_user = ?',
    [owner, viewer]
  );
  if (!grant) throw serviceError(CODES.NOT_SHARED, 'Not shared with you.');
  return libraryService.listGamesFor(owner);
}

// Decline a share someone granted TO you. Idempotent: revoking a grant that is not
// there is a success, and `removed` reports whether a row actually went.
async function revokeIncoming(toUser, fromUser) {
  const ctx = await run(
    'DELETE FROM user_shares WHERE from_user = ? AND to_user = ?',
    [norm(fromUser), norm(toUser)]
  );
  return { removed: ctx.changes };
}

// Minimal directory for the sharing picker. Every authenticated user may enumerate
// accounts — deliberate, and the reason nothing sensitive belongs in this shape.
async function listDirectory() {
  return all('SELECT username, display_name, origin FROM users ORDER BY username ASC', []);
}

// Users who have opted into library sharing globally.
async function listSharingUsers() {
  return all(
    'SELECT id, username, display_name, origin FROM users WHERE shares_library = 1 ORDER BY username ASC',
    []
  );
}

module.exports = {
  listOutgoing,
  listIncoming,
  replaceOutgoing,
  readSharedLibrary,
  revokeIncoming,
  listDirectory,
  listSharingUsers,
};
