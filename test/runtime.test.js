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
];

// Below this, a supported runtime is not what you are running. 20 is the lowest Node
// still receiving security updates; 19 is where globalThis.crypto arrived, so this
// floor also covers the specific defect above with a margin.
const MIN_SUPPORTED_MAJOR = 20;

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
  check('no `uses:` references a tag or branch', () => {
    const uses = [...raw.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)];
    assert.ok(uses.length > 0, 'no uses: lines found -- the scan is broken');
    for (const [, ref, rest] of uses) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit SHA`);
      assert.match(rest, /#\s*v\d/, `${ref} has no "# vX.Y.Z" comment saying which release it is`);
    }
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
  const files = walk('frontend').filter((f) => !/eslint\.config|vite\.config/.test(f));
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

  check('found the frontend sources (guards the guard)', () => {
    assert.ok(src['frontend/src/App.jsx'] && src['frontend/SharedLibrary.jsx'], 'the frontend walk found nothing');
  });
  check('only the axios interceptor (and Swagger UI\'s own client) set a Bearer header', () => {
    const where = files.filter((f) => /Authorization:?\s*[:=]?\s*`Bearer/.test(src[f]) || /Authorization = `Bearer/.test(src[f]));
    assert.deepStrictEqual(where.sort(), ['frontend/src/ApiDocsPage.jsx', 'frontend/src/App.jsx'],
      `hand-built Bearer headers in: ${where.join(', ')} — the interceptor in App.jsx adds it to every /api call`);
    assert.strictEqual((src['frontend/src/App.jsx'].match(/`Bearer \$\{/g) || []).length, 1,
      'App.jsx builds a Bearer header outside its interceptor');
  });
  check('nothing but App.jsx\'s session code deletes the token', () => {
    const where = files.filter((f) => /removeItem\(['"]token['"]\)/.test(src[f]));
    assert.deepStrictEqual(where, ['frontend/src/App.jsx'], `token deleted from: ${where.join(', ')}`);
    // The interceptor (401), useAuth (expired at boot) and logout. A fourth is a page
    // deciding on its own that the session is over.
    assert.strictEqual((src['frontend/src/App.jsx'].match(/removeItem\(['"]token['"]\)/g) || []).length, 3,
      'App.jsx removes the token somewhere other than the interceptor, useAuth and logout');
  });
  check('no `window.setUser` fallback', () => {
    for (const f of files) assert.ok(!/window\.setUser/.test(src[f]), `${f} still reaches for window.setUser`);
  });
}

console.log(`\n${n} runtime assertions passed.`);
