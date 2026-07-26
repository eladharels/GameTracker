/**
 * Sync display_name from LDAP for every ldap-origin user.
 *
 * Run inside the backend container so the PG* variables and settings.json are the
 * same ones the application uses:
 *
 *   docker compose -f docker-compose.yaml exec backend node backfill_ldap_display_names.js
 *
 * Add --dry-run to print what would change without writing anything.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const {
  buildUserSearchFilter, createLdapClient, warnIfCleartextLdap, entryAttributes, attrValue,
} = require('./ldap-helpers');

const DRY_RUN = process.argv.includes('--dry-run');

// __dirname, not the process cwd. Reading 'settings.json' relative to wherever the
// operator happened to be standing silently picked up a different file -- or none.
function loadLdapSettings() {
  const file = path.join(__dirname, 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`${file} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const ldapSettings = parsed.ldap || {};
  if (!ldapSettings.url || !ldapSettings.base) {
    console.error('settings.json has no LDAP url/base configured. Nothing to sync.');
    process.exit(1);
  }
  return ldapSettings;
}

// One bind for the whole run. The previous version created a fresh client and a
// fresh bind PER USER -- 12 binds for 12 users, each one an unauthenticated socket
// with no 'error' listener, so a directory that went away mid-run killed the process.
function withBoundClient(ldapSettings, fn) {
  return new Promise((resolve, reject) => {
    warnIfCleartextLdap(ldapSettings.url);
    const client = createLdapClient(ldapSettings.url, (err) => reject(err));
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        client.markHandled();
        try { client.unbind(); } catch { /* already closed */ }
        return reject(new Error(`LDAP bind failed: ${err.message}`));
      }
      fn(client)
        .then(resolve, reject)
        .finally(() => {
          client.markHandled();
          try { client.unbind(); } catch { /* already closed */ }
        });
    });
  });
}

// Resolves to a display name, or null when the directory has no entry for the user.
// Never rejects: one unresolvable user must not abort the whole backfill.
function lookupDisplayName(client, ldapSettings, username) {
  return new Promise((resolve) => {
    const options = {
      // Escaped, matching the server. A username containing `*` previously matched
      // every entry in the directory and this script wrote whichever one arrived
      // first into that user's display_name.
      filter: buildUserSearchFilter(username),
      scope: 'sub',
      attributes: ['displayName', 'cn'],
    };
    client.search(ldapSettings.base, options, (err, res) => {
      if (err) {
        console.error(`  LDAP search failed for ${username}: ${err.message}`);
        return resolve(null);
      }
      let value = null;
      res.on('searchEntry', (entry) => {
        if (value !== null) return; // first match wins
        // Case-insensitive: a directory answering `displayname` would otherwise fall
        // through to the cn and quietly overwrite every display name with it.
        value = attrValue(entryAttributes(entry), 'displayName', 'cn');
      });
      res.on('error', (e) => {
        console.error(`  LDAP search error for ${username}: ${e.message}`);
        resolve(null);
      });
      res.on('end', () => resolve(value));
    });
  });
}

function allUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT username, display_name FROM users WHERE origin = 'ldap' ORDER BY username",
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function setDisplayName(username, displayName) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET display_name = ? WHERE username = ?',
      [displayName, username],
      function (err) { return err ? reject(err) : resolve(this.changes); }
    );
  });
}

async function main() {
  const ldapSettings = loadLdapSettings();
  const users = await allUsers();
  console.log(`Found ${users.length} ldap-origin user(s).${DRY_RUN ? ' (dry run)' : ''}`);
  if (users.length === 0) return;

  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  await withBoundClient(ldapSettings, async (client) => {
    // Sequential on purpose: one connection, and a directory should not be hit with
    // N concurrent searches for the sake of a maintenance script.
    for (const user of users) {
      const displayName = await lookupDisplayName(client, ldapSettings, user.username);
      if (!displayName) {
        console.warn(`  ${user.username}: no displayName/cn in the directory — left as-is`);
        missing++;
        continue;
      }
      if (displayName === user.display_name) {
        unchanged++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`  ${user.username}: "${user.display_name || ''}" -> "${displayName}" (not written)`);
        updated++;
        continue;
      }
      await setDisplayName(user.username, displayName);
      console.log(`  ${user.username}: "${user.display_name || ''}" -> "${displayName}"`);
      updated++;
    }
  });

  console.log(`Done. ${updated} ${DRY_RUN ? 'would change' : 'updated'}, ${unchanged} already correct, ${missing} not found.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
