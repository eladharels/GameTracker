/**
 * Create a new local admin user in the database.
 * Run from project root:
 *   node create-local-admin.js <username> <password> [display_name]
 *
 * Password must be at least 8 characters.
 * Username is stored in lowercase (login is case-insensitive).
 * Optional display_name defaults to the username.
 *
 * Use same DB as the app if it runs from another directory:
 *   set DB_PATH=e:\path\to\gametracker.db && node create-local-admin.js admin MyPass123
 *   (PowerShell: $env:DB_PATH="e:\path\to\gametracker.db"; node create-local-admin.js admin MyPass123)
 */
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const DBSOURCE = process.env.DB_PATH || path.join(__dirname, 'gametracker.db');
const db = new sqlite3.Database(DBSOURCE);

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

console.log('Using database:', DBSOURCE);
console.log('Creating local admin:', { username, display_name: displayName || username });

bcrypt.hash(password, 10).then((hash) => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (username, password, can_manage_users, email, ntfy_topic, created_at, origin, display_name, shares_library)
     VALUES (?, ?, 1, '', '', ?, 'local', ?, 0)`,
    [username, hash, now, displayName || username],
    function (err) {
      db.close();
      if (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          console.error('A user with that username already exists.');
        } else {
          console.error('Error creating user:', err.message);
        }
        process.exit(1);
      }
      console.log('Local admin created successfully. Id:', this.lastID);
      console.log('You can log in with username:', username);
    }
  );
}).catch((err) => {
  console.error('Error hashing password:', err.message);
  db.close();
  process.exit(1);
});

