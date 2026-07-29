// MCP server unit tests. Run with: npm test (inside mcp/)
//
// SCOPE RULE, same as the backend suites: no EXTERNAL network, no backend, no
// database. What is asserted here is the tool INVENTORY, the credential handling, and
// the error mapping — everything that can be checked from the definitions themselves.
//
// A LOOPBACK listen against the in-process app IS allowed, and the handshake test below
// uses one. That is not a loosening: the rule exists to keep out things that fail for
// environmental reasons, and an ephemeral port bound to an app this file already
// imports has no fixture, no external dependency and no non-determinism. It is also the
// only way to prove the transport can complete an exchange at all — which it could not,
// in production, for a full deploy cycle. The header used to read "no network" flat,
// which this test contradicted; a rule and a test that disagree get one of them deleted
// by whoever reads them next.
//
// The end-to-end proof (a real MCP client against a real backend) is probe-e2e.js, run
// by hand, because it needs both processes up.

const assert = require('assert');

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };
const asyncChecks = [];
const checkAsync = (label, fn) => asyncChecks.push([label, fn]);

const { TOOLS } = require('../tools');
const api = require('../api');
const { tokenFromRequest, INSTRUCTIONS } = require('../server');
const { GUIDE, CONVENTIONS, RESOURCES } = require('../guide');

// --- the tool inventory, PINNED ---------------------------------------------------
//
// Pinned the way test/api-surface.test.js pins route tiers, and for the same reason:
// what this server exposes is a security boundary, not an implementation detail. A
// tool added here reaches an AI agent acting on someone's library, so it should be a
// deliberate edit to this list rather than a side effect of adding a function.
const EXPECTED_TOOLS = [
  'add_game',
  'get_backlog',
  'get_game',
  'list_library',
  'list_shareable_users',
  'list_shares',
  'read_gametracker_guide',
  'read_shared_library',
  'remove_game',
  'reorder_backlog',
  'search_games',
  'share_library',
  'unshare_library',
  'update_game_status',
  'whoami',
];

console.log('tool inventory:');

check('the exposed tool set is exactly what was decided', () => {
  assert.deepStrictEqual(TOOLS.map((t) => t.name).sort(), EXPECTED_TOOLS,
    'the MCP tool set changed. Each tool here is reachable by an AI agent acting on a '
    + 'real library — add or remove one deliberately, not to make CI pass.');
});

check('the administrative surface is NOT exposed, even with an admin token', () => {
  // /api/v2 has user management, server settings, token administration and
  // instance-wide job triggering. None of them belong to an agent, and this server
  // does not forward them regardless of what the caller's token would permit. The API
  // still enforces its own scopes; this is a second, narrower boundary on top.
  const forbidden = [
    /user/i, /settings/i, /token/i, /\bjob/i, /admin/i, /revoke/i, /password/i, /ldap/i,
  ];
  for (const t of TOOLS) {
    // `list_shareable_users` is the one legitimate "user" name: it returns username and
    // display name so a share target can be resolved, and it is library-scoped.
    if (t.name === 'list_shareable_users') continue;
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(t.name),
        `tool '${t.name}' matches ${pattern} — administrative operations must not be exposed here`);
    }
  }
});

check('every tool is named for a task, in snake_case, and is unique', () => {
  const seen = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `tool name is not snake_case: ${t.name}`);
    assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
    seen.add(t.name);
  }
});

check('every tool carries a description a model can choose from', () => {
  // A tool with a thin description is a tool that gets picked wrongly. These are the
  // model's only guide to WHEN to reach for something.
  for (const t of TOOLS) {
    assert.ok(t.config && typeof t.config.description === 'string',
      `${t.name} has no description`);
    assert.ok(t.config.description.length >= 80,
      `${t.name}'s description is ${t.config.description.length} chars — too thin to choose from`);
    assert.ok(t.config.title, `${t.name} has no title`);
    assert.ok(t.config.inputSchema !== undefined, `${t.name} has no inputSchema`);
  }
});

