// Asserts the RUNTIME the images actually ship. Run with: npm test
//
// SCOPE: reads repository artifacts (Dockerfiles, package.json) and cross-checks them
// against each other. Deliberately NOT in helpers.test.js, whose scope rule is pure
// functions with no filesystem — the shape here is the one openapi.test.js already
// uses: an artifact on disk must agree with the source of truth beside it.
//
// WHY THIS FILE EXISTS
//
// The MCP server shipped a full deploy cycle unable to answer a single call. Its image
// ran node:18-slim, the SDK's HTTP transport calls the GLOBAL crypto.randomUUID(), and
// globalThis.crypto is only exposed from Node 19. Every request returned -32700 while
// /health answered 200 and the container looked healthy.
//
// Nothing caught it because THE SUITES RUN ON THE CI RUNNER'S NODE, NEVER THE IMAGE'S.
// No runtime assertion can close that gap — by the time this process is executing, it
// is already on the wrong interpreter. The only check that works is a static one: read
// the base image out of the Dockerfile and compare it to the declared floor.
//
// The second reason is that no scanner covers this. Trivy reads dpkg metadata, and the
// Node runtime in the official images is a tarball at /usr/local/bin/node rather than a
// package — so trivy-api and trivy-mcp are structurally blind to CVEs in the
// interpreter, and a green scan says nothing about the Node version. Node 18 went EOL
// on 2025-04-30 and sat in the backend image with every gate reporting success.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };

const ROOT = path.join(__dirname, '..');

// Each image, and the package.json that declares its floor.
const IMAGES = [
  { name: 'backend', dockerfile: 'Dockerfile', pkg: 'package.json' },
  { name: 'mcp', dockerfile: 'mcp/Dockerfile', pkg: 'mcp/package.json' },
  // The frontend's BUILD stage (the first FROM). Nothing of it ships, but it runs npm ci
  // over the whole dependency tree on the production host, and swagger-client — which
  // does ship — declares engines >=22. It sat on EOL node:20 because this list omitted it.
  { name: 'frontend', dockerfile: 'frontend/Dockerfile', pkg: 'frontend/package.json' },
];

// Below this, a supported runtime is not what you are running. 22 is the lowest Node
// still receiving security updates: 20 went EOL on 2026-04-30 (ROADMAP UP-2), and this
// constant still said 20 five months later — a date is not something a test notices by
// itself, so RAISE THIS when 22 reaches EOL (2027-04-30). 19 is where globalThis.crypto
// arrived, so the floor also covers the MCP defect above with a margin.
const MIN_SUPPORTED_MAJOR = 22;

// engines.node must be a SIMPLE `>=N` floor and nothing else.
//
// This is deliberately strict, and it is strict because the obvious looser version is
// wrong in a way that passes. A disjunction like "18.x || >=20" reads as though it
// declares a floor of 20 — and any regex hunting for `>=` will report 20 — while the
// range it actually expresses still PERMITS Node 18. Caught by mutating this file's own
// assertion: the check went green on exactly the string someone writes when they want
// to keep an EOL runtime working.
//
// Rather than teach this file semver, refuse anything it cannot reason about.
function floorMajorOf(engines, where) {
  const m = /^>=\s*(\d+)(?:\.\d+)*$/.exec(String(engines).trim());
  assert.ok(m,
    `${where}: engines.node must be a simple ">=N" floor, got ${JSON.stringify(engines)}. `
    + 'Ranges with alternatives (e.g. "18.x || >=20") are rejected because they read like '
    + 'a floor while still permitting the older major.');
  return Number(m[1]);
}

console.log('the runtime the images ship:');

for (const img of IMAGES) {
  check(`${img.name}: Dockerfile base satisfies its engines floor`, () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, img.dockerfile), 'utf8');
    const from = /^FROM\s+node:(\d+)/m.exec(dockerfile);
    assert.ok(from, `${img.dockerfile}: no \`FROM node:<major>\` — cannot verify the runtime`);

    const engines = JSON.parse(fs.readFileSync(path.join(ROOT, img.pkg), 'utf8')).engines?.node;
    assert.ok(engines, `${img.pkg} declares no engines.node floor`);
    const floorMajor = floorMajorOf(engines, img.pkg);

    assert.ok(Number(from[1]) >= floorMajor,
      `${img.dockerfile} runs node:${from[1]} but ${img.pkg} requires node${engines}`);
  });

  check(`${img.name}: declared floor is a supported Node`, () => {
    const engines = JSON.parse(fs.readFileSync(path.join(ROOT, img.pkg), 'utf8')).engines.node;
    const floor = floorMajorOf(engines, img.pkg);
    assert.ok(floor >= MIN_SUPPORTED_MAJOR,
      `${img.pkg} floor is node>=${floor}; ${MIN_SUPPORTED_MAJOR} is the lowest Node still `
      + 'receiving security updates. Lowering this re-opens a hole no Trivy job can see.');
  });
}

// ROADMAP UP-6. A shared smoke-test group let a pull request cancel a QUEUED main run's
// smoke test, and deploy (which needs it) was skipped: a merge that never deployed and
// never said so. The partition only works because stacks can coexist, so both halves are
// pinned: per-run project, no fixed container_name, and six distinct host ports.
check('smoke stacks are per-run and a PR cannot evict a main run (UP-6)', () => {
  const yaml = require('js-yaml');
  const wfText = fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8');
  const wf = yaml.load(wfText);
  const job = wf.jobs['smoke-test'];
  assert.ok(/github\.event_name == 'push'/.test(job.concurrency.group),
    'smoke-test concurrency group is no longer partitioned by event');
  assert.ok(/github\.run_id/.test(job.env.SMOKE_PROJECT), 'SMOKE_PROJECT is not per run');
  const ports = [];
  for (const k of ['BACKEND_TEST_PORT', 'FRONTEND_TEST_PORT', 'MCP_TEST_PORT']) {
    const m = /'(\d+)' \|\| '(\d+)'/.exec(job.env[k] || '');
    assert.ok(m, `${k} is not chosen per partition`);
    ports.push(m[1], m[2]);
  }
  assert.strictEqual(new Set(ports).size, 6, `the six smoke host ports must all differ: ${ports.join(',')}`);
  for (const p of ['3000', '8080', '3001']) assert.ok(!ports.includes(p), `a smoke port collides with production ${p}`);
  // Every way a step could address the stack by a fixed name instead of the project.
  // Against each step's own `run` text: through JSON.stringify every quote became \",
  // and a quoted fixed name slipped past both patterns (UP-6 review).
  const runs = job.steps.map((st) => st.run || '').join('\n');
  for (const [re, what] of [
    [/(?:-p|--project-name)[ =]+["']?gametracker-smoke(?![-\w])/, 'a fixed compose project'],
    [/docker (?:logs|exec|inspect|stop|rm|kill)\b[^\n]*?["']?gametracker-[\w-]*smoke/, 'a fixed container name'],
  ]) assert.ok(!re.test(runs), `a smoke step addresses the stack by ${what} again`);
  // The pre-start cleanup runs `down --volumes` on whatever it matches. The anchoring is
  // the safety property: unanchored, it would also match the OTHER partition's live stack.
  const clean = job.steps.find((st) => /leftover smoke stacks/i.test(st.name || ''));
  assert.ok(clean, 'the leftover-stack cleanup step is gone');
  assert.ok(clean.run.includes('"^gametracker-smoke-${SMOKE_PARTITION}-[0-9]+-[0-9]+$"'),
    'the leftover-stack pattern is no longer anchored to this partition\'s per-run names');
  const compose = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.test.yml'), 'utf8'));
  for (const [name, svc] of Object.entries(compose.services)) {
    assert.ok(!svc.container_name, `docker-compose.test.yml: ${name} has a fixed container_name`);
  }
});

// SEC-14 condition 3. The session cookie's CSRF defence is that a cross-origin page cannot
// send the custom header without a preflight that CORS refuses. That holds only while
// credentialed CORS stays OFF: `credentials: true` (or an ACAC header set by hand) would let
// an allowlisted origin make cookie-carrying requests. And nothing may log Cookie headers.
check('credentialed CORS stays off, and no request headers are logged (SEC-14)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.ok(!/credentials\s*:\s*true/.test(src), 'cors() allows credentials -- the session cookie loses its CSRF defence');
  assert.ok(!/Access-Control-Allow-Credentials/i.test(src), 'an Access-Control-Allow-Credentials header is set by hand');
  assert.ok(!/console\.\w+\([^)]*req\.headers(?![.[]\s*['"]?(?:x-|sec-))/.test(src),
    'a log line prints request headers, which carry the session cookie');
});

// ROADMAP UP-18. Since P0-6 the SPA's interceptor ENDS THE SESSION on any 401. So a 401
// must mean exactly "no valid credential": an endpoint answering 401 for anything else —
// a wrong sudo password, a stale CSRF token, an upstream's 401 passed through — would
// sign people out for a typo. Sudo mode answers 403 (pinned in api-contract.test.js);
// this pins the general rule, by WHERE 401s can come from.
check('a 401 comes only from authentication (the SPA logs out on every 401, UP-18)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8').split('\n');
  // cookieSession and sessionUser are authRequired's two halves for a session JWT (SEC-14):
  // the cookie carrier and the shared privilege re-read. Still authentication, still here.
  const ALLOWED = ['function authRequired(', 'function patRequired(', 'function selfOnly(',
    'function ownershipRequired(', "app.post('/api/auth/login'",
    'function cookieSession(', 'function sessionUser('];
  // The block a line belongs to is the last column-0 opener; a column-0 closer ends it, so
  // code after an allowed function never inherits its name (review: without the reset, an
  // `app.all(…401…)` placed after ownershipRequired passed).
  const opener = /^(?:async )?function \w+\(|^(?:const|let|var) [\w{}, ]+ = |^(?:app|v2Router|router)\.\w+\(/;
  let enclosing = '(top level)'; const found = [];
  src.forEach((line, i) => {
    if (opener.test(line)) enclosing = line;
    else if (/^[})]/.test(line)) enclosing = '(top level)';
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(line) || !code.trim()) return;
    // ANY 401 literal, however it is sent (status, sendStatus, statusCode =, writeHead),
    // plus the service code that problem.js renders as 401.
    if (/\b401\b|UNAUTHENTICATED/.test(code)) {
      found.push(enclosing);
      assert.ok(ALLOWED.some((a) => enclosing.startsWith(a)),
        `index.js:${i + 1} can answer 401 inside ${enclosing.trim().slice(0, 80)} — a 401 logs the SPA user out; use 403 unless the CREDENTIAL is missing or invalid`);
    }
    // A status taken from a VARIABLE cannot be checked by reading it — which is exactly
    // how an upstream's 401 on an AxiosError reached the client. Each is allowlisted by
    // reason: a created/ok pair, and the final handler's clamp (problem.js).
    const variable = /(?:\.status|sendStatus)\(\s*(?!\d)([^)]*)\)|statusCode\s*=\s*(?!\d)/.exec(code);
    if (variable) {
      assert.ok(/^result\.created \? 201 : 200$|^problem\.statusForUnhandled\(err$/.test((variable[1] || '').trim()),
        `index.js:${i + 1} sets a status from a value (${code.trim().slice(0, 70)}). Map it through a table that cannot yield 401, and allowlist it here with the reason`);
    }
  });
  assert.ok(found.length >= 5, 'found no 401 producers — the scan itself is broken');
  // Services never decide "unauthenticated": that is the adapters' job, and a service
  // throwing it would reach both surfaces as a 401 through problem.js. Every top-level
  // module the backend requires, too — not only services/.
  const modules = [
    ...fs.readdirSync(path.join(ROOT, 'services')).filter((f) => !['errors.js', 'problem.js', 'v2.js'].includes(f))
      .map((f) => `services/${f}`),
    'ldap-helpers.js', 'directory.js', 'settings-store.js', 'user-rules.js', 'rate-limits.js',
  ];
  for (const f of modules) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/UNAUTHENTICATED|['"]unauthenticated['"]|\b401\b/.test(text.replace(/\/\/.*$/gm, '')),
      `${f} can produce an unauthenticated/401 answer`);
  }
});

// UP-17. The pairing only a deploy can check: the backend never sees its own bind.
check('deploy warns on a TRUST_PROXY / BACKEND_BIND mismatch (UP-17)', () => {
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  const steps = wf.jobs.deploy.steps;
  const i = steps.findIndex((st) => /reverse-proxy pairing/i.test(st.name || ''));
  const up = steps.findIndex((st) => /start production stack/i.test(st.name || ''));
  assert.ok(i >= 0 && i < up, 'the pairing check is gone, or runs after the stack starts');
  assert.ok(/TRUST_PROXY/.test(steps[i].run) && /BACKEND_BIND/.test(steps[i].run));
});

// FE-11. The SPA's CSP carries no 'unsafe-inline' anywhere. React style props go through
// the CSSOM, which CSP does not govern, so nothing needs it — and it is what would let
// injected markup restyle the page (a UI-redress primitive), and, in script-src, run.
check("the SPA's CSP has no 'unsafe-inline' and nothing in the SPA needs it (FE-11)", () => {
  const conf = fs.readFileSync(path.join(ROOT, 'frontend/nginx.conf'), 'utf8');
  const csp = /Content-Security-Policy\s+"([^"]+)"/.exec(conf);
  assert.ok(csp, 'no CSP in frontend/nginx.conf');
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp[1]), `the CSP allows unsafe-*: ${csp[1]}`);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return ['node_modules', 'dist'].includes(e.name) ? [] : walk(rel);
    return /\.jsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [rel] : [];
  });
  for (const f of walk('frontend')) {
    // Comments stripped — but only ones that START a line (or a JSX `{/* */}`), because a
    // stripper that is not string-aware lets '//' or 'image/*' inside a STRING hide real
    // code after it (review of FE-16). A note saying "never use innerHTML" is not a use.
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    // Every way markup — and so a style attribute or a <style> — gets in: React's escape
    // hatch, the two DOM sinks, setAttribute('style'), a created or JSX <style>.
    assert.ok(!/dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=(?!=)|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style['"]|createElement\(\s*['"]style['"]|<style[\s>{]/.test(text),
      `${f} sets style through markup; the CSP would block it (and it would need 'unsafe-inline')`);
  }
});

