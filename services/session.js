// The browser session (ROADMAP SEC-14): issuing, verifying, and the cookie that carries it.
//
// The SPA's session used to be a JWT in localStorage, readable by any script that ever runs
// in the origin. It is now an HttpOnly cookie. Everything about that cookie lives here, so
// the login route, authRequired and the two session routes are adapters over ONE set of
// rules. Like every service, nothing here takes `req`/`res`: it returns values and strings,
// and index.js puts them on the wire.
//
// What deliberately does NOT change:
//   - The credential is still the same 12-hour JWT, so the server stays stateless and the
//     per-request privilege re-read in authRequired still decides everything.
//   - Bearer (Android, scripts, PATs) is untouched. The cookie is opt-in at login.
//   - /api/v2 never reads the cookie: patRequired looks only at Authorization. v2 is
//     PAT-only by design, and a cookie there is the scope-less JWT that design excludes.
//
// Design sign-off conditions (CISO/Architect/UI-UX) are cited by number: ROADMAP SEC-14.
const jwt = require('jsonwebtoken');

const SESSION_TTL_SECONDS = 12 * 60 * 60;

// The CSRF control (condition 2). A cross-origin page cannot add a custom header without a
// CORS preflight, which CORS_ORIGINS denies by default and which never allows credentials
// (condition 3). Sec-Fetch-Site, where the browser sends it, must say same-origin: that
// still holds if CORS is ever misconfigured.
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'GameTracker';

// Condition 1. `__Host-` makes the browser refuse the cookie unless it is Secure, has no
// Domain and has Path=/ -- so a sibling subdomain (anything else on the same registrable
// domain) cannot toss a cookie of this name in to fix a session. Insecure mode cannot use
// the prefix (it requires Secure), so it gets a plain name, and the server reads ONLY the
// name for the mode it is in.
const COOKIE_NAMES = Object.freeze({ secure: '__Host-gt_session', insecure: 'gt_session' });

// Condition 10. unset / '' / '0' = secure (the default); '1' = insecure, for a plain-HTTP LAN
// install whose browser would otherwise drop a Secure cookie. Anything else is a typo that
// must not silently pick either: the caller exits at startup, as for JWT_SECRET.
function cookieMode(value = process.env.SESSION_COOKIE_INSECURE) {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (v === '' || v === '0') return 'secure';
  if (v === '1') return 'insecure';
  throw new Error(`SESSION_COOKIE_INSECURE must be unset, 0 or 1 (got ${JSON.stringify(v.slice(0, 20))})`);
}

// The claims a session carries. One place, so the two login success paths (local and
// directory) cannot drift in what they sign (condition 8).
function claimsFor(user) {
  return {
    id: user.id,
    username: user.username,
    can_manage_users: !!user.can_manage_users,
    origin: user.origin || 'local',
    display_name: user.display_name || user.username,
  };
}

// Sign a session. Returns the token and its `exp` (seconds since the epoch). The exp is
// computed HERE and signed in, rather than read back out of the token: nothing in this
// file decodes a JWT without verifying it (semgrep's jwt-decode-without-verify).
function issue(user, secret, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const token = jwt.sign({ ...claimsFor(user), exp }, secret);
  return { token, exp };
}

// The payload, or null. Never throws: every failure is the same "not a session".
function verify(token, secret) {
  try { return jwt.verify(token, secret); } catch { return null; }
}

// Cookie header -> Map(name -> [values]). A LIST per name, so a duplicate is visible:
// two cookies of one name is either a tossing attempt or a browser in a state nothing
// should guess about (condition 1). Values keep everything after the first '=' and lose
// surrounding double quotes (RFC 6265 permits them). Malformed pairs are skipped.
function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(value);
  }
  return out;
}

// The session cookie for this mode: { token } | { duplicate: true } | null (none sent).
function readSessionCookie(header, mode) {
  const values = parseCookies(header).get(COOKIE_NAMES[mode]);
  if (!values || !values.length) return null;
  if (values.length > 1) return { duplicate: true };
  return values[0] ? { token: values[0] } : null;
}

// Condition 2: null when the request may use its cookie, else the refusal message.
function csrfRefusal(headers = {}) {
  if (headers[CSRF_HEADER] !== CSRF_VALUE) return 'Missing or invalid X-Requested-With header';
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'Cross-site request refused';
  return null;
}

// Set-Cookie values. Max-Age follows the JWT's own exp, so the cookie cannot outlive the
// credential it carries.
function setCookie(token, exp, mode, nowMs = Date.now()) {
  const maxAge = Math.max(0, Math.floor(exp - nowMs / 1000));
  return `${COOKIE_NAMES[mode]}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly;`
    + `${mode === 'secure' ? ' Secure;' : ''} SameSite=Strict`;
}

function clearCookie(mode) {
  return `${COOKIE_NAMES[mode]}=; Path=/; Max-Age=0; HttpOnly;${mode === 'secure' ? ' Secure;' : ''} SameSite=Strict`;
}

// What GET /api/auth/session and a cookie login answer. `user` is the privilege RE-READ from
// the database (req.user), never the JWT's claims, so a revoked admin sees it at once
// (condition 7). `expiresIn` is the server's clock, so the SPA's expiry timer does not
// depend on the device's (condition 17). `cookieSecure` lets the System Status page warn an
// administrator that the instance runs in insecure mode (condition 10); it is no secret --
// anyone signed in can see whether their own cookie is Secure.
function sessionView(user, exp, nowMs = Date.now(), mode = 'secure') {
  return {
    username: user.username,
    can_manage_users: !!user.can_manage_users,
    origin: user.origin || 'local',
    display_name: user.display_name || user.username,
    exp,
    expiresIn: Math.max(0, Math.floor(exp - nowMs / 1000)),
    cookieSecure: mode !== 'insecure',
  };
}

module.exports = {
  SESSION_TTL_SECONDS, CSRF_HEADER, CSRF_VALUE, COOKIE_NAMES,
  cookieMode, claimsFor, issue, verify, parseCookies, readSessionCookie, csrfRefusal,
  setCookie, clearCookie, sessionView,
};
