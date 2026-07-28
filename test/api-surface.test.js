// API surface + authorization gate.  Run with: npm test
//
// WHAT THIS IS FOR
// This project has repeatedly shipped routes whose authorization was never
// consciously decided — a route under /api/admin/ that is not admin-gated, two
// different ownership rules on the same path prefix, debug endpoints live in
// production. Review did not catch any of them, because a missing middleware looks
// exactly like a route you have not read yet.
//
// So the authorization tier of every route is asserted here, mechanically, against
// the LIVE Express router. Adding a route without deciding its auth fails CI. This
// is the enforcement half of the OpenAPI work: the spec can describe the surface,
// but only this file can prove the description is true.
//
// SCOPE RULE — same as helpers.test.js: no database, no directory, no network.
// requiring index.js is safe and cheap because `require.main === module` gates the
// listener, the schema migration and the cron schedulers. It costs milliseconds and
// touches nothing.
//
// WHEN THIS FAILS, IT IS USUALLY RIGHT. The fix is to add your new route to the
// inventory below with its intended tier — which forces the decision to be made and
// recorded — not to loosen the assertion.

const assert = require('assert');

// index.js fail-fasts on a missing/short JWT_SECRET at module scope.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-signing';

const { app, parseRouteId } = require('../index.js');

// --- introspect the live router -------------------------------------------------
// Recurses into MOUNTED ROUTERS, which is not optional.
//
// The first version walked only the top-level stack and skipped any layer without
// `.route`. An `app.use('/api/v2', router)` layer is exactly that, so every route
// inside it was invisible: a review mounted a router exposing an entirely
// unauthenticated GET and DELETE, and this file reported "42 routes" and printed
// nine green assertions — including the one titled "ONLY the allowlisted routes are
// unauthenticated" — while the live server served data to an anonymous caller.
//
// It failed silently in the safe-looking direction, which is the single failure mode
// this file exists to eliminate. /api/v2 will be mounted as a router, so this must
// keep working.
function liveRoutes(stack = (app.router || app._router).stack, prefix = '', inherited = [], isRouter = false) {
  const out = [];
  // Grows AS THE WALK PASSES each `.use()` layer, never collected up front.
  //
  // The first version of this collected every `.use()` in a mounted router and
  // credited it to every route in that router. That is fail-OPEN, and a review proved
  // it against this codebase: a route registered ABOVE `router.use(patRequired)` is
  // served with no authentication at all, and the walker reported it as tier 'pat'.
  // Every downstream assertion then passed — including the one titled "ONLY the
  // allowlisted routes are unauthenticated" — while the live server answered an
  // anonymous caller. Express matches layers in stack order, so middleware registered
  // after a route never runs for it, and this now models that.
  const running = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      // Handles first, then derive everything from them. Deriving names and perms
      // separately is how the first rewrite of this function silently reported all
      // 13 admin routes as merely 'auth': `typeof handler === 'function'`, not
      // 'object', so the permission tag was never read.
      const handles = [...running, ...layer.route.stack.map((s) => s.handle)];
      const names = handles.map((h) => h.name || 'anon');
      const perms = handles.map((h) => h.requiredPermission).filter(Boolean);
      const selfOnly = handles.some((h) => h.isSelfOnly === true);
      for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
        out.push({ key: `${method.toUpperCase()} ${prefix}${layer.route.path}`, names, perms, selfOnly });
      }
      continue;
    }
    // A mounted router: recurse, carrying the mount path and whatever middleware is
    // in force AT THIS POINT in the stack (so `app.use('/x', authRequired, router)`
    // counts, and so does a router-level `.use()` already passed).
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      out.push(...liveRoutes(layer.handle.stack, prefix + mountPath(layer), running, true));
      continue;
    }
    // Router-level `.use()`. Credited ONLY inside a mounted router, ONLY when it is
    // path-less, and only from here onward.
    //
    // Path-scoped `.use('/admin', mw)` runs for a subset of routes; attributing it to
    // all of them is the same false-authenticated report in a quieter form. App-level
    // middleware (cors, express.json, the security headers) is still never inherited —
    // `isRouter` is false at the top level — because those are not authorization.
    if (isRouter && layer.handle && typeof layer.handle === 'function'
        && !Array.isArray(layer.handle.stack) && layer.handle.length < 4
        && mountedAtRoot(layer)) {
      running.push(layer.handle);
    }
  }
  return out;
}