check('destructive tools are annotated as destructive', () => {
  // The annotation is what lets a client warn a user or require confirmation. Getting
  // it wrong on a delete is the difference between a prompt and a silent removal.
  const destructive = { remove_game: true, unshare_library: true };
  for (const t of TOOLS) {
    const hint = t.config.annotations?.destructiveHint;
    if (destructive[t.name]) {
      assert.strictEqual(hint, true, `${t.name} deletes something but is not marked destructive`);
    } else if (t.config.annotations?.readOnlyHint !== true) {
      assert.strictEqual(hint, false, `${t.name} is a write and must state destructiveHint explicitly`);
    }
  }
});

check('read-only tools are annotated read-only', () => {
  const readOnly = ['whoami', 'search_games', 'list_library', 'get_game',
    'get_backlog', 'list_shares', 'list_shareable_users', 'read_shared_library'];
  for (const name of readOnly) {
    const t = TOOLS.find((x) => x.name === name);
    assert.strictEqual(t.config.annotations?.readOnlyHint, true,
      `${name} does not read as read-only, so a client cannot run it without prompting`);
  }
});

check('the instructions cover the four defaults an agent gets wrong', () => {
  // Each is a failure mode that produces a confidently wrong answer rather than an
  // error: inventing an id from a title, rewriting a backlog order without reading it,
  // checking one status and declaring a game absent, and reporting a weekly price
  // snapshot as today's.
  assert.match(INSTRUCTIONS, /igdb_/, 'the instructions do not show the id format');
  assert.match(INSTRUCTIONS, /search_games/, 'the instructions do not say to search before adding');
  assert.match(INSTRUCTIONS, /backlog/i, 'the instructions do not mention backlog ordering');
  assert.match(INSTRUCTIONS, /exactly one status|one status/i,
    'the instructions do not warn that a game has exactly one status');
  assert.match(INSTRUCTIONS, /snapshot|not a live price/i,
    'the instructions do not warn that lastPrice is not current');
  assert.ok(!/get_game_price/.test(INSTRUCTIONS),
    'the instructions still reference a price tool that no longer exists');
  assert.match(INSTRUCTIONS, /gametracker:\/\/guide/,
    'the instructions do not point at the guide resource');
});

console.log('application documentation (what an agent needs to reason correctly):');

check('the guide explains the application, not just the tools', () => {
  // An agent connecting fresh has no idea what GameTracker IS. Tool descriptions
  // cannot carry that — they describe one call each. These are the concepts a correct
  // answer depends on, and every one of them has produced a wrong answer when missing.
  const required = [
    [/wishlist/, 'the wishlist status'],
    [/playing/, 'the playing status'],
    [/\bdone\b/, 'the done status'],
    [/unreleased/, 'the unreleased status'],
    [/assigned by the server|not chosen/i, 'that unreleased is assigned, not chosen'],
    [/ordered/i, 'that the backlog is ordered'],
    [/replaces the ENTIRE ordering|replaces the whole ordering/i, 'that reorder replaces wholesale'],
    [/source-prefixed/i, 'the id format'],
    [/read-only/i, 'that sharing is read-only'],
    [/lastPrice/, 'the stored price field'],
    [/weekly/i, 'that the stored price is weekly'],
    [/crackStatus/, 'the DRM field'],
    [/steamAppId/, 'the Steam id field'],
    [/de-duplicated|merged/i, 'that search merges providers'],
    [/still succeeds/i, 'that search degrades rather than failing'],
    [/pagination|nextCursor/i, 'pagination'],
  ];
  for (const [pattern, what] of required) {
    assert.match(GUIDE + CONVENTIONS, pattern,
      `the application documentation does not explain ${what}`);
  }
});

check('the guide states what is NOT available and says not to work around it', () => {
  assert.match(GUIDE, /not reachable even with an administrator|deliberately absent/i,
    'the guide does not say the admin surface is unavailable');
  assert.match(GUIDE, /Do not attempt a workaround/i,
    'the guide does not tell the agent to stop rather than improvise');
});

