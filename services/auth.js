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

// Unknown scope names are dropped rather than rejected, and an empty result is an
// error: a token with no scopes would authenticate while being unable to do
// anything, which reads to the holder as a broken server rather than a bad request.
function normaliseScopes(requested) {
  const list = Array.isArray(requested) ? requested : [SCOPES.LIBRARY];
  const kept = [...new Set(list.map((s) => String(s).trim().toLowerCase()))]
    .filter((s) => ALL_SCOPES.includes(s));
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
async function createToken({ userId, name, scopes, expiresAt = null }) {
  const cleanName = sanitizeText(name, MAX_NAME_LENGTH);
  if (!cleanName) {
    throw serviceError(CODES.VALIDATION, 'a token name is required', { field: 'name' });
  }
  const kept = normaliseScopes(scopes);

  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    throw serviceError(CODES.VALIDATION, 'expiresAt must be an ISO timestamp, or null', { field: 'expiresAt' });
  }

  const owner = await db.promises.get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!owner) throw serviceError(CODES.NOT_FOUND, 'User not found');

  // base64url so the token is safe in a header, a URL and a shell argument without
  // quoting — the places an operator will actually paste it.
  const secret = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const token = TOKEN_PREFIX + secret;

  const ctx = await db.promises.run(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [userId, cleanName, hashToken(token), JSON.stringify(kept), new Date().toISOString(), expiresAt]
  );

  return { id: ctx.lastID, token, name: cleanName, scopes: kept, expiresAt };
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

  // Expiry is optional, so this only rejects when a date was actually set.
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  await touch(row.id, row.last_used_at);

  return {
    tokenId: row.id,
    scopes: parseScopes(row.scopes),
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
// Throttled in SQL rather than by read-then-write, so concurrent requests cannot
// race, and AWAITED rather than fired and forgotten — per db.js divergence #9 a
// query still waiting for a pooled connection is abandoned WITHOUT its callback
// running when the pool drains, so fire-and-forget writes are silently lost.
const TOUCH_INTERVAL_MS = 60 * 1000;
async function touch(tokenId, lastUsedAt) {
  const now = Date.now();
  if (lastUsedAt && now - Date.parse(lastUsedAt) < TOUCH_INTERVAL_MS) return;
  try {
    await db.promises.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [new Date(now).toISOString(), tokenId]);
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
  return db.promises.all(
    `SELECT id, name, scopes, created_at, last_used_at, expires_at
       FROM api_tokens WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );
}

// Scoped to the owner: `user_id = ?` is in the WHERE clause, not checked beforehand,
// so there is no window between the ownership test and the delete.
async function revokeToken(tokenId, userId) {
  const ctx = await db.promises.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [tokenId, userId]);
  if (ctx.changes === 0) throw serviceError(CODES.NOT_FOUND, 'Token not found');
  return { revoked: ctx.changes };
}

module.exports = {
  TOKEN_PREFIX, SCOPES, ALL_SCOPES, MAX_NAME_LENGTH,
  hashToken, looksLikePat, normaliseScopes, parseScopes, authorize,
  createToken, verifyToken, listTokens, revokeToken,
};