// Does this `.use()` layer apply to every path in its router?
//
// Returns FALSE when it cannot tell, so an unrecognised mount shape degrades the route
// to 'public' and trips the unauthenticated-route allowlist — the same fail-closed
// convention mountPath uses with '<UNKNOWN-MOUNT>'. Guessing "probably global" here
// would reintroduce exactly the fail-open this function was just fixed for.
function mountedAtRoot(layer) {
  const match = Array.isArray(layer.matchers) ? layer.matchers[0] : null;
  if (typeof match === 'function') {
    try { return !!match('/'); } catch { return false; }
  }
  // Express 4 shape, kept so this does not silently break on a downgrade.
  if (layer.regexp && layer.regexp.source === '^\\/?(?=\\/|$)') return true;
  return false;
}

// Resolve a mounted router's prefix.
//
// Express 5.1 keeps NO recoverable path on a mount layer — `layer.path` and
// `layer.regexp` are both undefined; all that survives is an opaque matcher
// function. So the prefix cannot be reconstructed, only CONFIRMED: probe the
// matcher with each candidate below and use the prefix it reports.
//
// An unrecognised mount returns '<UNKNOWN-MOUNT>', which is deliberate and
// fail-closed: its routes then cannot match any inventory key, so CI fails with
// "route(s) added without recording an authorization tier" rather than silently
// attributing them to the wrong path. Mounting a router at a new prefix means
// adding it here — a two-second edit that forces the mount to be declared.
const KNOWN_MOUNTS = ['/api/v2', '/api/v1', '/api'];

function mountPath(layer) {
  const match = Array.isArray(layer.matchers) ? layer.matchers[0] : null;
  if (typeof match === 'function') {
    for (const candidate of KNOWN_MOUNTS) {
      let hit;
      try { hit = match(candidate); } catch { hit = false; }
      if (hit && hit.path) return hit.path;
    }
  }
  // Express 4 shape, kept so this does not silently break on a downgrade.
  if (layer.path) return layer.path;
  return '<UNKNOWN-MOUNT>';
}

// Authorization tier, derived from the middleware chain rather than from the path.
// `/api/admin/test-notification` is the reason: it lives under /api/admin/ and is
// deliberately NOT admin-gated, so any path-based inference would be wrong.
function tierOf(route) {
  if (route.perms.length) {
    // requireAdminScope carries the same .requiredPermission tag as requirePermission,
    // so a v2 admin route reports the same tier as its v1 counterpart and the spec's
    // x-required-scope can be compared against one vocabulary rather than two.
    return route.names.includes('patRequired')
      ? `pat-admin:${route.perms.join('+')}`
      : `admin:${route.perms.join('+')}`;
  }
  if (route.names.includes('ownershipRequired')) return 'owner-or-admin';
  // Strictly narrower than owner-or-admin: self, with NO admin bypass. Recorded as
  // its own tier so the table states the real rule — it previously logged these as
  // plain 'auth', which understated them.
  if (route.selfOnly) return 'self-only';
  if (route.names.includes('authRequired')) return 'auth';
  // v2. A DISTINCT tier, not folded into 'auth': patRequired refuses a session JWT,
  // and a table that showed the two as the same tier would hide exactly the property
  // v2 depends on — a JWT carries no scope, so accepting one would make the admin
  // boundary bypassable by logging in with a password.
  //
  // Applied to the router with .use(), so it appears in the middleware chain of every
  // route mounted under /api/v2 without being repeated per route.
  if (route.names.includes('patRequired')) return 'pat';
  return 'public';
}

