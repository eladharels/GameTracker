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
// !! A cn=compat DN IS NOT PROOF OF A MIRROR. !!
//
// The obvious implementation — "drop anything under cn=compat" — is an
// authentication BYPASS, and shipped here once. FreeIPA with an Active Directory
// trust publishes trusted-domain users under cn=compat and NOWHERE ELSE; the same
// is true of any 389-ds slapi-nis compat tree fed from a non-IPA source. For such an
// account there is no cn=accounts counterpart, so a blanket drop deletes the REAL
// user from the result set. An attacker who controls any other entry answering the
// same username is then the only remaining match, sails through the ambiguity guard
// with matchCount == 1, and is issued a session as that user — using their own
// password. Measured: HTTP 401 before the blanket filter, HTTP 200 after.
//
// So a mirror is only discarded when the entry it mirrors is ACTUALLY PRESENT in the
// same result set. That is what makes it provably a duplicate rather than the only
// copy of somebody's account.
function isCompatMirrorDn(dn) {
  return /(^|,)\s*cn=compat\s*(,|$)/i.test(String(dn == null ? '' : dn));
}

// The cn=accounts DN that a given cn=compat DN would be a mirror of.
function canonicalCounterpartDn(dn) {
  return String(dn == null ? '' : dn).toLowerCase()
    .replace(/(^|,)(\s*)cn=compat(\s*)(?=,|$)/i, '$1$2cn=accounts$3');
}

// Given every DN a user search returned, drop only those cn=compat entries whose
// cn=accounts counterpart is also present. Everything else is kept — including a
// compat-only account, which therefore still counts toward the ambiguity check and
// still causes a refusal when it collides with another entry.
//
// Pure and order-preserving so it can be tested without a directory.
function dropPairedCompatMirrors(dns) {
  const present = new Set(dns.map((d) => String(d == null ? '' : d).toLowerCase()));
  return dns.filter((dn) => {
    if (!isCompatMirrorDn(dn)) return true;
    // Keep the mirror unless the thing it mirrors is right here beside it.
    return !present.has(canonicalCounterpartDn(dn));
  });
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

module.exports = {
  escapeLdapFilterValue,
  buildUserSearchFilter,
  createLdapClient,
  warnIfCleartextLdap,
  entryAttributes,
  attrValue,
  attrValues,
  isCompatMirrorDn,
  canonicalCounterpartDn,
  dropPairedCompatMirrors,
};
