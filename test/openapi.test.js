// The v2 OpenAPI document is checked, not merely stored. Run with: npm test
//
// A spec nobody validates is prose. This file makes the document a CI artifact: it
// must parse, it must be structurally coherent, and — crucially — the decisions
// recorded in API_V2_DESIGN.md must actually be present in it.
//
// WHAT THIS IS NOT, YET. There is no `/api/v2` route on the router, so there is
// nothing to compare the paths against. The real drift gate — every spec operation
// exists on the live router with a matching authorization tier, and every v2 route
// appears in the spec — belongs in test/api-surface.test.js and lands WITH the first
// v2 route, per API_V2_DESIGN.md. Until then this file proves the document is
// internally sound and says what it was decided to say; it cannot prove the server
// agrees with it, because there is no server code to disagree yet.
//
// SCOPE RULE: same as helpers.test.js. No database, no network. js-yaml is a
// devDependency, so this runs in CI (which installs dev deps) and is absent from the
// production image (which installs with --omit=dev).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };

const SPEC_PATH = path.join(__dirname, '..', 'openapi', 'gametracker-v2.yaml');

console.log('openapi/gametracker-v2.yaml:');

let spec;
check('parses as YAML', () => {
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  spec = yaml.load(raw);
  assert.ok(spec && typeof spec === 'object', 'the document did not parse to an object');
});

// Walk every operation once; most assertions below are over this list.
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const operations = () => {
  const out = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (OPERATION_METHODS.includes(method)) out.push({ path: p, method, op });
    }
  }
  return out;
};

check('is OpenAPI 3.1 with the required top-level fields', () => {
  assert.match(spec.openapi, /^3\.1\./, `unexpected openapi version: ${spec.openapi}`);
  assert.ok(spec.info?.title, 'info.title is required');
  assert.ok(spec.info?.version, 'info.version is required');
  assert.ok(spec.paths && Object.keys(spec.paths).length > 0, 'no paths');
  // A stray root key is how a hand-written spec quietly stops being a spec — an
  // accidental YAML anchor at the top of this document did exactly that once.
  const allowed = new Set(['openapi', 'info', 'servers', 'security', 'tags', 'paths', 'components',
    'jsonSchemaDialect', 'webhooks', 'externalDocs']);
  for (const key of Object.keys(spec)) {
    assert.ok(allowed.has(key) || key.startsWith('x-'), `unknown root key '${key}'`);
  }
});

check('every operation has a unique operationId', () => {
  // Generated clients name methods from these; a duplicate silently drops one.
  const seen = new Map();
  for (const { path: p, method, op } of operations()) {
    assert.ok(op.operationId, `${method.toUpperCase()} ${p} has no operationId`);
    assert.ok(!seen.has(op.operationId),
      `duplicate operationId '${op.operationId}' on ${method.toUpperCase()} ${p} and ${seen.get(op.operationId)}`);
    seen.set(op.operationId, `${method.toUpperCase()} ${p}`);
    assert.ok(op.summary, `${op.operationId} has no summary`);
    assert.ok(Array.isArray(op.tags) && op.tags.length, `${op.operationId} has no tag`);
  }
  assert.ok(seen.size >= 20, `only ${seen.size} operations — expected the full v2 surface`);
});

check('every $ref resolves', () => {
  // A typo'd $ref is invisible until a generator chokes on it.
  const refs = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') refs.push(v);
      else walk(v);
    }
  })(spec);
  assert.ok(refs.length > 0, 'no $refs at all — components are not being used');
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/'), `external $ref '${ref}' — the document must be self-contained`);
    let node = spec;
    for (const seg of ref.slice(2).split('/')) {
      node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
      assert.ok(node !== undefined, `unresolvable $ref: ${ref}`);
    }
  }
});