// --- the contract ---------------------------------------------------------------
// Every route, and the tier it is REQUIRED to have. Keep sorted by path.
const EXPECTED = {
  // --- public: only these two, ever ---
  'GET /api/health': 'public',
  'POST /api/auth/login': 'public',

  // --- authenticated ---
  'GET /api/all-users': 'auth',
  // Version discovery. Authenticated on purpose: /api/health is the only endpoint
  // that answers without a credential, and which API surfaces exist is not something
  // to hand an anonymous caller.
  'GET /api/capabilities': 'auth',
  // The v2 spec, served to a SESSION so the docs page can render it. It cannot live
  // on /api/v2 — that surface takes tokens only, and this endpoint exists to be
  // readable by someone who does not have one yet. 'auth', not 'public': the document
  // names every route and every admin operation.
  'GET /api/openapi/v2': 'auth',
  'GET /api/crack-status/cache-info': 'auth',
  'GET /api/game-price/:steamAppId': 'auth',
  'GET /api/games/search': 'auth',
  'GET /api/settings': 'auth',              // body is role-filtered inside the handler
  'POST /api/settings': 'auth',             // admin-only sections rejected in-handler
  'GET /api/shared-libraries': 'auth',
  'GET /api/user/me': 'auth',
  'GET /api/user/me/games': 'auth',
  'PUT /api/user/me/settings': 'auth',
  // Token management, session-authenticated. The BOOTSTRAP surface: /api/v2 takes
  // tokens only, so the endpoint that mints your first one cannot require one. All
  // three act on req.user.id — the caller's own row, never a path parameter — so
  // there is no ownership check to add and nothing an adapter could pass wrongly.
  'GET /api/user/me/tokens': 'auth',
  'POST /api/user/me/tokens': 'auth',
  'DELETE /api/user/me/tokens/:tokenId': 'auth',
  'PUT /api/user/me/sharing': 'auth',
  // Under /api/admin/ but deliberately NOT admin — non-admins use it for the
  // Diagnostics tab to test their own notification channels. Asserted so the
  // mismatch stays a recorded decision rather than looking like an oversight.
  'POST /api/admin/test-notification': 'auth',
  // Sharing routes: self-only, NO admin bypass — stricter than owner-or-admin.
  'DELETE /api/user/:username/revoke-share/:fromUser': 'self-only',
  'GET /api/user/:username/share': 'self-only',
  'POST /api/user/:username/share': 'self-only',
  'GET /api/user/:username/shared-with-me': 'self-only',
  'GET /api/user/:username/shared/:fromUser': 'self-only',

  // --- owner-or-admin (ownershipRequired: self, or can_manage_users) ---
  'GET /api/debug/user/:username/game/:gameId': 'owner-or-admin',
  'DELETE /api/user/:username/games/:gameId': 'owner-or-admin',
  'GET /api/user/:username/crack-status': 'owner-or-admin',
  'GET /api/user/:username/games': 'owner-or-admin',
  'POST /api/user/:username/games': 'owner-or-admin',
  'POST /api/user/:username/games/:gameId/crackrelease-status': 'owner-or-admin',
  'POST /api/user/:username/games/:gameId/refresh-metadata': 'owner-or-admin',
  'POST /api/user/:username/refresh-metadata': 'owner-or-admin',
  'PUT /api/user/:username/backlog-reorder': 'owner-or-admin',
  'PUT /api/user/:username/games/:gameId/backlog-order': 'owner-or-admin',

  // --- admin ---
  'POST /api/admin/check-releases': 'admin:can_manage_users',
  'POST /api/admin/crackrelease-status': 'admin:can_manage_users',
  'POST /api/admin/ldap-sync': 'admin:can_manage_users',
  'POST /api/admin/refresh-crackwatch-cache': 'admin:can_manage_users',
  'GET /api/settings/apikeys': 'admin:can_manage_users',
  'POST /api/settings/apikeys': 'admin:can_manage_users',
  'POST /api/settings/apikeys/refresh-igdb-token': 'admin:can_manage_users',
  'GET /api/system-status': 'admin:can_manage_users',
  'GET /api/test/igdb': 'admin:can_manage_users',
  'DELETE /api/users/:id': 'admin:can_manage_users',
  'GET /api/users': 'admin:can_manage_users',
  'POST /api/users': 'admin:can_manage_users',
  'PUT /api/users/:id': 'admin:can_manage_users',
};

