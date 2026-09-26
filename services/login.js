// The interactive login decision (ROADMAP UP-16, the third slice out of index.js): who, if
// anyone, a username and password sign in as. POST /api/auth/login is an adapter over
// authenticate(): it owns the request checks (CSRF, the cookie opt-in, the lockout), maps
// the outcome to a status, and signs the session. Everything in between is here.
//
// Moved rule for rule from a 330-line route. The rules are the security-relevant part,
// and several were once bypasses, so they are restated where they are enforced below:
//   - an unreachable directory, or one that does not know the name, FALLS BACK to the
//     local password; an AMBIGUOUS match REFUSES and never falls back;
//   - a wrong directory password still falls back (the name may also be local);
//   - an unrecognised verification result never counts as success;
//   - the directory never claims root, me, or a row holding a local hash
//     (user-rules.js#directoryClaimRefusal), asked before the group check and again at
//     provisioning and at the profile write;
//   - once the directory has authenticated the caller, a thrown exception is a 500, never
//     a fallback to local auth -- that would be fail-open on the group check;
//   - the failed-attempt counter is cleared only after authentication AND authorization;
//   - an unreachable directory that alone could decide is an OUTAGE (UP-21): counted
//     against the IP only, never the account.
//
// The route's callback shape had a latch (`authCompleted`) because the bind callback,
// the search callback and the socket error could each trigger the fallback, in any
// order. verifyLdapCredentials resolves once, and this is one async flow, so each path
// returns exactly one outcome and the latch has nothing left to guard.
//
// Rate limiting stays in index.js with the rest of the limiter; this calls back into it
// through `limits` at the same points the route did. Database access goes through the
// `db` MODULE object in the same two forms the route used (the callback shim for the
// user lookup and insert, db.promises for the claim check and profile sync), so the
// contract suite's stubs intercept it exactly as before.
const bcrypt = require('bcryptjs');
const db = require('../db');
const ldapHelpers = require('../ldap-helpers');
const { sanitizeText, isValidEmailAddress, directoryClaimRefusal, safeForLog } = require('../user-rules');

// The outcomes, which the adapter maps to statuses.
const OUTCOMES = Object.freeze({
  OK: 'ok',                                   // 200, a session for `user`
  INVALID: 'invalid',                         // 401 Invalid credentials
  NOT_IN_GROUP: 'not_in_group',               // 403 Not a member of the required group
  DIRECTORY_UNAVAILABLE: 'directory_unavailable', // 503 + Retry-After (UP-21)
  ERROR: 'error',                             // 500 with `message`, the route's own texts
});

const dbGet = (sql, params) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// ONLY for the directory login, where a successful authentication must provision a local
// row for a first-time user. Everything else must use findUser / withExistingUser.
// Resolves the row; rejects with `directoryClaimRefused` set when the name stopped being
// the directory's to claim, or with the database error.
async function getOrCreateDirectoryUser(username, displayName) {
  const normalizedUsername = username ? username.toLowerCase() : '';
  const user = await dbGet('SELECT * FROM users WHERE username = ?', [normalizedUsername]);
  // Asked AGAIN here, though the login asked before the group check: the row it saw may
  // not be the row that exists now -- an administrator creating a local account of the
  // same name in between must not have it claimed.
  const refusal = directoryClaimRefusal(normalizedUsername, user || null);
  if (refusal) throw Object.assign(new Error('directory may not claim this username'), { directoryClaimRefused: refusal });
  // No write for an EXISTING row here: the login's awaited profile sync is the one write
  // (ROADMAP CC-12).
  if (user) return user;
  const displayNameToUse = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : normalizedUsername;
  console.log('Creating user:', { username: safeForLog(normalizedUsername, 64), display_name: safeForLog(displayNameToUse, 64), origin: 'ldap' });
  // RETURNING id: Postgres does not hand back an insert id implicitly (db.js divergence #2).
  const createdAt = new Date().toISOString();
  const id = await new Promise((resolve, reject) => {
    db.run('INSERT INTO users (username, created_at, origin, display_name) VALUES (?, ?, ?, ?) RETURNING id',
      [normalizedUsername, createdAt, 'ldap', displayNameToUse],
      function (err) { if (err) reject(err); else resolve(this.lastID); });
  });
  return { id, username: normalizedUsername, created_at: createdAt, origin: 'ldap', display_name: displayNameToUse };
}