check('every resource is readable, described, and non-trivial', () => {
  assert.ok(RESOURCES.length >= 2, 'expected a guide and a conventions resource');
  for (const r of RESOURCES) {
    assert.match(r.uri, /^gametracker:\/\//, `${r.name} has a non-namespaced uri`);
    assert.ok(r.config.description.length >= 60, `${r.name}'s description is too thin to choose from`);
    assert.ok(r.config.mimeType, `${r.name} has no mimeType`);
    assert.ok(r.text.length > 800, `${r.name} is ${r.text.length} chars — too thin to be worth reading`);
  }
});

check('the documentation contains no credential and no instance detail', () => {
  // These are STATIC documents served to any caller. They must describe the
  // application, never this deployment — a hostname or a key here would be handed to
  // every agent that connects.
  const blob = GUIDE + CONVENTIONS + INSTRUCTIONS;
  assert.ok(!/gt_pat_[A-Za-z0-9]/.test(blob), 'a token-shaped value appears in the documentation');
  assert.ok(!/https?:\/\/(?!modelcontextprotocol)/.test(blob), 'a URL appears in the documentation');
  assert.ok(!/password\s*[:=]/i.test(blob), 'something password-shaped appears in the documentation');
});

// --- credentials ------------------------------------------------------------------

check('the guide is reachable as a TOOL, not only as a resource', () => {
  // Resources are the least-implemented part of MCP: many clients and agent frameworks
  // surface tools only, and almost none read a resource unprompted. If the guide were
  // resource-only, an agent on such a client would see the four instruction bullets as
  // the entire application model — and the whole instructions/resource split would
  // silently invert. So it is BOTH.
  const t = TOOLS.find((x) => x.name === 'read_gametracker_guide');
  assert.ok(t, 'the guide is not exposed as a tool');
  assert.strictEqual(t.config.annotations?.readOnlyHint, true);
  assert.match(INSTRUCTIONS, /read_gametracker_guide/,
    'the instructions do not tell the agent to call the guide tool');
});

checkAsync('the guide tool needs no token and returns the whole document', async () => {
  const t = TOOLS.find((x) => x.name === 'read_gametracker_guide');
  const result = await t.handler({}, {});          // deliberately no token
  assert.ok(!result.isError, 'the guide tool required a credential to read a static document');
  const text = result.content[0].text;
  assert.ok(text.length > 8000, `the guide tool returned ${text.length} chars — not the full document`);
  assert.match(text, /# GameTracker/);
  assert.match(text, /# Working conventions/, 'the conventions are missing from the guide tool');
});

check('the reorder warning names the actual consequence', () => {
  // "its position becomes undefined" read as tolerable, and an agent asked to move one
  // game sent a one-element list. That assigns 1..N to the ids sent and leaves every
  // other stored position alone — DUPLICATE positions, which break the web app's
  // up/down controls and are invisible in get_backlog, since it renders position by
  // row index. The warning has to say that, not gesture at it.
  const t = TOOLS.find((x) => x.name === 'reorder_backlog');
  assert.match(t.config.description, /EVERY backlogged game id/,
    'the reorder description does not demand the full list');
  assert.match(t.config.description, /duplicate positions/i,
    'the reorder description does not name the corruption a partial list causes');
  assert.match(GUIDE, /DUPLICATE positions/,
    'the guide does not name the corruption a partial list causes');
});

check('list_library states the REAL default sort, and exposes sort/order', () => {
  // It claimed "newest first by default". The API default is name/asc — so an agent
  // answering "what did I add recently" from the first page was reading an alphabetical
  // list and reporting it as chronological.
  const t = TOOLS.find((x) => x.name === 'list_library');
  assert.ok(!/newest first by default/i.test(t.config.description),
    'list_library still claims a default sort the API does not have');
  assert.match(t.config.description, /ALPHABETICALLY BY NAME/,
    'list_library does not state its real default order');
  assert.ok(t.config.inputSchema.sort, 'list_library cannot sort, so "recently added" is unanswerable');
  assert.ok(t.config.inputSchema.order, 'list_library cannot reverse its order');
});

check('ids and usernames are constrained to the shapes the API accepts', () => {
  // Loose `z.string().min(1)` let `..` through, and encodeURIComponent does not escape
  // it — WHATWG URL then normalises the segment away, so remove_game{gameId:".."}
  // reached DELETE /library/ instead of /library/games/.. . Not exploitable against
  // today's routes; entirely dependent on nobody adding one at the parent path.
  const t = TOOLS.find((x) => x.name === 'remove_game');
  const schema = t.config.inputSchema.gameId;
  assert.ok(schema.safeParse('igdb_1020').success, 'a legitimate id was rejected');
  for (const bad of ['..', '../users', 'igdb_1020/../..', '', 'Hades', '1020', 'ftp_9']) {
    assert.ok(!schema.safeParse(bad).success, `gameId accepted ${JSON.stringify(bad)}`);
  }
  const share = TOOLS.find((x) => x.name === 'unshare_library').config.inputSchema.username;
  for (const bad of ['..', '../admin', 'UPPER', 'a'.repeat(65), '']) {
    assert.ok(!share.safeParse(bad).success, `username accepted ${JSON.stringify(bad)}`);
  }
});

checkAsync('output is compact — indentation is pure cost', async () => {
  // Measured: pretty-printing a 200-game listing spent ~5,300 tokens on whitespace.
  // Asserted against what a tool actually EMITS, not against the source — the first
  // version grepped for the pretty-print call and matched the comment explaining why
  // it was removed.
  const realCall = api.call;
  api.call = async () => ({ data: [{ gameId: 'igdb_1', name: 'A' }], meta: { total: 1 } });
  try {
    const t = TOOLS.find((x) => x.name === 'list_library');
    const out = await t.handler({}, { _gametrackerToken: 'gt_pat_x' });
    const text = out.content[0].text;
    assert.ok(!/\n\s\s/.test(text),
      `tool output is pretty-printed: ${JSON.stringify(text.slice(0, 80))}`);
    assert.deepStrictEqual(JSON.parse(text).meta, { total: 1 }, 'output is not valid JSON');
  } finally {
    api.call = realCall;
  }
});

check('no tool references a capability this server does not have', () => {
  // Price lookup was removed. A description that still names a tool the agent cannot
  // call is worse than no description: it produces a plan whose next step does not
  // exist, and the model has no way to discover that until it fails.
  const gone = ['get_game_price'];
  const surfaces = TOOLS.map((t) => `${t.name} ${t.config.description}`).join('\n')
    + INSTRUCTIONS + GUIDE + CONVENTIONS;
  for (const name of gone) {
    assert.ok(!surfaces.includes(name),
      `${name} was removed but is still referenced — an agent will plan a call it cannot make`);
  }
});

console.log('credential handling:');

check('a token is read ONLY from an Authorization: Bearer header', () => {
  assert.strictEqual(tokenFromRequest({ headers: { authorization: 'Bearer gt_pat_abc' } }), 'gt_pat_abc');
  assert.strictEqual(tokenFromRequest({ headers: { authorization: 'bearer gt_pat_abc' } }), 'gt_pat_abc');
  assert.strictEqual(tokenFromRequest({ headers: { authorization: '  Bearer   gt_pat_abc  ' } }), 'gt_pat_abc');
  // Anything else is no token. A query-string credential would land in access logs and
  // proxy logs, which is exactly what holding no ambient credential is meant to avoid.
  assert.strictEqual(tokenFromRequest({ headers: {} }), null);
  assert.strictEqual(tokenFromRequest({ headers: { authorization: 'gt_pat_abc' } }), null);
  assert.strictEqual(tokenFromRequest({ headers: { authorization: 'Basic abc' } }), null);
  assert.strictEqual(tokenFromRequest({ headers: { authorization: '' } }), null);
  assert.strictEqual(tokenFromRequest({ headers: { authorization: ['Bearer a', 'Bearer b'] } }), null);
});

check('this server holds NO ambient credential', () => {
  // The central design property, asserted against the source rather than trusted: if
  // any token could come from the environment, this port would BE a credential and
  // anything that reached it would act as that account.
  const fs = require('fs');
  const path = require('path');
  for (const file of ['server.js', 'tools.js', 'api.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const envReads = src.match(/process\.env\.[A-Z_]+/g) || [];
    for (const read of envReads) {
      assert.ok(!/TOKEN|SECRET|KEY|PASS|CRED/i.test(read),
        `${file} reads ${read} — this server must not hold a credential of its own`);
    }
  }
});

checkAsync('a tool called without a token fails closed, and says why', async () => {
  // read_gametracker_guide is deliberately exempt: it returns a static document about
  // the application, not this account's data, so it needs no credential.
  const t = TOOLS.find((x) => x.name === 'whoami');
  const result = await t.handler({}, {});          // no _gametrackerToken
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /does not hold credentials/,
    'the no-token message does not explain that the client must supply one');
});

// --- the runtime the IMAGE ships ---------------------------------------------------
//
// This pair exists because the server shipped for a full deploy cycle unable to answer a
// single MCP call. `initialize` died with `ReferenceError: crypto is not defined`: the
// SDK's HTTP transport calls the GLOBAL crypto.randomUUID() on every request carrying a
// JSON-RPC request, and node:18-slim does not expose globalThis.crypto without a flag.
//
// Nothing caught it, for two separate reasons, and BOTH needed closing:
//
//  1. This suite runs on the CI runner's Node (20), never the image's (18). A handshake
//     test alone would have passed while production was broken — so the version the
//     image will actually run is asserted STATICALLY, from the Dockerfile text.
//  2. The smoke-test stack had no mcp service at all, so the container was never started
//     in CI, let alone spoken to. That is fixed in docker-compose.test.yml.
//
// /health kept returning 200 throughout. Liveness is not readiness for a protocol server.

console.log('the runtime the image ships:');

check('the Dockerfile base image satisfies the engines floor', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const from = /^FROM\s+node:(\d+)/m.exec(dockerfile);
  assert.ok(from, 'no `FROM node:<major>` in the Dockerfile — cannot verify the runtime');

  const engines = require('../package.json').engines?.node;
  assert.ok(engines, 'package.json declares no engines.node floor');
  // Anchored on `>=` rather than the first number in the string. A bare /(\d+)/ would
  // read "18.x || >=20" as a floor of 18 and pass a node:18 image — failing open on
  // the exact range shape someone writes when they want to keep 18 working.
  const floor = /">="?\s*(\d+)|>=\s*(\d+)/.exec(engines);
  assert.ok(floor, `engines.node must express a >= floor, got: ${engines}`);
  const floorMajor = floor[1] || floor[2];

  assert.ok(Number(from[1]) >= Number(floorMajor),
    `Dockerfile runs node:${from[1]} but package.json requires node${engines}. `
    + 'The SDK transport needs globalThis.crypto (Node 19+); below that EVERY MCP '
    + 'request fails while /health still answers 200.');
});

checkAsync('a real initialize handshake succeeds over HTTP', async () => {
  // The end-to-end check the inventory assertions cannot make: definitions can all be
  // correct while the transport is unable to complete a single exchange. Loopback only —
  // no backend, no database, no internet, so the suite's scope rule holds.
  const http = require('http');
  const { app } = require('../server');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gametracker-test', version: '0' },
      },
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer gt_pat_test',
          // Bare '127.0.0.1' is allowlisted whatever MCP_PORT is, so this needs no
          // fixed port and cannot collide with anything else on the runner.
          host: '127.0.0.1',
        },
      }, (r) => {
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => resolve({ status: r.statusCode, text }));
      });
      req.on('error', reject);
      req.end(body);
    });

    assert.strictEqual(res.status, 200,
      `handshake did not succeed: HTTP ${res.status} ${res.text.slice(0, 200)}`);

    // The transport answers as SSE when the client accepts it.
    const payload = JSON.parse(/^data: (.+)$/m.exec(res.text)[1]);
    assert.ok(!payload.error, `handshake returned an error: ${JSON.stringify(payload.error)}`);
    assert.strictEqual(payload.result.serverInfo.name, 'gametracker');
    assert.ok(payload.result.capabilities.tools, 'the server advertised no tools capability');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- error mapping ----------------------------------------------------------------

