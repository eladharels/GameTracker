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
const { isValidEmailAddress, validatePassword, sanitizeText, RESERVED_USERNAMES } = require('../user-rules');


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

// The complete set of `users` columns an administrator may write through this
// service. Exported so the test can assert an EXHAUSTIVE partition of the table:
// every column is either admin-writable, user-owned, or neither — and a new column
// belongs to none of them until someone says which, so it fails CI rather than
// defaulting to admin-writable by omission.
//
// This replaced a regex that guessed at channel-sounding names. `pushover_user`,
// `matrix_room` and `signal_number` all slipped through it, because a vocabulary
// tripwire only catches the vendors it was written knowing about.
const ADMIN_WRITABLE_COLUMNS = Object.freeze([
  'password', 'can_manage_users', 'email', 'shares_library',
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
// Called by BOTH write paths — update() and create() — as their first statement, so
// it cannot be reached past a partial write. It exists as a separate function rather
// than as a line inside update() because a guard covering one of the two paths, while
// its message claimed to cover both, is what let an admin plant the credentials at
// provisioning time instead: the new user changes their password and every release
// notification keeps flowing to the admin's device, surviving them taking full
// ownership of the account.
//
// Still exported. Nothing in this repository needs it from outside now that create()
// lives here, but it is the shape of the rule an out-of-service write path would have
// to honour, and un-exporting it is how the next one silently does not.
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

  // The asymmetry below is deliberate and both halves fail closed:
  //
  //   * the GUARD above reads through the prototype chain, so an INHERITED
  //     gotify_token is still seen and still refused;
  //   * every WRITE below reads OWN properties only, so an inherited value is
  //     never written.
  //
  // Own-only matters because the route now passes req.body straight through. The
  // old route built a fresh object literal, which gave all six fields own
  // `undefined` values that shadowed the prototype — that accidentally immunised
  // these reads, and passing the raw body removed the accident without replacing
  // it. A body that never mentions can_manage_users could then pick it up from
  // Object.prototype and grant admin on an arbitrary account.
  //
  // Not reachable today: only express.json() is mounted, and JSON.parse creates
  // __proto__ as an own DATA property rather than invoking the setter, so there is
  // no pollution gadget in this app. This is the load-bearing assumption a future
  // deep-merge would quietly break, which is exactly why it is enforced here rather
  // than relied upon. `{...fields}` does NOT fix it — the spread result still
  // inherits from Object.prototype.
  const sent = (key) => Object.hasOwn(Object(fields), key);

  if (sent('can_manage_users')) {
    if (!fields.can_manage_users && String(actingUserId) === String(id)) {
      throw serviceError(CODES.VALIDATION, 'You cannot remove your own admin permission.', { field: 'can_manage_users' });
    }
    updates.push('can_manage_users = ?');
    params.push(fields.can_manage_users ? 1 : 0);
  }
  if (sent('email')) {
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
  if (sent('shares_library')) {
    updates.push('shares_library = ?');
    params.push(fields.shares_library ? 1 : 0);
  }

  // Enforced HERE, not in the adapter, because it must hold for v2 too. Extracting
  // this service dropped both checks: an admin could set any password to "a", and a
  // non-string password was silently ignored while the call still reported success.
  const wantsPassword = sent('password') && fields.password !== null && fields.password !== '';
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

// Create an account.
//
// EXTRACTED FROM THE ROUTE, and both surfaces call it. Creation was the one write in
// this file that lived in index.js as an inline INSERT, and the cost was already
// visible: `assertNotUserOwned` had to be exported and invoked by hand from the route,
// because a guard inside update() covered one of the two write paths while claiming
// both. Every rule below was in the route; none of them is new.
//
// The ONE thing the adapters still differ on is the duplicate-username STATUS. This
// throws CONFLICT, which v2 renders as the 409 its spec documents; the v1 route maps
// it back to the 400 it has always answered, in the adapter, with a comment. v1's wire
// behaviour is frozen — that does not mean its rules have to be a second copy.
async function create(fields) {
  // BEFORE hashing and before the INSERT: an admin must not be able to plant a
  // notification target at provisioning time, which would survive the new user
  // changing their password and so outlive them taking ownership of the account.
  assertNotUserOwned(fields);

  const { username, password } = fields || {};
  // Both must be STRINGS. A JSON number reaching bcrypt.hash rejects with "Illegal
  // arguments", and under Node's default --unhandled-rejections=throw that takes the
  // whole process down.
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw serviceError(CODES.VALIDATION, 'Username and password must be strings');
  }
  if (!username.trim() || !password.trim()) {
    throw serviceError(CODES.VALIDATION, 'Username and password cannot be empty');
  }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) throw serviceError(CODES.VALIDATION, passwordProblem, { field: 'password' });

  const email = fields.email === undefined || fields.email === null ? '' : String(fields.email).trim();
  if (email !== '' && !isValidEmailAddress(email)) {
    throw serviceError(CODES.VALIDATION, 'email must be a single valid address, or empty', { field: 'email' });
  }

  const normalized = username.toLowerCase();
  // `me` collides with the /api/user/me/* routes, which are registered first and would
  // shadow the account entirely; the rest are reserved to avoid confusion with the
  // seeded administrator.
  if (RESERVED_USERNAMES.includes(normalized)) {
    throw serviceError(CODES.VALIDATION, `'${normalized}' is a reserved username.`, { field: 'username' });
  }

  const hash = await bcrypt.hash(password, 10);
  let ctx;
  try {
    ctx = await db.promises.run(
      // RETURNING id — required for lastID under Postgres. See db.js.
      'INSERT INTO users (username, password, can_manage_users, email, created_at, origin, display_name, shares_library)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [normalized, hash, fields.can_manage_users ? 1 : 0, email, new Date().toISOString(),
        'local', normalized, fields.shares_library ? 1 : 0]
    );
  } catch (err) {
    // SQLSTATE, not message matching — db.js divergence #11. 23505 is unique_violation,
    // and the only unique constraint on this table is the username.
    if (err && err.code === '23505') {
      throw serviceError(CODES.CONFLICT, 'User already exists', { field: 'username' });
    }
    throw err;
  }
  return { id: ctx.lastID, username: normalized };
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

// --- the caller's OWN notification settings -----------------------------------
//
// The other half of USER_OWNED_NOTIFICATION_COLUMNS. `update()` REFUSES these because
// it is the administrative surface; this is the surface that owns them, and it only
// ever reads and writes the caller's own row — there is no user parameter an adapter
// could pass wrongly.
//
// Extracted from the v1 route rather than reimplemented for v2. The email rule is
// load-bearing and was learned the hard way: Nodemailer treats a comma-separated `to`
// as a recipient LIST, so an unvalidated address here let one account fan
// notifications out to arbitrary third parties from this deployment's own
// SPF/DKIM-aligned domain. Two skins, one rule.
const NOTIFICATION_DAYS_DEFAULT = Object.freeze([0, 7, 30]);
const MAX_NOTIFICATION_DAY = 365;

// http(s) only, or empty to clear. The cloud instance-metadata blocklist is applied at
// the SEND sink, not here, because that also covers values written before this check
// existed — do not move it and delete it there.
const isServerUrl = (u) => u === '' || /^https?:\/\/\S+$/i.test(u);

function parseNotificationDays(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [...NOTIFICATION_DAYS_DEFAULT];
  } catch {
    return [...NOTIFICATION_DAYS_DEFAULT];
  }
}

