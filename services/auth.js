// Personal access tokens: minting, verification, and the authorization scope rule.
//
// Promise-based, no req/res. See services/shares.js for why the service layer exists.
//
// DELIBERATELY NOT IN THIS FILE: the interactive login flow. `/api/auth/login` is
// ~319 lines of nested LDAP callbacks in index.js and it stays there for now. /api/v2
// will have NO login endpoint at all — it accepts tokens only, minted by
// create-api-token.js — so extracting that pyramid is not a prerequisite for the v2
// spec, and doing it under time pressure on the most security-sensitive path in the
// project is how the two-implementations-of-login failure happens. See
// API_V2_DESIGN.md D1.
//
// THE ONE RULE THAT MATTERS HERE: a scope may only ever NARROW what the underlying
// account can do. It can never grant. `authorize()` intersects the token's scopes
// with the privilege freshly read from `users`, so a `library`-scoped token held by
// an administrator is not an administrator, and an `admin`-scoped token held by a
// demoted user is not either. Anything that computes privilege from the token alone
// reintroduces exactly the frozen-authorization bug that made authRequired re-read
// the database in the first place.

const crypto = require('crypto');
const db = require('../db');
// Called through `db.promises` rather than destructured at module load, so the SQL
// this file issues is OBSERVABLE to a test — the revocation query's owner scoping
// and the listing's exclusion of token_hash are both properties of the statement
// text, and a destructured binding cannot be stubbed. Same reason as
// services/users.js#listAll.
const { serviceError, CODES } = require('./errors');
const { sanitizeText } = require('../user-rules');

// `gt_` identifies the issuer, `pat_` the credential type. A recognisable prefix is
// not decoration: it is what lets a secret scanner match these in a commit or a log
// before they are used, and what lets authRequired route a credential to the right
// verifier without guessing.
const TOKEN_PREFIX = 'gt_pat_';

// 256 bits from a CSPRNG. Enough that offline guessing is not a threat model, which
// is what justifies a fast hash on the request path — see migrations/003.
const TOKEN_BYTES = 32;

const SCOPES = Object.freeze({ LIBRARY: 'library', ADMIN: 'admin' });
const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

const MAX_NAME_LENGTH = 60;

// A token is a bearer secret; this file must never log or return one after minting.
const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

// Cheap shape test used to ROUTE a credential, never to authorize one. A value that
// looks like a PAT is still verified; a value that does not is treated as a JWT.
const looksLikePat = (credential) => typeof credential === 'string' && credential.startsWith(TOKEN_PREFIX);

// An empty result is an error: a token with no scopes would authenticate while being
// unable to do anything, which reads to its holder as a broken server rather than as
// a bad request.
//
// `strict` decides what an UNRECOGNISED name means, and both answers are right in
// their own place. Re-reading a stored row: drop it, because a value that is no
// longer a scope must not keep granting anything. Accepting one a human just typed:
// refuse, because silently minting a weaker token than the operator asked for is how
// they discover the mistake at the worst possible moment.
//
// The option lives HERE and not in the caller because the CLI already implemented
// this refusal itself, and the coming Settings -> API Tokens route would have had to
// remember to reimplement it — two callers, one rule, one copy each. That is the
// drift this project keeps paying for.
//
// SORTED, so the stored form is canonical and migrations/003 can CHECK it.
function normaliseScopes(requested, { strict = false } = {}) {
  const list = Array.isArray(requested) ? requested : [SCOPES.LIBRARY];
  const cleaned = [...new Set(list.map((s) => String(s).trim().toLowerCase()))];
  if (strict) {
    for (const scope of cleaned) {
      if (!ALL_SCOPES.includes(scope)) {
        throw serviceError(CODES.VALIDATION,
          `unknown scope '${scope}'. Valid scopes: ${ALL_SCOPES.join(', ')}`, { field: 'scopes' });
      }
    }
  }
  const kept = cleaned.filter((s) => ALL_SCOPES.includes(s)).sort();
  if (kept.length === 0) {
    throw serviceError(CODES.VALIDATION,
      `scopes must include at least one of: ${ALL_SCOPES.join(', ')}`, { field: 'scopes' });
  }
  return kept;
}