// UP-7. The one smoke step that proves a REAL token works on v2 and through the MCP
// server. Deleting it, or letting the token print before it is masked, would leave CI
// green; so would minting a broader token than the checks need.
check('the smoke stage drives v2 and MCP with a real, masked, library-only token (UP-7)', () => {
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  const steps = wf.jobs['smoke-test'].steps;
  const e2e = steps.find((st) => /real token/i.test(st.name || ''));
  assert.ok(e2e, 'the end-to-end smoke step is gone');
  const run = e2e.run;
  const mint = run.search(/create-api-token\.js/), mask = run.indexOf('::add-mask::'), use = run.indexOf('Bearer $PAT');
  assert.ok(mint >= 0 && mask > mint && use > mask, 'the token is used before it is masked (or is not minted here)');
  assert.ok(/create-api-token\.js root "[^"]+" library --expires-in-days 1/.test(run),
    'the smoke token is minted with more than the library scope, or without an expiry');
  assert.ok(/tools\/call[\s\S]*whoami/.test(run), 'the MCP step no longer calls a tool that reaches the backend');
  // No smoke step writes a fixed /tmp path on the production host (symlink target).
  for (const st of steps) assert.ok(!/\/tmp\/smoke-/.test(st.run || ''), `"${st.name}" writes a fixed /tmp/smoke-* path`);
});

// FE-22 review. React Router 7's default transitions let the signed-in catch-all overtake
// the post-login return path (FE-14). main.jsx must ship the ONE router config the routed
// tests use, or the test proves a router nobody runs.
check('main.jsx renders the router with the shared ROUTER_PROPS (FE-22)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'frontend/src/main.jsx'), 'utf8');
  assert.ok(/<BrowserRouter \{\.\.\.ROUTER_PROPS\}>/.test(main), 'main.jsx no longer spreads ROUTER_PROPS onto BrowserRouter');
  const cfg = fs.readFileSync(path.join(ROOT, 'frontend/src/routerConfig.js'), 'utf8');
  assert.ok(/useTransitions:\s*false/.test(cfg), 'routerConfig.js no longer turns off router transitions');
});

// Tool installs on the production host (review of UP-7). Every binary the pipeline
// downloads is installed as ROOT, so it must come from a private mktemp dir (a fixed /tmp
// path can be pre-planted) and match a SHA-256 PINNED in this file before it is extracted.
// EVERY workflow file, not only the deploy pipeline: android.yml runs on the same host.
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
const WORKFLOW_FILES = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const loadWorkflow = (f) => require('js-yaml').load(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8'));
const stepRun = (st) => (st.run || '').replace(/^\s*#.*$/gm, '');

check('CI installs tools from a private dir, checksum-verified every run, and never uses sudo (MOB-38)', () => {
  let installs = 0;
  for (const file of WORKFLOW_FILES) {
    const wf = loadWorkflow(file);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      for (const st of job.steps || []) {
        const run = stepRun(st);
        const where = `${file} / ${jobName} / "${st.name}"`;
        // Quoted or not, as an argument or an assignment (review of SEC-17: `-o "/tmp/x"`,
        // `-C "/tmp"` and `DL=/tmp/fixed` all slipped past the first version).
        assert.ok(!/(?:\s|=)["']?\/tmp(?:\/|["'\s]|$)/m.test(run), `${where} uses a fixed /tmp path`);
        // ANY extraction of a downloaded archive, root install or not (android.yml review):
        // a pinned SHA-256 must be checked first, fed by name to sha256sum -c.
        const extract = run.search(/\btar -x|\bunzip\b/);
        if (extract >= 0) {
          const verify = run.search(/sha256sum -c/);
          assert.ok(verify >= 0 && verify < extract, `${where} extracts an archive without checking a pinned SHA-256 first`);
          const fed = /echo "\$\{(\w+)\}\s+[^"]*" \| sha256sum -c/.exec(run);
          assert.ok(fed, `${where} does not feed a named pin to sha256sum -c`);
          const pinned = { ...(wf.env || {}), ...(job.env || {}), ...(st.env || {}) };
          for (const m of run.matchAll(/^\s*(\w+)="([0-9a-f]{64})"/gm)) pinned[m[1]] = m[2];
          assert.ok(/^[0-9a-f]{64}$/.test(pinned[fed[1]] || ''), `${where}: ${fed[1]} is not a pinned 64-hex SHA-256`);
        }
        // MOB-38: the runner is to run as a non-root user (OPERATOR_RUNBOOK.md), so no step
        // may need root: tools are cached in the runner's home and run by path, and the
        // smoke stack's files change owner through Docker.
        assert.ok(!/(^|[\s;&|(])sudo\s/m.test(run), `${where} uses sudo: the runner must not need root (MOB-38)`);
        if (/>> "\$GITHUB_PATH"/.test(run) && /\btar -x/.test(run)) {
          installs++;
          // The cache is writable by every later job, so the pinned hash is re-checked on
          // EVERY run, on the line that extracts it: not only when it was downloaded.
          const lines = run.split('\n');
          const at = lines.findIndex((l) => /\btar -x/.test(l));
          assert.ok(at > 0 && /echo "\$\{\w+_SHA256\}\s+\$\{TARBALL\}" \| sha256sum -c -/.test(lines[at - 1]),
            `${where} extracts its cached tool without re-checking the pinned SHA-256 on the line before`);
          // ...from a private copy in BIN, so the shared cache cannot be swapped between the
          // check and the extraction (CISO review, PR #15).
          assert.ok(at > 1 && /^\s*TARBALL="\$\{BIN\}\/[\w.-]+"\s*$/.test(lines[at - 2]),
            `${where} checks and extracts the shared cached file instead of a private copy in BIN`);
        }
      }
    }
  }
  assert.ok(installs >= 4, `found ${installs} cached tool installs — expected gitleaks and three trivy`);
});

// MOB-38 moved host-file ownership changes from sudo into containers. Such a container runs with
// a host directory mounted, as uid 0 or with added capabilities, so its image is code running
// next to the host: it must be a digest-PINNED image, never one this run built from the pull
// request (CISO review, PR #15). And no container gets DAC_READ_SEARCH unless its image is
// pinned: with it, Docker's seccomp profile allows open_by_handle_at, a known escape.
check('privileged helper containers run a digest-pinned image, never a PR-built one (MOB-38)', () => {
  let helpers = 0;
  for (const file of WORKFLOW_FILES) {
    const wf = loadWorkflow(file);
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      const env = { ...(wf.env || {}), ...(job.env || {}) };
      for (const st of job.steps || []) {
        const run = stepRun(st).replace(/\\\n\s*/g, ' ');
        for (const cmd of run.split('\n').filter((l) => /\bdocker run\b/.test(l))) {
          const privileged = /--cap-add|--user 0\b|--privileged/.test(cmd);
          // Any -v/--volume/--mount whose source is a host path or a variable (CISO re-review).
          const binds = /(?:-v|--volume)[ =]"?(?:\$\{?\w+|\/|\$PWD|\.)[^:" ]*:\//.test(cmd) || /--mount\b/.test(cmd);
          if (!privileged && !binds) continue;
          const where = `${file} / ${jobName} / "${st.name}"`;
          assert.ok(!/--privileged/.test(cmd), `${where} runs a --privileged container`);
          const vars = [...cmd.matchAll(/"\$\{(\w+_IMAGE)\}"/g)].map((m) => m[1]);
          assert.ok(vars.length === 1, `${where}: a privileged or bind-mounting docker run must name its image as one "\${X_IMAGE}"`);
          assert.ok(!/^TEST_/.test(vars[0]), `${where} runs the PR-built ${vars[0]} with host access`);
          assert.ok(/@sha256:[0-9a-f]{64}$/.test(String(env[vars[0]] || '')),
            `${where}: ${vars[0]} is not pinned by digest in the workflow or job env`);
          if (privileged) helpers++;
        }
      }
    }
  }
  assert.ok(helpers >= 4, `found ${helpers} privileged helper containers -- expected the smoke chown and android's`);
  // One trusted image, written in two files: they must not drift apart on a bump.
  const helper = loadWorkflow('docker-build-deploy.yml').jobs['smoke-test'].env.HELPER_IMAGE;
  assert.strictEqual(helper, loadWorkflow('android.yml').env.JDK_IMAGE, 'HELPER_IMAGE and android.yml JDK_IMAGE differ');
});

// This repository is public and every job runs on the production host. A job reachable from
// a fork's pull request runs a stranger's code there, so each job must either carry the
// same-repo gate or not run on pull_request at all (push-only, like deploy). No test pinned
// this before, for any workflow. Both triggers that run a fork's code WITH this repo's
// secrets are refused outright.
check('every PR-triggered job is gated to same-repo PRs; no pull_request_target / workflow_run', () => {
  const GATE = "github.event.pull_request.head.repo.full_name == github.repository";
  for (const file of WORKFLOW_FILES) {
    const wf = loadWorkflow(file);
    const on = wf.on || wf[true] || {};
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
    for (const t of ['pull_request_target', 'workflow_run']) {
      assert.ok(!triggers.includes(t), `${file} uses the ${t} trigger`);
    }
    if (!triggers.includes('pull_request')) continue;
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      const cond = String(job.if || '');
      const gated = cond.includes(GATE);
      const pushOnly = /^github\.event_name == 'push'( && [^|]*)?$/.test(cond.trim());
      assert.ok(gated || pushOnly, `${file} / ${jobName} can run for a fork's pull request (if: ${cond || 'none'})`);
    }
  }
  assert.ok(WORKFLOW_FILES.includes('docker-build-deploy.yml'), 'the deploy workflow was not found -- the scan is broken');
});

