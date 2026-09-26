// Notification email resolution — needs a REAL Postgres, run by the smoke-test job
// inside the backend container. NOT part of `npm test`.
//
// ROADMAP CC-5: every account with an empty email fell through to the directory, which
// matches on the username alone, so a LOCAL `jsmith` was sent — and had WRITTEN to their
// row — directory-`jsmith`'s address. The property is "which rows reach the directory,
// and what lands in users.email afterwards", which needs real rows; the directory read
// itself is stubbed through the module object.
const assert = require('assert');
const db = require('../../db');
const directory = require('../../directory');
const notifications = require('../../services/notifications');

let n = 0, failed = 0;
const ok = (label) => { n++; console.log('  ok  ' + label); };
const fail = (label, e) => { n++; failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
async function check(label, fn) { try { await fn(); ok(label); } catch (e) { fail(label, e); } }

(async () => {
  const names = ['emlocal', 'emldap', 'emset'];
  await db.promises.run('DELETE FROM users WHERE username = ANY(?::text[])', [names]);
  const add = (u, origin, email) => db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin, email) VALUES (?, ?, 0, 'now', ?, ?)",
    [u, origin === 'local' ? 'x' : null, origin, email]);
  await add('emlocal', 'local', '');
  await add('emldap', 'ldap', '');
  await add('emset', 'local', 'own@example.com');
  const emailOf = async (u) => (await db.promises.get('SELECT email FROM users WHERE username = ?', [u])).email;

  const real = directory.getLdapEmail;
  const asked = [];
  directory.getLdapEmail = async (u) => { asked.push(u); return `${u}@directory.example.com`; };
  try {
    console.log('\nwhich accounts reach the directory (CC-5):');
    await check('a LOCAL account with no email gets none — and nothing is written', async () => {
      assert.strictEqual(await notifications.resolveEmail('emlocal'), null);
      assert.strictEqual(await emailOf('emlocal'), '', 'a directory address was written to a local account');
      assert.ok(!asked.includes('emlocal'), 'a local account was looked up in the directory');
    });
    await check('a DIRECTORY account with no email is resolved from the directory and cached', async () => {
      assert.strictEqual(await notifications.resolveEmail('emldap'), 'emldap@directory.example.com');
      assert.strictEqual(await emailOf('emldap'), 'emldap@directory.example.com');
    });
    await check('an account that HAS an email never reaches the directory', async () => {
      assert.strictEqual(await notifications.resolveEmail('emset'), 'own@example.com');
      assert.ok(!asked.includes('emset'));
    });
    await check('an unknown username resolves to nothing', async () => {
      assert.strictEqual(await notifications.resolveEmail('em-nobody'), null);
      assert.ok(!asked.includes('em-nobody'));
    });
  } finally {
    directory.getLdapEmail = real;
    await db.promises.run('DELETE FROM users WHERE username = ANY(?::text[])', [names]);
  }

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
