// v1 RESPONSE-SHAPE contract. Run with: npm test
//
// WHY THIS FILE EXISTS
//
// test/api-surface.test.js proves which routes exist and what authorization each
// one carries. It says nothing about what they RETURN. So /api is "frozen" only as
// an intention: any service can rename a field, drop an alias or restructure a
// result and every existing client breaks with CI green.
//
// That matters more here than in most projects, because two of the three clients
// are not in this repository and cannot be grepped — GameTracker-mobile (Android)
// talks to this same REST API, and an MCP server is planned against it. The web SPA
// is the only consumer a refactor can actually see.
//
// The specific thing this guards was named by two reviewers independently: the
// duplicated steamAppId/crackStatus aliases in the library row exist ONLY because
// clients read both spellings. They look like redundancy. Someone will tidy them
// away, and nothing would have noticed.
//
// SCOPE RULE — same as helpers.test.js: pure functions and stubbed seams only. No
// database, no network, no directory.
//
// WHAT THIS CANNOT DO, stated plainly so nobody reads a green run as more than it
// is: it does not exercise the Express adapters. A service can honour every shape
// below while a route handler wraps it in something else entirely. Proving the
// wire format needs the routes run against a live stack — that is the smoke-test
// job (docker-compose.test.yml), not this file. What this file proves is that the
// SERVICES still produce the shapes the adapters were written against, which is
// where the refactors actually land.

const assert = require('assert');

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };
const asyncChecks = [];
const checkAsync = (label, fn) => asyncChecks.push([label, fn]);

const db = require('../db');
const library = require('../services/library');
const catalog = require('../services/catalog');
const problem = require('../services/problem');
const { serviceError, CODES } = require('../services/errors');

// Exact key-set equality, not "has at least these". A contract test that only
// checks for presence cannot see an ADDED field, and an accidentally-added field
// is how internal state leaks into a response.
const keysOf = (o) => Object.keys(o).sort();
const assertKeys = (actual, expected, what) =>
  assert.deepStrictEqual(keysOf(actual), [...expected].sort(),
    `${what}: v1's published key set changed. Adding a field breaks nothing for a `
    + `tolerant client but leaks whatever it holds; removing one breaks every client. `
    + `If this is deliberate, it is a v2 change — /api is frozen.`);

console.log('library row (GET /api/user/:username/games):');

check('both spellings are emitted, snake_case AND camelCase', () => {
  const row = library.withAliases({
    id: 1, user_id: 2, game_id: 'igdb_123', game_name: 'A Game',
    cover_url: 'https://x/y.jpg', release_date: '2024-01-01', status: 'backlog',
    steam_app_id: '440', last_price: '₪59.99', last_price_updated: '2026-01-01T00:00:00Z',
    crack_status: 'cracked', backlog_order: 3,
  });

  // The originals survive.
  assert.strictEqual(row.steam_app_id, '440');
  assert.strictEqual(row.crack_status, 'cracked');
  // ...and the aliases sit ALONGSIDE them. Not instead of. Deleting either spelling
  // is a breaking change to a client this repo cannot see.
  assert.strictEqual(row.steamAppId, '440');
  assert.strictEqual(row.crackStatus, 'cracked');

  assertKeys(row, [
    'id', 'user_id', 'game_id', 'game_name', 'cover_url', 'release_date', 'status',
    'steam_app_id', 'last_price', 'last_price_updated', 'crack_status', 'backlog_order',
    'steamAppId', 'crackStatus',
  ], 'library row');
});

check('an absent optional becomes null, never undefined', () => {
  // undefined disappears through JSON.stringify — the key would vanish from the
  // response entirely rather than being present and empty, which reads to a client
  // as "this field no longer exists" rather than "this game has no Steam id".
  const row = library.withAliases({ game_id: 'rawg_1', game_name: 'B' });
  assert.strictEqual(row.steamAppId, null);
  assert.strictEqual(row.crackStatus, null);
  assert.ok('steamAppId' in row && 'crackStatus' in row);
});

