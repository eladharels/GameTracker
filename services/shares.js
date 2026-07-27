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
// Shared promise surface — see db.js. Four services had each written their own.
const { all, get, run } = db.promises;
const { serviceError, CODES } = require('./errors');
// One implementation of "this user's games" — see services/library.js.
const libraryService = require('./library');

const norm = (v) => (v ? String(v).toLowerCase() : '');

// Promise wrappers over the node-sqlite3-shaped callback shim. New code should
// prefer db.query(); these exist so this module reads as one style throughout.

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
    const unknownUsers = requested.filter((u) => !existing.includes(u));
    if (unknownUsers.length) {
      // `unknownUsers` is the ONE spelling: services/v2.js publishes it as the
      // UnknownUsersProblem extension, and v1 reads only the message. Two spellings of
      // the same detail is how one of them ends up unpopulated.
      throw serviceError(CODES.UNKNOWN_USERS,
        `Unknown user(s): ${unknownUsers.join(', ')}`, { unknownUsers });
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

// --- The v2 surface ---------------------------------------------------------
//
// v1 exposes sharing as two bare username lists and one POST with REPLACE semantics.
// The shapes below carry a display name and a date because a client showing "shared
// with" needs both and v1 made it fetch the whole directory to get them; the
// single-add and single-remove exist because "add one" spelled as a replace is how an
// agent revokes every other share while believing it added one.

const SHARE_COLUMNS = 'u.display_name AS "displayName", s.shared_at AS "sharedAt"';

// Accounts this library is shared WITH.
//
// LEFT JOIN, not an inner one: user_shares references users, but a row whose account
// was removed out from under it must still appear in the owner's list — an inner join
// would make it vanish from the UI while the grant is still on the table.
async function listOutgoingShares(fromUser) {
  return db.promises.all(
    `SELECT s.to_user AS username, ${SHARE_COLUMNS}
       FROM user_shares s LEFT JOIN users u ON u.username = s.to_user
      WHERE s.from_user = ? ORDER BY s.to_user ASC`,
    [norm(fromUser)]
  );
}

// Accounts that share THEIR library with this one.
async function listIncomingShares(toUser) {
  return db.promises.all(
    `SELECT s.from_user AS username, ${SHARE_COLUMNS}
       FROM user_shares s LEFT JOIN users u ON u.username = s.from_user
      WHERE s.to_user = ? ORDER BY s.from_user ASC`,
    [norm(toUser)]
  );
}

// Share with ONE more user. Additive, and idempotent: sharing with someone already on
// the list is a no-op rather than an error, so a retried tool call is safe.
//
// The existence check is deliberate and is NOT a disclosure: the caller is naming an
// account they intend to grant access to, so "no such user" tells them only about a
// name they supplied. That is the opposite of removeOutgoingShare below, where the
// same information WOULD be an oracle.
async function addOutgoing(fromUser, toUser) {
  const owner = norm(fromUser);
  const target = typeof toUser === 'string' ? toUser.trim().toLowerCase() : '';
  if (!target) {
    throw serviceError(CODES.VALIDATION, 'username is required', { field: 'username' });
  }
  if (target === owner) {
    throw serviceError(CODES.VALIDATION, 'you cannot share with yourself', { field: 'username' });
  }
  const exists = await db.promises.get('SELECT username FROM users WHERE username = ?', [target]);
  if (!exists) {
    throw serviceError(CODES.UNKNOWN_USERS, `Unknown user(s): ${target}`, { unknownUsers: [target] });
  }
  await db.promises.run(
    'INSERT INTO user_shares (from_user, to_user, shared_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [owner, target, new Date().toISOString()]
  );
  // Read back rather than return what was sent: on the idempotent path the stored
  // shared_at is the ORIGINAL one, and reporting today's date would tell the caller
  // the grant is newer than it is.
  return db.promises.get(
    `SELECT s.to_user AS username, ${SHARE_COLUMNS}
       FROM user_shares s LEFT JOIN users u ON u.username = s.to_user
      WHERE s.from_user = ? AND s.to_user = ?`,
    [owner, target]
  );
}

// Stop sharing with one user.
//
// `removed` is decided PURELY by whether a share row went — never by whether the named
// account exists. The adapter turns removed:false into a 404, so checking the users
// table here would turn this route into a username oracle for any authenticated
// caller: "404" for a real account with no share and "404" for a name that was never
// an account have to be the same answer.
async function removeOutgoing(fromUser, toUser) {
  const ctx = await db.promises.run(
    'DELETE FROM user_shares WHERE from_user = ? AND to_user = ?',
    [norm(fromUser), norm(toUser)]
  );
  return { removed: ctx.changes };
}

// A shared library, PAGED. Same grant check as readSharedLibrary — and the check runs
// BEFORE the page is read, so a viewer with no grant learns nothing about the size or
// contents of the library, including from timing.
//
// There is deliberately no admin bypass anywhere on this path (openapi's
// `x-admin-bypass: false`): a shared library is a consent relationship between two
// users, not a resource the server owns.
async function readSharedPage(ownerUsername, viewerUsername, opts = {}) {
  const owner = norm(ownerUsername);
  const viewer = norm(viewerUsername);
  const grant = await db.promises.get(
    `SELECT u.id AS "ownerId" FROM user_shares s JOIN users u ON u.username = s.from_user
      WHERE s.from_user = ? AND s.to_user = ?`,
    [owner, viewer]
  );
  // One answer for "no grant", "no such account" and "account deleted since". Telling
  // them apart is a username oracle, and this is the route most likely to be probed.
  if (!grant) throw serviceError(CODES.NOT_SHARED, 'Not shared with you.');
  return libraryService.listPage(grant.ownerId, {
    limit: opts.limit,
    cursor: opts.cursor,
  });
}

module.exports = {
  listOutgoing,
  listIncoming,
  listOutgoingShares,
  listIncomingShares,
  addOutgoing,
  removeOutgoing,
  readSharedPage,
  replaceOutgoing,
  readSharedLibrary,
  revokeIncoming,
  listDirectory,
  listSharingUsers,
};