// The local password decides. Never throws: every failure is an outcome.
// `directoryUnreachable`: only the directory could have decided a row with no local hash
// (or no row at all), and it could not be reached -- an outage, not a wrong password.
async function localAuth(username, password, limits, directoryUnreachable) {
  console.log('[Auth] Using fallback local authentication for user:', safeForLog(username, 64));
  const outage = () => {
    limits.failIpOnly();
    console.log(`[Auth] Directory unreachable; '${safeForLog(username, 64)}' cannot be verified locally. Answering 503.`);
    return { status: OUTCOMES.DIRECTORY_UNAVAILABLE };
  };
  let user;
  try {
    user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  } catch (err) {
    console.error('[Auth] Database error during user lookup:', err);
    return { status: OUTCOMES.ERROR, message: 'Database error' };
  }
  if (!user) {
    if (directoryUnreachable) return outage();
    console.log('[Auth] Local user not found:', safeForLog(username, 64));
    limits.fail();
    return { status: OUTCOMES.INVALID };
  }
  console.log('[Auth] Found user in database:', { id: user.id, username: safeForLog(user.username, 64), origin: user.origin });
  try {
    // A directory account has no local password: refuse cleanly rather than crash bcrypt.
    // Why goes to the server log only -- telling the client this is a directory account
    // confirms the name exists and hands over a target list for spraying.
    if (!user.password || typeof user.password !== 'string') {
      if (directoryUnreachable) return outage();
      console.log(`[Auth] User '${safeForLog(username, 64)}' has no local password (origin=${user.origin}). Local auth not possible.`);
      limits.fail();
      return { status: OUTCOMES.INVALID };
    }
    const valid = await bcrypt.compare(String(password), user.password);
    if (!valid) {
      console.log('[Auth] Local password validation failed for user:', safeForLog(username, 64));
      limits.fail();
      return { status: OUTCOMES.INVALID };
    }
    console.log('[Auth] Password validation successful for user:', safeForLog(username, 64));
    limits.clear();
    return { status: OUTCOMES.OK, user };
  } catch (bcryptError) {
    console.error('[Auth] Error during password comparison:', bcryptError);
    return { status: OUTCOMES.ERROR, message: 'Authentication error' };
  }
}

