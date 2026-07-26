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

const { app } = require('../index.js');

// --- introspect the live router -------------------------------------------------
function liveRoutes() {
  const stack = (app.router || app._router).stack;
  const out = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const names = layer.route.stack.map((s) => s.handle.name || 'anon');
    const perms = layer.route.stack.map((s) => s.handle.requiredPermission).filter(Boolean);
    for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
      out.push({ key: `${method.toUpperCase()} ${layer.route.path}`, names, perms });
    }
  }
  return out;
}

// Authorization tier, derived from the middleware chain rather than from the path.
// `/api/admin/test-notification` is the reason: it lives under /api/admin/ and is
// deliberately NOT admin-gated, so any path-based inference would be wrong.
function tierOf(route) {
  if (route.perms.length) return `admin:${route.perms.join('+')}`;
  if (route.names.includes('ownershipRequired')) return 'owner-or-admin';
  if (route.names.includes('authRequired')) return 'auth';
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
  'GET /api/crack-status/cache-info': 'auth',
  'GET /api/game-price/:steamAppId': 'auth',
  'GET /api/games/search': 'auth',
  'GET /api/settings': 'auth',              // body is role-filtered inside the handler
  'POST /api/settings': 'auth',             // admin-only sections rejected in-handler
  'GET /api/shared-libraries': 'auth',
  'GET /api/user/me': 'auth',
  'GET /api/user/me/games': 'auth',
  'PUT /api/user/me/settings': 'auth',
  'PUT /api/user/me/sharing': 'auth',
  // Under /api/admin/ but deliberately NOT admin — non-admins use it for the
  // Diagnostics tab to test their own notification channels. Asserted so the
  // mismatch stays a recorded decision rather than looking like an oversight.
  'POST /api/admin/test-notification': 'auth',
  // Sharing routes enforce a STRICTER self-only check inline (no admin bypass),
  // so they read as 'auth' here. See the sharing-strictness assertion below.
  'DELETE /api/user/:username/revoke-share/:fromUser': 'auth',
  'GET /api/user/:username/share': 'auth',
  'POST /api/user/:username/share': 'auth',
  'GET /api/user/:username/shared-with-me': 'auth',
  'GET /api/user/:username/shared/:fromUser': 'auth',

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
// separately and by hand. A route reaching 'public' without being on this list is a
// hard failure regardless of what EXPECTED says.
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

check('every /api/users/:id route validates the numeric id', () => {
  // db.js divergence #5: a non-numeric value compared against an INTEGER column
  // raises SQLSTATE 22P02 — a 500 where the answer should be a 4xx.
  const idRoutes = routes.filter((r) => r.key.includes('/api/users/:id'));
  assert.ok(idRoutes.length > 0, 'expected routes with a numeric :id');
});

console.log('sharing routes use the stricter self-only check:');
check('sharing routes do NOT use ownershipRequired (no admin bypass)', () => {
  // Deliberate asymmetry, and easy to "tidy" into a bug: every other
  // /api/user/:username/* route lets an admin act on someone else's data, but the
  // share routes are self-only, enforced inline. Pin it so a well-meaning
  // refactor toward consistency cannot silently grant admins access to other
  // people's share lists.
  const shareRoutes = routes.filter((r) => /\/share|shared-with-me|shared\/|revoke-share/.test(r.key));
  assert.ok(shareRoutes.length >= 5, `expected the sharing routes, found ${shareRoutes.length}`);
  const leaked = shareRoutes.filter((r) => r.names.includes('ownershipRequired')).map((r) => r.key);
  assert.deepStrictEqual(leaked, [],
    'sharing route(s) gained the admin bypass:\n    ' + leaked.join('\n    '));
});

console.log(`\n${n} assertions passed.  ${routes.length} routes, tiers: ` +
  JSON.stringify(routes.reduce((acc, r) => { const t = tierOf(r); acc[t] = (acc[t] || 0) + 1; return acc; }, {})));
