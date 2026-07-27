/**
 * Create a new local admin user.
 * Run from the project root:
 *   node create-local-admin.js <username> <password> [display_name]
 *
 * Password must be at least 8 characters.
 * Username is stored in lowercase (login is case-insensitive).
 * Optional display_name defaults to the username.
 *
 * This talks to the database the application actually reads, via ./db, which takes
 * its connection from the same PG* environment variables as the backend. Run it
 * inside the backend container so those are already set:
 *
 *   docker compose -f docker-compose.yaml exec -e NEW_ADMIN_PASSWORD backend \
 *     node create-local-admin.js jane "Jane Doe"
 *
 * Set NEW_ADMIN_PASSWORD in your shell first (`read -rs NEW_ADMIN_PASSWORD && export
 * NEW_ADMIN_PASSWORD`) rather than passing the password as an argument — argv is
 * visible in /proc, in the docker exec command line, and in your shell history.
 *
 * DB_PATH is gone. It pointed at the SQLite file, which is no longer the source of
 * truth; node-sqlite3 opens with OPEN_CREATE, so this script used to CREATE an empty
 * gametracker.db, insert the admin into it, and report success -- while the real
 * database never gained the account.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const { validateUsername } = require('./user-rules');

const username = process.argv[2] ? process.argv[2].trim().toLowerCase() : '';

// Prefer NEW_ADMIN_PASSWORD so the password does not land in /proc/<pid>/cmdline
// (readable by any process in the container, which also runs the internet-facing
// app), in the host's `docker exec` argv, or in the operator's shell history.
//
// The two forms take DIFFERENT positional arguments, deliberately -- an optional
// positional password would make `create-local-admin.js jane "Jane Doe"` ambiguous,
// and the ambiguity would resolve as "password = Jane Doe".
//   with the env var:     <username> [display_name]
//   without:              <username> <password> [display_name]
const envPassword = process.env.NEW_ADMIN_PASSWORD || '';
const password = envPassword || process.argv[3] || '';
const displayName = ((envPassword ? process.argv[3] : process.argv[4]) || username).trim();

if (!username || !password) {
  console.error('Usage: node create-local-admin.js <username> <password> [display_name]');
  console.error('');
  console.error('Preferred — keeps the password out of argv and shell history:');
  console.error('  read -rs NEW_ADMIN_PASSWORD && export NEW_ADMIN_PASSWORD');
  console.error('  node create-local-admin.js <username> [display_name]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

// The same rule POST /api/users enforces. This script creates an ADMIN, and used to
// skip the check entirely: it would create an account named `me`, which the
// /api/user/me/* routes permanently shadow, leaving it unusable and undeletable.
const usernameError = validateUsername(username);
if (usernameError) {
  console.error(usernameError);
  process.exit(1);
}
// Anything outside this set is either unreachable in a URL path or invisible in the
// admin UI. The API has no equivalent charset check; that is tracked separately.
if (!/^[a-z0-9._-]+$/.test(username)) {
  console.error('Username may contain only lowercase letters, digits, dot, underscore and hyphen.');
  process.exit(1);
}

async function main() {
  console.log('Using database: %s @ %s', process.env.PGDATABASE || 'gametracker', process.env.PGHOST || 'db');
  console.log('Creating local admin:', { username, display_name: displayName || username });

  // Checked up front so the common mistake gets a clear message rather than a
  // constraint violation. The unique index below is still what actually guarantees
  // it -- this is a nicety, not the enforcement.
  const existing = await new Promise((resolve, reject) => {
    db.get('SELECT id, origin FROM users WHERE username = ?', [username],
      (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (existing) {
    console.error(`A user named "${username}" already exists (id ${existing.id}, origin ${existing.origin}).`);
    console.error('To change its password use: node reset-root-password.js — or edit the user in the admin UI.');
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();

  const id = await new Promise((resolve, reject) => {
    db.run(
      // RETURNING id is REQUIRED for this.lastID under the Postgres shim -- SQLite
      // handed it back for free, Postgres does not. See db.js divergence #2.
      // No notification columns: they are the user's own, set by them on My Account,
      // and this script wrote ntfy_topic as a hardcoded '' only because the column
      // was in the list. Leaving them NULL reads as "not configured" everywhere.
      `INSERT INTO users (username, password, can_manage_users, email, created_at, origin, display_name, shares_library)
       VALUES (?, ?, 1, '', ?, 'local', ?, 0)
       RETURNING id`,
      [username, hash, now, displayName || username],
      function (err) {
        // SQLSTATE, not a message substring: err.code is '23505' for a unique
        // violation. Matching on the text 'UNIQUE' was a SQLite-ism and silently
        // stopped working. See db.js divergence #11.
        if (err && err.code === '23505') {
          return reject(new Error(`A user named "${username}" already exists.`));
        }
        return err ? reject(err) : resolve(this.lastID);
      }
    );
  });

  console.log('Local admin created successfully. Id:', id);
  console.log('You can log in with username:', username);
}

main()
  .catch((err) => {
    console.error('Error creating user:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
