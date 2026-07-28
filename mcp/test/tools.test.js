// MCP server unit tests. Run with: npm test (inside mcp/)
//
// SCOPE RULE, same as the backend suites: no network, no backend, no database. What is
// asserted here is the tool INVENTORY, the credential handling, and the error mapping —
// everything that can be checked from the definitions themselves.
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

// --- the tool inventory, PINNED ---------------------------------------------------
//
// Pinned the way test/api-surface.test.js pins route tiers, and for the same reason:
// what this server exposes is a security boundary, not an implementation detail. A
// tool added here reaches an AI agent acting on someone's library, so it should be a
// deliberate edit to this list rather than a side effect of adding a function.
const EXPECTED_TOOLS = [
  'add_game',
  'get_backlog',
  'get_game_price',
  'list_library',
  'list_shareable_users',
  'list_shares',
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
  const readOnly = ['whoami', 'search_games', 'get_game_price', 'list_library',
    'get_backlog', 'list_shares', 'list_shareable_users', 'read_shared_library'];
  for (const name of readOnly) {
    const t = TOOLS.find((x) => x.name === name);
    assert.strictEqual(t.config.annotations?.readOnlyHint, true,
      `${name} does not read as read-only, so a client cannot run it without prompting`);
  }
});

check('the instructions tell the model the two things it gets wrong unaided', () => {
  // Both are failure modes seen in practice: inventing an id from a title, and
  // rewriting a backlog order without reading it first.
  assert.match(INSTRUCTIONS, /igdb_/, 'the instructions do not show the id format');
  assert.match(INSTRUCTIONS, /search_games/, 'the instructions do not say to search before adding');
  assert.match(INSTRUCTIONS, /backlog/i, 'the instructions do not mention backlog ordering');
});

// --- credentials ------------------------------------------------------------------

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
  const t = TOOLS.find((x) => x.name === 'whoami');
  const result = await t.handler({}, {});          // no _gametrackerToken
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /does not hold credentials/,
    'the no-token message does not explain that the client must supply one');
});

// --- error mapping ----------------------------------------------------------------

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