// After the directory authenticated the caller: claim check, group check, provisioning and
// the profile sync. Throws only on a defect or a database failure of the claim check,
// which the caller turns into a 500 (never a fallback).
async function afterDirectoryVerified(username, password, ldapSettings, foundUser, limits) {
  const fallBack = () => localAuth(username, password, limits, false);

  // Is this username the DIRECTORY's to sign in as? Asked BEFORE the group check and
  // before the counter is cleared: a directory account named after a local admin must not
  // be able to reset that admin's lockout between password guesses. Falling back grants
  // nothing -- local auth demands the LOCAL password.
  const existing = await db.promises.get('SELECT origin, password FROM users WHERE username = ?', [username]);
  const claimRefusal = directoryClaimRefusal(username, existing || null);
  if (claimRefusal) {
    console.warn(`[LDAP] Directory authenticated '${safeForLog(username, 64)}', but that username is not a directory account (${claimRefusal}). Using local authentication instead.`);
    return fallBack();
  }

  // Group membership (authorization). The counter is NOT cleared yet: someone outside the
  // group is not authorized, and clearing here would let them reset the throttle at will.
  if (ldapSettings.requiredGroup) {
    console.log('[LDAP] User is member of groups:', ldapHelpers.attrValues(foundUser, 'memberOf'));
    if (!ldapHelpers.satisfiesRequiredGroup(foundUser, ldapSettings.requiredGroup)) {
      console.log(`[LDAP] Authorization failed: User is not in required group '${ldapSettings.requiredGroup}'.`);
      return { status: OUTCOMES.NOT_IN_GROUP };
    }
    console.log('[LDAP] Authorization passed: Group membership check OK.');
  }
  // Fully authenticated AND authorized: now it is safe to clear.
  limits.clear();

  let cnValue = ldapHelpers.attrValue(foundUser, 'cn');
  if (!cnValue && foundUser.dn) {
    const match = foundUser.dn.match(/CN=([^,]+)/i);
    if (match) cnValue = match[1];
  }
  // Sanitised before it becomes users.display_name: a cn with newlines was stored verbatim
  // and rendered in the UI, notification subjects and exports.
  const cleanCn = sanitizeText(cnValue);
  const displayName = cleanCn !== '' ? cleanCn : username;
  const userEmail = ldapHelpers.attrValue(foundUser, 'mail', 'email');
  // safeForLog: raw directory attribute values. ldapjs escapes control characters inside a
  // DN but NOT inside attributes.
  console.log('[DEBUG] Extracted cnValue:', safeForLog(cnValue));
  console.log('[DEBUG] Final displayName:', safeForLog(displayName));
  console.log('[DEBUG] User email from LDAP:', safeForLog(userEmail));

  let user;
  try {
    user = await getOrCreateDirectoryUser(username, displayName);
  } catch (err) {
    if (err && err.directoryClaimRefused) {
      console.warn(`[LDAP] Username '${safeForLog(username, 64)}' stopped being claimable during login (${err.directoryClaimRefused}). Using local authentication instead.`);
      return fallBack();
    }
    return { status: OUTCOMES.ERROR, message: 'DB error' };
  }

  const updates = ['display_name = ?, origin = ?'];
  const params = [displayName, 'ldap'];
  // Validated at THIS write site too: a directory address smuggling a comma reached
  // users.email and could fan notifications out to arbitrary third parties.
  if (isValidEmailAddress(userEmail)) {
    updates.push('email = ?');
    params.push(userEmail.trim());
  } else if (userEmail) {
    console.warn('[LDAP] Ignoring malformed email from directory:', safeForLog(userEmail));
  }
  params.push(username);
  // AWAITED (CC-12). A failure is logged but does not refuse the login: the directory has
  // authenticated this person, and the profile sync is not what authorizes them.
  try {
    // `AND password IS NULL` makes the WRITE re-check the claim rule: a local hash set on
    // this row after the claim check must not have the row relabelled origin='ldap'.
    const synced = await db.promises.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ? AND password IS NULL`, params);
    // ZERO rows: the row stopped being the directory's since the claim check. The session
    // would still be signed for it, so the LOCAL password decides instead.
    if (synced.changes === 0) {
      console.warn(`[LDAP] '${safeForLog(username, 64)}' stopped being a directory account during login. Using local authentication instead.`);
      return fallBack();
    }
  } catch (syncErr) {
    console.error('[LDAP] Could not sync profile for', safeForLog(username, 64), '-', syncErr.message);
  }
  return { status: OUTCOMES.OK, user: { ...user, origin: 'ldap', display_name: displayName } };
}

// The whole decision. `username` is already normalised (lower case) and non-empty, and the
// caller has already refused a locked-out client. `limits` = { fail, failIpOnly, clear }.
async function authenticate({ username, password, ldapSettings }, { limits }) {
  if (!ldapHelpers.isLdapConfigured(ldapSettings)) {
    console.log('[Auth] LDAP not properly configured. Using local authentication.');
    return localAuth(username, password, limits, false);
  }

  // Set once the directory has authenticated the caller: past this point a defect must be
  // a 500, never a fallback to local auth.
  let directoryVerified = false;
  try {
    // Through the module, so a test can stand in for the directory.
    const result = await ldapHelpers.verifyLdapCredentials(ldapSettings, username, password);

    // FALL BACK: an outage must not lock out local accounts, and a name the directory does
    // not know may still be a local one.
    if (result.reason === 'unreachable' || result.reason === 'not_found') {
      return localAuth(username, password, limits, result.reason === 'unreachable');
    }
    // REFUSE on ambiguity -- never fall back, never guess which identity was meant.
    if (result.reason === 'ambiguous') {
      console.error(`[LDAP] Ambiguous login: ${result.dns.length} entries matched username '${safeForLog(username, 64)}'. Refusing to authenticate.`);
      const advice = ldapHelpers.compatTreeAdvice(result.dns, ldapSettings.base);
      if (advice) console.error(`[LDAP] ${advice}`);
      limits.fail();
      return { status: OUTCOMES.INVALID };
    }
    // A wrong directory password still falls back: the name may also exist locally.
    if (result.reason === 'bad_password') {
      limits.fail();
      return localAuth(username, password, limits, false);
    }
    // POSITIVE test: a future non-ok reason that carries an entry must never be a success.
    if (!result.ok) {
      console.error('[LDAP] Unrecognised verification result, refusing:', result.reason);
      return localAuth(username, password, limits, false);
    }
    directoryVerified = true;
    console.log('[LDAP] User password authentication succeeded.');
    return await afterDirectoryVerified(username, password, ldapSettings, result.entry, limits);
  } catch (err) {
    // verifyLdapCredentials never rejects, so this is a defect in the handling above.
    console.error('[LDAP] Unexpected error handling the directory result:', err);
    // AFTER the directory authenticated, a bug is a 500: falling back would let an
    // exception in the group test hand a session to someone the directory refused.
    if (directoryVerified) return { status: OUTCOMES.ERROR, message: 'Authentication error' };
    // BEFORE it spoke, falling back is right: a bug must not be a total login outage.
    return localAuth(username, password, limits, false);
  }
}

module.exports = { OUTCOMES, authenticate, localAuth, getOrCreateDirectoryUser };
