/**
 * Diagnose the LDAP configuration: can we bind, can we find users, and do the
 * ldap-origin rows in the database still resolve in the directory?
 *
 * Read-only — this script never writes to the database or the directory.
 *
 * Run inside the backend container so the PG* variables and settings.json are the
 * same ones the application uses:
 *
 *   docker compose -f docker-compose.yaml exec backend node test_ldap_sync.js
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const {
  buildUserSearchFilter, createLdapClient, warnIfCleartextLdap, entryAttributes, attrValue,
} = require('./ldap-helpers');

// __dirname, not the process cwd — see backfill_ldap_display_names.js.
function loadLdapSettings() {
  const file = path.join(__dirname, 'settings.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`❌ Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  return parsed.ldap || {};
}

function bind(ldapSettings) {
  return new Promise((resolve, reject) => {
    warnIfCleartextLdap(ldapSettings.url);
    // createLdapClient attaches the 'error' listener. Without it an unreachable
    // directory did not fail this test — it killed the process outright, which is
    // the single worst outcome for a script whose entire job is diagnosing a
    // directory that might be unreachable.
    const client = createLdapClient(ldapSettings.url, (err) => reject(err));
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        client.markHandled();
        try { client.unbind(); } catch { /* already closed */ }
        return reject(err);
      }
      resolve(client);
    });
  });
}

function search(client, base, username) {
  return new Promise((resolve) => {
    client.search(base, { filter: buildUserSearchFilter(username), scope: 'sub', attributes: ['displayName', 'cn', 'mail'] }, (err, res) => {
      if (err) return resolve({ error: err.message });
      let entry = null;
      res.on('searchEntry', (e) => {
        if (entry) return;
        entry = entryAttributes(e);
      });
      res.on('error', (e) => resolve({ error: e.message }));
      res.on('end', () => resolve({ entry }));
    });
  });
}

function ldapUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT id, username, email, display_name FROM users WHERE origin = 'ldap' ORDER BY username",
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

async function main() {
  const ldapSettings = loadLdapSettings();

  console.log('Testing LDAP sync functionality...');
  console.log('LDAP settings:', {
    url: ldapSettings.url || 'NOT SET',
    base: ldapSettings.base || 'NOT SET',
    bindDn: ldapSettings.bindDn || 'NOT SET',
    // Never print the value, only whether one exists.
    bindPass: ldapSettings.bindPass ? '[HIDDEN]' : 'NOT SET',
    requiredGroup: ldapSettings.requiredGroup || '(none)',
  });

  if (!ldapSettings.url || !ldapSettings.base) {
    console.error('❌ settings.json has no LDAP url/base configured.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nDatabase: ${process.env.PGDATABASE || 'gametracker'} @ ${process.env.PGHOST || 'db'}`);
  const users = await ldapUsers();
  console.log(`✅ Found ${users.length} ldap-origin user(s) in the database:`);
  for (const u of users) {
    console.log(`  - ${u.username} (${u.display_name || 'no display name'}${u.email ? `, ${u.email}` : ''})`);
  }

  let client;
  try {
    client = await bind(ldapSettings);
    console.log('\n✅ LDAP bind successful');
  } catch (err) {
    console.error(`\n❌ LDAP bind failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    // The bind proves the service account works. It does NOT prove the base DN is
    // right or that these users are still in the directory — which is the failure
    // an operator is actually running this script to find.
    console.log('\nResolving each user against the directory:');
    let resolved = 0;
    for (const u of users) {
      const { entry, error } = await search(client, ldapSettings.base, u.username);
      if (error) {
        console.error(`  ❌ ${u.username}: search error — ${error}`);
      } else if (!entry) {
        console.warn(`  ⚠️  ${u.username}: no directory entry under ${ldapSettings.base}`);
      } else {
        resolved++;
        const name = attrValue(entry, 'displayName', 'cn') || '(no displayName/cn)';
        const mail = attrValue(entry, 'mail', 'email');
        console.log(`  ✅ ${u.username}: ${name}${mail ? ` <${mail}>` : ''}`);
      }
    }
    console.log(`\n${resolved}/${users.length} user(s) resolved in the directory.`);
    if (resolved < users.length) {
      console.warn('Some users did not resolve. Check the base DN, or expect LDAP login to fail for them.');
      process.exitCode = 1;
    } else {
      console.log('✅ All checks passed — LDAP sync should work correctly.');
    }
  } finally {
    client.markHandled();
    try { client.unbind(); } catch { /* already closed */ }
  }
}

main()
  .catch((err) => {
    console.error('\n❌ Tests failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