// android.yml builds third-party code (Gradle plugins, kapt processors, lint jars) on the
// production host. The isolation and the pins are the whole control, so each is asserted.
check('android.yml: path-filtered, containerised, pinned, and never a deploy dependency', () => {
  const file = 'android.yml';
  assert.ok(WORKFLOW_FILES.includes(file), 'android.yml is missing');
  const wf = loadWorkflow(file);
  const text = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
  const on = wf.on || wf[true];
  for (const t of ['push', 'pull_request']) {
    const paths = (on[t] && on[t].paths) || [];
    assert.ok(paths.includes('mobile/**'), `android.yml ${t} is not filtered to mobile/**`);
  }
  assert.match(wf.env.JDK_IMAGE, /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, 'the JDK image is not pinned by digest');
  assert.match(wf.env.CMDLINE_TOOLS_SHA256, /^[0-9a-f]{64}$/, 'the command-line tools are not SHA-256 pinned');
  const runs = Object.values(wf.jobs).flatMap((j) => (j.steps || []).map(stepRun)).join('\n');
  // Gradle must never run on the host: every gradlew invocation is inside the docker run.
  const build = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((st) => /gradlew/.test(st.run || ''));
  assert.ok(build, 'no step runs gradlew');
  const b = stepRun(build);
  assert.ok(b.indexOf('docker run') >= 0 && b.indexOf('docker run') < b.indexOf('gradlew'), 'gradlew runs outside the container');
  for (const flag of ['--cap-drop ALL', 'no-new-privileges', '--memory', '--pids-limit', '--user', '/tmp:rw,noexec']) {
    assert.ok(b.includes(flag), `the build container lost ${flag}`);
  }
  assert.ok(/\$\{JDK_IMAGE\}/.test(b), 'the build container does not use the pinned JDK_IMAGE');
  assert.ok(!/docker\.sock|--privileged|--network host|-v "?\$\{?HOME|GITHUB_WORKSPACE\}:/.test(runs),
    'a container gets the Docker socket, privileges, the host network, $HOME or the whole workspace');
  assert.ok(/GITHUB_WORKSPACE\}\/mobile:\/work/.test(b), 'the build container must mount only mobile/');
  assert.ok(/VOLUME_PARTITION/.test(b) && /'main' \|\| 'pr'/.test(wf.env.VOLUME_PARTITION), 'cache volumes are not split between PRs and main');
  // The wrapper jar pin must be the jar actually committed.
  const jar = fs.readFileSync(path.join(ROOT, 'mobile/gradle/wrapper/gradle-wrapper.jar'));
  const sha = require('crypto').createHash('sha256').update(jar).digest('hex');
  assert.strictEqual(wf.env.GRADLE_WRAPPER_JAR_SHA256, sha, 'GRADLE_WRAPPER_JAR_SHA256 is not the committed wrapper jar');
  assert.ok(/sha256sum -c/.test(runs) && /GRADLE_WRAPPER_JAR_SHA256/.test(runs), 'the wrapper jar is not verified');
  const props = fs.readFileSync(path.join(ROOT, 'mobile/gradle/wrapper/gradle-wrapper.properties'), 'utf8');
  assert.match(props, /^distributionSha256Sum=[0-9a-f]{64}$/m, 'the Gradle distribution is not SHA-256 pinned');
  const gprops = fs.readFileSync(path.join(ROOT, 'mobile/gradle.properties'), 'utf8');
  assert.match(gprops, /^android\.builder\.sdkDownload=false$/m, 'AGP may download SDK components on its own');
  // Strict dependency verification against the committed, reviewed metadata. Regenerating it in
  // CI (--write-verification-metadata) would verify every dependency against itself.
  assert.ok(/--dependency-verification strict/.test(b), 'Gradle does not run with --dependency-verification strict');
  assert.ok(!/--write-verification-metadata|--dependency-verification (lenient|off)|-M\s/.test(runs),
    'the workflow regenerates or relaxes the dependency verification metadata');
  assert.ok(!/org\.gradle\.dependency\.verification/.test(gprops), 'gradle.properties overrides dependency verification');
  // Nothing executable is trusted from a writable cache volume (CISO review, PR #6): the Gradle
  // home is pruned BEFORE gradlew (a killed build never reaches the prune after it, and an
  // init.d script would run next time), the whole SDK is reinstalled, and the wrapper
  // distribution is not kept, so distributionSha256Sum checks it every run.
  const gradlewAt = b.indexOf('bash gradlew');
  const firstPrune = b.indexOf('find /gradle -mindepth 1 -maxdepth 1 ! -name caches -exec rm -rf');
  assert.ok(firstPrune >= 0 && firstPrune < gradlewAt, 'the Gradle home is not pruned before gradlew runs');
  assert.ok(!/! -name wrapper/.test(b), 'the Gradle wrapper distribution is kept in a writable volume');
  assert.ok(b.indexOf('find /sdk -mindepth 1 -maxdepth 1 -exec rm -rf') >= 0 && b.indexOf('find /sdk -mindepth 1') < b.indexOf('sdkmanager'),
    'the SDK is not wiped before sdkmanager installs it');
  assert.ok(/\[ "\$\(id -u\)" != 0 \]/.test(b), 'the build container does not refuse uid 0');
  // The runner is root, so its own uid is not a non-root uid: Gradle runs as a fixed BUILD_UID
  // (PR #6's first run with the guard refused uid 0), and mobile/ is handed back afterwards.
  assert.ok(/^[1-9]\d*$/.test(String(wf.env.BUILD_UID)), 'BUILD_UID is not a fixed non-root uid');
  // (The signing containers DO run as the runner, MOB-38: they run no build code, and a
  // non-root runner's 0600 key is unreadable to anyone else. Only the BUILD is held to this.)
  assert.ok(/--user "\$\{BUILD_UID\}:\$\{BUILD_UID\}"/.test(b) && !/--user "\$\(id -u\)/.test(b),
    'the build container does not run as BUILD_UID');
  const cleanup = stepRun(wf.jobs.android.steps.find((st) => st.if === 'always()'));
  assert.ok(/chown -R "\$\(id -u\):\$\(id -g\)" \/work/.test(cleanup), 'mobile/ is not handed back to the runner after the build');
  // Every chown runs in a network-less container whose ONLY capability is CHOWN, never on the
  // host, and never follows symlinks (-L/-H): mobile/ is PR-controlled (CISO re-check, 74d21bf).
  const chowns = runs.split('\n').filter((l) => /\bchown\b/.test(l));
  assert.ok(chowns.length >= 2, 'the chown steps are missing');
  for (const line of chowns) {
    assert.ok(/"\$\{JDK_IMAGE\}" chown -R? ?"/.test(line), `a chown runs outside the pinned container: ${line.trim()}`);
    assert.ok(!/chown[^\n]*\s-(?:[a-zA-Z]*[LH])/.test(line), `a chown follows symlinks: ${line.trim()}`);
  }
  for (const m of runs.matchAll(/docker run([\s\S]*?)"\$\{JDK_IMAGE\}" chown/g)) {
    // CHOWN, plus DAC_READ_SEARCH (read/traverse only) to enter BUILD_UID's 0700 directories.
    assert.ok(/--network none/.test(m[1]) && /--cap-drop ALL/.test(m[1]) && /--cap-add CHOWN/.test(m[1])
      && !/--cap-add (?!CHOWN\b|DAC_READ_SEARCH\b)/.test(m[1]),
      'a chown container is not network-less with CHOWN (and DAC_READ_SEARCH) as its only capabilities');
  }
  const meta = fs.readFileSync(path.join(ROOT, 'mobile/gradle/verification-metadata.xml'), 'utf8');
  assert.match(meta, /<verify-metadata>true<\/verify-metadata>/, 'verification-metadata.xml does not verify metadata');
  assert.ok((meta.match(/<sha256 value="[0-9a-f]{64}"/g) || []).length > 100, 'verification-metadata.xml holds almost no checksums');
  assert.ok(!/<trusted-artifacts>|<trusted-keys>|<ignored-keys>/.test(meta), 'verification-metadata.xml trusts artifacts without a checksum');
  // Never a deploy dependency, and deploy never waits on it.
  const deploy = loadWorkflow('docker-build-deploy.yml').jobs.deploy;
  assert.ok(!JSON.stringify(deploy.needs).includes('android'), 'deploy depends on the Android job');
  assert.ok(wf.jobs.android['timeout-minutes'] > 0, 'the Android job has no timeout: a hung Gradle would block the one runner');
  // A cancelled job kills the docker CLIENT, not the container (seen on PR #6: the orphan
  // held the Gradle lock). The build container is named, cleared before, and removed in an
  // always() step -- which is what runs on cancellation.
  const steps = wf.jobs.android.steps;
  const name = /--name "(gametracker-android-build-\$\{VOLUME_PARTITION\})"/.exec(b);
  assert.ok(name, 'the build container has no fixed per-partition name');
  const idx = steps.indexOf(build);
  assert.ok(steps.slice(0, idx).some((st) => stepRun(st).includes(`docker rm -f "${name[1]}"`)), 'a leftover build container is not removed before the build');
  assert.ok(steps.slice(idx + 1).some((st) => /always\(\)/.test(String(st.if)) && stepRun(st).includes(`docker rm -f "${name[1]}"`)),
    'no always() step removes the build container after a cancelled or failed run');
});

// A single-quoted script handed to a container (`bash ... -c '...'`) must END at its own
// closing quote. An apostrophe in a comment inside it ("workflow's") closed it early on PR #9, and
// the REST of the container script then ran on the HOST, as root, on the production host: it
// reached `bash gradlew` and `find /gradle ... -exec rm -rf` there. Every such block's first
// closing quote must stand alone on its line.
check('no container script in a workflow is cut short by a quote inside it', () => {
  let blocks = 0;
  for (const f of WORKFLOW_FILES) {
    const text = fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8');
    for (const m of text.matchAll(/ -c '\n/g)) {
      blocks += 1;
      const start = m.index + m[0].length;
      const end = text.indexOf("'", start);
      const line = text.slice(text.lastIndexOf('\n', end) + 1, text.indexOf('\n', end));
      assert.ok(/^\s*'(\s*\|\|[^'\n]*)?\s*$/.test(line), `${f}: a container script closes early at: ${line.trim()}`);
    }
  }
  assert.ok(blocks >= 3, `found ${blocks} container scripts -- the scan is broken`);
});