check('every declared component is actually referenced', () => {
  // An orphaned schema is either dead weight or a forgotten wiring mistake, and the
  // second is the one that matters: a response that should have used it does not.
  const text = fs.readFileSync(SPEC_PATH, 'utf8');
  for (const name of Object.keys(spec.components?.schemas || {})) {
    assert.ok(text.includes(`#/components/schemas/${name}`), `schema '${name}' is never referenced`);
  }
  for (const name of Object.keys(spec.components?.responses || {})) {
    assert.ok(text.includes(`#/components/responses/${name}`), `response '${name}' is never referenced`);
  }
});

check('every operation documents 401, because every operation requires a credential', () => {
  // The document declares global `security`, so an operation with no 401 is
  // describing an authenticated call whose failure mode is undocumented.
  for (const { op } of operations()) {
    const codes = Object.keys(op.responses || {});
    assert.ok(codes.includes('401'), `${op.operationId} does not document a 401`);
    assert.ok(codes.some((c) => c.startsWith('2')), `${op.operationId} documents no success response`);
  }
});

check('there are no unauthenticated operations', () => {
  // v2 is not a public API. An operation opting out of the global requirement with
  // `security: []` would be the one thing worth catching here.
  assert.deepStrictEqual(spec.security, [{ bearerAuth: [] }], 'the global security requirement changed');
  for (const { op, path: p, method } of operations()) {
    assert.ok(!Array.isArray(op.security) || op.security.length > 0,
      `${method.toUpperCase()} ${p} opts out of authentication with an empty security array`);
  }
});

check('admin operations are marked, and only via x-required-scope', () => {
  // D1 addendum #2: an OpenAPI scope array is only meaningful for oauth2/openIdConnect,
  // so declaring scopes in `security` on an http-bearer scheme would be decorative.
  // x-required-scope is the checkable form, and the drift gate will compare it against
  // the router-derived tier once v2 routes exist.
  // Every operation declares one explicitly — see the mandatory-marker check below.
  // An earlier version required the marker to be ABSENT on non-admin operations, on
  // the reasoning that `library` is the absence of admin so marking it asserts
  // nothing. That was wrong in the way that matters: it made a FORGOTTEN marker
  // indistinguishable from a deliberate non-admin one, which is exactly the
  // "authorization decided by omission" pattern CLAUDE.md warns about for routes.
  const admin = operations().filter(({ op }) => op['x-required-scope'] === 'admin');
  assert.ok(admin.length > 0, 'no operation is marked as requiring the admin scope');
  // An operation the docs site groups under `admin` must carry the marker. The
  // converse is deliberately NOT required: tags organise the rendered documentation
  // and an admin-scoped operation can legitimately live under a different heading —
  // `jobs` does. Requiring equality conflated a presentation choice with a security
  // fact, and this assertion failed on its own spec the first time it ran because of
  // that, not because the spec was wrong.
  for (const { op } of operations()) {
    if (!(op.tags || []).includes('admin')) continue;
    assert.strictEqual(op['x-required-scope'], 'admin',
      `${op.operationId} is presented as an admin operation but carries no x-required-scope, `
      + 'so the docs claim a restriction CI cannot check');
  }
  // ...and an admin operation must document the 403 a library-scoped token receives.
  for (const { op } of admin) {
    assert.ok(Object.keys(op.responses || {}).includes('403'),
      `${op.operationId} requires the admin scope but documents no 403`);
  }
});

check('errors are problem+json everywhere, never the v1 envelope', () => {
  // D3. If some errors are problem+json and others are {error: string}, a client needs
  // two parsers and will get one of them wrong.
  for (const { op } of operations()) {
    for (const [code, response] of Object.entries(op.responses || {})) {
      if (!/^[45]/.test(code)) continue;
      const types = Object.keys(response.content || {});
      if (types.length === 0) continue;   // a bodyless error response is fine
      assert.deepStrictEqual(types, ['application/problem+json'],
        `${op.operationId} ${code} uses ${types.join(', ')} — v2 errors are problem+json`);
    }
  }
  for (const [name, response] of Object.entries(spec.components?.responses || {})) {
    assert.ok(response.content?.['application/problem+json'],
      `shared response '${name}' is not problem+json`);
  }
});

