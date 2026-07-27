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