check('game_id stays a STRING and is never coerced', () => {
  // The column is TEXT and holds values like igdb_12345. It was DECLARED INTEGER
  // under SQLite and stored strings anyway, which only worked because of SQLite's
  // flexible typing. Anything that coerces this corrupts ids on the way out.
  for (const id of ['igdb_12345', 'rawg_999', 'thegamesdb_7']) {
    const row = library.withAliases({ game_id: id });
    assert.strictEqual(typeof row.game_id, 'string');
    assert.strictEqual(row.game_id, id);
  }
});

checkAsync('GET /api/user/me/games keeps its FIVE-column projection', async () => {
  // Deliberately a different resource from the row above, and a client moving
  // between the two silently loses fields. Pinned so the difference is a decision
  // rather than a surprise.
  const original = db.promises.all;
  let issued = null;
  db.promises.all = async (sql) => { issued = sql; return []; };
  try {
    await library.listOwnGames(1);
  } finally {
    db.promises.all = original;
  }
  assert.ok(issued, 'listOwnGames issued no query');
  const projection = issued.replace(/^\s*SELECT\s+/i, '').split(/\s+FROM\s+/i)[0];
  assert.deepStrictEqual(
    projection.split(',').map((c) => c.trim()).sort(),
    ['cover_url', 'game_id', 'game_name', 'release_date', 'status'],
    `the own-library projection changed: ${issued}`
  );
  assert.ok(/ORDER BY\s+game_name/i.test(issued),
    'own-library results are no longer ordered by name — v1 clients render them unsorted');
});

console.log('search result (GET /api/search):');

check('a search item carries exactly the six published fields', () => {
  const [item] = catalog.mergeResults(
    [{ id: 'igdb_1', name: 'Hades', releaseDate: '2020-09-17', coverUrl: 'https://c/1.jpg', source: 'igdb', steamAppId: '1145360' }],
    [], []
  );
  assertKeys(item, ['id', 'name', 'releaseDate', 'coverUrl', 'source', 'steamAppId'], 'search item');
});

check('a search id is a SOURCE-PREFIXED string, and the client posts it verbatim', () => {
  // This is the join between search and the library: the id emitted here is what the
  // client sends back to POST /games and what lands in user_games.game_id. A bare
  // numeric id from any provider would collide across sources.
  const merged = catalog.mergeResults(
    [{ id: 'igdb_1', name: 'A', source: 'igdb' }],
    [{ id: 'rawg_1', name: 'B', source: 'rawg' }],
    [{ id: 'thegamesdb_1', name: 'C', source: 'thegamesdb' }]
  );
  assert.strictEqual(merged.length, 3, 'same numeric id from three sources must not collapse');
  for (const item of merged) {
    assert.strictEqual(typeof item.id, 'string');
    assert.ok(/^(igdb|rawg|thegamesdb)_/.test(item.id), `unprefixed search id: ${item.id}`);
  }
});

check('the published result cap is 20', () => {
  // Clients page against this. Changing it silently changes how much a caller gets
  // back from an unchanged query.
  assert.strictEqual(catalog.LIMIT_SEARCH, 20);
  assert.strictEqual(catalog.LIMIT_REFRESH, 10);
});

console.log('capabilities (GET /api/capabilities):');

check('the discovery document keeps its published shape', () => {
  // Read by clients this repo cannot grep — the Android app and any operator script.
  // It is also the LAST route addable to v1, so if its shape drifts there is no
  // second discovery endpoint to correct it from.
  //
  // Asserted from index.js source rather than by calling the handler: the payload is
  // static and the route needs an Express request. The smoke stage exercises the wire
  // format; this pins the fields.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const route = source.slice(source.indexOf("app.get('/api/capabilities'"));
  const body = route.slice(0, route.indexOf('});'));
  for (const field of ['serverVersion', 'apiVersions', 'deprecations', 'basePath', 'status']) {
    assert.ok(body.includes(field), `/api/capabilities no longer returns '${field}'`);
  }
  // v2 must not advertise itself as available while nothing serves it: a client would
  // route to a 404 it has no way to interpret.
  assert.ok(/V2_MOUNTED \? 'available' : 'planned'/.test(body),
    'v2 availability is no longer gated on the router actually being mounted');
  assert.ok(!body.includes("status: 'deprecated'"),
    'v1 is frozen and permanently supported, not deprecated — the phone is not ours to sunset');
});