check('the Problem code enum matches the service error taxonomy', () => {
  // The spec publishes `code` as the thing clients branch on. If it drifts from
  // services/errors.js the published contract names failures the server cannot emit,
  // or omits ones it does.
  const { CODES } = require('../services/errors');
  const published = new Set(spec.components.schemas.Problem.properties.code.enum);
  for (const code of Object.values(CODES)) {
    assert.ok(published.has(code),
      `services/errors.js emits '${code}' but the spec's Problem.code enum omits it — `
      + 'a client cannot branch on a code it was never told about');
  }
});

check('gameId is a STRING with the source prefix, nowhere an integer', () => {
  // D2, and the single most consequential typing decision in the document: a generated
  // client that types this as a number corrupts ids in transit.
  const ref = spec.components.schemas.GameRef;
  assert.strictEqual(ref.type, 'string');
  assert.ok(ref.pattern, 'GameRef has no pattern');
  const re = new RegExp(ref.pattern);
  for (const good of ['igdb_12345', 'rawg_3498', 'thegamesdb_7']) {
    assert.ok(re.test(good), `GameRef pattern rejects a real id: ${good}`);
  }
  for (const bad of ['12345', 'igdb_', 'steam_1', '']) {
    assert.ok(!re.test(bad), `GameRef pattern accepts '${bad}'`);
  }
  // Every path parameter named gameId must use the shared schema rather than
  // redeclaring one that could drift.
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const param of item.parameters || []) {
      if (param.name !== 'gameId') continue;
      assert.strictEqual(param.schema?.$ref, '#/components/schemas/GameRef',
        `${p} declares gameId inline instead of $ref'ing GameRef`);
    }
  }
});

check('the status enum matches the five the database allows', () => {
  // migrations/002 CHECK-constrains this column. A spec offering a sixth value would
  // publish a request that is guaranteed to fail at the database.
  const { STATUSES } = require('../services/library');
  assert.deepStrictEqual(
    [...spec.components.schemas.GameStatus.enum].sort(),
    [...STATUSES].sort(),
    'the spec status enum and services/library.js STATUSES disagree'
  );
});

check('the scope enum matches services/auth.js', () => {
  const { ALL_SCOPES } = require('../services/auth');
  const inSpec = spec.components.schemas.Me.properties.scopes.items.enum;
  assert.deepStrictEqual([...inSpec].sort(), [...ALL_SCOPES].sort(),
    'the spec advertises scopes the auth service does not implement, or vice versa');
});

check('list responses carry meta, so degradation is in the BODY', () => {
  // D4. v1 signalled a degraded catalog search in a header, which generated clients
  // drop — making "a provider is down" and "no such game" indistinguishable.
  const search = spec.paths['/catalog/search'].get.responses['200'];
  const props = search.content['application/json'].schema.properties;
  assert.ok(props.data && props.meta, 'search 200 is not the {data, meta} envelope');
  assert.strictEqual(props.meta.$ref, '#/components/schemas/SearchMeta');
  assert.ok(spec.components.schemas.SearchMeta.properties.degraded,
    'SearchMeta has no degraded flag — the outage signal has nowhere to live');
  assert.ok(spec.components.schemas.SearchMeta.required.includes('degraded'),
    'degraded is optional, so a client cannot rely on it being there');
});

check('no response is a bare array', () => {
  // A top-level array has nowhere to grow: no paging, no totals, no degradation flag.
  // v1's search returned one, which is why the outage signal ended up in a header.
  for (const { op } of operations()) {
    for (const [code, response] of Object.entries(op.responses || {})) {
      const schema = response.content?.['application/json']?.schema;
      if (!schema) continue;
      assert.notStrictEqual(schema.type, 'array',
        `${op.operationId} ${code} returns a bare array; wrap it in {data, meta}`);
    }
  }
});

