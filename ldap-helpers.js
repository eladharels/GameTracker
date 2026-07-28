// Shared LDAP primitives.
//
// These lived in index.js, which meant an operator script could only reach them by
// `require`ing the entire Express app (and with it the schema migration, the root-user
// seed and every route registration). The scripts that needed them therefore did not
// bother, and hand-rolled their own unescaped filter and listener-less client instead
// -- reintroducing, in backfill_ldap_display_names.js and test_ldap_sync.js, the exact
// two defects that were fixed in the server months earlier.
//
// One implementation, one place. index.js imports these rather than owning them; its
// own module.exports surface is unchanged.

const ldap = require('ldapjs');

// --- LDAP filter escaping (RFC 4515) ---
// A username goes straight into an LDAP search filter, so any of the filter
// metacharacters must be escaped or the caller can rewrite the filter. Without
// this, `username=*` matches every entry in the directory and the search picks an
// arbitrary one; `)(uid=admin` splices in a whole extra assertion.
// Backslash MUST be replaced first, or we would double-escape our own output.
function escapeLdapFilterValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

// Build the "find this user" filter used by both the login and the email lookup.
// Active Directory keys on sAMAccountName, FreeIPA on uid — match either.
function buildUserSearchFilter(username) {
  const safe = escapeLdapFilterValue(username);
  return `(|(sAMAccountName=${safe})(uid=${safe}))`;
}

// Create an ldapjs client that cannot take the process down.
//
// ldapjs Client is an EventEmitter that emits 'error' on socket-level failures
// (ECONNREFUSED, ETIMEDOUT, TCP reset, TLS failure). With no 'error' listener,
// Node treats that as an uncaught exception and EXITS — so an unreachable domain
// controller turned any anonymous POST /api/auth/login into a remote process kill,
// and one /api/admin/ldap-sync against a down directory was a guaranteed crash.
// The bind callback fires *first*, so the request itself often looked fine right
// before the server died. Every crash also wiped the in-memory login rate-limit
// counters, handing an attacker a lockout reset.
//
// `onError` lets a caller fail over (e.g. to local auth) exactly once.
function createLdapClient(url, onError) {
  const client = ldap.createClient({
    url,
    timeout: 10000,
    connectTimeout: 10000,
    reconnect: false,
  });
  let handled = false;
  client.on('error', (err) => {
    console.error('[LDAP] Client error:', err.message);
    try { client.destroy(); } catch { /* already gone */ }
    if (!handled) {
      handled = true;
      if (typeof onError === 'function') onError(err);
    }
  });
  // Mark the failover as spent once the caller has moved on, so a late socket
  // error cannot fire a second response on the same request.
  client.markHandled = () => { handled = true; };
  return client;
}

// Warn loudly about cleartext LDAP. A simple bind sends the user's password (and
// the service-account password) unencrypted in the BER payload, so plain `ldap://`
// exposes directory credentials to any passive observer on the path. We warn
// rather than refuse, because refusing would lock out an existing deployment
// mid-upgrade — but this should be `ldaps://` (or StartTLS) in any real network.
// Keyed on the URL, not a bare boolean. A single latch warned about the first
// cleartext URL it ever saw and then stayed silent — so an operator who fixed one URL
// and later introduced a second cleartext one got nothing. index.js reloads
// settings.json whenever its mtime changes, so that is a reachable sequence.
const warnedCleartextUrls = new Set();
function warnIfCleartextLdap(url) {
  if (!url) return;
  const key = String(url).trim().toLowerCase();
  if (warnedCleartextUrls.has(key)) return;
  if (/^ldap:\/\//i.test(String(url).trim())) {
    warnedCleartextUrls.add(key);
    console.warn('[LDAP] WARNING: connecting over cleartext ldap://. Bind passwords ' +
      '(including the service account and every user password) traverse the network ' +
      'unencrypted. Switch the LDAP URL to ldaps:// — see SECURITY_HARDENING_2026-07.md.');
  }
}