// MOB-40: the release APK. ONE file, at ONE URL, signed where build code cannot reach the key.
// Every property below fails silently: a second copy, a PR run that publishes, a key handed to
// the Gradle container, or a URL that answers with the SPA's index.html all "work".
check('android.yml publishes exactly one signed APK, from main only, served at /download/', () => {
  const yaml = require('js-yaml');
  const wf = loadWorkflow('android.yml');
  const text = fs.readFileSync(path.join(WORKFLOW_DIR, 'android.yml'), 'utf8');
  const { APK_PUBLISH_DIR: dir, APK_NAME: name } = wf.env;
  assert.ok(/^\/home\/docker\/gametracker\/[\w-]+$/.test(dir) && name === 'gametracker.apk', 'APK_PUBLISH_DIR / APK_NAME changed');
  const job = wf.jobs.android;
  const steps = job.steps;
  // The key is an ENVIRONMENT secret, and the environment is asked for only on a push to main.
  assert.strictEqual(job.environment,
    "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') && 'android-release' || '' }}",
    'the android-release environment (the signing key) is requested outside a push to main');
  const secretSteps = steps.filter((st) => /secrets\./.test(JSON.stringify(st)));
  assert.strictEqual(secretSteps.length, 1, 'the signing secrets reach more than one step');
  const pub = secretSteps[0];
  assert.strictEqual(pub.if, "success() && github.event_name == 'push' && github.ref == 'refs/heads/main'",
    'the APK can be signed or published by a pull request, or after a failed build');
  const gradle = steps.find((st) => /gradlew/.test(st.run || ''));
  assert.ok(steps.indexOf(pub) > steps.indexOf(gradle), 'the publish step runs before the build');
  assert.ok(!/secrets\.|\/key/.test(JSON.stringify(gradle)), 'the Gradle container can see the signing key');
  const r = stepRun(pub);
  const cleanup = stepRun(steps.find((st) => st.if === 'always()'));
  // Signing: fresh build-tools (not the build's writable SDK volume), in a network-less container.
  assert.ok(!/gametracker-android-sdk-/.test(r), 'signing uses the SDK volume the build could have written');
  const keyRun = /docker run([^\n]*(?:\\\n[^\n]*)*?)-v "\$\{SIGN\}\/key:\/key:ro"/.exec(r);
  assert.ok(keyRun && /--network none/.test(keyRun[1]) && /--cap-drop ALL/.test(keyRun[1]), 'the container holding the key has a network or capabilities');
  assert.strictEqual((r.match(/-v "\$\{SIGN\}\/key/g) || []).length, 1, 'the key is mounted into more than one container');
  assert.ok(/--v4-signing-enabled false/.test(r), 'apksigner may write a second file (.idsig)');
  // The container holding the key runs apksigner ONLY: the native parsers (aapt2, zipalign) read
  // build output, so they run in a container without the key (CISO review, PR #9).
  const keyScript = /-v "\$\{SIGN\}\/key:\/key:ro"[\s\S]*? -c '\n([\s\S]*?)\n\s*'/.exec(r);
  assert.ok(keyScript && /apksigner" sign/.test(keyScript[1]), 'the signing container script was not found');
  assert.ok(!/aapt2|zipalign|\/in\b|\/published/.test(keyScript[1]), 'a native parser, or the raw build output, is in the container that holds the key');
  // And only the commit main points at now may publish (CISO review, PR #9).
  const lsr = r.indexOf('git ls-remote'), mvAt = r.indexOf('mv -f -T');
  assert.ok(lsr >= 0 && lsr < mvAt && /"\$\{HEAD_SHA\}" != "\$\{GITHUB_SHA\}"/.test(r), 'a re-run of an old commit can publish');
  assert.ok(/dump packagename/.test(r), 'the APK is signed without checking which app it is');
  // `head` stops reading early, the writer dies of SIGPIPE, and under pipefail the whole step
  // fails with 141. That broke the first real publish on main, after aapt2's badging output grew.
  assert.ok(!/\|\s*head\b/.test(r), 'a pipeline in the publish step ends early with head (SIGPIPE under pipefail)');
  // A re-run of an older main run must never replace a newer published APK (Architect review, PR #9).
  assert.ok(/-v "\$\{APK_PUBLISH_DIR\}:\/published:ro"/.test(r) && /"\$\{NEW\}" -lt "\$\{OLD\}"/.test(r) && /exit 3/.test(r)
    && /if \[ "\$\{rc\}" = 3 \]; then[\s\S]*?exit 0/.test(r), 'an older build can be published over a newer one');
  assert.ok(/docker rm -f gametracker-android-sign\b/.test(cleanup), 'a cancelled job can leave the key-holding container running');
  // Publishing: only the SIGNED file, renamed atomically over the one name, then everything else goes.
  const mv = r.indexOf('mv -f -T "${INCOMING}" "${APK_PUBLISH_DIR}/${APK_NAME}"');
  const prune = r.indexOf('find "${APK_PUBLISH_DIR}" -mindepth 1 -maxdepth 1 ! -name "${APK_NAME}" -exec rm -rf {} +');
  assert.ok(mv >= 0 && prune > mv, 'the APK is not published as one atomically-replaced file');
  assert.ok(/OUT="\$\{SIGN\}\/signed\/signed\.apk"/.test(r) && !/unsigned\.apk"? "\$\{(INCOMING|APK_PUBLISH_DIR)/.test(r), 'something other than the signed APK is published');
  assert.ok(!/upload-artifact|actions\/cache/.test(text), 'the APK is copied somewhere else as well (an artifact or a cache)');
  assert.ok(/APK_OUT:-/.test(cleanup) && /ANDROID_SIGN:-/.test(cleanup), 'the unsigned APK or the signing directory outlives the job');
  // Served: the production frontend mounts THAT directory read-only, the smoke stack mounts the
  // same container path, and nginx serves exactly that one name there and 404s the rest.
  const prod = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.yaml'), 'utf8')).services.frontend.volumes || [];
  assert.deepStrictEqual(prod, [`${dir}:/usr/share/nginx/apk:ro`], 'the production frontend does not mount the APK directory read-only (and nothing else)');
  const test = yaml.load(fs.readFileSync(path.join(ROOT, 'docker-compose.test.yml'), 'utf8')).services.frontend.volumes || [];
  assert.ok(test.length === 1 && /\/apk:\/usr\/share\/nginx\/apk:ro$/.test(test[0]), 'the smoke stack does not mount the APK like production');
  const nginx = fs.readFileSync(path.join(ROOT, 'frontend/nginx.conf'), 'utf8').replace(/^\s*#.*$/gm, '');
  const loc = new RegExp(`location = /download/${name.replace('.', '\\.')} \\{([\\s\\S]*?)\\n  \\}`).exec(nginx);
  assert.ok(loc, 'nginx has no exact location for the APK');
  assert.ok(loc[1].includes(`alias /usr/share/nginx/apk/${name};`), 'nginx serves some other file at the APK URL');
  for (const h of ['application/vnd.android.package-archive', 'attachment; filename=', 'nosniff', "default-src 'none'", 'X-Frame-Options', 'Permissions-Policy']) {
    assert.ok(loc[1].includes(h), `the APK response lost ${h}`);
  }
  assert.ok(/location \/download\/ \{\s*return 404;\s*\}/.test(nginx), 'other /download/ paths fall through to the SPA');
  // The 404 before the first publish must not arrive as a file download (UI/UX review, PR #9).
  assert.ok(!/Content-Disposition[^;\n]*;[^\n]*\balways;/.test(loc[1]), 'Content-Disposition is sent on the 404 too (`always`)');
  const smoke = loadWorkflow('docker-build-deploy.yml').jobs['smoke-test'].steps.map(stepRun).join('\n');
  assert.ok(/\/download\/gametracker\.apk/.test(smoke), 'the smoke test does not fetch the APK URL');
});

// The Android app's critical security fixes (mobile/ROADMAP.md MOB-1, MOB-2, MOB-4), pinned
// from source: these are properties of the manifest and the build, which no JVM unit test in
// mobile/ can see, and they fail silently -- a re-exported activity or a dropped backup
// exclude breaks nothing a user notices.
{
  const APP = path.join(ROOT, 'mobile/app/src/main');
  const manifest = fs.readFileSync(path.join(APP, 'AndroidManifest.xml'), 'utf8');
  // A self-closing <activity .../>, or <activity ...> through its </activity> -- NOT up to the
  // first "/>", which inside an activity is a child element's.
  const activities = [...manifest.matchAll(/<activity\b[^>]*?\/>|<activity\b[^>]*>[\s\S]*?<\/activity>/g)].map((m) => m[0]);
  check('Android: only the launcher activity is exported (MOB-2)', () => {
    // Two since MOB-28 removed Settings: Login (the launcher) and Main.
    assert.ok(activities.length >= 2, `parsed ${activities.length} activities from the manifest -- the scan is broken`);
    for (const a of activities) {
      const name = /android:name="([^"]+)"/.exec(a)[1];
      const launcher = /android\.intent\.category\.LAUNCHER/.test(a);
      if (/android:exported="true"/.test(a)) {
        assert.ok(launcher, `${name} is exported but is not the launcher: any app can open it and skip the login`);
      }
    }
    assert.ok(/android:name="\.MainActivity"[\s\S]*?android:exported="false"/.test(manifest), 'MainActivity must say exported="false" explicitly');
  });
  check('Android: the session token is excluded from every backup path (MOB-4)', () => {
    const exclude = /<exclude\s+domain="sharedpref"\s+path="auth\.xml"\s*\/>/;
    // Comments stripped: an exclude inside <!-- --> excludes nothing (CISO review, PR #13).
    const backup = fs.readFileSync(path.join(APP, 'res/xml/backup_rules.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(exclude.test(backup), 'backup_rules.xml (Android 11 and older) does not exclude auth.xml');
    const extraction = fs.readFileSync(path.join(APP, 'res/xml/data_extraction_rules.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const m = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(extraction);
      assert.ok(m && exclude.test(m[1]), `data_extraction_rules.xml <${section}> does not exclude auth.xml`);
    }
    assert.ok(/android:dataExtractionRules="@xml\/data_extraction_rules"/.test(manifest) && /android:fullBackupContent="@xml\/backup_rules"/.test(manifest),
      'the manifest no longer points at the backup rules');
  });
  check('Android: HTTP logging is debug-only and never logs headers or bodies (MOB-1)', () => {
    // Code only: the KDoc explaining the old bug names Level.BODY on purpose.
    const client = fs.readFileSync(path.join(APP, 'java/ink/etech/gametracker/ApiClient.kt'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/Level\.(BODY|HEADERS)/.test(client), 'ApiClient logs at BODY or HEADERS: that is the bearer token and the password');
    assert.ok(/buildClient\(BuildConfig\.DEBUG/.test(client), 'the shipped client is not built from BuildConfig.DEBUG');
    const gradle = fs.readFileSync(path.join(ROOT, 'mobile/app/build.gradle.kts'), 'utf8');
    assert.ok(/buildConfig\s*=\s*true/.test(gradle), 'buildFeatures.buildConfig is off, so BuildConfig.DEBUG does not exist');
  });

  // MOB-10/11/12, the High data bugs. The behaviour is tested by the JVM suite in mobile/;
  // these pin the WIRING it cannot see. Code only, so an explanatory comment cannot satisfy
  // or trip a check.
  const code = (rel) => fs.readFileSync(path.join(APP, 'java/ink/etech/gametracker', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check('Android: the app\'s library-match vectors are the shared ones (MOB-10)', () => {
    // The Kotlin copy of the rule is the THIRD, beside services/library.js and the SPA's.
    // Its vectors cannot be required across the Gradle container boundary (only mobile/ is
    // mounted), so they are a JSON copy, and this keeps the copy equal to the source.
    const copy = JSON.parse(fs.readFileSync(path.join(ROOT, 'mobile/app/src/test/resources/library-match-vectors.json'), 'utf8'));
    assert.deepStrictEqual(copy, JSON.parse(JSON.stringify(require('./library-match-vectors'))),
      'mobile/app/src/test/resources/library-match-vectors.json differs from test/library-match-vectors.js: regenerate it');
  });

  check('Android: an add never posts without checking a fresh library, from Search or Details (MOB-10, MOB-16)', () => {
    // The rule lives in LibraryAdd, shared by both screens (MOB-16), so one cannot drift.
    const lib = code('LibraryAdd.kt');
    const add = lib.slice(lib.indexOf('suspend fun add('));
    assert.ok(add.length > 0 && add.indexOf('LibraryMatch.match(') >= 0, 'LibraryAdd.add does not consult LibraryMatch');
    // FORCED: the shared copy can be 30 s old (MOB-19), and a stale copy is the MOB-10 bug.
    const fresh = add.indexOf('LibraryRepository.load(context, force = true)');
    assert.ok(fresh >= 0 && fresh < add.indexOf('LibraryMatch.match(')
      && add.indexOf('LibraryMatch.match(') < add.indexOf('addOrUpdateGame('),
      'the add is not preceded by a fresh library read and a match check');
    assert.ok(/\?: return@withContext Outcome\.CheckFailed/.test(add), 'an add proceeds when the library check itself failed');
    assert.ok(!/addOrUpdateGame\(/.test(code('fragments/SearchFragment.kt')), 'Search posts an add itself instead of through LibraryAdd');
    for (const f of ['fragments/SearchFragment.kt', 'fragments/GameDetailsFragment.kt']) {
      assert.ok(/LibraryAdd\.add\(/.test(code(f)), `${f} no longer adds through LibraryAdd`);
    }
    assert.ok(!/status\s*=\s*"Wishlist"/.test(code('fragments/SearchFragment.kt')), 'search still sends a capitalised status');
  });

  // MOB-20: R8 is on, and Gson reads fields BY NAME. Every model is kept, and the BUILT dex is
  // checked in android.yml for one field of each; these three lists must stay one list.
  check('Android: the app id is final, R8 is on, and every Gson model is kept by name (MOB-20)', () => {
    const gradle = fs.readFileSync(path.join(ROOT, 'mobile/app/build.gradle.kts'), 'utf8');
    const wf = loadWorkflow('android.yml');
    assert.ok(/applicationId = "ink\.etech\.gametracker"/.test(gradle) && /namespace = "ink\.etech\.gametracker"/.test(gradle),
      'applicationId / namespace is not ink.etech.gametracker');
    assert.strictEqual(wf.env.APK_PACKAGE, 'ink.etech.gametracker', 'android.yml checks the APK for another package');
    assert.ok(!fs.existsSync(path.join(APP, 'java/com/example')), 'sources are left under com/example');
    const release = gradle.slice(gradle.indexOf('release {'));
    assert.ok(/isMinifyEnabled = true/.test(release.slice(0, 600)), 'R8 is off for the release build');
    const models = [...code('models.kt').matchAll(/data class (\w+)\(([\s\S]*?)\)\s*(?::|\{|$)/gm)]
      .map((m) => ({ name: m[1], fields: [...m[2].matchAll(/val (\w+)/g)].map((v) => v[1]) }));
    assert.ok(models.length >= 8, `found ${models.length} models in models.kt`);
    const rules = fs.readFileSync(path.join(ROOT, 'mobile/app/proguard-rules.pro'), 'utf8').replace(/#.*$/gm, '');
    const kept = [...rules.matchAll(/^-keep class ink\.etech\.gametracker\.(\w+) \{ \*; \}$/gm)].map((m) => m[1]).sort();
    assert.deepStrictEqual(kept, models.map((m) => m.name).sort(), 'proguard-rules.pro does not keep exactly the models.kt classes');
    const pairs = String(wf.env.R8_KEPT_FIELDS || '').trim().split(/\s+/).map((p) => p.split(':'));
    assert.deepStrictEqual(pairs.map((p) => p[0]).sort(), models.map((m) => m.name).sort(),
      'R8_KEPT_FIELDS does not name one field of every models.kt class');
    for (const [cls, fld] of pairs) {
      assert.ok(models.find((m) => m.name === cls).fields.includes(fld), `R8_KEPT_FIELDS: ${cls} has no field ${fld}`);
    }
    assert.ok(/-keep interface ink\.etech\.gametracker\.GameTrackerApi \{ \*; \}/.test(rules), 'the Retrofit interface is not kept');
    const step = wf.jobs.android.steps.map(stepRun).find((r) => /dexdump/.test(r)) || '';
    assert.ok(/for pair in \$\{R8_KEPT_FIELDS\}/.test(step) && /-e R8_KEPT_FIELDS/.test(step), 'android.yml no longer checks the built dex');
  });

  // MOB-27: users read `Login failed: {"error":...}` and `Error: Unable to resolve host ...`, and
  // a 15-minute lockout read like a wrong password. Fixed text only, from ErrorText.
  check('Android: no server body or exception text reaches the user (MOB-27)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of files) {
      code(f).split('\n').forEach((line, i) => {
        if (/\bLog\.[ewidv]\(/.test(line)) return;   // logcat may name the exception
        assert.ok(!/\$\{e\.(message|localizedMessage)\}|\be\.localizedMessage\b|errorBody\(\)/.test(line),
          `${f}:${i + 1} shows exception text or a server body to the user`);
      });
    }
    const login = code('LoginActivity.kt');
    assert.ok(/ErrorText\.signIn\(response\.code\(\), response\.headers\(\)\["Retry-After"\]\)/.test(login),
      'sign-in failures are not mapped by status (a lockout would read as a wrong password)');
  });

  // MOB-23: every debug build and test run used to log in to production with real accounts.
  check('Android: the server comes from the build type; release is production, fixed (MOB-23)', () => {
    // Whole-line comments only: a trailing-comment strip would eat the "https://" in a string.
    const gradle = fs.readFileSync(path.join(ROOT, 'mobile/app/build.gradle.kts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(/val productionApiBase = "https:\/\/gametracker\.etech\.ink\/api\/"/.test(gradle), 'the production API base moved');
    const release = gradle.slice(gradle.indexOf('release {'), gradle.indexOf('release {') + 500);
    assert.ok(/buildConfigField\("String", "API_BASE", apiBaseField\(productionApiBase\)\)/.test(release),
      'the release build does not use the fixed production API base');
    assert.ok(!/findProperty/.test(release), 'a Gradle property can change the RELEASE server');
    assert.ok(/require\(Regex\("\^https:\/\//.test(gradle), 'the API base is not required to be https');
    assert.ok(/BASE_URL = BuildConfig\.API_BASE/.test(code('ApiClient.kt')), 'ApiClient hard-codes its server again');
    for (const f of ['ApiClient.kt', 'MobileTokenApi.kt', 'LoginActivity.kt']) {
      // The RAW file: code() strips from "//" on, which is the middle of every URL.
      const raw = fs.readFileSync(path.join(APP, 'java/ink/etech/gametracker', f), 'utf8');
      assert.ok(!/"https?:\/\/[^"]*\/api/.test(raw), `${f} hard-codes an API URL`);
    }
  });

  // MOB-22: code that could not run, re-read by every reviewer (and fixed twice for MOB-3).
  check('Android: the dead Compose theme, toolbar menu and callback stay deleted (MOB-22)', () => {
    const J = path.join(APP, 'java/ink/etech/gametracker');
    assert.ok(!fs.existsSync(path.join(J, 'ui')), 'the unused Compose theme (ui/theme) is back');
    assert.ok(!fs.existsSync(path.join(APP, 'res/menu/main_menu.xml')), 'the unreachable toolbar menu is back');
    for (const f of ['MainActivity.kt', 'fragments/GameDetailsFragment.kt']) {
      assert.ok(!/GameDetailsCallback|refreshCurrentFragment|setupToolbar/.test(code(f)), `${f} brings back a dead path`);
    }
    for (const f of ['GameDetailsActivity.kt', 'GameSearchActivity.kt', 'MyLibraryActivity.kt']) {
      assert.ok(!fs.existsSync(path.join(J, f)), `${f}, never in the manifest, is back`);
    }
  });

  // MOB-19: every screen fetched the whole library in onViewCreated AND onResume, and a tab tap
  // built a new fragment. One cached copy, behind the session; tabs shown and hidden.
  check('Android: one library copy, one credential reader, tabs kept (MOB-19)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of files) {
      const src = code(f);
      if (f !== 'LibraryRepository.kt' && f !== 'GameTrackerApi.kt') {
        assert.ok(!/\.getLibrary\(/.test(src), `${f} fetches the library itself instead of through LibraryRepository`);
      }
      if (f !== 'SessionStore.kt') {
        assert.ok(!/getSharedPreferences\("auth"/.test(src), `${f} reads the "auth" preferences itself instead of through Session`);
        assert.ok(!/getString\("(?:username|token|display_name)"/.test(src), `${f} reads a session key directly`);
      }
      if (f.startsWith('fragments/')) {
        assert.ok(!/\.replace\(R\.id\.fragment_container/.test(src), `${f} replaces the tab instead of MainActivity.openDetails`);
      }
    }
    assert.ok(/LibraryWriteInterceptor \{ LibraryRepository\.invalidate\(\) \}/.test(code('ApiClient.kt')), 'writes no longer invalidate the library copy');
    const main = code('MainActivity.kt');
    assert.ok(/tx\.hide\(it\)/.test(main) && /tx\.show\(target\)/.test(main), 'tabs are no longer shown and hidden');
    assert.ok((main.match(/\.replace\(R\.id\.fragment_container/g) || []).length <= 2, 'MainActivity replaces fragments outside its last-resort path');
    for (const f of ['HomeFragment.kt', 'LibraryFragment.kt', 'InsightsFragment.kt']) {
      const src = code('fragments/' + f);
      assert.ok(/if \(!isHidden\) loadLibrary\(\)/.test(src) && /override fun onHiddenChanged/.test(src),
        `${f} does not reload on being shown, or reloads while hidden`);
    }
    for (const f of ['SignOut.kt', 'MainActivity.kt']) assert.ok(/LibraryRepository\.clear\(\)/.test(code(f)), `${f} leaves the library in memory at sign-out`);
  });

  // MOB-16: Details offered Remove, Refresh and status chips (which silently ADDED the game)
  // for search results not in the library, and Remove had no confirmation and no undo.
  check('Android: Details offers library actions only for library games, and Remove asks first (MOB-16)', () => {
    const d = code('fragments/GameDetailsFragment.kt');
    assert.ok(/fun newInstance\(game: Game, inLibrary: Boolean = true\)/.test(d), 'Details no longer knows whether the game is in the library');
    assert.ok(/btnRemoveFromLibrary\.setOnClickListener \{ confirmRemove\(\) \}/.test(d), 'Remove no longer asks for confirmation');
    for (const v of ['cardStatus', 'cardRating', 'cardNotes', 'btnRefreshMetadata', 'btnRemoveFromLibrary']) {
      assert.ok(new RegExp(`${v}\\.visibility = library`).test(d), `${v} is shown for a game that is not in the library`);
    }
    assert.ok(/inLibrary = false\)/.test(code('fragments/SearchFragment.kt')), 'Search opens Details for a non-library game as if it were owned');
  });

  check('Android: no statistic is invented from a game id (MOB-11)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of files) {
      const src = code(f);
      assert.ok(!/stableHash|GameExtras\.(hours|genre|progress)\b/.test(src), `${f} derives a value from a hash of the game id`);
    }
    assert.ok(!/\bfun (hours|genre|progress)\s*\(/.test(code('GameExtras.kt')), 'GameExtras still offers an invented statistic');
  });

  // MOB-6: the token was plaintext in SharedPreferences and the fingerprint only gated a
  // startActivity call. Each of these, broken, still "works" for every user.
  check('Android: the session token is never stored in the clear, and the fingerprint decrypts it (MOB-6)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    assert.ok(files.length > 20, `found ${files.length} Kotlin files -- the scan is broken`);
    let encryptInits = 0;
    for (const f of files) {
      const src = code(f);
      encryptInits += (src.match(/\bENCRYPT_MODE\b/g) || []).length;
      // The old key may be read only by SessionStore, and only to delete it.
      if (f !== 'SessionStore.kt') {
        assert.ok(!/(get|put)String\(\s*"token"/.test(src), `${f} reads or writes the plaintext "token" preference`);
        assert.ok(!/KEY_LEGACY_TOKEN/.test(src), `${f} touches the legacy plaintext token`);
      }
      // A prompt without a CryptoObject decides nothing. Only CryptoPrompt may create one.
      if (f !== 'FingerprintUnlock.kt') {
        assert.ok(!/\bBiometricPrompt\s*\(|import androidx\.biometric\.BiometricPrompt\b/.test(src),
          `${f} builds its own BiometricPrompt instead of using CryptoPrompt`);
      }
      assert.ok(!/EncryptedSharedPreferences|security\.crypto/.test(src), `${f} uses EncryptedSharedPreferences (deprecated, not biometric-bound)`);
    }
    const store = code('SessionStore.kt');
    const save = store.slice(store.indexOf('fun save('), store.indexOf('fun storeSealed('));
    assert.ok(save.length > 0 && !/KEY_LEGACY_TOKEN|\btoken\s+to\b/.test(save.replace('KEY_USERNAME to username', '')),
      'SessionStore.save writes the token to the preferences');
    const fu = code('FingerprintUnlock.kt');
    const calls = [...fu.matchAll(/\bprompt\.authenticate\(([^\n]*)/g)].map((m) => m[1]);
    assert.ok(calls.some((c) => /^info, BiometricPrompt\.CryptoObject\(cipher\)\)/.test(c)),
      'CryptoPrompt no longer passes a CryptoObject to BiometricPrompt.authenticate');
    assert.ok(/result\.cryptoObject\?\.cipher/.test(fu), 'a successful prompt is accepted without its cipher');
    const vault = code('TokenVault.kt');
    for (const [re, why] of [
      [/setUserAuthenticationRequired\(true\)/, 'the key does not require user authentication'],
      [/setInvalidatedByBiometricEnrollment\(true\)/, 'a newly enrolled fingerprint would not invalidate the key'],
      [/setUserAuthenticationParameters\(0,\s*KeyProperties\.AUTH_BIOMETRIC_STRONG\)/, 'the key is not per-use, strong-biometric only'],
      [/setUserAuthenticationValidityDurationSeconds\(-1\)/, 'below API 30 the key is not per-use'],
      [/BLOCK_MODE_GCM/, 'the key is not AES-GCM'],
      [/KeyPermanentlyInvalidatedException/, 'an invalidated key is not handled'],
    ]) assert.ok(re.test(vault), `TokenVault: ${why}`);
    // The nosemgrep on gcm-detection rests on this: every seal gets a Keystore-generated IV.
    const initEncrypt = vault.match(/private fun initEncrypt\(\)[\s\S]*?\n {4}\}/);
    assert.ok(initEncrypt, 'TokenVault.initEncrypt not found');
    // ONE encrypt path in the whole app, and it is exactly the reviewed two-argument init:
    // a third argument (any ParameterSpec, AlgorithmParameters, a variable) would be our IV.
    assert.strictEqual(encryptInits, 1,
      `ENCRYPT_MODE appears ${encryptInits} times in the app: every encrypt path must be TokenVault.initEncrypt`);
    assert.ok(/\n\s*cipher\.init\(Cipher\.ENCRYPT_MODE, existingKey\(\) \?: generateKey\(strongBox = Build\.VERSION\.SDK_INT >= 28\)\)\n/.test(initEncrypt[0]),
      'TokenVault.initEncrypt is not the reviewed `cipher.init(ENCRYPT_MODE, key)`: GCM IV uniqueness may no longer be the Keystore\'s');
    assert.ok(!/ParameterSpec|SecureRandom/.test(initEncrypt[0]),
      'TokenVault.initEncrypt supplies its own IV: GCM IV uniqueness is no longer the Keystore\'s');
    assert.ok(!/setRandomizedEncryptionRequired/.test(vault),
      'TokenVault changes randomized encryption: the Keystore would then accept a reused IV');
    const gradle = fs.readFileSync(path.join(ROOT, 'mobile/app/build.gradle.kts'), 'utf8');
    assert.ok(!/security-crypto/.test(gradle), 'the app depends on androidx.security:security-crypto');
  });

  check('Android: a removal is never sent from a snackbar callback (MOB-12)', () => {
    const lib = code('fragments/LibraryFragment.kt');
    assert.ok(!/onDismissed/.test(lib), 'LibraryFragment sends the removal from Snackbar.onDismissed again: it outlives the view');
    assert.ok(/PendingRemovals\.app\.schedule\(/.test(lib) && /PendingRemovals\.app\.undo\(/.test(lib),
      'the library removal does not go through PendingRemovals');
    assert.ok(/pendingIds\(username\)/.test(lib), 'a reload no longer hides THIS user\'s removals still inside their undo window');
  });

  // MOB-8: cleartext was allowed on API 24-27, and server-supplied cover URLs went to Glide
  // unchecked. No pinning, on purpose (see the ROADMAP entry).
  check('Android: no cleartext, user CAs in debug only, and every image URL is https-checked (MOB-8)', () => {
    assert.ok(/android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest),
      'the manifest no longer applies network_security_config.xml');
    const nsc = fs.readFileSync(path.join(APP, 'res/xml/network_security_config.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(/<base-config\s+cleartextTrafficPermitted="false"\s*>/.test(nsc), 'the base config permits cleartext');
    assert.ok(!/cleartextTrafficPermitted="true"/.test(nsc), 'some domain is allowed cleartext');
    const outsideDebug = nsc.replace(/<debug-overrides>[\s\S]*?<\/debug-overrides>/g, '');
    assert.ok(!/src="user"/.test(outsideDebug), 'a release build trusts user-installed CAs');
    assert.ok(!/<pin-set/.test(nsc), 'certificate pinning was added: see ROADMAP MOB-8 before doing that');
    assert.ok(!/usesCleartextTraffic="true"/.test(manifest), 'the manifest re-enables cleartext');
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.join(d, e.name));
      }
    })(dir);
    let loads = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // Glide's .load(url). LibraryRepository.load(context) is not a URL (MOB-19).
      for (const m of src.matchAll(/(?<!LibraryRepository)\.load\(([^)]*)\)/g)) {
        loads++;
        const arg = m[1].trim();
        // The argument is either the check itself or a local assigned from it.
        const viaLocal = /^\w+$/.test(arg) && new RegExp(`val ${arg}\\s*=\\s*SafeUrl\\.https\\(`).test(src);
        assert.ok(/^SafeUrl\.https\(/.test(arg) || viaLocal,
          `${path.relative(dir, f)} loads ${arg} without SafeUrl.https: a server-supplied URL reaches the network unchecked`);
      }
    }
    assert.ok(loads >= 3, `found ${loads} Glide loads -- the scan is broken`);
  });

  // MOB-17: unscoped coroutines outlived their screen, and fragment-scoped ones updated
  // views that had been destroyed while the fragment sat on the back stack.
  check('Android: coroutines are scoped to what they touch (MOB-17)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const all = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) all.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of all) {
      const src = code(f).replace(/\/\/.*$/gm, '');
      // PendingRemovals is the one deliberate process-lifetime scope (MOB-12).
      if (f !== 'PendingRemovals.kt') {
        assert.ok(!/\bCoroutineScope\s*\(|\bGlobalScope\b/.test(src), `${f} launches an unscoped coroutine`);
      }
    }
    for (const f of all.filter((x) => x.startsWith('fragments/'))) {
      // Raw text: the marker IS a comment, and code() strips comments (and, with block
      // comments, lines -- which would also make the reported line numbers wrong).
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/(?<![\w.])lifecycleScope\.launch/.test(line.replace(/\/\/.*$/, ''))) return;
        const marked = lines.slice(Math.max(0, i - 3), i).some((l) => /\/\/ outlives the view:/.test(l));
        assert.ok(marked, `${f}:${i + 1} uses the fragment's lifecycleScope: use viewLifecycleOwner.lifecycleScope, `
          + 'or mark work that must outlive the view with "// outlives the view: <why>"');
      });
    }
    const search = code('fragments/SearchFragment.kt');
    assert.ok(/override fun onDestroyView\(\)\s*\{[^}]*searchHandler\.removeCallbacks\(searchRunnable\)/.test(search),
      'SearchFragment no longer cancels the pending debounce in onDestroyView');
  });

  // MOB-9: the phone's 30-day library token. Every rule here is a condition of the CISO
  // design review, so a change to one of them is a change to that review.
  check('Android: the 30-day token is library-only, fixed-expiry, sealed or revoked, and revokes only itself (MOB-9)', () => {
    const tok = code('MobileToken.kt');
    assert.ok(/const val LIFETIME_DAYS = 30L\b/.test(tok), 'the token lifetime is no longer the reviewed 30 days');
    assert.ok(/const val SCOPE = "library"/.test(tok) && /scopes = listOf\(SCOPE\)/.test(tok),
      'the minted token asks for something other than exactly ["library"]');
    assert.ok(/expiresAt = expiry\(nowMillis\)\.second/.test(tok), 'the mint body no longer carries the fixed expiry');
    assert.ok(!/"admin"/.test(tok), 'MobileToken mentions the admin scope');
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const all = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) all.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of all) {
      const src = code(f);
      if (f !== 'MobileToken.kt' && f !== 'models.kt') {
        assert.ok(!/\bCreateTokenRequest\s*\(/.test(src), `${f} builds a token request itself: only MobileToken.request may`);
      }
      if (f !== 'MobileTokenApi.kt') {
        assert.ok(!/\.(createToken|revokeToken)\s*\(/.test(src), `${f} calls the token routes directly: only MobileTokenApi may`);
      }
      if (f !== 'LoginActivity.kt' && f !== 'SessionStore.kt') {
        assert.ok(!/\badoptPat\s*\(/.test(src), `${f} adopts a token: only the password sign-in may`);
      }
      // Revocation presents a credential and an id. The id is always this phone's own:
      // the session's current PAT, the one recorded for revocation, or the one just minted.
      for (const m of src.matchAll(/MobileTokenApi\.revoke\(([^,]+),\s*([^,)]+)/g)) {
        assert.ok(/^(id|old|minted\.id|it\.id)$/.test(m[2].trim()), `${f} revokes token ${m[2].trim()}: only this phone's own id`);
      }
    }
    const signOut = code('SignOut.kt');
    assert.ok(/val id = session\.patId/.test(signOut) && /val bearer = session\.bearer\(\)/.test(signOut)
      && /MobileTokenApi\.revoke\(bearer, id, self = true\)/.test(signOut), 'sign-out no longer revokes the PAT with itself');
    assert.ok((code('LoginActivity.kt').match(/self = true/g) || []).length === 0,
      'a revoke presenting the JWT treats 401 as gone: only a token revoking ITSELF may');
    // Turning fingerprint unlock off drops the sealed copy, so the sign-out after it must be
    // impossible to cancel: a Cancel there left the token live and unsealed (CISO + UI/UX, PR #14).
    assert.ok(/FingerprintUnlock\.disable\(activity\)\s*start\(activity, committed = true\)/.test(signOut),
      'turning fingerprint unlock off no longer starts a COMMITTED sign-out');
    assert.ok(/if \(inFlight && !committed\) return/.test(signOut), 'a committed sign-out can return silently');
    assert.ok((signOut.match(/if \(committed\) dialog\.setCancelable\(false\) else dialog\.set(Neutral|Negative)Button\("Cancel", null\)/g) || []).length === 2,
      'a dialog after a committed sign-out offers Cancel (or can be dismissed)');
    assert.ok(!/\.set(Neutral|Negative)Button\("Cancel", null\)\s*\.show\(\)/.test(signOut.replace(/fun confirmFingerprintOff[\s\S]*?return true/, '')),
      'a sign-out dialog shows an unconditional Cancel');
    const login = code('LoginActivity.kt');
    assert.ok(/session\.pendingRevokeId\(\)\?\.let \{ old ->[\s\S]*?MobileTokenApi\.revoke\("Bearer \$jwt", old\)/.test(login),
      'a token an earlier sign-in left behind is no longer revoked with the fresh JWT');
    assert.ok(/if \(wantsPat && earlierGone\)/.test(login), 'a new token is minted while an earlier one is still unrevoked: its id would be lost');
    assert.ok(/\?\.also \{ session\.trackPatId\(it\.id\) \}/.test(login) && /withContext\(NonCancellable \+ Dispatchers\.IO\)/.test(login),
      'a minted id is no longer recorded at once, in a step that cannot be cancelled');
    assert.ok(/MobileTokenApi\.revoke\("Bearer \$jwt", minted\.id\)/.test(login),
      'a token the prompt did not seal is no longer revoked (it must never stay unsealed)');
    assert.ok(/FingerprintUnlock\.isOn\(this\) && FingerprintUnlock\.canUse\(this\)/.test(login),
      'a token is minted without fingerprint unlock to seal it');
    assert.ok(/etPassword\.text\.clear\(\)/.test(login), 'the password field is no longer cleared after sign-in');
    const api = code('GameTrackerApi.kt');
    assert.ok(!/@GET\("user\/me\/tokens"\)/.test(api), 'the app lists tokens');
    const mintApi = code('MobileTokenApi.kt');
    assert.ok(!/errorBody|\.message\(\)/.test(mintApi), 'MobileTokenApi reads the server\'s error text: the UI must say fixed things');
  });

  // MOB-13: statuses were sent capitalised, "Unreleased" was offered as a choice the server
  // overrides, "" was sent for an unknown date, and the server's answer was thrown away.
  check('Android: status writes go through GameStatus, never offer Unreleased, and read the answer (MOB-13)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const all = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) all.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    for (const f of all.filter((x) => x !== 'GameStatus.kt' && x !== 'models.kt')) {
      assert.ok(!/\bGameUpdateRequest\s*\(/.test(code(f)), `${f} builds an add/update body itself: use GameStatus.request`);
    }
    const gs = code('GameStatus.kt');
    assert.ok(/releaseDate = game\.release\.ifBlank \{ null \}/.test(gs), 'an unknown release date is no longer sent as null');
    assert.ok(/val PICKABLE = listOf\(WISHLIST, BACKLOG, PLAYING, DONE\)/.test(gs), 'the pickable statuses changed: Unreleased is never a choice');
    assert.ok(/suspend fun addOrUpdateGame\([\s\S]*?\): Response<GameUpsertResult>/.test(code('GameTrackerApi.kt')),
      'addOrUpdateGame discards the server\'s answer again');
    const sheet = fs.readFileSync(path.join(APP, 'res/layout/bottom_sheet_status.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/itemUnreleased|"Unreleased"/.test(sheet), 'the status sheet offers Unreleased as a choice');
    for (const f of ['fragments/LibraryFragment.kt', 'fragments/GameDetailsFragment.kt']) {
      assert.ok(/GameStatus\.stored\(/.test(code(f)), `${f} no longer shows the status the server stored`);
    }
  });

  // MOB-14: a drag sent one unchecked call per step moved, computed on the search-filtered
  // list, and cards showed the stored number while Home showed the position.
  check('Android: a backlog drag is ONE whole-order call, never while searching, and positions are real (MOB-14)', () => {
    const api = code('GameTrackerApi.kt');
    assert.ok(/@PUT\("user\/\{username\}\/backlog-reorder"\)/.test(api), 'the app no longer sends the whole order in one call');
    assert.ok(!/backlog-order"/.test(api), 'the app calls the per-step backlog-order route again');
    const lib = code('fragments/LibraryFragment.kt');
    assert.ok(/BacklogOrder\.canDrag\(currentFilter, searchQuery\)/.test(lib), 'drag is allowed while a search narrows the backlog');
    assert.ok(!/repeat\(/.test(lib), 'a drag repeats a call per step again');
    assert.ok(!/game\.backlog_order\}/.test(code('GameAdapter.kt')), 'cards show the stored backlog number again, not the position');
  });

  // MOB-15: every failure rendered as "No games found", and a slow earlier search could land
  // after a later one and overwrite it (the web's FE-2).
  check('Android: a failed search says why, and only the latest search can render (MOB-15)', () => {
    const search = code('fragments/SearchFragment.kt');
    assert.ok(/SearchResults\.of\(response\.code\(\), response\.body\(\), response\.headers\(\)\[SearchResults\.DEGRADED_HEADER\]\)/.test(search),
      'the search no longer classifies the answer (status, body, degraded header)');
    assert.ok(/searchJob\?\.cancel\(\)\s*searchJob = viewLifecycleOwner\.lifecycleScope\.launch/.test(search),
      'a new search no longer cancels the one in flight');
    assert.ok(/query != currentQuery\) return@launch/.test(search), 'an answer for an older query can render again');
    assert.ok(!/else emptyList\(\)/.test(search), 'a failed search becomes an empty list again');
  });

  // fragments/ is a subpackage: a class from the app's root package needs an import there.
  // Nothing local compiles the app (no SDK), and a missing one failed CI twice (PR #12, #13).
  check('Android: fragments import every root-package class they use', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const roots = new Set();
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.kt'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^(?:(?:data|sealed|abstract|open|enum|private|internal)\s+)*(?:class|object|interface)\s+([A-Z]\w*)/gm)) {
        if (!/^\s*private\b/.test(m[0])) roots.add(m[1]);
      }
    }
    assert.ok(roots.has('UserData') && roots.has('Session'), `root-package scan found ${roots.size} classes -- it is broken`);
    for (const f of fs.readdirSync(path.join(dir, 'fragments')).filter((n) => n.endsWith('.kt'))) {
      const src = fs.readFileSync(path.join(dir, 'fragments', f), 'utf8');
      const body = src.replace(/^import .*$/gm, '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const declared = new Set([...body.matchAll(/\b(?:class|object|interface)\s+([A-Z]\w*)/g)].map((m) => m[1]));
      for (const name of roots) {
        if (declared.has(name) || !new RegExp(`(?<![\\w.])${name}\\b`).test(body)) continue;
        const imported = new RegExp(`^import ink\\.etech\\.gametracker\\.(${name}|\\*)$`, 'm').test(src);
        const qualified = new RegExp(`ink\\.etech\\.gametracker\\.${name}\\b`).test(body);
        assert.ok(imported || qualified, `fragments/${f} uses ${name} without importing ink.etech.gametracker.${name}`);
      }
    }
  });

  // MOB-7: notes, ratings, search history and the calendar map were device-wide, so the next
  // account on a phone saw them, and its sync deleted the first account's calendar events.
  check('Android: per-user local data lives only in UserData, and the calendar map is never backed up (MOB-7)', () => {
    const dir = path.join(APP, 'java/ink/etech/gametracker');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.kt')) files.push(path.relative(dir, path.join(d, e.name)));
      }
    })(dir);
    assert.ok(files.length > 20, `found ${files.length} Kotlin files -- the scan is broken`);
    for (const f of files.filter((x) => x !== 'UserData.kt')) {
      const src = code(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/"(game_extras|calendar_events|calendar)"/.test(src), `${f} opens a per-user store directly instead of through UserData`);
      assert.ok(!/"search_history"|"(note|rating)_/.test(src), `${f} reads or writes notes, ratings or search history outside UserData`);
      assert.ok(!/"(calendar_id|calendar_sync_enabled|event_map)"/.test(src), `${f} keeps calendar settings outside UserData`);
    }
    // Sign-out goes through SignOut, which asks about the calendar (owner's decision). The
    // toolbar menu that had a second path was unreachable and is gone (MOB-22).
    assert.ok(!/fun logout\(/.test(code('MainActivity.kt')), 'MainActivity has its own sign-out again');
    assert.ok(/btnLogout\)\.setOnClickListener \{ SignOut\.start\(requireActivity\(\)\) \}/.test(code('fragments/ProfileFragment.kt')),
      'Profile\'s sign-out bypasses SignOut');
    const calExclude = /<exclude\s+domain="sharedpref"\s+path="calendar\.xml"\s*\/>/;
    const noComments = (f) => fs.readFileSync(path.join(APP, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(calExclude.test(noComments('res/xml/backup_rules.xml')),
      'backup_rules.xml backs up the calendar map: its event ids belong to this phone');
    const extraction = fs.readFileSync(path.join(APP, 'res/xml/data_extraction_rules.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const m = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(extraction);
      assert.ok(m && calExclude.test(m[1]), `data_extraction_rules.xml <${section}> does not exclude calendar.xml`);
    }
    assert.ok(/CALENDAR_FILE = "calendar"/.test(code('UserData.kt')), 'UserData.CALENDAR_FILE is not the file the backup rules exclude');
  });
}

// The backend image is `COPY . .`; the Android app has no business in it.
check('.dockerignore keeps the Android app out of the backend image', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(lines.some((l) => /^\/?mobile\/?(\*\*)?$/.test(l)), '.dockerignore does not exclude mobile/');
});

// The gap that let the original bug through: CI ran Node 20 while the image ran 18, so
// every suite passed on an interpreter production never used. Keeping them equal is not
// cosmetic — it is what makes a green `npm test` mean anything about the deployed thing.
check('CI runs the same Node major the images do', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8');
  const ci = /node-version:\s*'?"?(\d+)/.exec(wf);
  assert.ok(ci, 'no node-version found in the workflow');

  for (const img of IMAGES) {
    const from = /^FROM\s+node:(\d+)/m.exec(fs.readFileSync(path.join(ROOT, img.dockerfile), 'utf8'));
    assert.strictEqual(ci[1], from[1],
      `CI installs Node ${ci[1]} but ${img.dockerfile} ships node:${from[1]}. The suites `
      + 'would run on an interpreter production does not use, which is exactly how the '
      + 'MCP crypto failure reached production with every job green.');
  }
});

// Every environment variable the backend READS must reach the backend CONTAINER.
//
// A variable the code reads but compose does not pass is worse than a missing one: an
// operator sets it in .env, nothing complains, and the default quietly stays in force.
// That shipped: TRUST_PROXY — which the README calls MANDATORY once the backend port is
// closed — was never in the backend's `environment:` block, so the hardened topology
// ran at trust-proxy 1, every login shared the frontend container's IP, and five bad
// passwords from anyone locked out every user. CORS_ORIGINS, THEGAMESDB_API_KEY,
// IGDB_CLIENT_SECRET and STEAM_REGION were silently ignored the same way.
//
// Static because it has to be: inside the container the variable is simply absent, and
// absent is exactly what "unset, use the default" looks like at runtime.
console.log('the environment the backend reads reaches its container:');
{
  const yaml = require('js-yaml');
  const SOURCES = ['index.js', 'db.js', 'settings-store.js', 'directory.js', 'ldap-helpers.js',
    'schema-migrate.js', 'user-rules.js', 'igdb-helpers.js',
    ...fs.readdirSync(path.join(ROOT, 'services')).filter((f) => f.endsWith('.js')).map((f) => `services/${f}`)];
  // Deliberately NOT passed, each with its reason. Adding a name here is a decision,
  // not a way to turn the check green.
  const NOT_PASSED = {
    // Pool tuning with sane defaults in db.js; exposed only if someone needs to tune.
    PG_POOL_MAX: 'both', PG_CONNECT_TIMEOUT_MS: 'both', PG_IDLE_TIMEOUT_MS: 'both', PG_STATEMENT_TIMEOUT_MS: 'both',
    // Only read on a FRESH database. Production does not keep it in the container's
    // environment (where `docker inspect` would show it for the life of the container);
    // the random password printed once at first boot is the Docker path. The smoke
    // stack sets a throwaway one so CI can log in.
    ROOT_PASSWORD: 'docker-compose.yaml',
    // UP-24. Set by the operator in the SAME change that swaps the single-file mount for a
    // directory mount (OPERATOR_RUNBOOK.md). Passed on its own it would point at a
    // directory that is not mounted, which the startup check refuses; so it is never
    // defaulted in here.
    SETTINGS_DIR: 'both',
  };

  const read = new Set();
  for (const f of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of [/process\.env\.([A-Z][A-Z0-9_]*)/g, /\benv\.([A-Z][A-Z0-9_]*)/g,
      /(?:resolveApiKey|apiKeyStatus)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g]) {
      for (const m of src.matchAll(re)) read.add(m[1]);
    }
  }

  const passed = (file) => {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const env = doc.services.backend.environment || [];
    return new Set((Array.isArray(env) ? env : Object.keys(env)).map((e) => String(e).split('=')[0]));
  };

  check('the scan actually finds the variables it is guarding', () => {
    // Guards the guard: a regex that matches nothing would pass every file below.
    for (const known of ['JWT_SECRET', 'TRUST_PROXY', 'CORS_ORIGINS', 'THEGAMESDB_API_KEY', 'STEAM_REGION']) {
      assert.ok(read.has(known), `the source scan no longer finds ${known}`);
    }
  });

  for (const file of ['docker-compose.yaml', 'docker-compose.test.yml']) {
    check(`${file}: every variable the backend reads is passed to it`, () => {
      const env = passed(file);
      const missing = [...read].filter((v) => !env.has(v)
        && NOT_PASSED[v] !== 'both' && NOT_PASSED[v] !== file).sort();
      assert.deepStrictEqual(missing, [],
        `${file} does not pass ${missing.join(', ')} to the backend, so setting it in .env does `
        + 'nothing. Add it to services.backend.environment, or record in NOT_PASSED why not.');
    });
  }
}

// ...and every variable docker-compose.yaml interpolates must reach it THROUGH CI.
//
// The deploy job runs compose from a fresh checkout, so the host's `.env` is never
// read: a variable the job does not carry silently takes compose's default on every
// push to main. P0-3 first shipped with the check above only, and the CISO review
// rejected it — TRUST_PROXY=2 in `.env` would still have redeployed at 1. BACKEND_BIND
// had been missing from the job the same way since the hardened topology was written.
console.log('the deploy job carries every variable production compose reads:');
{
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yaml'), 'utf8');
  // Fixed in production on purpose, each with its reason.
  const FIXED = {
    // The deploy health-checks localhost:3000 and nginx proxies backend:3000.
    BACKEND_PORT: 'the deploy health check is hard-wired to :3000',
    MCP_PORT: 'the deploy prints `compose port mcp` against the default',
    // Changing either after the first boot points the backend at a database that
    // does not exist; they are not deploy-time settings.
    POSTGRES_DB: 'fixed by the existing data volume',
    POSTGRES_USER: 'fixed by the existing data volume',
  };
  const referenced = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  const deploy = wf.jobs.deploy;
  const jobEnv = Object.keys(deploy.env || {});
  const composeSteps = deploy.steps.filter((st) => /docker compose -f docker-compose\.yaml/.test(st.run || ''));

  check('the scan finds the compose steps and the variables it guards', () => {
    assert.ok(composeSteps.length >= 2, 'no deploy steps running docker-compose.yaml were found');
    for (const known of ['TRUST_PROXY', 'BACKEND_BIND', 'JWT_SECRET']) assert.ok(referenced.has(known), known);
  });
  for (const st of composeSteps) {
    check(`deploy step "${st.name}" carries every variable docker-compose.yaml reads`, () => {
      const have = new Set([...jobEnv, ...Object.keys(st.env || {})]);
      const missing = [...referenced].filter((v) => !have.has(v) && !FIXED[v]).sort();
      assert.deepStrictEqual(missing, [],
        `the deploy step "${st.name}" does not carry ${missing.join(', ')}, so production takes `
        + "compose's default whatever the host's .env says. Add it to the deploy job's env "
        + '(non-secret, job level) or the step env (secret), or record in FIXED why not.');
    });
  }
}

// ONLY the deploy job may write `:latest`, and it must be able to roll back (P0-5, SEC-6).
//
// A main push used to be built straight to `:latest` before Trivy and the smoke test ran,
// so a build that failed a HIGH CVE skipped deploy with `:latest` already pointing at it --
// and the next restart of this host (it IS production) ran the rejected image. Every
// build now gets a tag nothing resolves by default, and deploy promotes it after every
// gate. Deploy also used to stop production before starting the new stack, with no way
// back: a bad image was an outage until someone intervened.
console.log('images reach :latest only through deploy, which can roll back:');
{
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  // Script text with shell comments removed, so a comment ABOUT `latest` is not a use.
  const script = (st) => String(st.run || '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // ONE matcher, used by the check and by its self-test, so narrowing it narrows both.
  const latestIn = (job) => /[^\s"']*:latest\b/.exec(JSON.stringify(
    { ...job, steps: (job.steps || []).map((st) => ({ ...st, run: script(st) })) }));

  check('no job except deploy mentions :latest at all', () => {
    // DELIBERATELY BLUNT. The first version matched `docker tag <arg>:latest` and
    // `-t <arg>:latest` only, and a CISO review showed it green on
    // `docker tag x:sha x:latest`, `docker image tag`, `--tag x:latest` — the likeliest
    // shape of the regression. Nothing outside deploy has a reason to name `:latest`,
    // so any mention anywhere in the job (run scripts minus shell comments, env,
    // `with:` inputs such as a build action's `tags`) fails.
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (id === 'deploy') continue;
      const hit = latestIn(job);
      assert.ok(!hit, `${id} mentions ${hit && hit[0]} -- only deploy may write :latest, after every gate has passed`);
    }
  });
  check('that check fails on the shapes it exists to catch', () => {
    // Guards the guard: prove the scan would have gone red, on a copy of build-images.
    for (const line of ['docker tag "${base}:sha" "${base}:latest"', 'docker image tag a:b a:latest',
      'docker build --tag x:latest .', 'docker build -t local/gametracker-backend:latest .']) {
      assert.ok(latestIn({ steps: [{ run: line }] }), `the scan misses: ${line}`);
    }
    assert.ok(latestIn({ steps: [{ uses: 'docker/build-push-action', with: { tags: 'x:latest' } }] }),
      'the scan misses a with.tags input');
    assert.ok(latestIn({ env: { IMAGE: 'local/x:latest' } }), 'the scan misses a job env');
    assert.ok(!latestIn({ steps: [{ run: '# a comment about :latest' }] }), 'a shell comment counts as a use');
  });
  check('build-images never produces the latest tag, on any event', () => {
    const st = wf.jobs['build-images'].steps.find((x) => x.id === 'image-tags');
    assert.ok(st, 'build-images has no image-tags step');
    assert.ok(!/\blatest\b/.test(script(st)), 'the build tag step can still produce `latest`');
  });
  check('deploy keeps a rollback target and restores it on failure', () => {
    const steps = wf.jobs.deploy.steps;
    const promote = steps.find((x) => x.id === 'promote');
    assert.ok(promote && /:previous/.test(script(promote)), 'deploy does not save the old :latest as :previous');
    const rollback = steps.find((x) => /failure\(\)/.test(String(x.if || '')) && /cancelled\(\)/.test(String(x.if || '')));
    assert.ok(rollback, 'deploy has no step that runs on failure AND on cancellation');
    // ORDER matters: the rollback must come after the step that can fail, and the
    // rollback target must be recorded before `latest` is moved -- otherwise a promote
    // that fails partway leaves nothing to roll back to.
    const idx = (st) => steps.indexOf(st);
    const health = steps.find((x) => /api\/health/.test(script(x)) && x !== rollback);
    assert.ok(health && idx(rollback) > idx(health), 'the rollback step runs before the health check');
    const p = script(promote);
    assert.ok(p.indexOf('has_previous=') >= 0 && p.indexOf('has_previous=') < p.lastIndexOf(':latest'),
      'promote moves :latest before recording the rollback target');
    assert.ok(/:previous"? "?\S*:latest/.test(script(rollback)) && /docker compose -f docker-compose\.yaml up/.test(script(rollback)),
      'the failure step does not restore :previous and bring the stack back up');
    assert.ok(!steps.some((x) => /docker compose -f docker-compose\.yaml down/.test(script(x))),
      'deploy stops production before starting the new stack -- every deploy is an outage again');
  });
  check('the cleanup job never removes latest or previous', () => {
    const text = wf.jobs['cleanup-pr-images'].steps.map(script).join('\n');
    assert.ok(/pr-\*\|sha-\*\)/.test(text), 'cleanup no longer restricts itself to pr-*/sha-* tags');
    assert.ok((wf.jobs['cleanup-pr-images'].needs || []).includes('deploy'),
      'cleanup can run before deploy has promoted the image it is untagging');
    // Without always() it never runs after a failed scan; without push it never removes
    // sha-<commit> tags. Either way the runner's disk fills with rejected images again.
    // A push run that did not deploy must KEEP its sha-* tags: "Re-run failed jobs"
    // does not rebuild, so removing them after a transient scan failure breaks the re-run.
    const step = wf.jobs['cleanup-pr-images'].steps.find((st) => /docker rmi/.test(script(st)));
    assert.ok(/needs\.deploy\.result/.test(JSON.stringify(step.env || {}))
      && /DEPLOY_RESULT.*!=\s*"success"/.test(script(step)),
      'cleanup removes a push run\'s images even when it never deployed');
    // The deploy-time sweep must filter on `:sha-` and nothing wider: a `grep -v latest`
    // or a bare `docker images <base>` would take :previous -- the rollback target.
    const sweep = script(step).split('\n').filter((l) => /docker images/.test(l));
    assert.ok(sweep.length > 0 && sweep.every((l) => /grep ':sha-'/.test(l)),
      'the cleanup sweep no longer restricts itself to :sha-* tags');
    const cond = String(wf.jobs['cleanup-pr-images'].if || '');
    assert.ok(/always\(\)/.test(cond) && /'push'/.test(cond), `cleanup no longer runs on every push run: ${cond}`);
  });
}

// SAST must run the PINNED Semgrep, never whatever is on PATH (ROADMAP SEC-3). It was
// `if ! command -v semgrep; then pip3 install semgrep; fi` -- on a persistent runner, a
// stale or stubbed binary earlier on PATH turned the gate green for ever.
console.log('the semgrep gate runs a pinned binary:');
{
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  const steps = wf.jobs.semgrep.steps;
  const text = (st) => String(st.run || '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('semgrep is installed at a pinned version, verified, into an isolated directory', () => {
    const install = steps.find((st) => /semgrep==\$\{SEMGREP_VERSION\}/.test(text(st)));
    assert.ok(install, 'no step installs semgrep==${SEMGREP_VERSION}');
    assert.match(String(install.env && install.env.SEMGREP_VERSION), /^\d+\.\d+\.\d+$/, 'SEMGREP_VERSION is not an exact version');
    // --target, not a venv: the runner has no ensurepip, and `python3 -m venv` failed.
    assert.ok(/--target "\$\{DIR\}\/lib"/.test(text(install)), 'semgrep is not installed into its own directory');
    assert.ok(!/python3 -m venv/.test(text(install)), 'a venv needs python3-venv, which the runner does not have');
    assert.ok(/PYTHONNOUSERSITE=1/.test(text(install)) && /\$\{DIR\}\/lib\/bin:/.test(text(install)),
      'the wrapper does not isolate the pinned tree (PYTHONNOUSERSITE, its own bin/ first on PATH)');
    assert.ok(/test "\$\("\$\{DIR\}\/semgrep" --version\)" = "\$\{SEMGREP_VERSION\}"/.test(text(install)),
      'the installed version is not verified');
  });
  check('the scan runs that binary by path, and nothing trusts `semgrep` on PATH', () => {
    const all = steps.map(text).join('\n');
    assert.ok(!/command -v semgrep/.test(all), 'a step decides from `command -v semgrep` again');
    assert.ok(/"\$\{SEMGREP_BIN[^}]*\}" scan/.test(all), 'the scan does not run "${SEMGREP_BIN}"');
    assert.ok(!/^\s*semgrep\s/m.test(all), 'a step runs a bare `semgrep` from PATH');
  });
}

// Every action is pinned to a commit SHA (ROADMAP SEC-4). A tag can be moved upstream,
// and this runner is the production host.
console.log('every GitHub Action is pinned to a commit:');
{
  const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8');
  check('no `uses:` in ANY workflow references a tag or branch', () => {
    let total = 0;
    for (const file of WORKFLOW_FILES) {
      const text = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
      const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
      total += uses.length;
      for (const [, ref, rest] of uses) {
        assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${ref} is not pinned to a commit SHA`);
        assert.match(rest, /#\s*v\d/, `${file}: ${ref} has no "# vX.Y.Z" comment saying which release it is`);
      }
    }
    assert.ok(total > 0, 'no uses: lines found -- the scan is broken');
  });
  check('the Semgrep rule that flags a mutable action tag is not excluded', () => {
    assert.ok(!/github-actions-mutable-action-tag/.test(raw), 'the mutable-action-tag rule is excluded again');
  });
}

// The secret scan must actually scan (SEC-5 review). On the runner, git refused the
// checkout ("dubious ownership"), gitleaks logged "failed to scan", then "no leaks
// found" and exited 0 -- the gate was green without reading a commit.
console.log('the secret scan scans, and fails closed when it cannot:');
{
  const yaml = require('js-yaml');
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8'));
  const step = wf.jobs['secret-scan'].steps.find((st) => /gitleaks detect/.test(st.run || ''));
  const toml = fs.readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');
  check('the scan step marks the checkout safe for git, for that step only', () => {
    assert.ok(step, 'no step runs gitleaks detect');
    // GIT_CONFIG_GLOBAL, NOT GIT_CONFIG_COUNT/-c: git < 2.38 ignores command-line scope
    // for safe.directory, and the runner has 2.34.1.
    assert.ok(/export GIT_CONFIG_GLOBAL=/.test(step.run) && /--add safe\.directory/.test(step.run),
      'without it git refuses the checkout and gitleaks scans nothing');
    assert.ok(!/GIT_CONFIG_(COUNT|KEY_0)/.test(JSON.stringify(step)), 'command-line scope is ignored for safe.directory on git < 2.38');
  });
  check('the scan step refuses to pass on an error or a short commit count', () => {
    assert.ok(/grep -Eq '[^']*ERR[^']*\|failed to scan'/.test(step.run), 'an errored scan can pass again');
    assert.ok(/commits scanned/.test(step.run) && step.run.includes('rev-list --count --no-merges HEAD -- .'),
      'the scanned-commit count is no longer checked against the history');
    assert.ok(step.run.includes('$((scanned * 10)) -lt $((expected * 9))'),
      'the scanned-commit floor (90% of the history) is gone');
  });
  check('no documentation file is exempt from the secret scan (SEC-5)', () => {
    const start = toml.indexOf('paths = [');
    const block = toml.slice(start, toml.indexOf(']', start));
    const entries = [...block.matchAll(/^\s*'''([^']+)'''/gm)].map((m) => m[1]);
    for (const doc of ['README', 'CLAUDE', 'SECURITY', 'CHANGELOG', 'FIXES', 'RELEASE_STATUS', 'gitleaks']) {
      assert.ok(!entries.some((e) => e.includes(doc)), `${doc} is path-allowlisted again: ${entries.join(', ')}`);
    }
  });
  check('the config-password rule captures the VALUE, not the key', () => {
    const start = toml.indexOf('id = "gametracker-config-password"');
    const rule = toml.slice(start, toml.indexOf('[[rules]]', start));
    const regex = /regex = '''(.*)'''/.exec(rule)[1];
    assert.ok(regex.startsWith('(?i)"(?:'), 'the key alternation is a capturing group again');
    assert.ok(/\nsecretGroup = 1/.test(rule), 'secretGroup is not set');
  });
}

// No .env variant reaches git or any image build context (ROADMAP SEC-11). The old
// lines matched `.env`, `.env.local` and `.env.*.local` only, so `.env.production` was
// committable and — the backend Dockerfile ends in `COPY . .` — baked into the image.
console.log('no .env variant is committed or copied into an image:');
{
  const lines = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').map((l) => l.trim());
  // .gitignore: a pattern with no slash matches at ANY depth. .dockerignore does NOT work
  // that way — patterns are anchored at the context root and `*` does not cross `/` — so
  // `.env*` there left frontend/.env.production in the backend context, which ends in
  // `COPY . .`. Those files need `**/.env*`.
  const WANT = { '.gitignore': '.env*', '.dockerignore': '**/.env*',
    'frontend/.dockerignore': '**/.env*', 'mcp/.dockerignore': '**/.env*' };
  for (const [f, want] of Object.entries(WANT)) {
    check(`${f} ignores every .env variant, at any depth`, () => {
      assert.ok(lines(f).includes(want), `${f} has no '${want}' line`);
      // A negation may re-admit ONLY the example file.
      const negated = lines(f).filter((l) => /^!.*\.env/.test(l));
      assert.deepStrictEqual(negated.filter((l) => l !== '!.env.example'), [],
        `${f} re-admits an env file: ${negated.join(', ')}`);
    });
  }
}

// The break-glass root reset reads its password from the environment (ROADMAP SEC-9).
// argv is readable in /proc by every process in the container that runs the public app.
console.log('reset-root-password.js prefers the environment over argv:');
check('the password comes from NEW_ROOT_PASSWORD first', () => {
  const src = fs.readFileSync(path.join(ROOT, 'reset-root-password.js'), 'utf8');
  assert.match(src, /process\.env\.NEW_ROOT_PASSWORD \|\| ''/, 'the script no longer reads NEW_ROOT_PASSWORD');
  assert.match(src, /envPassword \|\| process\.argv\[2\]/, 'argv is no longer the fallback behind the env var');
  assert.match(src, /if \(!envPassword\)[\s\S]{0,80}WARNING/, 'an argv password is accepted without a warning');
});

// The SPA authenticates in ONE place and ends a session in ONE place (ROADMAP P0-6, FE-8).
// Hand-built `Authorization` headers and ad-hoc `removeItem('token')` calls are how P0-6
// happened: two pages treated a 403 as a logout, deleted the token behind React's back,
// and left the app looking signed in with every later request failing.
console.log('the SPA has one auth header and one way to end a session:');
{
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(rel);
    return /\.(jsx?|mjs)$/.test(e.name) ? [rel] : [];
  });
  // Component tests are excluded: they set up and reset storage and stub requests, which
  // is exactly what a test harness does and exactly what app code must not.
  const isTest = (f) => /\.test\.jsx?$/.test(f);
  const files = walk('frontend').filter((f) => !/eslint\.config|vite\.config/.test(f) && !isTest(f));
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

  // The exclusion above is by NAME, so it holds only while a `.test.` file is really a
  // test: app code importing one would ship it unscanned.
  check('no app module imports a *.test.* file (the scan exclusion stays honest)', () => {
    for (const [f, text] of Object.entries(src)) {
      assert.ok(!/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"][^'"]*\.test(?:\.jsx?)?['"]/.test(text), `${f} imports a test file`);
    }
  });

  check('found the frontend sources (guards the guard)', () => {
    assert.ok(src['frontend/src/App.jsx'] && src['frontend/src/SharedLibrary.jsx'] && src['frontend/src/api.js'],
      'the frontend walk found nothing');
  });
  // FE-9: every SPA module lives under src/ — SharedLibrary.jsx sat beside it and reached
  // back in with './src/...' imports.
  check('no SPA module outside frontend/src/ (FE-9)', () => {
    const outside = files.filter((f) => /\.jsx$/.test(f) && !f.startsWith('frontend/src/'));
    assert.deepStrictEqual(outside, [], `SPA modules outside src/: ${outside.join(', ')}`);
  });
  // FE-16: ONE client. Pages import `api` from ./api; nothing imports axios itself, so no
  // page can quietly send a request without the token, and the interceptors cannot be
  // re-installed on the global instance.
  check('only src/api.js imports axios, and API_BASE is defined once (FE-16)', () => {
    // Static, dynamic and require(), and any 'axios/...' subpath.
    const importers = files.filter((f) => /(?:from\s+|import\s*\(\s*|require\(\s*)['"]axios(?:\/[^'"]*)?['"]/.test(src[f]));
    assert.deepStrictEqual(importers, ['frontend/src/api.js'], `axios imported directly by: ${importers.join(', ')}`);
    const defs = files.filter((f) => /\bconst API_BASE\s*=/.test(src[f]));
    assert.deepStrictEqual(defs, ['frontend/src/api.js'], `API_BASE defined in: ${defs.join(', ')}`);
  });
  // SEC-14: the session is an HttpOnly COOKIE the page cannot read. So nothing in the SPA
  // builds an Authorization header at all any more -- Swagger UI's Try-it-out attaches the
  // PAT the user typed from inside the library, never from our source -- and the one
  // header our code adds is the CSRF header: api.js on every own-API call, ApiDocsPage on
  // the spec fetch alone (sign-off condition 15).
  check('the SPA builds no Authorization header; only api.js and the spec fetch set the CSRF header (SEC-14)', () => {
    const built = files.filter((f) => /`Bearer \$\{|['"`]Bearer ['"`]\s*\+|Authorization['"]?\s*[:=]\s*[`'"]Bearer/.test(src[f]));
    assert.deepStrictEqual(built, [], `an Authorization header is built in: ${built.join(', ')} -- the session is a cookie now`);
    const csrf = (f) => (src[f].match(/['"]X-Requested-With['"]\s*\]?\s*[:=]\s*['"]GameTracker['"]/g) || []).length;
    const where = files.filter((f) => csrf(f) > 0).sort();
    assert.deepStrictEqual(where, ['frontend/src/ApiDocsPage.jsx', 'frontend/src/api.js'], `CSRF header set in: ${where.join(', ')}`);
    assert.strictEqual(csrf('frontend/src/api.js'), 1);
    assert.strictEqual(csrf('frontend/src/ApiDocsPage.jsx'), 1);
    const docs = src['frontend/src/ApiDocsPage.jsx'];
    const setAt = docs.indexOf("'X-Requested-With'");
    assert.ok(docs.lastIndexOf('if (!isSpecRequest) return req', setAt) !== -1 && docs.lastIndexOf('if (!isSpecRequest) return req', setAt) < setAt,
      'ApiDocsPage sets the CSRF header on requests other than the spec fetch (Try-it-out would carry it to v2)');
  });
  check('no credential in browser storage: the old `token` key is only ever DELETED, in one place (SEC-14, FE-17)', () => {
    for (const f of files) assert.ok(!/localStorage\.clear\(/.test(src[f]), `${f} clears ALL storage`);
    const touches = (f) => (src[f].match(/(?:getItem|setItem|removeItem)\(\s*['"]token['"]/g) || []);
    const where = files.filter((f) => touches(f).length > 0);
    assert.deepStrictEqual(where, ['frontend/src/session.js'], `the token key is touched in: ${where.join(', ')}`);
    assert.ok(!/setItem\(\s*['"]token['"]/.test(src['frontend/src/session.js']), 'session.js WRITES a token again');
    const sess = src['frontend/src/session.js'];
    const fn = sess.slice(sess.indexOf('export function dropLegacyToken'), sess.indexOf('\n}\n', sess.indexOf('export function dropLegacyToken')));
    assert.strictEqual(touches('frontend/src/session.js').length, (fn.match(/(?:getItem|removeItem)\(\s*['"]token['"]/g) || []).length,
      'the legacy token key is touched outside dropLegacyToken');
  });
  check('every session ending goes through endSession, and only two are silent (FE-17)', () => {
    // The ways a session ends -- the 401 interceptor (api.js); boot, sign-out, expiry and
    // another tab's sign-out (App.jsx) -- all go through it. A page deciding on its own is P0-6.
    assert.strictEqual((src['frontend/src/api.js'].match(/endSession\(\{/g) || []).length, 1,
      "api.js's 401 interceptor no longer ends the session through endSession");
    assert.ok((src['frontend/src/App.jsx'].match(/endSession\(\{/g) || []).length >= 3,
      'App.jsx no longer ends sessions through endSession');
    // SILENT endings: a manual sign-out, and another tab's sign-out. Counted across EVERY
    // file (review: a page adding a silent endSession would have passed an App.jsx-only count).
    const silent = files.flatMap((f) => (src[f].match(/explain: false/g) || []).map(() => f));
    assert.deepStrictEqual(silent, ['frontend/src/App.jsx', 'frontend/src/App.jsx'], `silent session endings in: ${silent.join(', ')}`);
    const app = src['frontend/src/App.jsx'];
    const logoutFn = app.slice(app.indexOf('const logout = useCallback'), app.indexOf('}, [setUser, navigate])'));
    assert.ok(/endSession\(\{ explain: false \}\)/.test(logoutFn), 'sign-out now shows a "session ended" notice');
    const tabFn = app.slice(app.indexOf('onSessionAnnounced('), app.indexOf('[user, setUser, navigate, probe]'));
    assert.ok(/explain: false, announce: false/.test(tabFn), "another tab's sign-out is no longer the other silent ending");
  });
  // The login page's "session ended" notice (shown once, cleared on mount) is covered by
  // behaviour tests now: frontend/src/pages/LoginPage.test.jsx (UP-20).
  // FE-19: every modal dialog gets focus-in, focus-return and the Tab trap from ONE hook.
  // Each dialog used to carry its own partial copy, and three had none. A file may not
  // render more dialogs than it has useDialogFocus() calls, and nothing focuses on a timer.
  check('every dialog gets its focus handling from useDialogFocus (FE-19)', () => {
    let dialogs = 0;
    for (const f of files) {
      const roles = (src[f].match(/role=["'](?:alert)?dialog["']/g) || []).length;
      const hooks = (src[f].match(/\buseDialogFocus\(/g) || []).length;
      dialogs += roles;
      assert.ok(roles <= hooks, `${f} renders ${roles} dialog(s) but calls useDialogFocus ${hooks} time(s)`);
      assert.ok(!/setTimeout\(\s*\(\)\s*=>[^)]*\.focus\(/.test(src[f]), `${f} focuses on a timer instead of useDialogFocus`);
    }
    assert.ok(dialogs >= 6, `found only ${dialogs} dialogs — the scan is broken`);
  });
  check('no `window.setUser` fallback', () => {
    for (const f of files) assert.ok(!/window\.setUser/.test(src[f]), `${f} still reaches for window.setUser`);
  });
}

// FE-1, FE-2, FE-5 and FE-6 are covered by BEHAVIOUR now (FE-10):
// frontend/src/pages/SearchPage.test.jsx (FE-2: the four stale-response guards) and
// frontend/src/pages/LibraryPage.test.jsx (FE-1: one crack check per game and the 429
// back-off; FE-5: per-game, conditional rollback; FE-6: chip buttons, labelled card
// groups, named controls, backlog focus and Escape). Each fix, removed, fails a test there.
// Two WIRING properties stay here because no rendered output shows them.
console.log('frontend wiring the component tests cannot observe:');
{
  const library = fs.readFileSync(path.join(ROOT, 'frontend/src/pages/LibraryPage.jsx'), 'utf8');
  // FE-1's other half. The in-flight set (tested) stops the duplicate REQUESTS; an effect
  // keyed on `currentGames` — a new array every render — would still re-run on every
  // render, which nothing on screen reveals. Use currentPageKey / currentPriceKey.
  check('no effect is keyed on the per-render `currentGames` array (FE-1)', () => {
    assert.ok(!/\}, \[[^\]]*\bcurrentGames\b[^\]]*\]\)/.test(library),
      'an effect depends on currentGames, a new array every render — use currentPageKey');
  });
  // FE-7 (the detail dialog's focus trap, focus on open, focus return and the fallback)
  // is covered by behaviour tests in frontend/src/GameDetailModal.test.jsx (UP-20). That
  // harness renders the dialog alone, so whether each PAGE hands it a fallback is pinned here.
  check('every GameDetailModal call site passes a focus fallback (FE-7 wiring)', () => {
    // Across every page, not App.jsx alone: FE-10 moves call sites into src/pages/.
    const dir = path.join(ROOT, 'frontend/src');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)),
      ...fs.readdirSync(path.join(dir, 'pages')).map((f) => path.join(dir, 'pages', f))]
      .filter((f) => /\.jsx$/.test(f) && !/\.test\./.test(f) && !/GameDetailModal\.jsx$/.test(f));
    let sites = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const renders = (text.match(/<GameDetailModal\b/g) || []).length;
      const fallbacks = (text.match(/fallbackFocusRef=\{/g) || []).length;
      sites += renders;
      assert.strictEqual(fallbacks, renders, `${path.relative(ROOT, f)}: a GameDetailModal is rendered without a focus fallback`);
    }
    assert.ok(sites >= 2, `found ${sites} GameDetailModal call sites — the scan is broken`);
  });
}

// The pins retired above are covered by component tests; this keeps them from quietly
// disappearing, and CI from quietly not running them (UP-20).
check('the frontend component tests exist and CI runs them', () => {
  // With a MINIMUM test count each (Architect review): an emptied file would otherwise
  // pass an existence check while covering nothing.
  const minimums = {
    'frontend/src/GameDetailModal.test.jsx': 1, 'frontend/src/pages/LoginPage.test.jsx': 1,
    'frontend/src/App.relogin.test.jsx': 1, 'frontend/src/useDialogFocus.test.jsx': 1,
    'frontend/src/pages/SearchPage.test.jsx': 5, 'frontend/src/pages/LibraryPage.test.jsx': 16, 'frontend/src/pages/SystemStatusPage.test.jsx': 2,
  };
  for (const [f, min] of Object.entries(minimums)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is gone — its source-text pin was retired in its favour`);
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const n = (text.match(/^\s*(?:it|test)\(/gm) || []).length;
    assert.ok(n >= min, `${f} has ${n} tests, want at least ${min} — pins were retired in their favour`);
    // A skipped test counts above and runs nowhere; `.only` silently skips its siblings.
    assert.ok(!/\b(?:it|test|describe)\.(?:skip|only|todo)\(/.test(text), `${f} skips or isolates tests`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'vitest run', 'frontend `npm test` no longer runs vitest');
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/docker-build-deploy.yml'), 'utf8');
  // The step, located INSIDE frontend-quality (the next top-level job ends it), with its
  // keys in either order — and nothing that lets it fail green.
  const job = wf.split(/\n {2}frontend-quality:\n/)[1]?.split(/\n {2}[a-z][\w-]*:\n/)[0] ?? '';
  const step = job.split(/\n\s*- name: /).find((st) => /^Run frontend component tests\b/.test(st)) ?? '';
  assert.ok(/working-directory: \.\/frontend\b/.test(step) && /\brun: npm test\s*$/m.test(step),
    'frontend-quality no longer runs the component tests');
  assert.ok(!/continue-on-error|\bif:|\|\|/.test(step), 'the component-test step can no longer fail the job');
});

console.log(`\n${n} runtime assertions passed.`);