check('mutations are falsifiable — DELETE is 204 plus 404, never 200 {success:true}', () => {
  // D6. v1 answered {"success": true} whether or not a row existed, so a mistyped id
  // was a silent no-op reported as success.
  for (const { path: p, method, op } of operations()) {
    if (method !== 'delete') continue;
    const codes = Object.keys(op.responses);
    assert.ok(codes.includes('204'), `DELETE ${p} does not return 204`);
    assert.ok(codes.includes('404'), `DELETE ${p} does not document 404 — a no-op delete would report success`);
    assert.ok(!codes.includes('200'), `DELETE ${p} returns 200; use 204 and let 404 mean "nothing there"`);
  }
});

check('the update body cannot carry a releaseDate', () => {
  // D7, expressed as a schema constraint rather than a warning. Accepting a date here
  // is what let v1 write a released game back to `unreleased` and then announce it to
  // every notification channel on the next correct write.
  const update = spec.components.schemas.LibraryGameUpdate;
  assert.ok(!('releaseDate' in update.properties),
    'LibraryGameUpdate accepts releaseDate — status must be derived from the STORED date');
  assert.strictEqual(update.additionalProperties, false,
    'LibraryGameUpdate allows extra properties, so releaseDate would be accepted anyway');
});

check('request schemas are closed', () => {
  // additionalProperties:false everywhere a client sends a body. An open request schema
  // means a typo'd field is silently ignored and the caller is told it succeeded.
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    if (!/(Create|Update)$/.test(name)) continue;
    assert.strictEqual(schema.additionalProperties, false,
      `${name} is an open object; a misspelled field would be accepted and dropped`);
  }
});

// --- leak checks: walk RESOLVED schemas from every response ---------------------
//
// The first version of these two assertions was theatre. A review evaded them ten
// times out of ten attempts: they iterated `components.schemas` top-level keys only,
// so a secret inside an `allOf` branch, nested one object deep, in an INLINE response
// body, or merely renamed (`passwordHash`, `pushToken`, `chatId`) all sailed through
// — and the name-substring skip list exempted `Settings`, the one schema that
// actually carries secrets, from the only leak check in the suite.
//
// This walks every schema reachable from a 2xx response body, resolves $refs,
// descends through properties/items/allOf/oneOf/anyOf, and matches a denylist. The
// allowlist is by JSON POINTER, never by name — a name-shaped exemption is what
// failed last time.

const SECRETISH = /^(password|passwordHash|pass|tokenHash|token_hash|secret|bindPass|botToken|apiKey|clientSecret|hash)$/i;

// DERIVED from services/users.js rather than hand-written, so the two cannot drift:
// that constant is already the single definition of "a per-user delivery target", and
// the admin surface refuses every name in it.
//
// It matches the value-bearing names (ntfyTopic, gotifyToken, telegramChatId, and the
// two server URLs), NOT the bare section names `ntfy`/`gotify`/`telegram` that group
// the instance-wide defaults in server settings — those are admin-owned configuration,
// a different thing that happens to share a vendor name. A blunter regex flagged them
// and would have trained the next person to widen the exemption instead of the check.
const { USER_OWNED_NOTIFICATION_COLUMNS } = require('../services/users');
const camelise = (c) => c.replace(/_(.)/g, (_, ch) => ch.toUpperCase());
const USER_TARGET_NAMES = new Set([
  ...USER_OWNED_NOTIFICATION_COLUMNS,
  ...USER_OWNED_NOTIFICATION_COLUMNS.map(camelise),
]);
// Plus shapes a rename would take, since renaming defeated the previous check.
const TARGET_RENAME = /^(chatId|pushToken|deviceToken|notificationTarget|topic)$/i;
const isUserTarget = (name) => USER_TARGET_NAMES.has(name) || TARGET_RENAME.test(name);