console.log('error envelope:');

check('an exposed error is {error: <message>} and nothing else', () => {
  // Every SPA call site reads data.error. The envelope changes at /api/v2; until
  // then adding or renaming a key here breaks all three clients at once.
  const mapped = problem.toProblem(serviceError(CODES.VALIDATION, 'email must be a single valid address, or empty'));
  assertKeys(mapped, ['status', 'body'], 'toProblem result');
  assert.strictEqual(mapped.status, 400);
  assertKeys(mapped.body, ['error'], 'error envelope');
  assert.strictEqual(mapped.body.error, 'email must be a single valid address, or empty');
});

check('a non-exposed error still returns {error}, with a generic message', () => {
  // The shape must not vary with exposure — a client branching on key presence
  // would see two different response types for the same status.
  const mapped = problem.toProblem(serviceError(CODES.NOT_FOUND, 'user 42 has no row in user_games'));
  assertKeys(mapped.body, ['error'], 'non-exposed error envelope');
  assert.ok(!/user_games|42/.test(mapped.body.error), `internal detail leaked: ${mapped.body.error}`);
});

check('every error CODE maps to a status, so none can fall through to 500', () => {
  // An unmapped code makes toProblem return null, and the adapter then sends an
  // opaque 500 for what is actually a 4xx — the caller cannot tell a bad request
  // from a broken server.
  for (const code of Object.values(CODES)) {
    const spec = problem.PROBLEMS[code];
    assert.ok(spec, `CODES.${code} has no PROBLEMS entry — it would surface as a 500`);
    assert.ok(Number.isInteger(spec.status) && spec.status >= 400 && spec.status < 600,
      `CODES.${code} maps to a non-error status ${spec.status}`);
    assert.strictEqual(typeof spec.expose, 'boolean',
      `CODES.${code} has no explicit expose decision — disclosure must never be implicit`);
  }
});

// --- the adapters, for the one route whose STATUS is a compatibility shim --------
//
// The header of this file says it cannot exercise the Express adapters. That is
// still true in general, and it stopped being acceptable for one route: POST
// /api/users no longer contains its own logic — it calls services/users.js#create,
// which BOTH surfaces use — and the only thing keeping v1's wire behaviour is three
// lines in the handler that turn the service's CONFLICT into the 400 v1 has always
// answered for a duplicate username. Nothing else in the suite can see those lines.
// Delete them as a tidy-up and v1 silently starts answering 409.
//
// So this drives the real handler off the live router with the service stubbed. It
// is not a substitute for the smoke test — no HTTP, no database — but it puts the
// route's own status mapping under assertion, which is where this change lands.
console.log('POST /api/users (v1 status is a shim over the shared service):');

// The handler, pulled out of the live Express stack rather than re-imported. Walking
// the router is what makes this the route that actually runs.
function handlerFor(method, path) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-signing';
  const { app } = require('../index.js');
  for (const layer of (app.router || app._router).stack) {
    if (!layer.route || layer.route.path !== path) continue;
    if (!layer.route.methods[method]) continue;
    // The LAST handler in the chain — the ones before it are authRequired and
    // requirePermission, which this test deliberately does not exercise (tiers are
    // api-surface.test.js's job).
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  throw new Error(`no ${method.toUpperCase()} ${path} on the live router`);
}

// A res that records rather than writes. `json` and `status` are all these handlers
// use; anything else appearing here should fail loudly rather than be absorbed.
function recordingRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

