// User accounts (`users`) — the administrative surface.
//
// Promise-based, no req/res. See services/shares.js for why the service layer exists.
//
// SAFETY RULES ENCODED HERE, not in the adapter, because they must hold for /api/v2
// and any future caller too — an instance that locks itself out has no way back in
// short of a shell on the host:
//   * an admin may not remove their own admin permission
//   * nobody may delete their own account
//   * the seeded `root` account may not be deleted

const bcrypt = require('bcryptjs');
const db = require('../db');
// Shared promise surface — see db.js. Four services had each written their own.
// `all` is deliberately absent: listAll() calls db.promises.all through the module
// so a test can observe the SQL it issues. See listAll.
const { get, run } = db.promises;
const { serviceError, CODES } = require('./errors');
const { isValidEmailAddress, validatePassword } = require('../user-rules');


// Where a user's notifications GO. The user's own setting, on My Account — never an
// administrative field.
//
// Every column here answers "which device does this reach". A Gotify application
// token lets the holder post to that user's devices; an ntfy topic is a bearer
// secret in the same way, since anyone who knows the topic can publish to it; a
// Telegram chat id addresses a conversation; and the two server URLs decide which
// host the token or topic is presented to, so writing a URL redirects the channel
// just as effectively as writing the secret.
//
// `GET /api/users` returned ntfy_topic and gotify_token for EVERY user to EVERY
// admin, and `PUT /api/users/:id` let an admin overwrite them — silently repointing
// another user's notifications at a channel the admin controls. The other three were
// never readable or writable there; they are named here so that sending one is
// ANSWERED rather than shrugged off, which is the same dishonesty in a quieter form.
//
// The name is deliberately about ownership, not secrecy: two of these are URLs. The
// rule is "the user owns their delivery path", and that is what makes the set
// well-defined enough to be worth asserting against.
//
// This list is the ONLY place these names appear on the write path — the routes
// derive their forwarded fields from it (index.js). Hand-listing them there meant
// adding a name here silently failed to guard it, since the route never forwarded it
// for the service to see: the exact silent-ignore this rule exists to remove,
// reintroduced by editing the list meant to prevent it.
const USER_OWNED_NOTIFICATION_COLUMNS = Object.freeze([
  'ntfy_url', 'ntfy_topic', 'gotify_url', 'gotify_token', 'telegram_chat_id',
]);

// Columns the admin list exposes. Deliberately not `SELECT *`: `password` is in that
// table too, and an allowlist fails closed when a column is added.
const ADMIN_LIST_COLUMNS =
  'id, username, can_manage_users, email, created_at, origin, display_name, shares_library';

// `db.promises.all`, not the destructured `all`, so a test can observe the SQL this
// actually issues. Asserting the ADMIN_LIST_COLUMNS constant alone proved nothing:
// rewriting this line to `SELECT *` would ship every credential AND the password
// hash while every assertion about the constant still passed. The test now reads the
// query, so the artifact and the behaviour cannot diverge.
async function listAll() {
  return db.promises.all(`SELECT ${ADMIN_LIST_COLUMNS} FROM users ORDER BY id ASC`, []);
}

// Refused, not silently dropped. An admin tool that thinks it just set a user's
// Gotify token and got `{success:true}` back has been told something false; a 400
// naming the field is the only answer that leaves the caller correctly informed.
//
// EXPORTED because account CREATION never went through this service — it is still an
// inline INSERT in index.js. A guard living only inside update() covered one of the
// two write paths while the error message it threw claimed to cover both, so an
// admin could simply plant the credentials at provisioning time instead: the new
// user changes their password and every release notification keeps flowing to the
// admin's device, surviving the user taking full ownership of the account.
//
// Callers must invoke this BEFORE any other work, so it cannot be reached past a
// partial write.
function assertNotUserOwned(fields) {
  for (const column of USER_OWNED_NOTIFICATION_COLUMNS) {
    if (typeof fields?.[column] !== 'undefined') {
      throw serviceError(
        CODES.VALIDATION,
        `${column} is that user's own notification setting, changed by them on My Account. `
        + 'An administrator cannot set it on their behalf.',
        { field: column }
      );
    }
  }
}

async function findById(id) {
  return get('SELECT id, username, can_manage_users, origin FROM users WHERE id = ?', [id]);
}