// Legitimate, and each one is a deliberate decision rather than an oversight:
const ALLOWED = new Set([
  // The minted secret, returned exactly once. This IS the operation's purpose.
  '#/components/schemas/TokenCreated/allOf/1/properties/token',
]);
// The caller's OWN delivery settings, on their own resource. Readable because it is
// the caller's own row; the point of the check is that these appear NOWHERE else.
const SELF_ONLY_TARGETS = '#/components/schemas/NotificationSettings';

const deref = (node, seen = new Set()) => {
  if (node && node.$ref && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    let t = spec;
    for (const seg of node.$ref.slice(2).split('/')) t = t?.[seg];
    return deref(t, seen);
  }
  return node;
};

// Yields [pointer, propertyName, schema] for every property reachable from `root`.
function* walkProperties(root, pointer, seen = new Set()) {
  const node = deref(root);
  if (!node || typeof node !== 'object') return;
  const key = root?.$ref || pointer;
  if (seen.has(key)) return;
  seen.add(key);
  const base = root?.$ref || pointer;
  for (const [name, sub] of Object.entries(node.properties || {})) {
    yield [`${base}/properties/${name}`, name, sub];
    yield* walkProperties(sub, `${base}/properties/${name}`, seen);
  }
  for (const kw of ['allOf', 'oneOf', 'anyOf']) {
    (node[kw] || []).forEach((branch, i) => {
      // generators flatten these; a secret hiding in a branch is still shipped
    });
    for (let i = 0; i < (node[kw] || []).length; i++) {
      yield* walkProperties(node[kw][i], `${base}/${kw}/${i}`, seen);
    }
  }
  if (node.items) yield* walkProperties(node.items, `${base}/items`, seen);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    yield* walkProperties(node.additionalProperties, `${base}/additionalProperties`, seen);
  }
}

// Every schema a client can RECEIVE: 2xx bodies, $ref'd or inline.
function responseSchemas() {
  const out = [];
  for (const { op } of operations()) {
    for (const [code, response] of Object.entries(op.responses || {})) {
      if (!/^2/.test(code)) continue;
      for (const [ct, media] of Object.entries(deref(response).content || {})) {
        if (!media.schema) continue;
        out.push([media.schema.$ref || `#/paths/${op.operationId}/${code}/${ct}`, media.schema, op.operationId]);
      }
    }
  }
  return out;
}

check('MaskedSecret cannot carry any part of a real secret', () => {
  // This is what earns the exemption below, so it is asserted rather than assumed:
  // a closed enum of two fixed strings can hold no fraction of a credential. The
  // codebase has historically had a second mask that emitted the last six characters
  // of an API key — that shape must never become MaskedSecret.
  const masked = spec.components.schemas.MaskedSecret;
  assert.deepStrictEqual(masked.enum, ['__unchanged__', ''],
    'MaskedSecret is no longer a closed enum of harmless sentinels');
  assert.strictEqual(masked.type, 'string');
});

check('no response anywhere can carry a secret', () => {
  for (const [pointer, schema, operationId] of responseSchemas()) {
    for (const [ptr, name, sub] of walkProperties(schema, pointer)) {
      if (ALLOWED.has(ptr)) continue;
      // Exempt by TYPE, never by name. A field typed MaskedSecret is provably
      // non-secret-carrying (asserted directly above); a name-shaped exemption is
      // what let the previous version of this check be evaded ten times.
      if (sub?.$ref === '#/components/schemas/MaskedSecret') continue;
      assert.ok(!SECRETISH.test(name),
        `${operationId} can return '${name}' at ${ptr}`);
    }
  }
});

