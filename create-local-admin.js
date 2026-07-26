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
 *   docker compose -f docker-compose.yaml exec backend \
 *     node create-local-admin.js admin MySecurePass123 "Admin User"
 *
 * DB_PATH is gone. It pointed at the SQLite file, which is no longer the source of
 * truth; node-sqlite3 opens with OPEN_CREATE, so this script used to CREATE an empty
 * gametracker.db, insert the admin into it, and report success -- while the real
 * database never gained the account.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

const username = process.argv[2] ? process.argv[2].trim().toLowerCase() : '';
const password = process.argv[3] || '';
const displayName = (process.argv[4] || username).trim();

if (!username || !password) {
  console.error('Usage: node create-local-admin.js <username> <password> [display_name]');
  console.error('Example: node create-local-admin.js admin MySecurePass123 "Admin User"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
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
      `INSERT INTO users (username, password, can_manage_users, email, ntfy_topic, created_at, origin, display_name, shares_library)
       VALUES (?, ?, 1, '', '', ?, 'local', ?, 0)
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
