// The admin LDAP sync (ROADMAP UP-16, the second slice out of index.js): re-read every
// ldap-origin account's display name and email from the directory and write back what
// changed. POST /api/admin/ldap-sync is an adapter over syncAll().
//
// Moved from a 230-line route whose body was a db.all CALLBACK wrapping a for-loop of
// hand-built promises. The behaviour is the same, rule for rule:
//   - one client per user, closed on EVERY path (the early-return reject paths once leaked
//     a socket per failing user);
//   - more than one matching entry is AMBIGUOUS and writes nothing -- reported distinctly,
//     because "found twice" and "not there" are opposite diagnoses with opposite remedies;
//   - the SAME sanitising and email validation as the login path, the other writer of
//     display_name/email from directory data (user-rules.js);
//   - the response shape is v1's and frozen: {total, updated, errors[], details[]}.
//
// Like every service: no req/res. It throws ServiceError for "not configured" and lets a
// database failure on the initial read propagate; a failure for ONE user is recorded
// against that user and the run continues.
const db = require('../db');
const ldapHelpers = require('../ldap-helpers');
const { sanitizeText, isValidEmailAddress, safeForLog } = require('../user-rules');
const { serviceError, CODES } = require('./errors');

const AMBIGUOUS = Symbol('ambiguous-ldap-match');

// The four settings a service-account read needs, each non-blank.
function isConfigured(ldap) {
  return ['url', 'base', 'bindDn', 'bindPass']
    .every((k) => typeof ldap?.[k] === 'string' && ldap[k].trim() !== '');
}

// One user's directory attributes: an attribute map, null (no entry), or AMBIGUOUS.
// Rejects on a bind/search/socket failure. The client is closed whatever happens.
async function lookupUser(ldap, username) {
  let client = null;
  try {
    ldapHelpers.warnIfCleartextLdap(ldap.url);
    await new Promise((resolve, reject) => {
      // Without an 'error' listener an unreachable directory is a process crash.
      client = ldapHelpers.createLdapClient(ldap.url, (err) => reject(err));
      client.bind(ldap.bindDn, ldap.bindPass, (err) => {
        if (err) reject(new Error(`LDAP bind failed: ${err.message}`));
        else resolve();
      });
    });
    return await new Promise((resolve, reject) => {
      // Escaped even though the username comes from our own table: ldap-origin rows are
      // created from directory data, so this is second-order untrusted input.
      const options = {
        filter: ldapHelpers.buildUserSearchFilter(username),
        scope: 'sub',
        attributes: ['displayName', 'mail', 'sAMAccountName', 'uid'],
      };
      client.search(ldap.base, options, (err, searchRes) => {
        if (err) return reject(new Error(`LDAP search failed: ${err.message}`));
        // Buffered, so the count decides -- resolving on the first entry could not see
        // a second one. No compat filtering: see ldap-helpers.js.
        const entries = [];
        searchRes.on('searchEntry', (entry) => entries.push(entry));
        searchRes.on('error', (e) => reject(new Error(`LDAP search error: ${e.message}`)));
        searchRes.on('end', () => {
          if (!entries.length) return resolve(null);
          if (entries.length > 1) return resolve(AMBIGUOUS);
          return resolve(ldapHelpers.entryAttributes(entries[0]));
        });
      });
    });
  } finally {
    if (client) {
      try { client.markHandled(); client.unbind(); } catch { /* already closed */ }
    }
  }
}

// What the directory says should change on this row. Pure. `columns` lists the changed
// columns in a FIXED order, and only ever these two names, so the UPDATE built from it
// never interpolates anything that came from the directory.
//
// No `cn` fallback for the display name, though the login path has one: adding it would
// change what gets written for users with no displayName, which is a policy decision.
function planUpdate(user, attrs) {
  const displayName = sanitizeText(ldapHelpers.attrValue(attrs, 'displayName')) || user.username;
  const mail = ldapHelpers.attrValue(attrs, 'mail', 'email');
  const email = isValidEmailAddress(mail) ? mail.trim() : user.email;
  const set = [];
  if (displayName !== user.display_name) set.push(['display_name', displayName]);
  if (email !== user.email) set.push(['email', email]);
  return { columns: set.map(([c]) => c), values: set.map(([, v]) => v) };
}

// The whole run. `ldap` is settings.ldap. `deps.lookup` replaces the directory in tests.
async function syncAll(ldap, { lookup = lookupUser } = {}) {
  if (!isConfigured(ldap)) throw serviceError(CODES.VALIDATION, 'LDAP is not properly configured');

  const users = await db.promises.all(
    "SELECT id, username, email, display_name FROM users WHERE origin = 'ldap'",
  );
  const results = { total: users.length, updated: 0, errors: [], details: [] };

  for (const user of users) {
    try {
      const attrs = await lookup(ldap, user.username);
      if (attrs === AMBIGUOUS) {
        console.warn(`[LDAP Sync] More than one entry matched '${safeForLog(user.username, 64)}'; skipping.`);
        results.details.push({ username: user.username, action: 'ambiguous_ldap_match', changes: [] });
      } else if (!attrs) {
        results.details.push({ username: user.username, action: 'not_found_in_ldap', changes: [] });
      } else {
        const { columns, values } = planUpdate(user, attrs);
        if (!columns.length) {
          results.details.push({ username: user.username, action: 'no_changes', changes: [] });
        } else {
          try {
            await db.promises.run(
              `UPDATE users SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
              [...values, user.id],
            );
          } catch (err) {
            throw new Error(`Database update failed: ${err.message}`);
          }
          results.updated++;
          results.details.push({ username: user.username, action: 'updated', changes: columns });
        }
      }
    } catch (err) {
      // Both values can carry directory text: ldap-origin usernames came from login input,
      // and an ldapjs message can quote the server's diagnostic.
      console.error(`[LDAP Sync] Error processing ${safeForLog(user.username, 64)}:`, safeForLog(err.message));
      results.errors.push({ username: user.username, error: err.message });
      results.details.push({ username: user.username, action: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = { AMBIGUOUS, isConfigured, lookupUser, planUpdate, syncAll };