check('notification targets appear ONLY on the caller\'s own resource', () => {
  // The historical defect: v1 returned ntfy_topic and gotify_token for every user to
  // every admin. Renaming the field, nesting it, or hanging it off Me instead of User
  // all defeated the previous check.
  for (const [pointer, schema, operationId] of responseSchemas()) {
    for (const [ptr, name] of walkProperties(schema, pointer)) {
      if (ptr.startsWith(SELF_ONLY_TARGETS)) continue;
      assert.ok(!isUserTarget(name),
        `${operationId} can return '${name}' at ${ptr} — notification targets are bearer `
        + 'secrets and belong only on the caller\'s own /me/notifications resource');
    }
  }
});

check('no REQUEST schema lets one account write another\'s notification target', () => {
  // The write path was the sharper half of the v1 defect and the previous check looked
  // only at responses. services/users.js refuses these; the spec must not offer them.
  const { USER_OWNED_NOTIFICATION_COLUMNS } = require('../services/users');
  const camel = USER_OWNED_NOTIFICATION_COLUMNS.map((c) => c.replace(/_(.)/g, (_, ch) => ch.toUpperCase()));
  for (const { op } of operations()) {
    const schema = op.requestBody?.content?.['application/json']?.schema;
    if (!schema) continue;
    const selfService = op.operationId === 'updateMyNotificationSettings';
    for (const [ptr, name] of walkProperties(schema, schema.$ref || `#/paths/${op.operationId}/body`)) {
      if (selfService) continue;
      assert.ok(!camel.includes(name) && !USER_OWNED_NOTIFICATION_COLUMNS.includes(name),
        `${op.operationId} accepts '${name}' at ${ptr} — only the owning user may set that`);
    }
  }
});

// Every schema NODE, not just every property — `failures.items` is not a property of
// anything, and an earlier version of the check below missed exactly that, so
// reopening JobResult's per-item shape slipped through.
function* walkNodes(root, pointer, seen = new Set()) {
  const node = deref(root);
  if (!node || typeof node !== 'object') return;
  const key = root?.$ref || pointer;
  if (seen.has(key)) return;
  seen.add(key);
  const base = root?.$ref || pointer;
  yield [base, node];
  for (const [name, sub] of Object.entries(node.properties || {})) {
    yield* walkNodes(sub, `${base}/properties/${name}`, seen);
  }
  for (const kw of ['allOf', 'oneOf', 'anyOf']) {
    for (let i = 0; i < (node[kw] || []).length; i++) {
      yield* walkNodes(node[kw][i], `${base}/${kw}/${i}`, seen);
    }
  }
  if (node.items) yield* walkNodes(node.items, `${base}/items`, seen);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    yield* walkNodes(node.additionalProperties, `${base}/additionalProperties`, seen);
  }
}

check('nothing reachable from a response is an open object', () => {
  // additionalProperties:true is how a provider error body or a stack trace ends up in
  // a response without anyone deciding to put it there. The job sweeps call five
  // external services and RAWG's key travels as a query parameter, so this is the
  // check standing between an implementer's `err.message` and the wire.
  for (const [pointer, schema, operationId] of responseSchemas()) {
    for (const [ptr, node] of walkNodes(schema, pointer)) {
      assert.notStrictEqual(node.additionalProperties, true,
        `${operationId} returns an open object at ${ptr}`);
    }
  }
});

check('every list response uses the SAME envelope', () => {
  // D4 says lists return {data, meta}. Renaming `data` to `items` in one operation
  // breaks every client bound to it and was invisible until this check existed —
  // the envelope was described in prose and pinned nowhere.
  const ENVELOPES = {
    listTokens: ['data'],
    listLibraryGames: ['data', 'meta'],
    getBacklog: ['data'],
    replaceBacklogOrder: ['data', 'meta'],
    searchCatalog: ['data', 'meta'],
    listShares: ['incoming', 'outgoing'],
    replaceOutgoingShares: ['data'],
    getSharedLibrary: ['data', 'meta'],
    listUsers: ['data'],
  };
  for (const [operationId, expected] of Object.entries(ENVELOPES)) {
    const { op } = operations().find((o) => o.op.operationId === operationId);
    const schema = op.responses['200'].content['application/json'].schema;
    assert.deepStrictEqual(Object.keys(deref(schema).properties).sort(), expected.sort(),
      `${operationId}'s response envelope changed`);
  }
});

