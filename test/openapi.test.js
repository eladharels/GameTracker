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
  const admin = operations().filter(({ op }) => op['x-required-scope'] === 'admin');
  assert.ok(admin.length > 0, 'no operation is marked as requiring the admin scope');

  for (const { op } of operations()) {
    const scope = op['x-required-scope'];
    if (scope !== undefined) {
      assert.strictEqual(scope, 'admin',
        `${op.operationId} declares x-required-scope '${scope}'; only 'admin' is meaningful — `
        + '`library` is defined as the ABSENCE of admin, so marking it asserts nothing');
    }
  }
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

check('nothing in the document leaks a password field', () => {
  // Cheap, and it guards the class of mistake this project has actually made twice:
  // a response shape quietly carrying a credential.
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    if (/Create|Update|Settings/.test(name)) continue;   // these legitimately accept secrets
    for (const prop of Object.keys(schema.properties || {})) {
      assert.ok(!/^password$/i.test(prop), `response schema '${name}' exposes a password field`);
    }
  }
  // And the admin user shape must not carry notification targets — the v1 disclosure.
  for (const prop of Object.keys(spec.components.schemas.User.properties)) {
    assert.ok(!/ntfy|gotify|telegram/i.test(prop),
      `User exposes '${prop}' — per-user notification targets are bearer secrets`);
  }
});

console.log(`\n${n} spec assertions passed.`);