// The route calls usersService.create through the module object, so this is
// observable — the destructured-binding trap CLAUDE.md documents does not apply.
async function callCreate(stub) {
  const usersService = require('../services/users');
  const real = usersService.create;
  usersService.create = stub;
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/users')({ body: { username: 'x', password: 'y' } }, res);
    // The handler is promise-chained, not awaited by Express: give the chain a turn.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally { usersService.create = real; }
  return res;
}

checkAsync('a duplicate username is still 400, not the service\'s 409', async () => {
  const res = await callCreate(async () => { throw serviceError(CODES.CONFLICT, 'User already exists'); });
  assert.strictEqual(res.statusCode, 400,
    'POST /api/users answered 409 for a duplicate. v1 has always answered 400 here; the '
    + 'shim in the handler is the only thing preserving that, and v2 is where the 409 lives.');
  assert.deepStrictEqual(res.body, { error: 'User already exists' });
});

checkAsync('a successful create still returns {success, id} and nothing more', async () => {
  const res = await callCreate(async () => ({ id: 42, username: 'x' }));
  assert.strictEqual(res.statusCode, 200);
  // EXACT key set. `username` comes back from the service now and must not start
  // appearing in the response just because it is available.
  assertKeys(res.body, ['success', 'id'], 'POST /api/users');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.id, 42);
});

checkAsync('a validation refusal keeps the {error} envelope and its message', async () => {
  const res = await callCreate(async () => {
    throw serviceError(CODES.VALIDATION, 'Password must be at least 8 characters long', { field: 'password' });
  });
  assert.strictEqual(res.statusCode, 400);
  // v1's envelope is a bare {error}. The `field` detail v2 renders as `errors[]` must
  // NOT leak into it — a client parsing v1 would see a key it has never seen.
  assertKeys(res.body, ['error'], 'POST /api/users validation');
  assert.strictEqual(res.body.error, 'Password must be at least 8 characters long');
});

checkAsync('an unrecognised failure is a 500 with a fixed message, never the exception', async () => {
  const res = await callCreate(async () => { throw new Error('relation "users" does not exist'); });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'Failed to create user' });
});

// --- POST /api/user/me/tokens: the sudo-mode gate lives in the ADAPTER ----------
//
// services/users.js#verifyPassword is unit-tested, but the DECISION to call it — and
// to refuse when it says no — is three lines in the route. A mutation that replaced
// the check with `if (false)` left the whole unit suite green while the endpoint
// minted a permanent credential for anyone holding a session. That is the one thing
// this route exists to prevent, so it is asserted against the handler that runs.
console.log('POST /api/user/me/tokens (sudo mode):');

// A DISTINCT user id per call by default. The sudo gate is rate limited on user id
// and that counter is module state, so reusing one id across these assertions meant
// the sixth deliberate failure locked out every test after it — which presented as
// "createToken was never called" three assertions later. Tests that exercise the
// limiter pass an explicit uid.
let nextMintUid = 1000;

async function callMintToken(body, { verify, create, uid } = {}) {
  const usersService = require('../services/users');
  const authService = require('../services/auth');
  const realVerify = usersService.verifyPassword;
  const realCreate = authService.createToken;
  let created = 0;
  usersService.verifyPassword = verify || (async () => ({ ok: true }));
  authService.createToken = async (args) => {
    created++;
    return create ? create(args) : { id: 1, token: 'gt_pat_x', hint: 'x', name: args.name, scopes: args.scopes || ['library'] };
  };
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/user/me/tokens')(
      { body, user: { id: uid ?? nextMintUid++, username: 'someone', can_manage_users: false } }, res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    usersService.verifyPassword = realVerify;
    authService.createToken = realCreate;
  }
  return { res, created };
}

checkAsync('a wrong password mints NOTHING and answers 403', async () => {
  const { res, created } = await callMintToken(
    { name: 'x', password: 'wrong' },
    { verify: async () => ({ ok: false, reason: 'wrong_password' }) });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(created, 0, 'a token was created despite the password check failing');
});