// --- spec-vs-code invariants that are checkable today ---------------------------

check('the admin operation set is PINNED, not merely non-empty', () => {
  // Counting was not enough: dropping the marker from an operation not tagged `admin`
  // was invisible, so the two multi-minute all-library sweeps could be silently
  // republished as library-scoped. Pin the set, the way api-surface.test.js pins tiers.
  const admin = operations().filter(({ op }) => op['x-required-scope'] === 'admin')
    .map(({ op }) => op.operationId).sort();
  assert.deepStrictEqual(admin,
    ['createUser', 'deleteUser', 'getJob', 'getSettings', 'listUsers', 'startJob', 'updateSettings', 'updateUser'],
    'the set of admin-scoped operations changed');
});

check('every operation declares a scope, and absence is a failure not a default', () => {
  // `library` being "the absence of admin" made a FORGOTTEN marker indistinguishable
  // from a deliberate non-admin one — the exact "decided by omission" pattern
  // CLAUDE.md describes for route authorization.
  for (const { path: p, method, op } of operations()) {
    const scope = op['x-required-scope'];
    assert.ok(scope === 'admin' || scope === 'library',
      `${method.toUpperCase()} ${p} declares x-required-scope '${scope}'`);
  }
  assert.strictEqual(spec.paths['/shares/incoming/{username}/games'].get['x-admin-bypass'], false,
    'the no-admin-bypass rule on the shared-library read is no longer expressed where CI can see it');
});

check('the operation inventory is pinned', () => {
  // ">= 20" is why the document could claim 26 operations while containing 25.
  // The FULL set, not a count and not a spot check. Every operationId becomes a method
  // name in the generated client, so renaming one silently renames a client method —
  // and a count alone is why the document could claim 26 operations while holding 25.
  const inventory = operations().map(({ path: p, method, op }) => `${method.toUpperCase()} ${p} ${op.operationId}`).sort();
  assert.deepStrictEqual(inventory, [
    'DELETE /library/games/{gameId} removeLibraryGame',
    'DELETE /shares/outgoing/{username} removeOutgoingShare',
    'DELETE /tokens/{tokenId} revokeToken',
    'DELETE /users/{userId} deleteUser',
    'GET /catalog/search searchCatalog',
    'GET /jobs/{jobId} getJob',
    'GET /library/backlog getBacklog',
    'GET /library/games listLibraryGames',
    'GET /library/games/{gameId} getLibraryGame',
    'GET /me getMe',
    'GET /me/notifications getMyNotificationSettings',
    'GET /settings getSettings',
    'GET /shares listShares',
    'GET /shares/incoming/{username}/games getSharedLibrary',
    'GET /tokens listTokens',
    'GET /users listUsers',
    'PATCH /library/games/{gameId} updateLibraryGame',
    'PATCH /me/notifications updateMyNotificationSettings',
    'PATCH /settings updateSettings',
    'PATCH /users/{userId} updateUser',
    'POST /jobs startJob',
    'POST /library/games addLibraryGame',
    'POST /library/refresh refreshMyLibrary',
    'POST /shares/outgoing addOutgoingShare',
    'POST /tokens createToken',
    'POST /users createUser',
    'PUT /library/backlog replaceBacklogOrder',
    'PUT /shares/outgoing replaceOutgoingShares',
  ], 'the operation inventory changed — update this list deliberately, not to make CI pass');
});