// Stored scopes are parsed defensively: this column is read on every authenticated
// request, and malformed JSON must not throw the request away. Falling back to the
// LEAST privilege is the only safe direction — a parse failure that defaulted to
// admin would turn a corrupt row into a privilege escalation.
function parseScopes(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [SCOPES.LIBRARY];
    const kept = parsed.filter((s) => ALL_SCOPES.includes(s));
    return kept.length ? kept : [SCOPES.LIBRARY];
  } catch {
    return [SCOPES.LIBRARY];
  }
}

// Mint a token. The plaintext is returned EXACTLY ONCE and is not recoverable
// afterwards — only its hash is stored, which is the property that makes a leaked
// database dump not a set of working credentials.
// `grantedScopes` is the EFFECTIVE scope set of the credential doing the minting, and
// a token may not carry a scope its minter does not hold. Without it this function is
// an escape hatch out of the entire scope system: the library-scoped token handed to
// the MCP — the least-trusted consumer in this design — mints itself an admin token
// and is an administrator one call later, and `authorize()`'s narrowing becomes a
// speed bump rather than a boundary.
//
// Not reachable today: nothing but create-api-token.js calls this, and that needs a
// shell on the host, which is already above the API. It becomes live the moment
// `POST /api/v2/tokens` exists, which is why it is closed BEFORE that route rather
// than alongside it.
//
// `null` means "no presenting credential" — an operator at a shell. That is not a
// loophole for the API to use: an adapter passing null would be asserting the request
// came from the host, and there is no v2 route that may.
async function createToken({ userId, name, scopes, expiresAt = null, grantedScopes = null }) {
  const cleanName = sanitizeText(name, MAX_NAME_LENGTH);
  if (!cleanName) {
    throw serviceError(CODES.VALIDATION, 'a token name is required', { field: 'name' });
  }
  const kept = normaliseScopes(scopes, { strict: true });

  if (expiresAt !== null) {
    // A STRING, checked before Date.parse rather than trusting it. `Date.parse` takes
    // whatever it is given and coerces via toString, so `["2099-01-01"]` parses as a
    // valid future instant — and the array is then bound into Postgres as the literal
    // `{"2099-01-01"}`, which reads back as NaN and 401s on first use. The token was
    // minted, reported 201, and could never authenticate.
    //
    // Not exploitable — verifyToken's NaN handling fails closed, exactly as its
    // comment promises — but it is precisely what the paragraph below forbids:
    // minting a dead credential and reporting success is worse than refusing.
    if (typeof expiresAt !== 'string') {
      throw serviceError(CODES.VALIDATION, 'expiresAt must be an ISO timestamp string, or null', { field: 'expiresAt' });
    }
    const parsed = Date.parse(expiresAt);
    if (Number.isNaN(parsed)) {
      throw serviceError(CODES.VALIDATION, 'expiresAt must be an ISO timestamp, or null', { field: 'expiresAt' });
    }
    // A token that has already expired can never authenticate. The CLI cannot reach
    // this (its flag is a positive number of days) but a UI date picker can, and
    // minting a dead credential that reports success is worse than refusing.
    if (parsed <= Date.now()) {
      throw serviceError(CODES.VALIDATION, 'expiresAt is in the past', { field: 'expiresAt' });
    }
  }

  if (grantedScopes !== null) {
    const held = new Set(grantedScopes);
    for (const scope of kept) {
      if (!held.has(scope)) {
        throw serviceError(CODES.FORBIDDEN,
          `this credential does not hold the '${scope}' scope, so it cannot mint a token that does`,
          { field: 'scopes' });
      }
    }
  }

  const owner = await db.promises.get(
    'SELECT id, can_manage_users FROM users WHERE id = ?', [userId]);
  if (!owner) throw serviceError(CODES.NOT_FOUND, 'User not found');

  // An admin-scoped token on an account with no administrator permission is not a
  // privilege escalation — authorize() narrows it away on every request — but it IS a
  // credential that silently does less than whoever minted it believes. Refusing is
  // the same reasoning as refusing an already-expired expiry: minting something
  // inert and reporting success is worse than saying no.
  if (kept.includes(SCOPES.ADMIN) && !owner.can_manage_users) {
    throw serviceError(CODES.VALIDATION,
      'that account is not an administrator, so an admin-scoped token would grant it '
      + 'nothing — scopes narrow privilege, they never add it', { field: 'scopes' });
  }

  // base64url so the token is safe in a header, a URL and a shell argument without
  // quoting — the places an operator will actually paste it.
  const secret = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const token = TOKEN_PREFIX + secret;

  const hint = secret.slice(-4);
  let ctx;
  try {
    ctx = await db.promises.run(
      `INSERT INTO api_tokens (user_id, name, hint, token_hash, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [userId, cleanName, hint, hashToken(token), JSON.stringify(kept), new Date().toISOString(), expiresAt]
    );
  } catch (err) {
    // SQLSTATE, not a message substring — see db.js divergence #11, where matching on
    // the text 'UNIQUE' was a SQLite-ism that silently stopped working under Postgres.
    //
    // Translated rather than propagated so no caller has to render a raw constraint
    // name. The CLI merely looks unpolished doing that; the coming Settings route
    // would be echoing database internals to a browser.
    if (err && err.code === '23505') {
      throw serviceError(CODES.CONFLICT,
        `you already have a token named '${cleanName}' — names must be unique so a `
        + 'revocation list is unambiguous', { field: 'name' });
    }
    throw err;
  }

  return { id: ctx.lastID, token, hint, name: cleanName, scopes: kept, expiresAt };
}

// Verify a presented token and return the identity AND the privilege it may use.
//
// Returns null for every failure — unknown, expired, or owned by a deleted account.
// One undifferentiated answer on purpose: telling a caller that a token is "expired"
// rather than "unknown" confirms the token was real, which is a probing oracle.
async function verifyToken(presented) {
  if (!looksLikePat(presented)) return null;

  const row = await db.promises.get(
    `SELECT t.id, t.user_id, t.scopes, t.expires_at, t.last_used_at,
            u.username, u.can_manage_users, u.origin, u.display_name
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`,
    [hashToken(presented)]
  );
  if (!row) return null;

  // Expiry is optional, so this only rejects when a date was actually set — but an
  // UNPARSEABLE date is treated as expired, not as absent.
  //
  // `Date.parse('whatever')` is NaN and `NaN <= Date.now()` is false, so the obvious
  // one-liner silently reads a corrupt expiry as "never expires". That is the
  // opposite of how parseScopes handles the same class of input twenty lines above,
  // and the inconsistency is the bug: two columns on one row, one failing closed and
  // one failing open. Not reachable through createToken, which validates the value —
  // it becomes reachable the moment the planned Settings -> API Tokens route writes
  // expires_at without going through it.
  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return null;
  }

  await touch(row.id, row.last_used_at);

  return {
    tokenId: row.id,
    scopes: parseScopes(row.scopes),
    // Returned because /api/v2/me is specified to report token expiry (D10); reading
    // the column for the check above and then dropping it would force a second query.
    expiresAt: row.expires_at || null,
    user: {
      id: row.user_id,
      username: row.username,
      // Straight from `users`, re-read on THIS request. Narrowed by scope in
      // authorize(), never widened.
      can_manage_users: !!row.can_manage_users,
      origin: row.origin || 'local',
      display_name: row.display_name || row.username,
    },
  };
}

// last_used_at is advisory, but a write per request is not: it would turn every
// read into a read-write and put a row update on the hot path.
//
// The JS check below skips the round trip in the common case; the WHERE clause is
// what makes the throttle actually hold. An earlier version had only the JS check
// and a comment claiming it was "throttled in SQL so concurrent requests cannot
// race" — it was read-then-write against the value from the preceding SELECT, and
// concurrent requests raced. The race was harmless, but a comment asserting the
// opposite of its code is worse than no comment in a codebase where the rationale
// lives in the comments.
//
// AWAITED rather than fired and forgotten: per db.js divergence #9 a query still
// waiting for a pooled connection is abandoned WITHOUT its callback running when the
// pool drains, so fire-and-forget writes are silently lost.
const TOUCH_INTERVAL_MS = 60 * 1000;
async function touch(tokenId, lastUsedAt) {
  const now = Date.now();
  if (lastUsedAt && now - Date.parse(lastUsedAt) < TOUCH_INTERVAL_MS) return;
  const cutoff = new Date(now - TOUCH_INTERVAL_MS).toISOString();
  try {
    await db.promises.run(
      'UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)',
      [new Date(now).toISOString(), tokenId, cutoff]
    );
  } catch (err) {
    // A failed bookkeeping write must never fail the request it was bookkeeping for.
    console.error('[Auth] Could not record token use:', err.message);
  }
}

// Intersect account privilege with token scope. NARROWING ONLY.
//
// Returning the same `req.user` shape the JWT path produces is what lets every
// existing route keep working unchanged: requirePermission('can_manage_users')
// already reads that flag, so a library-scoped token simply arrives with it false
// and every admin route refuses it without knowing tokens exist.
function authorize(identity) {
  const hasAdminScope = identity.scopes.includes(SCOPES.ADMIN);
  return {
    ...identity.user,
    can_manage_users: identity.user.can_manage_users && hasAdminScope,
  };
}

async function listTokens(userId) {
  // token_hash is deliberately absent. It is not the secret, but it is the lookup
  // key, and a listing endpoint is not a reason to move it any closer to a response.
  const rows = await db.promises.all(
    `SELECT id, name, hint, scopes, created_at, last_used_at, expires_at
       FROM api_tokens WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );
  // PARSED. Returning the raw column handed every caller '["library"]' where it
  // expected ['library'] — invisible while nothing called this, and a bug the v2
  // mapper would have inherited as the shape it was written against.
  return rows.map((row) => ({ ...row, scopes: parseScopes(row.scopes) }));
}

// Scoped to the owner: `user_id = ?` is in the WHERE clause, not checked beforehand,
// so there is no window between the ownership test and the delete.
async function revokeToken(tokenId, userId) {
  const ctx = await db.promises.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [tokenId, userId]);
  if (ctx.changes === 0) throw serviceError(CODES.NOT_FOUND, 'Token not found');
  return { revoked: ctx.changes };
}

