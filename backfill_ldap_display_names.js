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
// Throws rather than calling process.exit(): this runs from inside main(), after
// require('./db') has already opened the pool, so exiting here would skip the
// .finally(() => db.close()) that every other exit path in this file goes through.
function loadLdapSettings() {
  const file = path.join(__dirname, 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const ldapSettings = parsed.ldap || {};
  if (!ldapSettings.url || !ldapSettings.base) {
    throw new Error('settings.json has no LDAP url/base configured. Nothing to sync.');
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
      // Counted so an ambiguous result can be REFUSED rather than resolved
      // arbitrarily, matching the login path, which rejects when more than one entry
      // matches. Taking the first match here would write some other account's display
      // name onto this user.
      let matchCount = 0;
      res.on('searchEntry', (entry) => {
        matchCount++;
        if (value !== null) return;
        // Case-insensitive. Against a directory that lowercases `displayname` but
        // not `cn`, property access would have fallen through to the cn and written
        // that instead; against one that lowercases both, it resolved to nothing and
        // the user was skipped.
        value = attrValue(entryAttributes(entry), 'displayName', 'cn');
      });
      res.on('error', (e) => {
        console.error(`  LDAP search error for ${username}: ${e.message}`);
        resolve(null);
      });
      res.on('end', () => {
        if (matchCount > 1) {
          console.warn(`  ${username}: ${matchCount} directory entries matched — ambiguous, skipping`);
          return resolve(null);
        }
        resolve(value);
      });
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
