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
const { serviceError, CODES } = require('./errors');
const { isValidEmailAddress, validatePassword } = require('../user-rules');

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
});

// Columns the admin list exposes.
//
// NOTE for v2: this includes ntfy_topic and gotify_token, which are per-user PUSH
// CREDENTIALS. An administrator does not need them to administer an account, and
// they are returned to every admin for every user. v1's shape is preserved here;
// v2 must drop them.
const ADMIN_LIST_COLUMNS =
  'id, username, can_manage_users, email, ntfy_topic, gotify_token, created_at, origin, display_name, shares_library';

async function listAll() {
  return all(`SELECT ${ADMIN_LIST_COLUMNS} FROM users ORDER BY id ASC`, []);
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
  if (typeof fields.ntfy_topic !== 'undefined') { updates.push('ntfy_topic = ?'); params.push(fields.ntfy_topic); }
  if (typeof fields.gotify_token !== 'undefined') { updates.push('gotify_token = ?'); params.push(fields.gotify_token); }
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
  const ctx = await run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
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

module.exports = { listAll, findById, update, remove, ADMIN_LIST_COLUMNS };