checkAsync('a MISSING password is the same 403 — not a distinguishable answer', async () => {
  // Collapsed on purpose. Telling "you sent no password" apart from "that password is
  // wrong" hands an attacker holding a stolen session a way to probe, and there is
  // nothing a legitimate caller does differently with the two.
  const missing = await callMintToken({ name: 'x' }, { verify: async () => ({ ok: false, reason: 'missing' }) });
  const wrong = await callMintToken({ name: 'x', password: 'no' }, { verify: async () => ({ ok: false, reason: 'wrong_password' }) });
  assert.strictEqual(missing.res.statusCode, wrong.res.statusCode);
  assert.deepStrictEqual(missing.res.body, wrong.res.body);
  assert.strictEqual(missing.created + wrong.created, 0);
});

checkAsync('a directory FAULT is not reported as a wrong password', async () => {
  // Directory accounts are now verified by binding to the directory, so these are
  // reachable outcomes. Reporting an unreachable domain controller as "incorrect
  // password" sends the user to reset a password that was right all along, and a
  // misconfigured search base is not something they can fix by retyping either.
  for (const reason of ['directory_unreachable', 'directory_ambiguous', 'no_directory']) {
    const { res, created } = await callMintToken(
      { name: 'x', password: 'whatever' },
      { verify: async () => ({ ok: false, reason, origin: 'ldap' }) });
    assert.strictEqual(res.statusCode, 503, `${reason} should be a 503, not a client error`);
    assert.strictEqual(created, 0, `${reason} minted a token`);
    assert.doesNotMatch(res.body.error, /password.{0,20}(incorrect|wrong)/i,
      `${reason} blamed the user's password for a server-side fault`);
  }
});

checkAsync('an account the directory does not know is the SAME 403 as a wrong password', async () => {
  // Deliberately not distinguished: telling a caller that the directory has no such
  // entry confirms which usernames the directory holds, to anyone with any session.
  const notFound = await callMintToken({ name: 'x', password: 'w' },
    { verify: async () => ({ ok: false, reason: 'directory_not_found' }) });
  const wrong = await callMintToken({ name: 'x', password: 'w' },
    { verify: async () => ({ ok: false, reason: 'wrong_password' }) });
  assert.strictEqual(notFound.res.statusCode, wrong.res.statusCode);
  assert.deepStrictEqual(notFound.res.body, wrong.res.body);
  assert.strictEqual(notFound.created + wrong.created, 0);
});

checkAsync('the scope FLOOR comes from the account, never from the body', async () => {
  // req.user.can_manage_users is false in this harness, so `grantedScopes` must not
  // contain admin however the body is decorated. The service refuses to widen beyond
  // grantedScopes; this asserts the route hands it the right set to begin with.
  let seen = null;
  await callMintToken(
    { name: 'x', password: 'ok', scopes: ['admin'], grantedScopes: ['admin'] },
    { create: (args) => { seen = args; return { id: 1, token: 't', scopes: args.scopes }; } });
  assert.deepStrictEqual(seen.grantedScopes, ['library'],
    'a non-admin session offered admin in grantedScopes — the floor is the account, not the request');
});

