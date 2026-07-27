/**
 * Mint a personal access token for an existing user.
 *
 *   node create-api-token.js <username> <token-name> [scopes] [--expires-in-days N]
 *   node create-api-token.js <username> --list
 *   node create-api-token.js <username> --revoke <token-id>
 *
 * REVOCATION IS THE POINT of this design — a token is looked up rather than
 * self-describing precisely so that deleting one row kills it, without rotating
 * JWT_SECRET and signing out the web app and the phone as well. So it needs a way to
 * be done that is not "shell in and hand-write SQL": the first version of this script
 * only minted, which left the entire justification for the table unexercisable.
 *
 * `scopes` is a comma-separated subset of: library, admin. Defaults to `library`.
 * Grant `admin` only to something that genuinely needs to manage users or read API
 * keys — an MCP server tending your game library does not.
 *
 * Run it inside the backend container so the PG* variables are the ones the
 * application actually uses:
 *
 *   docker compose -f docker-compose.yaml exec backend \
 *     node create-api-token.js jane "laptop cli" library
 *
 * THE TOKEN IS PRINTED ONCE AND IS NOT RECOVERABLE. Only its SHA-256 hash is
 * stored, so a database dump does not yield working credentials — and neither this
 * script nor the API can show it to you again. Lost it? Revoke and mint another.
 *
 * It is printed to STDOUT alone, with everything else on stderr, so
 * `node create-api-token.js ... > token.txt` captures exactly the secret and nothing
 * else. Be aware that a token pasted into a shell lands in your history.
 *
 * Use it as a normal bearer credential — the same header a browser session uses:
 *
 *   curl -H "Authorization: Bearer gt_pat_..." https://your-host/api/user/me/games
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT: minting the FIRST credential cannot
 * itself require a credential. A Settings -> API Tokens page comes later and will
 * mint subsequent ones; this is the way in that does not depend on the way in.
 */
const db = require('./db');
const authService = require('./services/auth');

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--expires-in-days');
let expiresInDays = null;
if (flagIndex !== -1) {
  expiresInDays = Number(argv[flagIndex + 1]);
  argv.splice(flagIndex, 2);
}

const wantsList = argv.includes('--list');
const revokeIndex = argv.indexOf('--revoke');
const revokeId = revokeIndex === -1 ? null : Number(argv[revokeIndex + 1]);

const username = (argv[0] || '').trim().toLowerCase();
const name = (argv[1] || '').trim();
const scopes = (argv[2] || 'library').split(',').map((s) => s.trim()).filter(Boolean);

function usage(message) {
  console.error(`[ERROR] ${message}`);
  console.error('Usage:');
  console.error('  node create-api-token.js <username> <token-name> [scopes] [--expires-in-days N]');
  console.error('  node create-api-token.js <username> --list');
  console.error('  node create-api-token.js <username> --revoke <token-id>');
  console.error(`Scopes: ${authService.ALL_SCOPES.join(', ')}  (default: library)`);
  process.exit(1);
}

if (!username) usage('a username is required.');
if (revokeIndex !== -1 && (!Number.isInteger(revokeId) || revokeId <= 0)) {
  usage('--revoke needs a numeric token id (see --list).');
}
if (!wantsList && revokeIndex === -1 && !name) usage('a token-name is required when minting.');
// Upper-bounded, not just positive. `--expires-in-days 1e15` is finite and greater
// than zero, and then `new Date(...).toISOString()` throws an uncaught RangeError —
// no token minted and nothing leaked, but the operator gets a stack trace where a
// usage message belongs. Ten years is well past any real answer.
const MAX_EXPIRY_DAYS = 3650;
if (expiresInDays !== null
    && (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > MAX_EXPIRY_DAYS)) {
  usage(`--expires-in-days must be a number between 1 and ${MAX_EXPIRY_DAYS}.`);
}

// The refusal for an unknown scope lives in the SERVICE (normaliseScopes strict
// mode), not here. It used to be a loop in this file, which meant the coming
// Settings -> API Tokens route would have had to remember to reimplement it or
// silently mint weaker tokens than the operator selected — two callers, one rule,
// one copy each.

const expiresAt = expiresInDays === null
  ? null
  : new Date(Date.now() + expiresInDays * 86400000).toISOString();

(async () => {
  const user = await db.promises.get('SELECT id, username FROM users WHERE username = ?', [username]);
  if (!user) {
    console.error(`[ERROR] No such user: '${username}'. This script does not create accounts —`);
    console.error('        use create-local-admin.js for that.');
    process.exitCode = 1;
    return;
  }

  if (wantsList) {
    const tokens = await authService.listTokens(user.id);
    if (tokens.length === 0) {
      console.error(`[OK] ${user.username} has no API tokens.`);
      return;
    }
    console.error(`[OK] API tokens for ${user.username}:`);
    for (const t of tokens) {
      console.error(`  #${t.id}  ${t.name}  (…${t.hint || '????'})  [${t.scopes.join(', ')}]`
        + `  created ${t.created_at}  last used ${t.last_used_at || 'never'}`
        + `  expires ${t.expires_at || 'never'}`);
    }
    console.error('');
    console.error(`Revoke with: node create-api-token.js ${user.username} --revoke <id>`);
    return;
  }

  if (revokeIndex !== -1) {
    // Scoped to this user inside the DELETE, so naming another account's token id
    // removes nothing and says so, rather than silently succeeding.
    await authService.revokeToken(revokeId, user.id);
    console.error(`[OK] Token #${revokeId} revoked. It stops working on its next request.`);
    return;
  }

  // grantedScopes is deliberately omitted (null): this script requires a shell on the
  // host, which is already strictly above the API. A v2 adapter must NOT do this — it
  // has to pass the presenting credential's effective scopes, or the scope floor is
  // not a floor.
  const result = await authService.createToken({
    userId: user.id, name, scopes, expiresAt,
  });

  console.error(`[OK] Token '${result.name}' created for ${user.username}.`);
  console.error(`     Ends in: …${result.hint}   (shown in --list, so you can match this token to its row)`);
  console.error(`     Scopes:  ${result.scopes.join(', ')}`);
  console.error(`     Expires: ${result.expiresAt || 'never (revoke by deleting it)'}`);
  console.error('');
  console.error('     Copy it now — it cannot be shown again:');
  console.error('');
  console.log(result.token);
})()
  .catch((err) => {
    // Service errors carry a caller-facing message; anything else is a bug or a
    // database failure and its message is not something to dress up as advice.
    console.error('[ERROR] Could not create token:', err.message);
    process.exitCode = 1;
  })
  // db.close() drains queries that already hold a connection. The INSERT above is
  // awaited before we get here, so it cannot be one of the abandoned ones described
  // in db.js divergence #9.
  .finally(() => db.close());
