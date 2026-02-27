/**
 * Reset the root user's password in the database.
 * Run from project root: node reset-root-password.js "YourNewPassword"
 * Password must be at least 8 characters.
 *
 * Use same DB as the app: set DB path if app runs from another directory:
 *   set DB_PATH=e:\path\to\gametracker.db && node reset-root-password.js "NewPass"
 *   (PowerShell: $env:DB_PATH="e:\path\to\gametracker.db"; node reset-root-password.js "NewPass")
 */
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// Use DB_PATH env if set (so you can point to the same file the app uses); else project root
const DBSOURCE = process.env.DB_PATH || path.join(__dirname, 'gametracker.db');
const db = new sqlite3.Database(DBSOURCE);

const newPassword = process.argv[2];
if (!newPassword || newPassword.length < 8) {
  console.error('Usage: node reset-root-password.js "YourNewPassword"');
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

console.log('Using database:', DBSOURCE);

// First check that root user exists
db.get('SELECT id, username, length(password) as pwd_len FROM users WHERE username = ?', ['root'], (err, row) => {
  if (err) {
    console.error('Error reading database:', err.message);
    db.close();
    process.exit(1);
  }
  if (!row) {
    console.error('No user with username "root" found in this database.');
    console.error('Make sure you are using the same database file the app uses (see DB_PATH above).');
    db.close();
    process.exit(1);
  }
  console.log('Found root user id=%s, current password length=%s', row.id, row.pwd_len == null ? 'NULL' : row.pwd_len);

  bcrypt.hash(newPassword, 10).then((hash) => {
    db.run('UPDATE users SET password = ? WHERE username = ?', [hash, 'root'], function (err) {
      if (err) {
        console.error('Error updating password:', err.message);
        db.close();
        process.exit(1);
      }
      if (this.changes === 0) {
        console.error('Update affected 0 rows.');
        db.close();
        process.exit(1);
      }
      console.log('Root user password updated successfully.');
      db.close();
    });
  }).catch((err) => {
    console.error('Error hashing password:', err.message);
    db.close();
    process.exit(1);
  });
});

