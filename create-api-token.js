/**
 * Mint a personal access token for an existing user.
 *
 *   node create-api-token.js <username> <token-name> [scopes] [--expires-in-days N]
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

const username = (argv[0] || '').trim().toLowerCase();
const name = (argv[1] || '').trim();
const scopes = (argv[2] || 'library').split(',').map((s) => s.trim()).filter(Boolean);

function usage(message) {
  console.error(`[ERROR] ${message}`);
  console.error('Usage: node create-api-token.js <username> <token-name> [scopes] [--expires-in-days N]');
  console.error(`Scopes: ${authService.ALL_SCOPES.join(', ')}  (default: library)`);
  process.exit(1);
}

if (!username || !name) usage('username and token-name are required.');
if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
  usage('--expires-in-days must be a positive number.');
}

// Named so an unknown scope is a REFUSAL rather than a token that silently has less
// power than the operator believes. createToken drops unrecognised names, which is
// right for a stored value being re-read but wrong for a human typing it once.
for (const scope of scopes) {
  if (!authService.ALL_SCOPES.includes(scope)) {
    usage(`unknown scope '${scope}'. Valid scopes: ${authService.ALL_SCOPES.join(', ')}`);
  }
}

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

  const result = await authService.createToken({
    userId: user.id, name, scopes, expiresAt,
  });

  console.error(`[OK] Token '${result.name}' created for ${user.username}.`);
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