// Unauthenticated routes are the ones that can hurt, so they are allowlisted
// --- /api/v2 -------------------------------------------------------------
// Tier 'pat' is NOT the same as 'auth': patRequired refuses a session JWT, which is
// what keeps the admin boundary from being bypassable by logging in with a password.
// Every one of these is also an operation in openapi/gametracker-v2.yaml carrying
// `x-implemented: true`, and the drift check below fails if the two disagree.
const EXPECTED_V2 = {
  'GET /api/v2/me': 'pat',
  'GET /api/v2/library/games': 'pat',
  'GET /api/v2/library/games/:gameId': 'pat',
  'DELETE /api/v2/library/games/:gameId': 'pat',
  'GET /api/v2/tokens': 'pat',
  'POST /api/v2/tokens': 'pat',
  'DELETE /api/v2/tokens/:tokenId': 'pat',
  'GET /api/v2/me/notifications': 'pat',
  'PATCH /api/v2/me/notifications': 'pat',
  'PATCH /api/v2/library/games/:gameId': 'pat',
  'GET /api/v2/library/backlog': 'pat',
  'PUT /api/v2/library/backlog': 'pat',
  'GET /api/v2/catalog/search': 'pat',
  // A LIVE Steam price, distinct from the library row's stored one. Library scope: an
  // agent asking "what does this cost" is doing library work, not administration.
  'GET /api/v2/catalog/prices/:steamAppId': 'pat',
  'POST /api/v2/library/games': 'pat',
  'GET /api/v2/shares': 'pat',
  // Share TARGETS. Library-scoped and NOT admin, deliberately: listUsers is admin-only,
  // so without this a non-admin credential could reach POST /shares/outgoing and had no
  // way to discover a valid value for it. Username and display name only.
  'GET /api/v2/users/directory': 'pat',
  'PUT /api/v2/shares/outgoing': 'pat',
  'POST /api/v2/shares/outgoing': 'pat',
  'DELETE /api/v2/shares/outgoing/:username': 'pat',
  // No ownership middleware, deliberately: the grant check IS the authorization, and
  // there is no admin bypass on this path. See openapi's `x-admin-bypass: false`.
  'GET /api/v2/shares/incoming/:username/games': 'pat',
  'GET /api/v2/users': 'pat-admin:can_manage_users',
  'POST /api/v2/users': 'pat-admin:can_manage_users',
  'PATCH /api/v2/users/:userId': 'pat-admin:can_manage_users',
  'DELETE /api/v2/users/:userId': 'pat-admin:can_manage_users',
  // The DEPROVISIONING surface. Revoking a credential you cannot see is not a
  // workflow — before these, an admin could not tell whether a departing user held a
  // token at all, and destroying one meant deleting the account and their library
  // with it. Admin scope, so an admin ACCOUNT holding a library-scoped token is not
  // an admin here either.
  'GET /api/v2/users/:userId/tokens': 'pat-admin:can_manage_users',
  'DELETE /api/v2/users/:userId/tokens': 'pat-admin:can_manage_users',
  'DELETE /api/v2/users/:userId/tokens/:tokenId': 'pat-admin:can_manage_users',
  'GET /api/v2/settings': 'pat-admin:can_manage_users',
  'PATCH /api/v2/settings': 'pat-admin:can_manage_users',
  // Library-scoped on purpose: POST /library/refresh hands back a job, and an
  // operation whose own caller cannot poll the result is not an operation. Ownership,
  // not scope, is what protects an instance-wide job's failures[].
  'POST /api/v2/library/refresh': 'pat',
  'GET /api/v2/jobs/:jobId': 'pat',
  'POST /api/v2/jobs': 'pat-admin:can_manage_users',
};

// separately and by hand. A route reaching 'public' without being on this list is a
// hard failure regardless of what EXPECTED says.
Object.assign(EXPECTED, EXPECTED_V2);

const PUBLIC_ALLOWLIST = new Set([
  'GET /api/health',        // container healthcheck + CI deploy gate; leaks nothing
  'POST /api/auth/login',   // rate-limited per IP and per account
]);

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };

const routes = liveRoutes();
const live = new Map(routes.map((r) => [r.key, r]));

console.log('API surface:');
check(`router exposes routes (${routes.length} found)`, () => {
  assert.ok(routes.length > 0, 'no routes introspected — did the router shape change?');
});

check('no duplicate route registrations', () => {
  const seen = new Set(); const dupes = [];
  for (const r of routes) { if (seen.has(r.key)) dupes.push(r.key); seen.add(r.key); }
  assert.deepStrictEqual(dupes, [], `duplicate routes shadow each other: ${dupes.join(', ')}`);
});

check('every live route is in the inventory', () => {
  const missing = routes.map((r) => r.key).filter((k) => !(k in EXPECTED)).sort();
  assert.deepStrictEqual(missing, [],
    'route(s) added without recording an authorization tier:\n    ' + missing.join('\n    '));
});