check('gameId is GameRef EVERYWHERE, not just in path parameters', () => {
  // The previous version checked path-item parameters only, so typing
  // LibraryGame.gameId as an integer — the response shape every client binds to, and
  // the exact corruption D2 exists to prevent — passed.
  const offenders = [];
  const scan = (schema, pointer) => {
    for (const [ptr, name, sub] of walkProperties(schema, pointer)) {
      if (name !== 'gameId') continue;
      if (sub.$ref !== '#/components/schemas/GameRef') offenders.push(ptr);
    }
  };
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    scan(schema, `#/components/schemas/${name}`);
  }
  for (const { op } of operations()) {
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) scan(body, `#/paths/${op.operationId}/body`);
    for (const param of op.parameters || []) {
      if (param.name === 'gameId') {
        assert.strictEqual(param.schema?.$ref, '#/components/schemas/GameRef',
          `${op.operationId} declares gameId inline`);
      }
    }
  }
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const param of item.parameters || []) {
      if (param.name !== 'gameId') continue;
      assert.strictEqual(param.schema?.$ref, '#/components/schemas/GameRef',
        `${p} declares gameId inline instead of $ref'ing GameRef`);
    }
  }
  assert.deepStrictEqual(offenders, [], `gameId not typed as GameRef at: ${offenders.join(', ')}`);
});

check('the Problem code enum matches errors.js in BOTH directions', () => {
  // Previously one-directional, so the spec already published two codes no service can
  // emit while the check stayed green.
  const { CODES } = require('../services/errors');
  const published = new Set(spec.components.schemas.Problem.properties.code.enum);
  const implemented = new Set(Object.values(CODES));
  // Codes the spec may publish ahead of implementation — each one a written decision.
  const PLANNED = new Set(['rate_limited', 'provider_unavailable', 'settings_unreadable', 'internal']);
  for (const code of implemented) {
    assert.ok(published.has(code), `services/errors.js emits '${code}' but the spec omits it`);
  }
  for (const code of published) {
    assert.ok(implemented.has(code) || PLANNED.has(code),
      `the spec publishes '${code}', which no service can emit and which is not in PLANNED`);
  }
});

check('every published code carries an explicit disclosure decision', () => {
  // services/problem.js has one load-bearing `expose` column. Carrying it onto the wire
  // keeps the document and that table honest about the same thing.
  const { PROBLEMS } = require('../services/problem');
  const expose = spec.components.schemas.Problem.properties.code['x-expose'];
  for (const code of spec.components.schemas.Problem.properties.code.enum) {
    assert.strictEqual(typeof expose?.[code], 'boolean',
      `code '${code}' has no x-expose decision — disclosure must never be implicit`);
    if (PROBLEMS[code]) {
      assert.strictEqual(expose[code], PROBLEMS[code].expose,
        `x-expose for '${code}' disagrees with services/problem.js`);
    }
  }
});

check('the User shape matches the admin projection, field for field', () => {
  // The strongest available spec-vs-code check: catches both a leak and a drop.
  const { ADMIN_LIST_COLUMNS } = require('../services/users');
  const expected = ADMIN_LIST_COLUMNS.split(',').map((c) => c.trim().replace(/_(.)/g, (_, ch) => ch.toUpperCase()));
  assert.deepStrictEqual(Object.keys(spec.components.schemas.User.properties).sort(), expected.sort(),
    'User and services/users.js ADMIN_LIST_COLUMNS disagree');
});

check('bounds agree with the constants the services enforce', () => {
  const library = require('../services/library');
  const authService = require('../services/auth');
  const catalog = require('../services/catalog');
  assert.strictEqual(spec.components.schemas.GameRef.maxLength, library.MAX_GAME_ID);
  assert.strictEqual(spec.components.schemas.LibraryGameCreate.properties.name.maxLength, library.MAX_GAME_NAME);
  assert.strictEqual(spec.components.schemas.TokenCreate.properties.name.maxLength, authService.MAX_NAME_LENGTH);
  assert.strictEqual(spec.paths['/catalog/search'].get.parameters.find((p) => p.name === 'limit').schema.maximum,
    catalog.LIMIT_SEARCH);
});

console.log(`\n${n} spec assertions passed.`);