check('the published address is accepted without a second setting', () => {
  // Binding to a LAN address publishes the port there, but the CONTAINER only ever
  // binds 0.0.0.0 — so the Host header names an address this process never saw, and
  // the DNS-rebinding check refuses a legitimate client with an error that points at
  // neither of the two addresses involved. Deriving it means one variable does the job.
  const { execFileSync } = require('child_process');
  const read = (env) => execFileSync(process.execPath,
    ['-e', 'const s=require("./server.js");console.log(JSON.stringify(s.ALLOWED_HOSTS))'],
    { cwd: require('path').join(__dirname, '..'), env: { ...process.env, ...env } }).toString();

  const lan = JSON.parse(read({ MCP_PUBLIC_HOST: '192.168.1.30', MCP_PORT: '3001' }));
  assert.ok(lan.includes('192.168.1.30:3001'), `published address not accepted: ${lan}`);
  assert.ok(lan.includes('192.168.1.30'), 'published address not accepted without the port');
  // Localhost must survive it, or setting one address locks out same-host clients.
  assert.ok(lan.includes('127.0.0.1:3001') && lan.includes('localhost:3001'),
    'setting a published address dropped the localhost defaults');

  // 0.0.0.0 is not a Host anything sends; adding it would be noise.
  const wild = JSON.parse(read({ MCP_PUBLIC_HOST: '0.0.0.0', MCP_PORT: '3001' }));
  assert.ok(!wild.includes('0.0.0.0'), '0.0.0.0 was added as an accepted Host');

  // The explicit list ADDS rather than replaces, so it cannot lock out localhost.
  const named = JSON.parse(read({ MCP_ALLOWED_HOSTS: 'games.example.com', MCP_PORT: '3001' }));
  assert.ok(named.includes('games.example.com'), 'the explicit allowlist was ignored');
  assert.ok(named.includes('localhost:3001'), 'the explicit allowlist replaced the defaults');
});