// --- FreeIPA / 389-ds compatibility-tree mirrors ---
//
// FreeIPA's Schema Compatibility plugin republishes every account under cn=compat
// for legacy clients, so a subtree search from the domain root returns each user
// TWICE:
//
//   uid=jane,cn=users,cn=accounts,dc=example,dc=com   <- the real entry
//   uid=jane,cn=users,cn=compat,dc=example,dc=com     <- the mirror
//
// Those are one person, but the login path cannot know that: it sees two matches
// for one username and refuses to authenticate rather than bind as an arbitrarily
// chosen DN. Correct behaviour, wrong input — so drop the mirror BEFORE the
// ambiguity check rather than loosening the check.
//
// !! NOTHING BELOW FILTERS THE AUTHENTICATION RESULT SET. THIS IS DIAGNOSTIC ONLY. !!
//
// Two attempts were made to resolve the duplicate automatically, and BOTH were
// authentication bypasses:
//
//   1. "Drop anything under cn=compat." FreeIPA with an AD trust publishes
//      trusted-domain users under cn=compat and NOWHERE ELSE, so this deleted the
//      real user. An attacker holding any colliding entry became the sole match and
//      was issued a session with their own password. Measured 401 -> 200.
//
//   2. "Drop a cn=compat entry only when its cn=accounts counterpart is present,
//      proving it redundant." The attacker simply CREATES the counterpart:
//      given real `uid=karen,cn=users,cn=compat,...`, planting
//      `uid=karen,cn=users,cn=accounts,...` makes the real entry look like a
//      redundant mirror. It is dropped, the attacker is the sole match, and the
//      legitimate user is simultaneously locked out. Measured 401 -> 200.
//
// The defect both share: a DN is a NAME, not evidence. Whatever shape the code
// treats as proof of "these two entries are the same person", an attacker who can
// create a directory entry can produce that shape. There is no string test over
// DNs that fixes this, so no third variant should be attempted.
//
// The duplicate is a CONFIGURATION problem and is fixed in configuration: point
// ldap.base at the accounts subtree (e.g. cn=accounts,dc=example,dc=com) so the
// compat mirror is never in search scope. The login path keeps its unconditional
// "refuse when more than one entry matches" guard, which is fail-closed and cannot
// be tricked. isCompatMirrorDn exists only so an operator whose base is too broad
// is TOLD that, instead of staring at an unexplained login failure.
function isCompatMirrorDn(dn) {
  return /(^|,)\s*cn=compat\s*(,|$)/i.test(String(dn == null ? '' : dn));
}

// Remediation advice for an ambiguous match, or null when the compat tree is not
// what caused it. Returned as text rather than logged here so the caller controls
// where it goes.
function compatTreeAdvice(dns, configuredBase) {
  if (!Array.isArray(dns) || !dns.some(isCompatMirrorDn)) return null;
  // Deliberately does NOT nominate one of the matched DNs as "the real one".
  // An earlier draft pointed at the first non-compat entry, which in the very attack
  // this guard exists to stop is the ATTACKER's DN — advice telling an operator to
  // trust the attacker's entry is worse than no advice.
  return (
    `The search base ${configuredBase ? `'${configuredBase}' ` : ''}includes a cn=compat subtree, ` +
    'which republishes accounts that also exist elsewhere, so a single user can match twice. ' +
    'Narrow the LDAP base to the accounts subtree — e.g. cn=accounts,dc=example,dc=com. ' +
    'This is deliberately NOT resolved automatically: a DN cannot prove two entries are the ' +
    'same person, and both attempts to infer it were authentication bypasses.'
  );
}