async function readNotificationSettings(userId) {
  const row = await db.promises.get(
    `SELECT email, ntfy_url, ntfy_topic, gotify_url, gotify_token, telegram_chat_id, notification_days
       FROM users WHERE id = ?`,
    [userId]
  );
  if (!row) throw serviceError(CODES.NOT_FOUND, 'User not found');
  return { ...row, notification_days: parseNotificationDays(row.notification_days) };
}

async function updateNotificationSettings(userId, fields) {
  const updates = [];
  const params = [];
  // Own-property only, for the same reason update() uses it: the adapter passes the
  // request body straight through, and an inherited value must never be written.
  const has = (key) => Object.hasOwn(Object(fields), key);

  if (has('email')) {
    const clean = fields.email === null ? '' : String(fields.email).trim();
    if (clean !== '' && !isValidEmailAddress(clean)) {
      throw serviceError(CODES.VALIDATION, 'email must be a single valid address, or empty', { field: 'email' });
    }
    updates.push('email = ?'); params.push(clean);
  }
  for (const [key, column] of [['ntfyUrl', 'ntfy_url'], ['gotifyUrl', 'gotify_url']]) {
    if (!has(key)) continue;
    const clean = fields[key] === null ? '' : String(fields[key]).trim();
    if (!isServerUrl(clean)) {
      throw serviceError(CODES.VALIDATION, `${key} must be an http(s) URL, or empty to clear`, { field: key });
    }
    updates.push(`${column} = ?`); params.push(clean);
  }
  for (const [key, column] of [['ntfyTopic', 'ntfy_topic'], ['gotifyToken', 'gotify_token'],
    ['telegramChatId', 'telegram_chat_id']]) {
    if (!has(key)) continue;
    updates.push(`${column} = ?`);
    params.push(fields[key] === null ? '' : sanitizeText(fields[key], 200));
  }
  if (has('notificationDays')) {
    const days = fields.notificationDays;
    const valid = Array.isArray(days) && days.length > 0
      && days.every((d) => Number.isInteger(d) && d >= 0 && d <= MAX_NOTIFICATION_DAY);
    if (!valid) {
      throw serviceError(CODES.VALIDATION,
        `notificationDays must be a non-empty array of integers between 0 and ${MAX_NOTIFICATION_DAY}`,
        { field: 'notificationDays' });
    }
    // De-duplicated and sorted: the release sweep matches `days.includes(diff)`, so a
    // repeated value is silently meaningless and an unsorted one reads badly back.
    updates.push('notification_days = ?');
    params.push(JSON.stringify([...new Set(days)].sort((a, b) => a - b)));
  }

  if (updates.length === 0) throw serviceError(CODES.VALIDATION, 'no settings to update');
  params.push(userId);
  const ctx = await db.promises.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  if (ctx.changes === 0) throw serviceError(CODES.NOT_FOUND, 'User not found');
  return readNotificationSettings(userId);
}

module.exports = {
  listAll, findById, create, update, remove,
  assertNotUserOwned, ADMIN_LIST_COLUMNS, USER_OWNED_NOTIFICATION_COLUMNS,
  ADMIN_WRITABLE_COLUMNS,
  readNotificationSettings, updateNotificationSettings, NOTIFICATION_DAYS_DEFAULT,
};