check('every inventoried route still exists', () => {
  const gone = Object.keys(EXPECTED).filter((k) => !live.has(k)).sort();
  assert.deepStrictEqual(gone, [],
    'inventory lists route(s) the router no longer has (stale entry, or a typo):\n    ' + gone.join('\n    '));
});

console.log('authorization:');
check('every route has its expected tier', () => {
  const wrong = [];
  for (const r of routes) {
    const actual = tierOf(r);
    if (actual !== EXPECTED[r.key]) wrong.push(`${r.key}\n      expected ${EXPECTED[r.key]}, got ${actual}`);
  }
  assert.deepStrictEqual(wrong, [], 'authorization tier changed:\n    ' + wrong.join('\n    '));
});

check('ONLY the allowlisted routes are unauthenticated', () => {
  const pub = routes.filter((r) => tierOf(r) === 'public').map((r) => r.key).sort();
  const unexpected = pub.filter((k) => !PUBLIC_ALLOWLIST.has(k));
  assert.deepStrictEqual(unexpected, [],
    'route(s) reachable WITHOUT AUTHENTICATION:\n    ' + unexpected.join('\n    '));
  assert.deepStrictEqual(pub, [...PUBLIC_ALLOWLIST].sort(),
    'the set of unauthenticated routes changed');
});

check('authRequired precedes every authorization middleware', () => {
  // ownershipRequired and requirePermission both read req.user, which only
  // authRequired populates. Registered in the wrong order they read undefined and
  // deny everything (fail-closed, but a total outage) — or, worse, a future
  // refactor makes them fail-open. Assert the ordering rather than trusting it.
  const bad = [];
  for (const r of routes) {
    const a = r.names.indexOf('authRequired');
    for (const guard of ['ownershipRequired', 'requirePermissionMiddleware']) {
      const g = r.names.indexOf(guard);
      if (g !== -1 && (a === -1 || a > g)) bad.push(`${r.key} (${guard} at ${g}, authRequired at ${a})`);
    }
  }
  assert.deepStrictEqual(bad, [], 'authorization middleware runs before authRequired:\n    ' + bad.join('\n    '));
});

// --- DRIFT GATE: the published spec vs the live router -------------------------
//
// api-surface proves the router matches the recorded table. This proves the router
// matches what openapi/gametracker-v2.yaml TELLS THE WORLD. Different lie, same
// ground truth — and for an MCP the failure mode is specific: an operation the spec
// promises but the router does not serve means an agent calls a 404 and reasons
// around it.
//
// The spec is the SOURCE for v2, so it necessarily describes operations that are not
// built yet. `x-implemented: true` marks the ones that are, and the gate checks BOTH
// directions against it: a route with no implemented operation is undocumented
// surface, and an implemented operation with no route is a published lie.
console.log('/api/v2 spec drift:');

const yaml = require('js-yaml');
const spec = yaml.load(require('fs').readFileSync(
  require('path').join(__dirname, '..', 'openapi', 'gametracker-v2.yaml'), 'utf8'));

// OpenAPI writes `{gameId}`; Express writes `:gameId`.
const specKeys = new Map();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'put', 'post', 'delete', 'patch'].includes(method)) continue;
    if (op['x-implemented'] !== true) continue;
    const express = path.replace(/\{(\w+)\}/g, ':$1');
    specKeys.set(`${method.toUpperCase()} /api/v2${express}`, op);
  }
}

check('every implemented spec operation exists on the router', () => {
  const live = new Set(liveRoutes().map((r) => r.key));
  for (const key of specKeys.keys()) {
    assert.ok(live.has(key),
      `the spec marks '${key}' x-implemented but the router does not serve it — `
      + 'a client generated from this document would call a 404');
  }
});

check('every v2 route on the router is in the spec', () => {
  for (const route of liveRoutes().filter((r) => r.key.includes('/api/v2/'))) {
    assert.ok(specKeys.has(route.key),
      `${route.key} is served but is not an x-implemented operation in the spec — `
      + 'undocumented surface is how a route nobody has read reaches production');
  }
});

check('x-required-scope agrees with the tier the router derives', () => {
  // The one comparison worth making: the spec's published authorization claim against
  // the middleware chain that actually runs. `library` is defined as the ABSENCE of
  // admin, so only the admin boundary is derivable — which is exactly what
  // API_V2_DESIGN.md narrowed the claim to.
  const tiers = new Map(liveRoutes().map((r) => [r.key, tierOf(r)]));
  for (const [key, op] of specKeys) {
    const declared = op['x-required-scope'];
    const tier = tiers.get(key);
    const routerSaysAdmin = String(tier).startsWith('pat-admin:');
    assert.strictEqual(declared === 'admin', routerSaysAdmin,
      `${key}: spec says x-required-scope '${declared}' but the router's tier is '${tier}'`);
  }
});