// --- Search-entry attribute access ---
//
// Two problems with reading `entry.attributes` by hand, both of which this file's
// callers had:
//
//  1. `attr.vals` is DEPRECATED in ldapjs 3.x (it warns on every access) in favour
//     of `attr.values`. When it is eventually removed, every LDAP login breaks.
//  2. Attribute descriptors are CASE-INSENSITIVE -- RFC 4512 §2.5. A directory is
//     free to answer `memberof` where the schema says `memberOf`, and
//     `attributes[attr.type]` then leaves `foundUser.memberOf` undefined. For the
//     requiredGroup check that means the membership list reads as empty and every
//     login is refused; for the sync it means display names silently fall back to
//     the cn. Both look like a directory problem rather than a code one.
//
// Build the map with entryAttributes(), then read it with attrValue()/attrValues()
// rather than by property access, and neither problem can recur.
function entryAttributes(entry) {
  // Null prototype: attribute names come off the wire, and a directory serving an
  // attribute called `__proto__` or `constructor` must not reach Object.prototype.
  const out = Object.create(null);
  for (const attr of (entry && entry.attributes) || []) {
    const values = attr.values || attr.vals || [];
    out[attr.type] = values.length === 1 ? values[0] : values;
  }
  return out;
}

// Every value for the first of `names` that is present, always as an array.
// Use for multi-valued attributes such as memberOf.
function attrValues(attrs, ...names) {
  if (!attrs) return [];
  const lower = Object.create(null);
  for (const key of Object.keys(attrs)) lower[key.toLowerCase()] = attrs[key];
  for (const name of names) {
    const value = lower[String(name).toLowerCase()];
    if (value === undefined || value === null || value === '') continue;
    return Array.isArray(value) ? value : [value];
  }
  return [];
}

// The first value of the first of `names` that is present, or null.
function attrValue(attrs, ...names) {
  const values = attrValues(attrs, ...names);
  return values.length ? values[0] : null;
}