checkAsync('five wrong passwords lock the gate, and bcrypt stops being reachable', async () => {
  // Two findings, one fix. Unthrottled, this was measured at 11.6 guesses/second
  // against the single control protecting persistence escalation — and it was the
  // first route letting a non-admin trigger unbounded bcrypt, which took /api/health
  // from 2ms to 2.5s under 30 concurrent calls because bcryptjs shares the event loop.
  //
  // A distinct user id per run: the counter is module state and would otherwise carry
  // between assertions in this file.
  const uid = 4242;
  const wrong = async () => {
    const usersService = require('../services/users');
    const authService = require('../services/auth');
    const realVerify = usersService.verifyPassword;
    const realCreate = authService.createToken;
    let verified = 0;
    usersService.verifyPassword = async () => { verified++; return { ok: false, reason: 'wrong_password' }; };
    authService.createToken = async () => { throw new Error('must not be reached'); };
    const res = recordingRes();
    try {
      await handlerFor('post', '/api/user/me/tokens')(
        { body: { name: 'x', password: 'no' }, user: { id: uid, username: 'victim', can_manage_users: false } }, res);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      usersService.verifyPassword = realVerify;
      authService.createToken = realCreate;
    }
    return { res, verified };
  };

  for (let i = 0; i < 5; i++) {
    const { res } = await wrong();
    assert.strictEqual(res.statusCode, 403, `attempt ${i + 1} should still be a 403`);
  }
  const sixth = await wrong();
  assert.strictEqual(sixth.res.statusCode, 429, 'the sixth attempt was not rate limited');
  assert.match(sixth.res.body.error, /minutes/);
  // The point of putting the limiter BEFORE the check: once locked, no bcrypt runs.
  assert.strictEqual(sixth.verified, 0,
    'verifyPassword still ran while locked out — the bcrypt DoS is not actually bounded');
});

checkAsync('the token gate and the LOGIN limiter do not share a budget', async () => {
  // Keyed on user id, in its own namespace. If they shared keys, five fat-fingered
  // attempts on the token form would lock the account out of signing in — and an
  // attacker holding a session could burn a victim's login budget deliberately.
  const { isLockedOut } = require('../index.js');
  // No silent skip. An earlier version of this returned early when the export was
  // missing, which made it a test that passed whether or not the property held —
  // exactly the vacuous shape this suite exists to avoid.
  assert.strictEqual(typeof isLockedOut, 'function',
    'index.js no longer exports isLockedOut, so this assertion can no longer be made');
  // Probed with the USER ID as the username. The mutation this catches is
  // `sudo:${userId}` -> `user:${userId}`, which collides with the login namespace for
  // any account whose name is its own id — and, more to the point, means the two
  // counters are one. Probing with an unrelated name would have passed either way,
  // which is how the first version of this assertion missed it.
  assert.strictEqual(isLockedOut('9.9.9.9', '4242'), 0,
    'exhausting the token gate also consumed the LOGIN budget — the two counters share a namespace');
  assert.strictEqual(isLockedOut('9.9.9.9', 'victim'), 0,
    'exhausting the token gate locked an unrelated account out of login');
});

console.log('POST /api/auth/login (the LDAP verification ladder):');

checkAsync('an UNRECOGNISED verification result never issues a session', async () => {
  // The ladder used to test four reason strings and then fall through to the success
  // branch, so any other non-ok reason authenticated. A review proved it: the route
  // logged "User password authentication succeeded" for a FAILED verification. It
  // failed closed only by accident, because `result.entry` was absent and reading
  // `.dn` threw. A future reason that CARRIES an entry — password_expired,
  // account_locked, both natural shapes here — would have issued a real session.
  const ldapHelpers = require('../ldap-helpers');
  const settingsStore = require('../settings-store');
  const realVerify = ldapHelpers.verifyLdapCredentials;
  // loadSettings, not readSettings: the login route reads through the former, and
  // stubbing the latter left isLdapConfigured false — so this test exercised LOCAL
  // auth and passed while the LDAP ladder it names was never reached at all.
  const realLoad = settingsStore.loadSettings;
  settingsStore.loadSettings = () => ({
    ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw' },
  });
  // Carries an entry, exactly like the shapes that would make the old code issue a
  // session. If the ladder ever falls through again, this authenticates.
  ldapHelpers.verifyLdapCredentials = async () => ({
    ok: false,
    reason: 'password_expired',
    entry: { dn: 'uid=jane,dc=x', cn: 'Jane', memberOf: [] },
  });
  // The database is STUBBED so the success path can actually complete. Without this
  // the test proves nothing: with the guard removed the route reaches getOrCreateUser,
  // finds no database, and errors out before issuing a token — passing the assertion
  // for the wrong reason. That accidental failure-to-authenticate is precisely the
  // property under review, so it must not be what makes the test green.
  const realGet = db.get;
  const realRun = db.run;
  db.get = (sql, params, cb) => cb(null, { id: 42, username: 'jane', can_manage_users: 0 });
  db.run = (sql, params, cb) => { if (typeof cb === 'function') cb.call({ lastID: 42 }, null); };
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/auth/login')(
      { body: { username: 'jane', password: 'anything' }, ip: '203.0.113.9' }, res);
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    ldapHelpers.verifyLdapCredentials = realVerify;
    settingsStore.loadSettings = realLoad;
    db.get = realGet;
    db.run = realRun;
  }
  assert.ok(!res.body || !res.body.token,
    'an unrecognised verification reason issued a session token');
  assert.notStrictEqual(res.statusCode, 200,
    'an unrecognised verification reason authenticated the caller');
});

