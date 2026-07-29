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

console.log(`\n${n} runtime assertions passed.`);