// --- Verify a directory password -------------------------------------------------
//
// THE ONLY PLACE IN THIS CODEBASE THAT BINDS AS A USER. Everything else that touches
// the directory (directory.js, the backfills, test_ldap_sync.js) binds as the service
// account to READ; this is the one that proves someone knows a password.
//
// It exists because there are now two callers — the interactive login and the sudo-mode
// re-check that guards minting a personal access token — and the alternative was a
// second copy of the sequence below. Two of this function's branches were once
// authentication BYPASSES (see the ambiguity refusal, and ldap-helpers' notes on
// cn=compat), so a second copy is a second thing that has to stay correct forever.
//
// Deliberately does steps 1-3 ONLY: resolve the username to exactly one entry, then
// bind as that entry. It does NOT check group membership, create or sync the local
// user, or issue anything. Those are authorization and session concerns that differ
// between the two callers, and folding them in here is what would make this
// unreusable again.
//
// Returns a DISCRIMINATED result rather than a boolean, because the callers must treat
// the failures differently — login falls back to local auth on `unreachable` and
// `not_found`, but must REFUSE on `ambiguous`. Collapsing them would turn a directory
// outage into "wrong password" and, worse, turn an ambiguous match into a fallback.
//
//   { ok: true,  entry }                  password verified; entry is attribute-mapped
//   { ok: false, reason: 'unreachable' }  socket/service-bind/search failure
//   { ok: false, reason: 'not_found' }    no entry matched the username
//   { ok: false, reason: 'ambiguous', dns } more than one matched — caller MUST refuse
//   { ok: false, reason: 'bad_password' } entry found, bind as that entry rejected
//
// Never rejects. A thrown error here would land in whichever caller's chain, and one
// of them is a login route where an unhandled rejection used to take the process down.
function verifyLdapCredentials(ldapSettings, username, password) {
  return new Promise((resolve) => {
    // SETTLE-ONCE LATCH. The bind callback, the search callback and the client's
    // 'error' event are three independent signals that do NOT arrive in a fixed
    // order — on a refused connection the socket error usually beats the bind
    // callback. Without this the login route resolved twice and threw
    // ERR_HTTP_HEADERS_SENT. A Promise only settles once, but the cleanup below
    // (markHandled/unbind) must also happen exactly once.
    let settled = false;
    const done = (result, client) => {
      if (settled) return;
      settled = true;
      if (client) {
        try { client.markHandled(); client.unbind(); } catch { /* already gone */ }
      }
      resolve(result);
    };

    // An empty password is a special case that MUST NOT reach the directory. LDAP
    // treats a simple bind with an empty password as an ANONYMOUS bind and returns
    // success, so `bind(userDn, '')` would report that any existing user's password
    // is correct. This is the classic LDAP unauthenticated-bind bypass.
    if (typeof password !== 'string' || password === '') {
      return done({ ok: false, reason: 'bad_password' }, null);
    }

    warnIfCleartextLdap(ldapSettings.url);
    const client = createLdapClient(ldapSettings.url, () =>
      done({ ok: false, reason: 'unreachable' }, null));

    // 1. Bind as the service account.
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed:', err.message);
        return done({ ok: false, reason: 'unreachable' }, client);
      }

      // 2. Find the user. The username is RFC 4515-escaped by buildUserSearchFilter,
      // so it cannot alter the filter's structure.
      const searchOptions = {
        filter: buildUserSearchFilter(username),
        scope: 'sub',
        attributes: ['dn', 'memberOf', 'displayName', 'cn', 'mail', 'email'],
      };
      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search initiation failed:', err.message);
          return done({ ok: false, reason: 'unreachable' }, client);
        }

        // Entries are BUFFERED rather than folded down as they arrive. Whether a
        // cn=compat entry is a redundant mirror or somebody's only account cannot be
        // judged from that entry alone — it depends on whether its cn=accounts
        // counterpart is elsewhere in the same result set. Deciding per entry is what
        // made the first version of this an authentication bypass.
        const rawEntries = [];
        searchRes.on('searchEntry', (entry) => rawEntries.push(entry));
        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during processing:', err.message);
          return done({ ok: false, reason: 'unreachable' }, client);
        });

        searchRes.on('end', () => {
          // NOTHING IS FILTERED OUT HERE, deliberately. Two attempts to recognise and
          // discard FreeIPA's cn=compat duplicate were both authentication bypasses,
          // because a DN is a name rather than evidence: any shape treated as proof
          // that two entries are the same person can be created by an attacker who can
          // add a directory entry. Every matched entry counts, and the fail-closed
          // ambiguity refusal below decides.
          if (rawEntries.length === 0) {
            return done({ ok: false, reason: 'not_found' }, client);
          }
          if (rawEntries.length > 1) {
            // A username must identify exactly one entry. Binding as an arbitrary
            // matched DN is an authentication bug — the old code silently kept
            // whichever arrived last.
            return done({
              ok: false,
              reason: 'ambiguous',
              dns: rawEntries.map((e) => e.dn.toString()),
            }, client);
          }

          // Read attributes with attrValue/attrValues, never by property access —
          // the keys carry whatever casing the directory sent.
          const entry = { dn: rawEntries[0].dn.toString(), ...entryAttributes(rawEntries[0]) };
          // Log the DN only. Dumping the whole entry put mail addresses and full group
          // membership into shared logs for every single login.
          console.log('[LDAP] Resolved to DN:', entry.dn);

          // 3. Bind AS THAT ENTRY. This is the step that verifies the password.
          client.bind(entry.dn, password, (err) => {
            if (err) {
              console.log('[LDAP] User password authentication failed:', err.message);
              return done({ ok: false, reason: 'bad_password' }, client);
            }
            return done({ ok: true, entry }, client);
          });
        });
      });
    });
  });
}

module.exports = {
  verifyLdapCredentials,
  escapeLdapFilterValue,
  buildUserSearchFilter,
  createLdapClient,
  warnIfCleartextLdap,
  entryAttributes,
  attrValue,
  attrValues,
  isCompatMirrorDn,
  compatTreeAdvice,
};