// --- the administrative surface -------------------------------------------------
//
// Everything above is owner-scoped by construction: the caller's id is in the WHERE
// clause and there is no argument that could point it elsewhere. These three take the
// target account as a PARAMETER, which is a different safety property — the caller's
// authority is checked by the route's requireAdminScope, and what is enforced here is
// that the SQL cannot be made to act on a row the caller did not name.
//
// They exist because revoking a credential you cannot see is not a workflow. Until
// now an administrator could not tell whether a departing user held a token at all,
// and the only way to destroy one was deleting the account — which is why
// deprovisioning someone meant erasing their library too.

// Another account's tokens. Same projection as listTokens, deliberately: `token_hash`
// stays out of a response that now crosses an account boundary, where it matters more
// than it did on the self-service listing.
async function listTokensForUser(userId) {
  const rows = await db.promises.all(
    `SELECT id, name, hint, scopes, created_at, last_used_at, expires_at
       FROM api_tokens WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );
  return rows.map((row) => ({ ...row, scopes: parseScopes(row.scopes) }));
}

// Revoke EVERY token an account holds. The deprovisioning action.
//
// Zero rows is a SUCCESS, not a NOT_FOUND. "This account had nothing to revoke" is the
// outcome the administrator wanted, and raising an error there would train them to
// ignore an error from this operation — on the one call whose whole purpose is to be
// trusted in an incident. The route answers 200 with the count either way.
async function revokeAllTokensForUser(userId) {
  const ctx = await db.promises.run('DELETE FROM api_tokens WHERE user_id = ?', [userId]);
  return { revoked: ctx.changes };
}

// Revoke ONE token belonging to a named account.
//
// BOTH ids are in the WHERE clause. Matching on tokenId alone and checking the owner
// separately would leave a window between the check and the delete, and — more
// practically — a mistyped userId would silently revoke a token from an account the
// administrator never meant to touch. Here that combination simply matches nothing.
async function revokeTokenForUser(tokenId, userId) {
  const ctx = await db.promises.run(
    'DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [tokenId, userId]);
  if (ctx.changes === 0) throw serviceError(CODES.NOT_FOUND, 'Token not found');
  return { revoked: ctx.changes };
}

module.exports = {
  TOKEN_PREFIX, SCOPES, ALL_SCOPES, MAX_NAME_LENGTH,
  hashToken, looksLikePat, normaliseScopes, parseScopes, authorize,
  createToken, verifyToken, listTokens, revokeToken,
  listTokensForUser, revokeAllTokensForUser, revokeTokenForUser,
};