check('no v2 route is registered below the catch-all that would shadow it', () => {
  // The authorization gate CANNOT see this. Three routes were once added below the
  // terminal 404 handler: they were present on the router, carried tier `pat`, matched
  // the spec, and every assertion in this file passed — while all three returned 404 to
  // every caller. Express answers with the first matching layer, and a path-less
  // `.use()` matches everything.
  //
  // Asserted from the router's own stack rather than from source text, so it holds
  // however the routes are written.
  const v2Layer = (app.router || app._router).stack.find(
    (l) => l.handle && Array.isArray(l.handle.stack) && mountPath(l) === '/api/v2');
  assert.ok(v2Layer, 'the /api/v2 router is no longer mounted');

  const stack = v2Layer.handle.stack;
  // A catch-all is a path-less `.use()` that is not the authenticator.
  const firstCatchAll = stack.findIndex(
    (l) => !l.route && typeof l.handle === 'function' && l.handle.name !== 'patRequired'
           && mountedAtRoot(l));
  if (firstCatchAll === -1) return;   // no terminal handler yet; nothing to shadow
  const shadowed = stack.slice(firstCatchAll + 1).filter((l) => l.route).map((l) => l.route.path);
  assert.deepStrictEqual(shadowed, [],
    `these v2 routes are registered below the catch-all and are UNREACHABLE: ${shadowed.join(', ')}`);
});

check('every v2 route is token-authenticated, never merely authenticated', () => {
  // A v2 route reaching 'auth' would mean it accepted a session JWT — and a JWT
  // carries no scope, so the admin boundary would be bypassable by logging in.
  for (const route of liveRoutes().filter((r) => r.key.includes('/api/v2/'))) {
    const tier = tierOf(route);
    assert.ok(tier === 'pat' || tier.startsWith('pat-admin:'),
      `${route.key} has tier '${tier}' — every /api/v2 route must go through patRequired`);
  }
});

check('v2 auth refusals are 401, and carry WWW-Authenticate', () => {
  // Not visible to this file's router walk — it compares tiers, not status codes — and
  // no unit test exercises the middleware. Asserted from source because the deviation
  // it guards (403 where the published contract says 401) shipped once already, and
  // nothing anywhere else would notice it coming back.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  // Bounded by the NEXT function, whatever it is. An earlier version sliced to
  // `function requirePermission`, and requireAdminScope landing between the two put
  // its (correct) SVC.FORBIDDEN inside the window — the assertion below fired on code
  // it was never about. A boundary that moves when a function is inserted is a
  // boundary that reports the wrong function.
  const patStart = source.indexOf('function patRequired');
  const fn = source.slice(patStart, source.indexOf('\nfunction ', patStart + 1));
  assert.ok(fn.includes('SVC.UNAUTHENTICATED'),
    'patRequired no longer answers 401 — 403 is what an insufficient SCOPE returns, and '
    + 'collapsing the two leaves a client unable to tell re-authenticate from stop-retrying');
  assert.ok(!fn.includes('SVC.FORBIDDEN'), 'patRequired answers FORBIDDEN somewhere');

  // And the inverse conflation, which is the same defect pointing the other way: the
  // scope guard must NOT answer 401, or a client holding a perfectly valid
  // library-scoped token is told to re-authenticate and loops forever trying.
  const adminStart = source.indexOf('function requireAdminScope');
  assert.ok(adminStart !== -1, 'requireAdminScope is gone — the v2 admin routes have no guard');
  const guard = source.slice(adminStart, source.indexOf('\nfunction ', adminStart + 1));
  assert.ok(guard.includes('SVC.FORBIDDEN'), 'requireAdminScope no longer answers 403');
  assert.ok(!guard.includes('SVC.UNAUTHENTICATED'),
    'requireAdminScope answers 401 — an insufficient scope is not an authentication failure, '
    + 'and a client told to re-authenticate over it will retry forever');
  assert.ok(fn.includes('WWW_AUTHENTICATE'), 'the 401 no longer carries WWW-Authenticate (RFC 9110)');
});

