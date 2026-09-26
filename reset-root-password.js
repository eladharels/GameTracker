/**
 * Reset the root user's password in the database.
 * Password must be at least 8 characters, and is read from NEW_ROOT_PASSWORD
 * (ROADMAP SEC-9) -- NOT from the command line: argv is visible in /proc/<pid>/cmdline
 * to every process in the container (which also runs the internet-facing app), in the
 * host's `docker exec` argv, and in the operator's shell history. The positional
 * argument still works, with a warning, so a runbook that uses it is not stranded in
 * the middle of a lockout -- this is the break-glass path.
 *
 * This is the break-glass recovery path for an admin lockout, so it must always
 * talk to the database the application actually reads. It now uses ./db, which
 * takes its connection from the same PG* environment variables as the backend.
 * Run it inside the backend container so those are already set:
 *
 *   read -rs NEW_ROOT_PASSWORD && export NEW_ROOT_PASSWORD
 *   docker compose -f docker-compose.yaml exec -e NEW_ROOT_PASSWORD backend \
 *     node reset-root-password.js
 *
 * DB_PATH is gone. It pointed at the SQLite file, which is no longer the source
 * of truth; leaving it in place meant this script would silently CREATE an empty
 * gametracker.db and then report "no root user found" while production was fine.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

const envPassword = process.env.NEW_ROOT_PASSWORD || '';
const newPassword = envPassword || process.argv[2] || '';
if (!newPassword || newPassword.length < 8) {
  console.error('Usage:');
  console.error('  read -rs NEW_ROOT_PASSWORD && export NEW_ROOT_PASSWORD');
  console.error('  node reset-root-password.js');
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
if (!envPassword) {
  console.error('WARNING: the password was passed on the command line, where it is visible in');
  console.error('/proc, in `docker exec` argv and in shell history. Prefer NEW_ROOT_PASSWORD, and');
  console.error('consider clearing this command from your shell history.');
}

console.log('Using database: %s @ %s', process.env.PGDATABASE || 'gametracker', process.env.PGHOST || 'db');

const fail = async (msg) => {
  console.error(msg);
  await db.close();
  process.exit(1);
};

db.get('SELECT id, username, length(password) AS pwd_len FROM users WHERE username = ?', ['root'], async (err, row) => {
  if (err) return fail(`Error reading database: ${err.message}`);
  if (!row) {
    return fail(
      'No user with username "root" found in this database.\n' +
      'Check that PGHOST/PGDATABASE point at the database the app uses.'
    );
  }
  console.log('Found root user id=%s, current password length=%s', row.id, row.pwd_len == null ? 'NULL' : row.pwd_len);

  let hash;
  try {
    hash = await bcrypt.hash(newPassword, 10);
  } catch (e) {
    return fail(`Error hashing password: ${e.message}`);
  }

  db.run('UPDATE users SET password = ? WHERE username = ?', [hash, 'root'], async function (err2) {
    if (err2) return fail(`Error updating password: ${err2.message}`);
    if (this.changes === 0) return fail('Update affected 0 rows.');
    console.log('Root user password updated successfully.');
    await db.close();
  });
});
