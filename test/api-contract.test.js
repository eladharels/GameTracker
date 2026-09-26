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
  const res = { statusCode: 200, body: undefined, headersSent: false, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (name, value) => { res.headers[String(name).toLowerCase()] = value; return res; };
  // Set-Cookie is the one header that repeats; append collects every value (SEC-14).
  res.append = (name, value) => {
    const k = String(name).toLowerCase();
    res.headers[k] = [].concat(res.headers[k] || [], value);
    return res;
  };
  res.end = () => { res.headersSent = true; return res; };
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
// --- GET /api/system-status: a v1 shape that just moved into a service ------------
//
// The 120-line inline handler became a thin adapter over services/status.js so v2
// could share the probes. The System Status page binds to this shape, and /api is
// frozen — a field renamed on the way through the refactor breaks it silently.
console.log('GET /api/system-status (v1 shape, after the extraction):');

checkAsync('the report keeps its published shape', async () => {
  const statusSvc = require('../services/status');
  const axiosMod = require('axios');
  const store = require('../settings-store');
  const realGet = axiosMod.get, realPost = axiosMod.post, realDbGet = db.promises.get;
  const realResolve = store.resolveApiKey;
  axiosMod.get = async () => ({ data: {} });
  axiosMod.post = async () => ({ data: {} });
  db.promises.get = async () => ({ ok: 1 });
  store.resolveApiKey = () => 'k';
  let report;
  try {
    report = await statusSvc.checkAll({
      crackWatchCacheSize: 3,
      okCache: { read: () => ({ lastOk: '2026-01-01T00:00:00.000Z', latency: 12 }), record: () => {} },
    });
  } finally {
    axiosMod.get = realGet; axiosMod.post = realPost;
    db.promises.get = realDbGet; store.resolveApiKey = realResolve;
  }
  assertKeys(report, ['overall', 'services', 'checkedAt'], 'system status envelope');
  // snake_case is deliberately absent and camelCase deliberately present: v1 emits
  // lastOk/lastOkLatency/httpStatus here, unlike most of its surface.
  const ok = report.services.find((s2) => s2.status === 'ok');
  assertKeys(ok, ['name', 'status', 'latency', 'lastOk', 'lastOkLatency'], 'a healthy service row');
  assert.strictEqual(ok.lastOk, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(ok.lastOkLatency, 12);
  assert.ok(['ok', 'degraded'].includes(report.overall));
});

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

console.log('POST /api/user/:username/games/:gameId/refresh-metadata (CC-8):');

checkAsync('with no API keys configured, a single-game refresh says "unavailable", not "not found"', async () => {
  // The single-game route chose the message from `lookup.degraded`, which is false
  // when every provider is merely SKIPPED (no keys) -- so it told the user their game
  // did not exist in any database. The bulk route had already been fixed; both now go
  // through jobs.refreshOne. Stubbed through module objects: the catalog search, the
  // library read, and the user lookup behind withExistingUser.
  const catalog = require('../services/catalog');
  const libraryService = require('../services/library');
  const real = { search: catalog.searchAll, find: libraryService.findGame, get: db.get };
  catalog.searchAll = async () => ({
    results: [], providers: { igdb: 'skipped', rawg: 'skipped', thegamesdb: 'skipped' },
    counts: { igdb: 0, rawg: 0, thegamesdb: 0 }, degraded: false,
  });
  libraryService.findGame = async () => ({ game_id: 'igdb_1', game_name: 'Halo', release_date: null });
  db.get = (sql, params, cb) => cb(null, { id: 7, username: 'jane' });
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/user/:username/games/:gameId/refresh-metadata')(
      { params: { username: 'jane', gameId: 'igdb_1' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    catalog.searchAll = real.search; libraryService.findGame = real.find; db.get = real.get;
  }
  assert.strictEqual(res.statusCode, 200);
  assertKeys(res.body, ['success', 'results', 'message'], 'single-game refresh');
  assert.strictEqual(res.body.results.errors[0].error, 'Lookup unavailable — a game database did not respond',
    `told the user: ${res.body.results.errors[0].error}`);
  assert.strictEqual(res.body.results.details[0].error, 'Lookup unavailable');
});

console.log('PUT /api/user/me/settings (CC-9: the same rules as v2, v1 wording):');

// Drives the real v1 handler with the users table stubbed through db.promises, and
// records the UPDATE it issues.
async function putSettings(body) {
  const real = { run: db.promises.run, get: db.promises.get };
  const writes = [];
  db.promises.run = async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; };
  db.promises.get = async () => ({ email: '', notification_days: '[0,7,30]' });
  const res = recordingRes();
  try {
    await handlerFor('put', '/api/user/me/settings')({ user: { id: 7 }, body }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { db.promises.run = real.run; db.promises.get = real.get; }
  return { res, writes };
}

checkAsync('a valid write still answers exactly {success: true}', async () => {
  const { res } = await putSettings({ ntfy_topic: 'games', notification_days: [7, 0, 7] });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { success: true });
});
checkAsync('notification_days is capped and de-duplicated, as on v2', async () => {
  // v1 accepted [1e9] and stored duplicates; v2 refused and de-duplicated.
  const big = await putSettings({ notification_days: [1000000000] });
  assert.strictEqual(big.res.statusCode, 400, 'a day count of 1e9 was accepted');
  assertKeys(big.res.body, ['error'], 'settings 400');
  assert.match(big.res.body.error, /^notification_days /, 'the message lost its v1 field name');
  const dup = await putSettings({ notification_days: [7, 0, 7] });
  const w = dup.writes.find((x) => /notification_days/.test(x.sql));
  assert.ok(w.params.includes('[0,7]'), `stored ${JSON.stringify(w.params)}`);
});
checkAsync('free-text channel fields are bounded and must be text', async () => {
  // v1 stored ntfy_topic, gotify_token and telegram_chat_id verbatim, any size or type.
  const long = await putSettings({ ntfy_topic: 'x'.repeat(5000) });
  assert.strictEqual(long.res.statusCode, 200);
  assert.ok(long.writes[0].params.every((p) => typeof p !== 'string' || p.length <= 200), 'a 5000-char topic was stored');
  // A non-text value is REFUSED, never blanked with a 200 -- that would destroy the
  // stored value while reporting success.
  const obj = await putSettings({ telegram_chat_id: { $gt: '' } });
  assert.strictEqual(obj.res.statusCode, 400);
  assert.deepStrictEqual(obj.res.body, { error: 'telegram_chat_id must be text' });
  assert.strictEqual(obj.writes.length, 0, 'an object reached the UPDATE');
});
checkAsync('a NUMERIC telegram_chat_id is stored as text, not silently wiped', async () => {
  // v1 stored whatever it was sent, and a chat id is a number. Wiping it would 200 and
  // quietly turn that user's Telegram reminders off.
  const { res, writes } = await putSettings({ telegram_chat_id: 123456789 });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(writes[0].params.includes('123456789'), `stored ${JSON.stringify(writes[0].params)}`);
});
checkAsync('an empty body keeps v1 wording, and an unknown key is ignored', async () => {
  const { res, writes } = await putSettings({ can_manage_users: 1 });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { error: 'No settings to update' });
  assert.strictEqual(writes.length, 0);
});

checkAsync('a PARTIAL outage with no match is "unavailable" too, not "not found"', async () => {
  // IGDB down, RAWG answered without an exact match: the game may be exactly where we
  // could not look. From the code review of CC-8.
  const catalog = require('../services/catalog');
  const libraryService = require('../services/library');
  const real = { search: catalog.searchAll, find: libraryService.findGame, get: db.get };
  catalog.searchAll = async () => ({
    results: [{ id: 'rawg_1', name: 'Something Else' }],
    providers: { igdb: 'failed', rawg: 'ok', thegamesdb: 'skipped' },
    counts: { igdb: 0, rawg: 1, thegamesdb: 0 }, degraded: true,
  });
  libraryService.findGame = async () => ({ game_id: 'igdb_1', game_name: 'Halo', release_date: null });
  db.get = (sql, params, cb) => cb(null, { id: 7, username: 'jane' });
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/user/:username/games/:gameId/refresh-metadata')(
      { params: { username: 'jane', gameId: 'igdb_1' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    catalog.searchAll = real.search; libraryService.findGame = real.find; db.get = real.get;
  }
  assert.strictEqual(res.body.results.details[0].error, 'Lookup unavailable',
    `a partial outage was reported as ${res.body.results.details[0].error}`);
});

console.log('POST /api/user/:username/games/:gameId/crackrelease-status (CC-11):');

async function crackRelease(fetchImpl, gameName = 'Halo') {
  const axiosMod = require('axios');
  const real = { axiosGet: axiosMod.get, get: db.get, run: db.promises.run };
  const writes = [];
  axiosMod.get = fetchImpl;
  db.get = (sql, params, cb) => cb(null, /FROM user_games/.test(sql) ? { game_name: gameName } : { id: 7, username: 'jane' });
  db.promises.run = async (sql, params) => { writes.push(params); return { changes: 1 }; };
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/user/:username/games/:gameId/crackrelease-status')(
      { params: { username: 'jane', gameId: 'igdb_1' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { axiosMod.get = real.axiosGet; db.get = real.get; db.promises.run = real.run; }
  return { res, writes };
}

checkAsync('a CrackRelease outage leaves the stored status alone and leaks no upstream text', async () => {
  const { res, writes } = await crackRelease(async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:443'); });
  assert.strictEqual(writes.length, 0, 'an outage overwrote the stored crack status');
  assert.strictEqual(res.body.status, 'unknown');
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.7'), 'the upstream error reached the caller');
});
checkAsync('the source link is always https://crackrelease.com/<slug>/, whatever the game is called (SEC-8)', async () => {
  // The SPA renders `url` into an href. It is BUILT here from a slug, never taken from
  // the page or the name, so no game name can make it a javascript: link. The client
  // also refuses anything that is not http(s); this pins the server half.
  for (const name of ['javascript:alert(document.domain)', 'Halo"><img src=x onerror=1>', '../../evil', 'data:text/html,x']) {
    const { res } = await crackRelease(async () => ({ data: '<b>CRACKED</b>' }), name);
    assert.match(String(res.body.url), /^https:\/\/crackrelease\.com\/[a-z0-9-]+\/$/,
      `'${name}' produced a source URL outside the fixed origin: ${res.body.url}`);
  }
});
checkAsync('a page that loads but carries no status word is not an answer', async () => {
  const parked = await crackRelease(async () => ({ data: '<html>This domain is for sale</html>' }));
  assert.strictEqual(parked.writes.length, 0, 'a parked page overwrote the stored crack status');
});
checkAsync('a page that WAS read is stored -- and only as a documented value', async () => {
  const cracked = await crackRelease(async () => ({ data: '<span> CRACKED </span>' }));
  assert.deepStrictEqual(cracked.writes.map((p) => p[0]), ['cracked']);
  const unreleased = await crackRelease(async () => ({ data: '<b>UNRELEASED</b>' }));
  assert.strictEqual(unreleased.res.body.status, 'unreleased', 'the response lost the scraped answer');
  assert.deepStrictEqual(unreleased.writes.map((p) => p[0]), ['unknown'], 'an undocumented value reached the column');
});


console.log('GET /api/user/:username/crack-status (UP-26: pinned before the move):');
checkAsync('a map of game_id -> status: the stored status wins, then the cache; unknown otherwise; DB error is 500', async () => {
  const real = { get: db.get, all: db.all };
  const rows = [
    { game_id: 'igdb_1', game_name: 'Anything', crack_status: 'uncracked' },
    { game_id: 'rawg_2', game_name: 'A Game Nobody Has Heard Of', crack_status: null },
  ];
  let fail = false;
  db.get = (sql, params, cb) => cb(null, { id: 7, username: 'jane' });
  db.all = (sql, params, cb) => (fail ? cb(new Error('ECONNREFUSED 10.0.0.5')) : cb(null, rows));
  const call = async () => {
    const res = recordingRes();
    await handlerFor('get', '/api/user/:username/crack-status')({ params: { username: 'Jane' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
    return res;
  };
  try {
    const ok = await call();
    assert.deepStrictEqual([ok.statusCode, ok.body], [200, { igdb_1: 'uncracked', rawg_2: 'unknown' }]);
    fail = true;
    const down = await call();
    assert.deepStrictEqual([down.statusCode, down.body], [500, { error: 'DB error' }]);
  } finally { db.get = real.get; db.all = real.all; }
});
checkAsync('crackrelease-status: an unknown game is 404, a DB error 500, both with v1\'s texts', async () => {
  const real = { get: db.get };
  let gameLookup;
  db.get = (sql, params, cb) => (/FROM user_games/.test(sql) ? gameLookup(cb) : cb(null, { id: 7, username: 'jane' }));
  const call = async () => {
    const res = recordingRes();
    await handlerFor('post', '/api/user/:username/games/:gameId/crackrelease-status')({ params: { username: 'jane', gameId: 'igdb_404' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
    return res;
  };
  try {
    gameLookup = (cb) => cb(null, undefined);
    const missing = await call();
    assert.deepStrictEqual([missing.statusCode, missing.body], [404, { error: 'Game not found for this user' }]);
    gameLookup = (cb) => cb(new Error('ECONNREFUSED 10.0.0.5'));
    const down = await call();
    assert.deepStrictEqual([down.statusCode, down.body], [500, { error: 'DB error' }]);
  } finally { db.get = real.get; }
});
checkAsync('a crack_status write that FAILS is logged, and the caller still gets the scraped answer (CC-11)', async () => {
  // The write is awaited inside its own try: a database failure must neither become the
  // response (a 500) nor escape as an unhandled rejection (review of 057f22b).
  const axiosMod = require('axios');
  const real = { axiosGet: axiosMod.get, get: db.get, run: db.promises.run, error: console.error };
  const logged = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  axiosMod.get = async () => ({ data: '<b>CRACKED</b>' });
  db.get = (sql, params, cb) => cb(null, /FROM user_games/.test(sql) ? { game_name: 'Halo' } : { id: 7, username: 'jane' });
  db.promises.run = () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('deadlock detected')), 20));
  console.error = (...a) => logged.push(a.join(' '));
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/user/:username/games/:gameId/crackrelease-status')(
      { params: { username: 'jane', gameId: 'igdb_1' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40));   // past the write's rejection
  } finally {
    axiosMod.get = real.axiosGet; db.get = real.get; db.promises.run = real.run; console.error = real.error;
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.strictEqual(res.statusCode, 200, 'a failed crack_status write became the response');
  assert.strictEqual(res.body.status, 'cracked');
  assert.ok(logged.some((l) => l.includes('Failed to update crack_status')), 'the failed write was not logged');
  assert.deepStrictEqual(unhandled, [], 'the failed write escaped as an unhandled rejection');
});

console.log('POST /api/admin/test-notification (SEC-1 per-user limiter):');

checkAsync('the 11th test notification in the window is 429, keyed per user', async () => {
  // The limiter, pulled out of the live route by name, so this is the one that runs.
  const { app } = require('../index.js');
  const layer = (app.router || app._router).stack.find((l) => l.route
    && l.route.path === '/api/admin/test-notification' && l.route.methods.post);
  const limiter = layer.route.stack.find((s) => s.handle.name === 'testNotificationLimit').handle;
  const call = (userId) => {
    const res = recordingRes();
    res.set = () => res;
    let passed = false;
    limiter({ user: { id: userId } }, res, () => { passed = true; });
    return { res, passed };
  };
  for (let i = 0; i < 10; i++) assert.ok(call(91001).passed, `test notification ${i + 1} was throttled`);
  const eleventh = call(91001);
  assert.strictEqual(eleventh.passed, false, 'the 11th test notification was allowed');
  assert.strictEqual(eleventh.res.statusCode, 429);
  assertKeys(eleventh.res.body, ['error'], 'test-notification 429');
  assert.ok(call(91002).passed, "one user's budget throttled another user");
});

checkAsync('the 61st crack-status check in the window is 429 {error}, keyed per user (SEC-15)', async () => {
  const { app } = require('../index.js');
  const layer = (app.router || app._router).stack.find((l) => l.route
    && l.route.path === '/api/user/:username/games/:gameId/crackrelease-status' && l.route.methods.post);
  const limiter = layer.route.stack.find((s) => s.handle.name === 'crackCheckLimit').handle;
  const call = (userId) => {
    const res = recordingRes();
    res.set = () => res;
    let passed = false;
    limiter({ user: { id: userId } }, res, () => { passed = true; });
    return { res, passed };
  };
  for (let i = 0; i < 60; i++) assert.ok(call(92001).passed, `crack check ${i + 1} was throttled`);
  const over = call(92001);
  assert.strictEqual(over.passed, false, 'the 61st check was allowed');
  assert.strictEqual(over.res.statusCode, 429);
  assertKeys(over.res.body, ['error'], 'crack-status 429');
  assert.ok(call(92002).passed, "one user's budget throttled another user");
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

// P0-1. Drives the real login handler with the directory stubbed to say YES, and the
// users table stubbed to hold a LOCAL administrator of the same name. The local row's
// bcrypt hash is real, so the fallback genuinely checks it.
async function ldapLoginAs(username, row, ip, opts = {}) {
  const ldapHelpers = require('../ldap-helpers');
  const settingsStore = require('../settings-store');
  const realVerify = ldapHelpers.verifyLdapCredentials;
  const realLoad = settingsStore.loadSettings;
  const realGet = db.get;
  const realRun = db.run;
  const realPGet = db.promises.get;
  const realPRun = db.promises.run;
  const writes = [];
  // BOTH write paths are recorded: the profile sync moved to db.promises.run (CC-12),
  // and a helper that only watched db.run would make the "relabelled" check vacuous.
  db.promises.run = async (sql) => {
    if (opts.syncFails) throw new Error('connection terminated');
    writes.push(sql);
    return { changes: opts.syncChanges ?? 1 };
  };
  settingsStore.loadSettings = () => ({
    ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw' },
  });
  ldapHelpers.verifyLdapCredentials = async () => (opts.verify || {
    ok: true, entry: { dn: `uid=${username},dc=x`, cn: username, memberOf: [] },
  });
  db.promises.get = async () => row;
  db.get = (sql, params, cb) => cb(null, row);
  db.run = (sql, params, cb) => { writes.push(sql); if (typeof cb === 'function') cb.call({ lastID: 99 }, null); };
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/auth/login')(
      { body: { username, password: 'the-directory-password' }, ip }, res);
    // Polled, not a fixed sleep: the local fallback runs a real bcrypt compare, and a
    // slow runner must not turn "no answer yet" into a pass for the no-token assertion.
    for (let i = 0; i < 200 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(res.headersSent, `the login route never answered for '${username}'`);
  } finally {
    ldapHelpers.verifyLdapCredentials = realVerify;
    settingsStore.loadSettings = realLoad;
    db.get = realGet;
    db.run = realRun;
    db.promises.get = realPGet;
    db.promises.run = realPRun;
  }
  return { res, writes };
}

checkAsync('a directory login named after a LOCAL admin does not sign in as it (P0-1)', async () => {
  // The directory authenticated `root` / `boss`, but the rows are local administrators
  // whose passwords are something else. The old route returned the row, relabelled it
  // origin='ldap' and signed a session carrying can_manage_users. Now the directory's
  // YES is ignored for these names and the LOCAL password decides — and it is wrong.
  const hash = require('bcryptjs').hashSync('the-local-password', 4);
  // `taken` is a takeover that already happened under the old code: origin='ldap',
  // hash kept. It must be refused too, or the fix undoes nothing already done.
  for (const [name, ip, origin] of [['root', '203.0.113.21', 'local'], ['boss', '203.0.113.22', 'local'],
    ['taken', '203.0.113.24', 'ldap']]) {
    const row = { id: 1, username: name, can_manage_users: 1, origin, password: hash };
    const { res, writes } = await ldapLoginAs(name, row, ip);
    assert.ok(!res.body || !res.body.token, `a directory login took over local account '${name}'`);
    assert.strictEqual(res.statusCode, 401, `'${name}': expected the local password to be checked`);
    assert.ok(!writes.some((w) => /origin/i.test(w)), `'${name}' was relabelled as a directory account`);
  }
});

// UP-21. The directory could not be REACHED. Before this, the route fell back to local
// auth, a directory account has no local hash, and the answer was 401 "Invalid
// credentials" -- every directory user was told their password was wrong during an
// outage, and each retry burned their lockout budget.
const UNREACHABLE = { ok: false, reason: 'unreachable' };

checkAsync('directory unreachable + a directory account: 503 {error}, never "wrong password" (UP-21)', async () => {
  const row = { id: 7, username: 'dora', can_manage_users: 0, origin: 'ldap', password: null };
  const { res } = await ldapLoginAs('dora', row, '203.0.113.41', { verify: UNREACHABLE });
  assert.strictEqual(res.statusCode, 503, 'an outage answered as a credential failure');
  assertKeys(res.body, ['error'], 'login 503');
  assert.ok(res.headers && res.headers['retry-after'], 'a 503 without Retry-After');
  assert.ok(!res.body.token);
});

checkAsync('directory unreachable + no local row: 503 too, so it names no account (UP-21)', async () => {
  // Same answer as a directory account: an outage must not become an oracle for which
  // usernames the directory holds.
  const { res } = await ldapLoginAs('ghost', undefined, '203.0.113.42', { verify: UNREACHABLE });
  assert.strictEqual(res.statusCode, 503);
});

checkAsync('directory unreachable + a LOCAL account: bcrypt still decides (UP-21 control)', async () => {
  // A local hash is a definitive answer, outage or not: the right password signs in and a
  // wrong one is 401 and counted -- an outage is not a window for guessing local passwords.
  const hash = require('bcryptjs').hashSync('local-pass', 4);
  const row = { id: 8, username: 'loki', can_manage_users: 0, origin: 'local', password: hash };
  const wrong = await ldapLoginAs('loki', row, '203.0.113.43', { verify: UNREACHABLE });
  assert.strictEqual(wrong.res.statusCode, 401, 'a wrong LOCAL password was not refused as one');
  const ldapHelpers = require('../ldap-helpers');
  const settingsStore = require('../settings-store');
  const realVerify = ldapHelpers.verifyLdapCredentials;
  const realLoad = settingsStore.loadSettings;
  const realGet = db.get;
  settingsStore.loadSettings = () => ({ ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw' } });
  ldapHelpers.verifyLdapCredentials = async () => UNREACHABLE;
  db.get = (sql, params, cb) => cb(null, row);
  const res = recordingRes();
  try {
    await handlerFor('post', '/api/auth/login')({ body: { username: 'loki', password: 'local-pass' }, ip: '203.0.113.44' }, res);
    for (let i = 0; i < 200 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    ldapHelpers.verifyLdapCredentials = realVerify;
    settingsStore.loadSettings = realLoad;
    db.get = realGet;
  }
  assert.strictEqual(res.statusCode, 200, 'a directory outage locked out a LOCAL account');
});

checkAsync('a REACHABLE directory: unknown user and wrong directory password stay 401 (UP-21 control)', async () => {
  // The outage flag is the whole boundary. Without these, marking `not_found` as an
  // outage turned every unknown username into a 503 with the suite green (CISO review).
  const nf = await ldapLoginAs('nobody', undefined, '203.0.113.51', { verify: { ok: false, reason: 'not_found' } });
  assert.strictEqual(nf.res.statusCode, 401, 'an unknown user on a working directory was not a plain 401');
  const row = { id: 10, username: 'dave', can_manage_users: 0, origin: 'ldap', password: null };
  const bp = await ldapLoginAs('dave', row, '203.0.113.52', { verify: { ok: false, reason: 'bad_password' } });
  assert.strictEqual(bp.res.statusCode, 401, 'a wrong directory password was not a plain 401');
});

checkAsync('outage retries never lock the ACCOUNT out, but still count against the IP (UP-21)', async () => {
  const row = { id: 9, username: 'dana', can_manage_users: 0, origin: 'ldap', password: null };
  // Eight tries for one account from eight addresses: the owner is never locked out.
  for (let i = 0; i < 8; i++) {
    const { res } = await ldapLoginAs('dana', row, `198.51.100.${10 + i}`, { verify: UNREACHABLE });
    assert.strictEqual(res.statusCode, 503, `outage attempt ${i + 1} for one account answered ${res.statusCode}`);
  }
  // Many accounts from ONE address: the IP budget still applies, so an outage is no spray window.
  let throttled = false;
  for (let i = 0; i < 8 && !throttled; i++) {
    const { res } = await ldapLoginAs(`spray${i}`, undefined, '198.51.100.99', { verify: UNREACHABLE });
    throttled = res.statusCode === 429;
  }
  assert.ok(throttled, 'outage attempts from one IP were never throttled');
});

checkAsync('a directory login for a directory account still signs in (P0-1 control)', async () => {
  // Without this, the assertion above would pass for a route that refused every LDAP login.
  const row = { id: 5, username: 'jane', can_manage_users: 0, origin: 'ldap', password: null };
  const { res, writes } = await ldapLoginAs('jane', row, '203.0.113.23');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body && typeof res.body.token === 'string', 'a legitimate directory login got no session');
  // CC-12: the profile sync is issued, ONCE, and before the session is answered.
  assert.strictEqual(writes.filter((w) => /UPDATE users SET display_name/.test(w)).length, 1,
    `profile sync writes: ${JSON.stringify(writes)}`);
  // ...and the write itself refuses a row that holds a local password hash.
  assert.ok(writes.some((w) => /UPDATE users SET display_name[\s\S]*AND password IS NULL/.test(w)),
    'the profile sync can relabel a row that has a local password');
});

checkAsync('a row that gained a local password DURING login gets no directory session', async () => {
  // The claim check saw a passwordless directory row; by the profile sync, a local hash
  // was set, so the guarded UPDATE matched nothing. Signing the token anyway would be a
  // directory session on a local account. The local password decides instead -- and the
  // directory password is not it.
  const row = { id: 8, username: 'kim', can_manage_users: 1, origin: 'ldap', password: null };
  const warn = console.warn; console.warn = () => {};
  let out;
  try { out = await ldapLoginAs('kim', row, '203.0.113.26', { syncChanges: 0 }); } finally { console.warn = warn; }
  assert.ok(!out.res.body || !out.res.body.token, 'a directory session was signed for a row that now has a local password');
  // 401 from LOCAL auth: the row's password decided, and the directory's was not it.
  assert.strictEqual(out.res.statusCode, 401);
});

checkAsync('a failed profile sync is logged, and does not refuse the login (CC-12)', async () => {
  const row = { id: 6, username: 'joe', can_manage_users: 0, origin: 'ldap', password: null };
  const errLog = console.error; console.error = () => {};
  let out;
  try { out = await ldapLoginAs('joe', row, '203.0.113.25', { syncFails: true }); } finally { console.error = errLog; }
  assert.strictEqual(out.res.statusCode, 200, 'a profile-sync failure refused a login the directory approved');
  assert.ok(typeof out.res.body.token === 'string');
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

// --- the statistics shapes three components bind to -------------------------------
//
// Neither /api/user/:u/stats nor .../games/:id/history had a single assertion here, so
// `inProgress` joined a v1 response with nothing covering it and the nested field names
// were pinned nowhere at all. The smoke test greps TOP-LEVEL keys only, so renaming
// `days` to `durationDays` broke the card badge, the modal headline and both statistics
// panels with every job in CI green.
//
// Driven through the real services against stubbed db.promises, so these are the shapes
// the service actually emits rather than a literal restating the intent.

const statsSvc = require('../services/stats');

// EXACT key equality here too — the file's existing `keysOf` does that job.

checkAsync('the statistics summary keeps the shape the page and the card read', async () => {
  const dbMod = require('../db');
  const realAll = dbMod.promises.all, realGet = dbMod.promises.get;
  const iso = new Date('2026-03-02T00:00:00Z').toISOString();
  const started = new Date('2026-03-01T00:00:00Z').toISOString();
  dbMod.promises.all = async (q) => {
    if (/FROM user_games ug/.test(q)) {
      return [{ game_id: 'igdb_1', game_name: 'A', started_at: started }];
    }
    if (/d\.changed_at AS finished_at/.test(q)) {
      return [{ game_id: 'igdb_1', game_name: 'A', started_at: started, finished_at: iso }];
    }
    return [{ game_id: 'igdb_1', game_name: 'A', changed_at: iso }];
  };
  dbMod.promises.get = async (q) => (/COUNT\(\*\)::int AS n FROM user_games/.test(q)
    ? { n: 1 }
    : { total: 2, userEvents: 2, firstAt: iso });
  let out;
  try { out = await statsSvc.summary(1); } finally {
    dbMod.promises.all = realAll; dbMod.promises.get = realGet;
  }

  assert.deepStrictEqual(keysOf(out),
    ['completions', 'coverage', 'durations', 'inProgress', 'trackingSince'],
    'the statistics summary gained or lost a top-level field');
  assert.deepStrictEqual(keysOf(out.coverage),
    ['libraryDone', 'recordedCompletions', 'totalEvents', 'truncated', 'userEvents']);
  assert.deepStrictEqual(keysOf(out.completions[0]), ['at', 'gameId', 'name'],
    'StatsPage joins completions to durations on gameId + at');
  assert.deepStrictEqual(keysOf(out.durations[0]),
    ['days', 'finishedAt', 'gameId', 'name', 'startedAt'],
    'the card badge and the finished list both read durations[].days');
  assert.deepStrictEqual(keysOf(out.inProgress[0]), ['days', 'gameId', 'name', 'startedAt'],
    'inProgress must not regrow coverUrl — nothing reads it');
});

checkAsync('a game history keeps the shape the modal reads', async () => {
  const dbMod = require('../db');
  const realAll = dbMod.promises.all;
  const at = new Date('2026-03-02T00:00:00Z').toISOString();
  dbMod.promises.all = async (q) => (/WHERE\s+e\.user_id/.test(q)
    ? [{ from_status: 'playing', to_status: 'done', changed_at: at, source: 'user' }]
    : [{ game_id: 'igdb_1', started_at: new Date('2026-03-01T00:00:00Z').toISOString(), finished_at: at }]);
  let out;
  try { out = await statsSvc.gameHistory(1, 'igdb_1'); } finally { dbMod.promises.all = realAll; }

  assert.deepStrictEqual(keysOf(out),
    ['daysToFinish', 'events', 'finishedAt', 'gameId', 'startedAt', 'truncated'],
    'the history response gained or lost a top-level field');
  assert.deepStrictEqual(keysOf(out.events[0]), ['at', 'from', 'source', 'to'],
    'the timeline renders every one of these, and labels rows by `source`');
});

console.log('GET /api/debug/user/:username/game/:gameId (SEC-10 — kept, frozen):');

async function debugRead(row) {
  const libraryService = require('../services/library');
  const real = { get: db.get, find: libraryService.findGame };
  const asked = [];
  db.get = (sql, params, cb) => cb(null, { id: 7, username: 'jane' });
  libraryService.findGame = async (userId, gameId) => { asked.push([userId, gameId]); return row; };
  const res = recordingRes();
  try {
    await handlerFor('get', '/api/debug/user/:username/game/:gameId')(
      { params: { username: 'Jane', gameId: 'igdb_1' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { db.get = real.get; libraryService.findGame = real.find; }
  return { res, asked };
}

checkAsync('the single-game read keeps its six-field shape and reads through the service', async () => {
  const { res, asked } = await debugRead({ game_id: 'igdb_1', game_name: 'Halo', status: 'done', user_id: 7, steam_app_id: '1', last_price: 'x' });
  assert.deepStrictEqual(asked, [[7, 'igdb_1']], 'the route no longer reads through libraryService.findGame');
  assertKeys(res.body, ['game_id', 'game_name', 'status', 'user_id', 'username', 'timestamp'], 'debug game read');
  assert.strictEqual(res.body.username, 'jane');
});

checkAsync('a failed read is 500 {error:"DB error"} and the request is never logged', async () => {
  // The point of SEC-10: the route used to log the username, the raw :gameId and the
  // row on EVERY request. Nothing request-derived may reach the log now, on either path.
  const libraryService = require('../services/library');
  const logged = [];
  const real = { get: db.get, find: libraryService.findGame, log: console.log, info: console.info, error: console.error };
  console.log = console.info = console.error = (...a) => logged.push(a.join(' '));
  db.get = (sql, params, cb) => cb(null, { id: 7, username: 'jane' });
  const call = async (find) => {
    libraryService.findGame = find;
    const res = recordingRes();
    await handlerFor('get', '/api/debug/user/:username/game/:gameId')(
      { params: { username: 'jane', gameId: 'igdb_MARKER' } }, res);
    for (let i = 0; i < 50 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 5));
    return res;
  };
  let ok, failed;
  try {
    ok = await call(async () => ({ game_id: 'igdb_MARKER', game_name: 'Halo', status: 'done', user_id: 7 }));
    failed = await call(async () => { throw new Error('boom'); });
  } finally {
    Object.assign(console, { log: real.log, info: real.info, error: real.error });
    db.get = real.get; libraryService.findGame = real.find;
  }
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(failed.statusCode, 500);
  assert.deepStrictEqual(failed.body, { error: 'DB error' });
  const leaked = logged.filter((l) => /igdb_MARKER|jane|Halo/.test(l));
  assert.deepStrictEqual(leaked, [], 'request data reached the log');
});

checkAsync('an absent game is still 404 {error}', async () => {
  const { res } = await debugRead(undefined);
  assert.strictEqual(res.statusCode, 404);
  assertKeys(res.body, ['error'], 'debug game 404');
});

console.log('Token scopes (SEC-12 — admin does not imply library):');
// Authorization BEHAVIOUR rather than a shape, placed here because this file already
// loads index.js and drives the live route chains; helpers.test.js must not load it.

// The REAL chains, pulled off the live routers, so what runs here is what serves.
function routeChain(stack, method, path) {
  const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is not a live route`);
  return layer.route;
}
function v2Stack() {
  const { app } = require('../index.js');
  const mount = (app.router || app._router).stack.find(
    (l) => l.handle && Array.isArray(l.handle.stack) && l.handle.stack.some((x) => x.route && x.route.path === '/jobs/:jobId'));
  return mount.handle.stack;
}
const scopedIdentity = (scopes, admin = true) => ({
  user: { id: 7, username: 'ops', can_manage_users: admin, origin: 'local', display_name: 'ops' },
  scopes, tokenId: 1, expiresAt: null,
});

// v1: authRequired, fed a PAT, on a library route and on an admin route.
async function v1Call(method, path, scopes) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-signing';
  const { app } = require('../index.js');
  const authService = require('../services/auth');
  const route = routeChain((app.router || app._router).stack, method, path);
  const authRequired = route.stack.find((s) => s.handle.name === 'authRequired').handle;
  const realVerify = authService.verifyToken;
  authService.verifyToken = async () => scopedIdentity(scopes);
  const res = recordingRes();
  let passed = false;
  try {
    await authRequired({ headers: { authorization: 'Bearer gt_pat_scope-test' }, route }, res, () => { passed = true; });
  } finally {
    authService.verifyToken = realVerify;
  }
  return { res, passed };
}

checkAsync('v1: an admin-only token is refused on a library route, with the {error} envelope', async () => {
  const { res, passed } = await v1Call('get', '/api/user/:username/games', ['admin']);
  assert.strictEqual(passed, false, 'an admin-only token reached a library route on v1');
  assert.strictEqual(res.statusCode, 403);
  assertKeys(res.body, ['error'], 'v1 scope refusal');
});

checkAsync('v1: an admin-only token still reaches an admin route', async () => {
  const { passed } = await v1Call('get', '/api/users', ['admin']);
  assert.strictEqual(passed, true, 'the admin-only token lost the admin routes it exists for');
});

checkAsync('v1: a library token reaches a library route', async () => {
  const { passed } = await v1Call('get', '/api/user/:username/games', ['library']);
  assert.strictEqual(passed, true);
});

checkAsync('v1: with no route context the scope check fails CLOSED', async () => {
  const authService = require('../services/auth');
  const route = routeChain((require('../index.js').app.router || require('../index.js').app._router).stack, 'get', '/api/users');
  const authRequired = route.stack.find((s) => s.handle.name === 'authRequired').handle;
  const realVerify = authService.verifyToken;
  authService.verifyToken = async () => scopedIdentity(['admin']);
  const res = recordingRes();
  let passed = false;
  try {
    await authRequired({ headers: { authorization: 'Bearer gt_pat_scope-test' } }, res, () => { passed = true; });
  } finally { authService.verifyToken = realVerify; }
  assert.strictEqual(passed, false, 'an admin-only token passed where authRequired could not see the route');
  assert.strictEqual(res.statusCode, 403);
});

// v2: the guard itself, and the job poll whose scope comes from the job.
function v2Res() {
  const res = recordingRes();
  res.set = () => res;
  res.type = () => res;
  return res;
}
checkAsync('v2: requireLibraryScope refuses an admin-only token and admits a library one', async () => {
  const guard = routeChain(v2Stack(), 'get', '/library/games').stack
    .find((s) => s.handle.name === 'requireLibraryScope').handle;
  const run = (scopes) => {
    const res = v2Res();
    let passed = false;
    guard({ user: { can_manage_users: true }, auth: { scopes } }, res, () => { passed = true; });
    return { res, passed };
  };
  const admin = run(['admin']);
  assert.strictEqual(admin.passed, false, 'an admin-only token reached a v2 library route');
  assert.strictEqual(admin.res.statusCode, 403);
  assert.strictEqual(admin.res.body.code, 'forbidden');
  assert.strictEqual(run(['library']).passed, true);
  assert.strictEqual(run(['admin', 'library']).passed, true);
});

checkAsync('v2: a job is readable with the scope that STARTED it, and no other', async () => {
  // REAL records from the job store, not hand-built ones: a fake record once used field
  // names the runner does not have, and the 200s it asserted proved only "not 403".
  const jobRunner = require('../services/job-runner');
  const handler = routeChain(v2Stack(), 'get', '/jobs/:jobId').stack.slice(-1)[0].handle;
  const started = {
    self: jobRunner.start({ kind: 'refreshMetadata', scope: 'self', ownerId: 7, work: async () => 0 }),
    instance: jobRunner.start({ kind: 'checkReleases', scope: 'instance', ownerId: 7, work: async () => 0 }),
  };
  const poll = (which, scopes, admin, userId = 7) => {
    const res = v2Res();
    res.statusCode = 0;   // recordingRes defaults to 200; a handler that never answered must not pass
    handler({ params: { jobId: started[which].id }, user: { id: userId, can_manage_users: admin }, auth: { scopes } }, res);
    return res;
  };
  const ok = poll('instance', ['admin'], true);
  assert.strictEqual(ok.statusCode, 0, 'the job poll set a status on success; expected a plain res.json');
  assert.strictEqual(ok.body && ok.body.id, started.instance.id, 'an admin-only token cannot poll the sweep it started');
  assert.strictEqual(poll('instance', ['library'], false).statusCode, 403, "a library token read an instance-wide job's results");
  assert.strictEqual(poll('self', ['library'], false).body.id, started.self.id, 'a library token cannot poll its own refresh');
  assert.strictEqual(poll('self', ['admin'], true).statusCode, 403, "an admin-only token read a library refresh's results");
  // Ownership BEFORE scope: someone else's job is a 404 whatever the token holds.
  assert.strictEqual(poll('instance', ['library'], false, 8).statusCode, 404, "another account's job answered other than 404");
});

checkAsync('v2 POST /library/games: the duplicate policy goes IN, the hint comes OUT (UP-19)', async () => {
  // The adapter owns no rule, but it must carry both: a dropped `onPossibleDuplicate`
  // silently turns an agent's "ask first" into "add anyway", and a dropped hint hides
  // the duplicate it exists to report.
  const catalogService = require('../services/catalog');
  const libraryService = require('../services/library');
  const realResolve = catalogService.resolveGame;
  const realAdd = libraryService.addResolvedGame;
  let seenOptions;
  catalogService.resolveGame = async () => ({ id: 'rawg_7', name: 'Halo', releaseDate: '2001-11-15' });
  libraryService.addResolvedGame = async (userId, game, status, deps, options) => {
    seenOptions = options;
    return { created: true, events: [], game: { game_id: 'rawg_7', game_name: 'Halo', status: 'wishlist' },
      possibleDuplicates: [{ gameId: 'igdb_1', name: 'Halo', releaseDate: '2001-11-15', match: 'same' }] };
  };
  const handler = routeChain(v2Stack(), 'post', '/library/games').stack.slice(-1)[0].handle;
  const res = v2Res();
  try {
    handler({ body: { name: 'Halo', onPossibleDuplicate: 'reject' }, user: { id: 7, username: 'u' }, auth: { scopes: ['library'] } }, res);
    for (let i = 0; i < 100 && !res.body; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    catalogService.resolveGame = realResolve;
    libraryService.addResolvedGame = realAdd;
  }
  assert.deepStrictEqual(seenOptions, { onPossibleDuplicate: 'reject' }, 'the policy did not reach the service');
  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body.possibleDuplicates,
    [{ gameId: 'igdb_1', name: 'Halo', releaseDate: '2001-11-15', match: 'same' }], 'the hint did not reach the caller');
});

// SEC-14: the browser session cookie. Driven through the REAL middleware chains, so what
// is pinned is what a request meets, not what a function returns in isolation.
{
  const sess = require('../services/session');
  // The SAME default handlerFor() gives index.js, set BEFORE it is read: CI runs `npm test`
  // with no JWT_SECRET, and reading it here first captured undefined -- every session this
  // block signed was "secretOrPrivateKey must have a value".
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-signing';
  const SECRET = process.env.JWT_SECRET;
  const ROW = { id: 31, username: 'cookie-user', can_manage_users: 0, origin: 'local', display_name: 'Cookie User' };
  const CSRF = { 'x-requested-with': 'GameTracker' };
  const cookieFor = (token) => `__Host-gt_session=${token}`;
  // Run a chain of middleware the way Express would, stopping at the first response.
  const runChain = async (handlers, req) => {
    const res = recordingRes();
    res.statusCode = 0;
    for (const h of handlers) {
      let advanced = false;
      await new Promise((resolve) => {
        const done = () => { advanced = true; resolve(); };
        h(req, res, done);
        const poll = () => (res.headersSent || advanced ? resolve() : setTimeout(poll, 2));
        poll();
      });
      if (!advanced) break;
    }
    return res;
  };
  const withUserRow = async (row, fn) => {
    const realGet = db.get;
    db.get = (sql, params, cb) => cb(null, row);
    try { return await fn(); } finally { db.get = realGet; }
  };
  const v1Chain = (method, path) => routeChain((require('../index.js').app.router || require('../index.js').app._router).stack, method, path)
    .stack.map((l) => l.handle);
  const setCookies = (res) => [].concat(res.headers['set-cookie'] || []);

  checkAsync('login WITHOUT the opt-in: the frozen {token}, no Set-Cookie, no-store (SEC-14 cond. 4, 9)', async () => {
    const hash = require('bcryptjs').hashSync('pw-cookie-1', 4);
    const res = await withUserRow({ ...ROW, password: hash }, () =>
      runChain([handlerFor('post', '/api/auth/login')], { body: { username: 'cookie-user', password: 'pw-cookie-1' }, headers: {}, ip: '198.51.100.201' }));
    assertKeys(res.body, ['token'], 'login without the opt-in');
    assert.strictEqual(setCookies(res).length, 0, 'a no-opt-in login sent a Set-Cookie -- Android would store it');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
  });

  checkAsync('login WITH the opt-in: {session}, exact keys, the __Host- cookie, NO token in the body', async () => {
    const hash = require('bcryptjs').hashSync('pw-cookie-2', 4);
    const res = await withUserRow({ ...ROW, password: hash }, () =>
      runChain([handlerFor('post', '/api/auth/login')], { body: { username: 'cookie-user', password: 'pw-cookie-2', session: 'cookie' }, headers: CSRF, ip: '198.51.100.202' }));
    assertKeys(res.body, ['session'], 'cookie login');
    assert.strictEqual(res.headers['cache-control'], 'no-store', 'a Set-Cookie response is cacheable');
    assertKeys(res.body.session, ['can_manage_users', 'cookieSecure', 'display_name', 'exp', 'expiresIn', 'origin', 'username'], 'cookie login session');
    assert.ok(!JSON.stringify(res.body).includes('eyJ'), 'a JWT reached the cookie-mode body');
    const [c] = setCookies(res);
    assert.ok(c && c.startsWith('__Host-gt_session=') && /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Strict/.test(c) && /Path=\//.test(c), `cookie: ${c}`);
  });

  checkAsync('cookie login needs the CSRF header (403, no cookie); a bad `session` value is 400', async () => {
    const hash = require('bcryptjs').hashSync('pw-cookie-3', 4);
    const noHeader = await withUserRow({ ...ROW, password: hash }, () =>
      runChain([handlerFor('post', '/api/auth/login')], { body: { username: 'cookie-user', password: 'pw-cookie-3', session: 'cookie' }, headers: {}, ip: '198.51.100.203' }));
    assert.strictEqual(noHeader.statusCode, 403, 'login CSRF from a sibling subdomain would fix a session');
    assert.strictEqual(setCookies(noHeader).length, 0);
    const bad = await runChain([handlerFor('post', '/api/auth/login')], { body: { username: 'x', password: 'y', session: 'jwt' }, headers: {}, ip: '198.51.100.204' });
    assert.strictEqual(bad.statusCode, 400);
  });

  checkAsync('a P0-1 directory takeover in COOKIE mode sets no cookie either', async () => {
    const hash = require('bcryptjs').hashSync('the-local-password', 4);
    const ldapHelpers = require('../ldap-helpers');
    const settingsStore = require('../settings-store');
    const realVerify = ldapHelpers.verifyLdapCredentials, realLoad = settingsStore.loadSettings;
    settingsStore.loadSettings = () => ({ ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw' } });
    ldapHelpers.verifyLdapCredentials = async () => ({ ok: true, entry: { dn: 'uid=root,dc=x', cn: 'root', memberOf: [] } });
    const row = { id: 1, username: 'root', can_manage_users: 1, origin: 'local', password: hash };
    // The directory path reads and syncs through db.promises, the local fallback through
    // db.get: both are stubbed, as ldapLoginAs does, or the answer is a DB-error 500.
    const realPGet = db.promises.get, realPRun = db.promises.run;
    db.promises.get = async () => row;
    db.promises.run = async () => ({ changes: 1 });
    try {
      const res = await withUserRow(row, () =>
        runChain([handlerFor('post', '/api/auth/login')], { body: { username: 'root', password: 'the-directory-password', session: 'cookie' }, headers: CSRF, ip: '198.51.100.205' }));
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(setCookies(res).length, 0, 'a refused takeover still received a session cookie');
    } finally {
      ldapHelpers.verifyLdapCredentials = realVerify; settingsStore.loadSettings = realLoad;
      db.promises.get = realPGet; db.promises.run = realPRun;
    }
  });

  checkAsync('GET /api/auth/session: cookie + header answers the RE-READ privilege; each refusal is the right one', async () => {
    const { token } = sess.issue({ ...ROW, can_manage_users: 1 }, SECRET);   // the JWT says admin...
    const chain = v1Chain('get', '/api/auth/session');
    const ok = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, cookie: cookieFor(token) } }));
    assertKeys(ok.body, ['session'], 'GET /api/auth/session');
    assert.strictEqual(ok.body.session.can_manage_users, false, '...but the ROW says not: the JWT claim was answered');
    assert.strictEqual(ok.headers['cache-control'], 'no-store');
    // No CSRF header: 403, and the cookie is NOT cleared (the credential may be fine).
    const noCsrf = await withUserRow(ROW, () => runChain(chain, { headers: { cookie: cookieFor(token) } }));
    assert.strictEqual(noCsrf.statusCode, 403, 'a missing CSRF header was a 401 -- that signs the SPA out');
    assert.strictEqual(setCookies(noCsrf).length, 0);
    // An invalid cookie: 401, and CLEARED so it cannot loop the browser (cond. 6).
    const bad = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, cookie: cookieFor('garbage') } }));
    assert.strictEqual(bad.statusCode, 401);
    assert.match(setCookies(bad)[0] || '', /Max-Age=0/, 'a rejected cookie was not cleared');
    // The user is gone: 401 and cleared too.
    const gone = await withUserRow(undefined, () => runChain(chain, { headers: { ...CSRF, cookie: cookieFor(token) } }));
    assert.strictEqual(gone.statusCode, 401);
    assert.match(setCookies(gone)[0] || '', /Max-Age=0/);
    // The cookie twice: refused and cleared (cond. 1).
    const dup = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, cookie: `${cookieFor(token)}; ${cookieFor(token)}` } }));
    assert.strictEqual(dup.statusCode, 401);
    assert.match(setCookies(dup)[0] || '', /Max-Age=0/, 'a duplicated cookie was refused but not cleared');
    // A PAT is never accepted from the cookie.
    const pat = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, cookie: cookieFor(`gt_pat_${'A'.repeat(43)}`) } }));
    assert.strictEqual(pat.statusCode, 401);
  });

  checkAsync('an Authorization header ALONE decides: a bad Bearer never falls through to the cookie (cond. 5)', async () => {
    const { token } = sess.issue(ROW, SECRET);
    const chain = v1Chain('get', '/api/capabilities');
    const res = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, authorization: 'Bearer nope', cookie: cookieFor(token) } }));
    assert.strictEqual(res.statusCode, 401, 'an invalid Bearer fell through to a valid cookie');
    // ANY Authorization header decides, not only a Bearer one: another scheme next to a valid
    // cookie is a 401, never a quiet fall-through to the cookie.
    const basic = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, authorization: 'Basic cm9vdDpwdw==', cookie: cookieFor(token) } }));
    assert.strictEqual(basic.statusCode, 401, 'a non-Bearer Authorization header fell through to the cookie');
    // ...and an EMPTY one: present is present (review: `!auth` in place of `=== undefined`
    // would let `Authorization:` with no value fall through to the cookie).
    const empty = await withUserRow(ROW, () => runChain(chain, { headers: { ...CSRF, authorization: '', cookie: cookieFor(token) } }));
    assert.strictEqual(empty.statusCode, 401, 'an empty Authorization header fell through to the cookie');
    // And the browser-only routes refuse a valid Bearer session: they are for the cookie.
    const viaBearer = await withUserRow(ROW, () => runChain(v1Chain('get', '/api/auth/session'), { headers: { authorization: `Bearer ${token}` } }));
    assert.strictEqual(viaBearer.statusCode, 403);
  });

  checkAsync('the session route passes the COOKIE MODE, so System Status can warn about insecure mode', async () => {
    // Called through the module object: a route that drops the mode argument would report
    // cookieSecure:true on an insecure instance, and the warning would never show.
    const { token } = sess.issue(ROW, SECRET);
    const real = sess.sessionView;
    let args;
    sess.sessionView = (...a) => { args = a; return real(...a); };
    try {
      await withUserRow(ROW, () => runChain(v1Chain('get', '/api/auth/session'), { headers: { ...CSRF, cookie: cookieFor(token) } }));
    } finally { sess.sessionView = real; }
    assert.strictEqual(args && args[3], 'secure', 'the session route no longer tells the view which cookie mode is in force');
  });

  check('an INSECURE-mode instance reports cookieSecure:false and sets an unprefixed, non-Secure cookie', () => {
    // The mode is read once, when index.js loads, so only a second process can run the route
    // in the other mode. The test above cannot tell a route that passes the mode from one
    // that hard-codes 'secure' on a secure instance; this one can (Architect review).
    const { execFileSync } = require('child_process');
    // Both routes that take the mode run for real: the session view, and the cookie LOGIN,
    // whose Set-Cookie is read off its own response (not built by calling setCookie here,
    // which proved nothing about the route -- review of 5ac5af4).
    const probe = `
      const db = require('./db');
      const hash = require('bcryptjs').hashSync('pw-insecure', 4);
      db.get = (sql, params, cb) => cb(null, { id: 9, username: 'jane', password: hash, can_manage_users: 0, origin: 'local', display_name: 'Jane' });
      const { app } = require('./index.js');
      const stack = (app.router || app._router).stack;
      const last = (path, method) => { const r = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]).route; return r.stack[r.stack.length - 1].handle; };
      const fakeRes = () => {
        const r = { headers: {} };
        r.done = new Promise((resolve) => { r.json = (b) => { r.body = b; resolve(); return r; }; });
        r.status = (c) => { r.statusCode = c; return r; };
        r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
        r.append = (k, v) => { r.headers[k.toLowerCase()] = [].concat(r.headers[k.toLowerCase()] || [], v); return r; };
        return r;
      };
      (async () => {
        const out = {};
        const view = fakeRes();
        last('/api/auth/session', 'get')({ user: { username: 'jane', can_manage_users: 0 }, auth: { exp: Math.floor(Date.now() / 1000) + 60 } }, view);
        await view.done;
        out.view = view.body;
        const login = fakeRes();
        last('/api/auth/login', 'post')({ body: { username: 'jane', password: 'pw-insecure', session: 'cookie' },
          headers: { 'x-requested-with': 'GameTracker' }, ip: '198.51.100.250', connection: {} }, login);
        await login.done;
        out.login = login.body;
        out.cookies = login.headers['set-cookie'] || [];
        process.stdout.write('\\nRESULT ' + JSON.stringify(out) + '\\n');
        process.exit(0);
      })().catch((e) => { console.error(e); process.exit(1); });`;
    const env = { ...process.env, SESSION_COOKIE_INSECURE: '1', JWT_SECRET: SECRET };
    const stdout = execFileSync(process.execPath, ['-e', probe], { cwd: require('path').join(__dirname, '..'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `the insecure-mode probe printed no result:\n${stdout}`);
    const out = JSON.parse(line.slice('RESULT '.length));
    assert.strictEqual(out.view.session.cookieSecure, false, 'the session route ignores the configured cookie mode');
    assert.strictEqual(out.login.session && out.login.session.cookieSecure, false, 'the login answer ignores the cookie mode');
    assert.strictEqual(out.cookies.length, 1, `the insecure login set ${out.cookies.length} cookies`);
    assert.match(out.cookies[0], /^gt_session=[^;]+; Path=\/; /, 'the insecure login did not set the unprefixed cookie');
    assert.ok(!/Secure/.test(out.cookies[0]), 'the insecure login set a Secure cookie a plain-HTTP browser drops');
  });

  checkAsync('POST /api/auth/logout clears the cookie with 204', async () => {
    const { token } = sess.issue(ROW, SECRET);
    const res = await withUserRow(ROW, () => runChain(v1Chain('post', '/api/auth/logout'), { headers: { ...CSRF, cookie: cookieFor(token) } }));
    assert.strictEqual(res.statusCode, 204);
    assert.match(setCookies(res)[0] || '', /^__Host-gt_session=; Path=\/; Max-Age=0/);
  });

  checkAsync('/api/v2 NEVER accepts the session cookie, even with the CSRF header (SEC-14 constraint)', async () => {
    const { token } = sess.issue({ ...ROW, can_manage_users: 1 }, SECRET);
    const guard = v2Stack().find((l) => l.handle && l.handle.name === 'patRequired').handle;
    const res = v2Res();
    res.statusCode = 0;
    let passed = false;
    await withUserRow(ROW, async () => {
      guard({ headers: { ...CSRF, cookie: cookieFor(token) } }, res, () => { passed = true; });
      for (let i = 0; i < 50 && !res.body && !passed; i++) await new Promise((r) => setTimeout(r, 2));
    });
    assert.strictEqual(passed, false, 'v2 accepted a browser session cookie');
    assert.strictEqual(res.statusCode, 401);
  });
}

// UP-16: the LDAP sync moved to services/ldap-sync.js, and the route is an adapter over it.
// The SPA's User Management page reads `success`, `results.updated`, `results.total` and,
// on failure, `error`, so the envelope is pinned here with the two error mappings the old
// inline route answered.
console.log('POST /api/admin/ldap-sync (v1 envelope over services/ldap-sync.js):');
async function callLdapSync(stub) {
  const ldapSync = require('../services/ldap-sync');
  const real = ldapSync.syncAll;
  ldapSync.syncAll = stub;
  const res = recordingRes();
  const errors = console.error;
  console.error = () => {};
  try { await handlerFor('post', '/api/admin/ldap-sync')({ body: {} }, res); }
  finally { ldapSync.syncAll = real; console.error = errors; }
  return res;
}
checkAsync('success is {success, message, results} with the counts in the message', async () => {
  const results = { total: 3, updated: 1, errors: [], details: [{ username: 'a', action: 'updated', changes: ['email'] }] };
  // The adapter must hand over THE CONFIGURED ldap section: `syncAll({})` would make every
  // sync a 400 in production, and "some object" could not tell (review of 5ac5af4).
  const settingsStore = require('../settings-store');
  const realLoad = settingsStore.loadSettings;
  const configured = { url: 'ldaps://dc.example', base: 'dc=example', bindDn: 'cn=svc', bindPass: 'pw' };
  settingsStore.loadSettings = () => ({ ldap: configured });
  let got;
  let res;
  try { res = await callLdapSync(async (ldap) => { got = ldap; return results; }); }
  finally { settingsStore.loadSettings = realLoad; }
  assert.strictEqual(res.statusCode, 200);
  assertKeys(res.body, ['message', 'results', 'success'], 'ldap-sync success');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.message, 'LDAP sync completed. 1 users updated out of 3 total LDAP users.');
  assert.strictEqual(res.body.results, results, 'the service result was not passed through unchanged');
  assert.strictEqual(got, configured, 'the adapter did not hand the service the configured ldap section');
});
checkAsync('not configured is 400 {error} with the message the SPA has always shown', async () => {
  const { serviceError, CODES } = require('../services/errors');
  const res = await callLdapSync(async () => { throw serviceError(CODES.VALIDATION, 'LDAP is not properly configured'); });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { error: 'LDAP is not properly configured' });
});
checkAsync('an unexpected failure is 500 {error} and does NOT echo the exception message', async () => {
  const res = await callLdapSync(async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { error: 'LDAP sync failed.' }, 'the 500 echoed the exception or changed its text');
});

// UP-16: the login decision is services/login.js; the route maps its outcomes. Each status
// and body is pinned here, driven through the real handler with the service stood in for.
console.log('POST /api/auth/login (v1 statuses over services/login.js):');
checkAsync('each outcome maps to the status and {error} text v1 always answered', async () => {
  const loginService = require('../services/login');
  const O = loginService.OUTCOMES;
  const real = loginService.authenticate;
  const cases = [
    [{ status: O.INVALID }, 401, { error: 'Invalid credentials' }],
    [{ status: O.NOT_IN_GROUP }, 403, { error: 'Not a member of the required group' }],
    [{ status: O.ERROR, message: 'Database error' }, 500, { error: 'Database error' }],
    [{ status: O.ERROR, message: 'DB error' }, 500, { error: 'DB error' }],
    [{ status: O.ERROR, message: 'Authentication error' }, 500, { error: 'Authentication error' }],
    // Only the three fixed texts reach the wire, whatever a future service puts here.
    [{ status: O.ERROR, message: 'connect ECONNREFUSED 10.0.0.9:5432' }, 500, { error: 'Authentication error' }],
  ];
  const errors = console.error; console.error = () => {};
  try {
    for (const [outcome, status, body] of [...cases, ['throws', 500, { error: 'Authentication error' }]]) {
      loginService.authenticate = async () => { if (outcome === 'throws') throw new Error('bug at 10.0.0.9'); return outcome; };
      const res = recordingRes();
      await handlerFor('post', '/api/auth/login')({ body: { username: 'Outcome-Map-User', password: 'pw' }, headers: {}, ip: `203.0.113.${60 + cases.findIndex((c) => c[0] === outcome) + 1}`, connection: {} }, res);
      assert.strictEqual(res.statusCode, status, `${JSON.stringify(outcome)} answered ${res.statusCode}`);
      assert.deepStrictEqual(res.body, body);
    }
    let seen;
    loginService.authenticate = async (args) => { seen = args; return { status: O.OK, user: { id: 5, username: 'jane', can_manage_users: 0, origin: 'local' } }; };
    const ok = recordingRes();
    await handlerFor('post', '/api/auth/login')({ body: { username: 'Outcome-Map-User', password: 'pw' }, headers: {}, ip: '203.0.113.80', connection: {} }, ok);
    assert.strictEqual(ok.statusCode, 200);
    assertKeys(ok.body, ['token'], 'login OK');
    assert.strictEqual(seen.username, 'outcome-map-user', 'the service was not given the normalised username');
  } finally { loginService.authenticate = real; console.error = errors; }
});

// The lockout, through the REAL handler and the real limiter (CISO review of 5aa6275). The
// service calls back into index.js through `limits`, and a no-op `fail` or `clear` there
// passed every test: nothing drove a login to a 429.
checkAsync('five wrong passwords lock the account out (429 + Retry-After); a success clears the count', async () => {
  const dbMod = require('../db');
  const hash = require('bcryptjs').hashSync('right-pw', 4);
  const realGet = dbMod.get;
  const settingsStore = require('../settings-store');
  const realLoad = settingsStore.loadSettings;
  dbMod.get = (sql, params, cb) => cb(null, { id: 61, username: params[0], password: hash, origin: 'local', can_manage_users: 0 });
  settingsStore.loadSettings = () => ({});   // no directory: the local password decides
  const quiet = console.log; console.log = () => {};
  const attempt = async (username, password, ip) => {
    const res = recordingRes();
    await handlerFor('post', '/api/auth/login')({ body: { username, password }, headers: {}, ip, connection: {} }, res);
    return res;
  };
  try {
    for (let i = 1; i <= 5; i++) {
      assert.strictEqual((await attempt('lockout-a', 'wrong', '203.0.113.90')).statusCode, 401, `wrong attempt ${i}`);
    }
    const locked = await attempt('lockout-a', 'right-pw', '203.0.113.90');
    assert.strictEqual(locked.statusCode, 429, 'five failures did not lock the account -- the limiter is not wired');
    assert.ok(Number(locked.headers['retry-after']) > 0, 'the lockout carries no Retry-After');
    assertKeys(locked.body, ['error'], 'lockout');
    // Four failures, a success, four more: the success must have cleared the first four.
    for (let i = 0; i < 4; i++) await attempt('lockout-b', 'wrong', '203.0.113.91');
    assert.strictEqual((await attempt('lockout-b', 'right-pw', '203.0.113.91')).statusCode, 200);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual((await attempt('lockout-b', 'wrong', '203.0.113.91')).statusCode, 401,
        'a success did not clear the failure count');
    }
  } finally { dbMod.get = realGet; settingsStore.loadSettings = realLoad; console.log = quiet; }
});

// UP-16: My Account's profile read and sharing toggle are services/users.js now. Neither route
// had a shape pinned before; both are v1 and frozen.
console.log('GET /api/user/me and PUT /api/user/me/sharing (v1 over services/users.js):');
checkAsync('GET /api/user/me: exact keys, no credential column, v1\'s notification_days parse, 404 and 500', async () => {
  const dbMod = require('../db');
  const realGet = dbMod.promises.get;
  const ROW = { id: 7, username: 'jane', email: 'j@x.io', ntfy_topic: 't', ntfy_url: '', gotify_token: 'g', gotify_url: '',
    telegram_chat_id: '1', notification_days: '[1,3]', display_name: 'Jane', shares_library: 1 };
  const call = async (answer) => {
    let sql;
    dbMod.promises.get = async (s) => { sql = s; if (answer instanceof Error) throw answer; return answer; };
    const res = recordingRes();
    try { await handlerFor('get', '/api/user/me')({ user: { id: 7 } }, res); } finally { dbMod.promises.get = realGet; }
    return { res, sql };
  };
  const errors = console.error; console.error = () => {};
  try {
    const ok = await call(ROW);
    assertKeys(ok.res.body, Object.keys(ROW), 'GET /api/user/me');
    assert.deepStrictEqual(ok.res.body.notification_days, [1, 3]);
    // The EXACT column list, from the SQL actually issued -- not the stub's keys, which cannot
    // see a dropped column, and not a denylist, which a future sensitive column would pass
    // (review of 6df162e).
    const cols = /^SELECT (.+) FROM users WHERE id = \?$/.exec(ok.sql);
    assert.ok(cols, `unexpected profile query: ${ok.sql}`);
    assert.deepStrictEqual(cols[1].split(',').map((c) => c.trim()),
      ['id', 'username', 'email', 'ntfy_topic', 'ntfy_url', 'gotify_token', 'gotify_url', 'telegram_chat_id',
        'notification_days', 'display_name', 'shares_library'],
      'the profile read no longer selects exactly the frozen v1 columns');
    assert.strictEqual((await call({ ...ROW, notification_days: null })).res.body.notification_days, null,
      'a NULL notification_days no longer answers null (v1\'s frozen rendering)');
    assert.deepStrictEqual((await call({ ...ROW, notification_days: 'not json' })).res.body.notification_days, [0, 7, 30]);
    const missing = await call(undefined);
    assert.deepStrictEqual([missing.res.statusCode, missing.res.body], [404, { error: 'User not found' }]);
    const down = await call(new Error('ECONNREFUSED 10.0.0.5'));
    assert.deepStrictEqual([down.res.statusCode, down.res.body], [500, { error: 'DB error' }]);
  } finally { console.error = errors; }
});
checkAsync('PUT /api/user/me/sharing: truthiness to 1/0, a missing value is 400, {success:true}', async () => {
  const dbMod = require('../db');
  const realRun = dbMod.promises.run;
  const writes = [];
  dbMod.promises.run = async (sql, params) => { writes.push(params); return { changes: 1 }; };
  const call = async (body) => {
    const res = recordingRes();
    await handlerFor('put', '/api/user/me/sharing')({ user: { id: 7 }, body }, res);
    return res;
  };
  try {
    for (const [value, stored] of [[true, 1], [false, 0], ['yes', 1], [0, 0]]) {
      const res = await call({ shares_library: value });
      assert.deepStrictEqual([res.statusCode, res.body], [200, { success: true }]);
      assert.deepStrictEqual(writes.pop(), [stored, 7]);
    }
    const missing = await call({});
    assert.deepStrictEqual([missing.statusCode, missing.body], [400, { error: 'Missing shares_library value' }]);
    assert.strictEqual(writes.length, 0, 'a refused toggle wrote');
  } finally { dbMod.promises.run = realRun; }
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