console.log('error mapping (what the model is told to do next):');

check('401 and 403 are DIFFERENT answers', () => {
  // They need different fixes. Conflating them sends the user to re-issue a token that
  // was fine, or to widen a scope when the token had simply expired.
  const unauth = api.toolError({ response: { status: 401, data: {} } });
  const forbidden = api.toolError({ response: { status: 403, data: {} } });
  assert.match(unauth, /Not authenticated/);
  assert.match(forbidden, /Not permitted/);
  assert.notStrictEqual(unauth, forbidden);
  // Both must tell the model to stop, or it retries a permanent failure.
  assert.match(unauth, /Retrying will not help/);
  assert.match(forbidden, /Retrying will not help/);
});

check('5xx says retrying is reasonable; 4xx does not', () => {
  assert.match(api.toolError({ response: { status: 503, data: {} } }), /transient|retrying/i);
  const validation = api.toolError({ response: { status: 400, data: { code: 'validation', title: 'Invalid request' } } });
  assert.ok(!/transient/i.test(validation), 'a validation failure invited a retry');
});

check('a problem+json body contributes only code, title and detail', () => {
  const msg = api.toolError({
    response: {
      status: 409,
      data: {
        code: 'conflict', title: 'Conflict', detail: 'two games match',
        // Everything below is the rest of the body and must NOT cross: it is JSON from
        // another service, and a model reads whatever is in it as instruction-shaped.
        internalTrace: 'at Object.<anonymous> (/app/services/library.js:88)',
        sql: 'SELECT * FROM user_games',
      },
    },
  });
  assert.match(msg, /conflict/);
  assert.match(msg, /two games match/);
  assert.ok(!msg.includes('services/library.js'), 'an internal path reached the model');
  assert.ok(!msg.includes('SELECT'), 'a SQL statement reached the model');
});

check('a connection failure does not name the internal address', () => {
  const msg = api.toolError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 172.18.0.4:3000' });
  assert.ok(!msg.includes('172.18.0.4'), 'internal topology reached the model');
  assert.match(msg, /Could not reach GameTracker/);
});

check('a timeout warns that a write may have landed', () => {
  // The one case where "just retry" is actively dangerous.
  const msg = api.toolError({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' });
  assert.match(msg, /may still have been applied/);
});

// --- run ---------------------------------------------------------------------------

(async () => {
  for (const [label, fn] of asyncChecks) {
    await fn();
    n++;
    console.log('  ok  ' + label);
  }
  console.log(`\n${n} assertions passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