checkAsync('a directory account outside requiredGroup CANNOT mint', async () => {
  // The blocker a review reproduced: ldap.requiredGroup is the only authorization
  // signal that lives in the directory and is never mirrored into `users`, so the
  // per-request privilege re-read cannot revoke it. Without the group re-check, an
  // account removed from the group was refused at LOGIN and could still turn its
  // residual session into a token with no expiry that no admin can see or revoke.
  const { res, created } = await callMintToken(
    { name: 'x', password: 'their-real-directory-password' },
    { verify: async () => ({ ok: false, reason: 'directory_not_authorized', viaDirectory: true }) });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(created, 0, 'a deprovisioned directory account minted a permanent token');
  assert.match(res.body.error, /required group/i);
});

checkAsync('every directory-backed attempt is counted, including the successful ones', async () => {
  // Findings 2 and 3: the wrong-password counter cannot bound directory load, because
  // it does not count faults and it is CLEARED on success. Unthrottled, a review drove
  // 40 mints against a dead domain controller and 40 successful mints costing 80 binds
  // and 40 subtree searches — an outbound flood at someone else's DC from any session.
  const uid = 7777;
  const call = (result) => callMintToken({ name: 'x', password: 'pw' }, { uid, verify: async () => result });

  // 20 SUCCESSFUL directory mints: allowed, then capped. Success must not buy more.
  let last;
  for (let i = 0; i < 20; i++) last = await call({ ok: true, viaDirectory: true });
  assert.strictEqual(last.res.statusCode, 201, 'the 20th legitimate mint should still work');
  const capped = await call({ ok: true, viaDirectory: true });
  assert.strictEqual(capped.res.statusCode, 429, 'successful directory mints are still unbounded');
  assert.strictEqual(capped.created, 0);
});

checkAsync('a LOCAL account is never charged to the directory budget', async () => {
  // The cap exists to protect a domain controller. A local account never touches one,
  // so charging it there would throttle bcrypt users for someone else's problem.
  const uid = 8888;
  for (let i = 0; i < 25; i++) {
    const { res } = await callMintToken({ name: 'x', password: 'pw' },
      { uid, verify: async () => ({ ok: true }) });   // no viaDirectory
    assert.strictEqual(res.statusCode, 201, `local mint ${i + 1} was throttled by the directory cap`);
  }
});

checkAsync('a correct password mints, and answers 201 with the plaintext', async () => {
  const { res, created } = await callMintToken({ name: 'ok', password: 'right' });
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(created, 1);
  // This is the ONE response in the whole API that carries the secret.
  assert.ok(res.body.token, 'the mint response has no token in it — it is unrecoverable afterwards');
});

// The async cases run last. A rejection here must fail the process — an async
// assertion that only prints would be a test that always passes.
(async () => {
  for (const [label, fn] of asyncChecks) {
    await fn();
    n++;
    console.log('  ok  ' + label);
  }
  console.log(`\n${n} contract assertions passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