check('the walker credits router middleware by STACK POSITION, not membership', () => {
  // This function is what every other authorization assertion in this file rests on,
  // so it gets a test of its own. An earlier version credited a router's `.use()` to
  // every route in it, which reported a genuinely open route as authenticated and
  // made the whole file pass over an anonymous-access hole.
  const express = require('express');
  const r = express.Router();
  r.get('/before', (req, res) => res.end());          // registered ABOVE the guard
  r.use(function patRequired(req, res, next) { next(); });
  r.get('/after', (req, res) => res.end());
  r.use('/scoped', function alsoGuard(req, res, next) { next(); });
  r.get('/unscoped', (req, res) => res.end());        // /scoped must NOT count here
  const probe = express();
  probe.use('/api/v2', r);

  const tiers = new Map(
    liveRoutes((probe.router || probe._router).stack).map((x) => [x.key, tierOf(x)]));
  assert.strictEqual(tiers.get('GET /api/v2/before'), 'public',
    'a route registered ABOVE the guard was reported as authenticated — the middleware '
    + 'never runs for it, because Express matches layers in stack order');
  assert.strictEqual(tiers.get('GET /api/v2/after'), 'pat');
  assert.strictEqual(tiers.get('GET /api/v2/unscoped'), 'pat',
    'a PATH-SCOPED .use() must neither add nor remove a tier for routes outside its path');
});

check('parseRouteId rejects everything that is not a plain integer', () => {
  // db.js divergence #5: a non-numeric value compared against an INTEGER column
  // raises SQLSTATE 22P02 — a 500 where the answer should be a 4xx.
  //
  // The previous version of this check asserted only that the :id routes EXIST, so
  // removing parseRouteId from DELETE /api/users/:id left it green. Test the
  // function.
  assert.strictEqual(parseRouteId('7'), 7);
  assert.strictEqual(parseRouteId('01'), 1);
  for (const bad of ['abc', '1abc', '1 ', ' 1', '', '-1', '1.5', '0x10', '1e3', null, undefined, '٧']) {
    assert.strictEqual(parseRouteId(bad), null, `parseRouteId(${JSON.stringify(bad)}) should be null`);
  }
});

console.log('sharing routes use the stricter self-only check:');
check('the selfOnly guard is present exactly where the table says', () => {
  // Bidirectional, and derived from EXPECTED rather than from a path pattern — a
  // regex over paths matched /api/shared-libraries, which is NOT a self-only route.
  //
  // The absence-only version of this check passed CI after the guard was deleted
  // from two adapters, and a non-admin could then read and overwrite another user's
  // share list. Both directions matter: a route losing the guard, and a route
  // gaining one without the table being updated.
  const declared = Object.keys(EXPECTED).filter((k) => EXPECTED[k] === 'self-only').sort();
  const actual = routes.filter((r) => r.selfOnly).map((r) => r.key).sort();
  assert.ok(declared.length >= 5, `expected at least 5 self-only routes, table declares ${declared.length}`);
  assert.deepStrictEqual(actual, declared,
    'the set of routes carrying selfOnly does not match the table.\n' +
    `      table:  ${declared.join(', ')}\n` +
    `      actual: ${actual.join(', ')}`);
});
check('sharing routes do NOT use ownershipRequired (no admin bypass)', () => {
  // Deliberate asymmetry, and easy to "tidy" into a bug: every other
  // /api/user/:username/* route lets an admin act on someone else's data, but the
  // share routes are self-only, enforced inline. Pin it so a well-meaning
  // refactor toward consistency cannot silently grant admins access to other
  // people's share lists.
  const shareRoutes = routes.filter((r) => EXPECTED[r.key] === 'self-only');
  assert.ok(shareRoutes.length >= 5, `expected the sharing routes, found ${shareRoutes.length}`);
  const leaked = shareRoutes.filter((r) => r.names.includes('ownershipRequired')).map((r) => r.key);
  assert.deepStrictEqual(leaked, [],
    'sharing route(s) gained the admin bypass:\n    ' + leaked.join('\n    '));
});

console.log(`\n${n} assertions passed.  ${routes.length} routes, tiers: ` +
  JSON.stringify(routes.reduce((acc, r) => { const t = tierOf(r); acc[t] = (acc[t] || 0) + 1; return acc; }, {})));