// Partial update. Only the keys present in `fields` are written — PATCH semantics,
// despite v1 spelling it PUT.
//
// `actingUserId` is required so the self-demotion rule can be enforced here rather
// than trusted to every caller.
async function update(id, fields, actingUserId) {
  const updates = [];
  const params = [];

  assertNotUserOwned(fields);

  if (typeof fields.can_manage_users !== 'undefined') {
    if (!fields.can_manage_users && String(actingUserId) === String(id)) {
      throw serviceError(CODES.VALIDATION, 'You cannot remove your own admin permission.', { field: 'can_manage_users' });
    }
    updates.push('can_manage_users = ?');
    params.push(fields.can_manage_users ? 1 : 0);
  }
  if (typeof fields.email !== 'undefined') {
    const cleanEmail = String(fields.email).trim();
    // Validated at the write site, not only at the send sink: an address smuggling
    // a comma turns notifications into an authenticated relay from this
    // deployment's SPF/DKIM-aligned domain.
    if (cleanEmail !== '' && !isValidEmailAddress(cleanEmail)) {
      throw serviceError(CODES.VALIDATION, 'email must be a single valid address, or empty', { field: 'email' });
    }
    updates.push('email = ?');
    params.push(cleanEmail);
  }
  if (typeof fields.shares_library !== 'undefined') {
    updates.push('shares_library = ?');
    params.push(fields.shares_library ? 1 : 0);
  }

  // Enforced HERE, not in the adapter, because it must hold for v2 too. Extracting
  // this service dropped both checks: an admin could set any password to "a", and a
  // non-string password was silently ignored while the call still reported success.
  const wantsPassword = typeof fields.password !== 'undefined' && fields.password !== null && fields.password !== '';
  if (wantsPassword) {
    const problem = validatePassword(fields.password);
    if (problem) throw serviceError(CODES.VALIDATION, problem, { field: 'password' });
  }

  if (updates.length === 0 && !wantsPassword) {
    // An empty body once produced `UPDATE users SET  WHERE id = ?` — a SQL syntax
    // error surfacing as an opaque 500.
    throw serviceError(CODES.VALIDATION, 'No fields to update');
  }

  if (wantsPassword) {
    updates.push('password = ?');
    params.push(await bcrypt.hash(fields.password, 10));
  }

  params.push(id);
  // `db.promises.run`, not the destructured `run`, for the same reason listAll uses
  // db.promises.all: so a test can observe the SQL this actually emits.
  //
  // That matters more here than anywhere else in this file. The route hands the whole
  // request body to this function, and the ONLY thing making that safe is that every
  // string appended to `updates` above is a hardcoded literal — nothing caller-
  // controlled reaches this template. Nothing asserted that. A later "generalise the
  // update path" refactor introducing `updates.push(\`${key} = ?\`)` would silently
  // turn the raw-body seam into an arbitrary-column write primitive with the suite
  // green. The test now drives a hostile body through and asserts what comes out.
  const ctx = await db.promises.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  if (ctx.changes === 0) throw serviceError(CODES.NOT_FOUND, 'User not found');
  return { updated: ctx.changes };
}

// Delete an account. Refuses self-deletion and the root account.
//
// `user_shares` rows go with it via ON DELETE CASCADE, which Postgres now actually
// enforces — SQLite declared the foreign keys but ran with them off, which is why
// v1 also issued an explicit DELETE. That explicit statement was fire-and-forget:
// the response was sent without awaiting it, so under the connection pool it could
// be abandoned. Relying on the cascade removes the unawaited write.
//
// The cascade is declared at migrations/001_initial_schema.sql:81-82 (ON DELETE
// CASCADE ON UPDATE CASCADE on both from_user and to_user) and was confirmed
// empirically during the extraction. It is NOT covered by an automated test — both
// current suites are database-free by design; a real regression test belongs in the
// smoke stage, which has Postgres.
async function remove(id, actingUserId) {
  if (String(actingUserId) === String(id)) {
    throw serviceError(CODES.VALIDATION, 'You cannot delete your own account.');
  }
  const row = await get('SELECT username FROM users WHERE id = ?', [id]);
  if (!row) throw serviceError(CODES.NOT_FOUND, 'User not found');
  if (row.username === 'root') {
    throw serviceError(CODES.VALIDATION, 'The root account cannot be deleted.');
  }
  const ctx = await run('DELETE FROM users WHERE id = ?', [id]);
  return { removed: ctx.changes, username: row.username };
}

module.exports = {
  listAll, findById, update, remove,
  assertNotUserOwned, ADMIN_LIST_COLUMNS, USER_OWNED_NOTIFICATION_COLUMNS,
};
