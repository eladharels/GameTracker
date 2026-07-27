// The job store: accept work, run it off the request, hand back something to poll.
//
// WHY THIS EXISTS AT ALL. The four sweeps behind it walk every game in a library — or
// in every library — against up to three external providers, sequentially, because
// running them concurrently earns a rate-limit. On a real library that is minutes, and
// any reverse proxy in front of this closes the connection long before it finishes.
// v1 runs them inline anyway: `POST /api/user/:username/refresh-metadata` holds the
// request open for the whole sweep, so a client's only signal is a timeout that says
// nothing about whether the work completed. 202 plus a pollable resource is the
// difference between "we do not know" and an answer.
//
// IN MEMORY, DELIBERATELY, and the consequence is written down rather than hidden: a
// restart loses every job, and a poll for one that is gone is a 404 — the same answer
// as someone else's job id. The alternative is a `jobs` table, which buys durability
// this does not need (the work is idempotent; re-run it) at the cost of a migration, a
// reaper, and a second source of truth about what is running. The backend is one
// process in one container — see the note on `key` below for the one assumption that
// rests on.
//
// NOTHING HERE KNOWS WHAT A JOB DOES. It takes an async function and stores what came
// back. The four kinds and their result shapes live in services/jobs.js.

const crypto = require('crypto');
const { serviceError, CODES } = require('./errors');

// Unguessable, not sequential. openapi/gametracker-v2.yaml states the rule and the
// reason: a job is readable by the account that started it, and someone else's id is a
// 404 rather than a 403 — which is only worth having if the id cannot be enumerated.
// 24 bytes, so guessing is not a strategy even against an unbounded prober.
const ID_BYTES = 24;

// Retention. Jobs are evicted FINISHED-FIRST and oldest-first, and a running job is
// never evicted — losing the handle to work still in flight would leave the caller
// polling an id that will never resolve while the sweep keeps running.
const MAX_JOBS = 200;
const TTL_MS = 24 * 60 * 60 * 1000;

const STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed']);
const SCOPES = Object.freeze(['self', 'instance']);

// The CLOSED set of failure reasons. Never an exception message: these jobs call IGDB,
// RAWG, TheGamesDB, Steam and CrackWatch, whose error text carries endpoint paths,
// quota state and occasionally the failing key — RAWG's travels as a query parameter.
// services/catalog.js exists in large part to stop that reaching a caller, and a
// free-text `error` here would hand the next implementer the obvious `err.message` and
// undo it.
const REASONS = Object.freeze(['provider_unavailable', 'rate_limited', 'not_found', 'invalid_data', 'internal']);

// A thrown error, as a reason. Everything unrecognised is `internal` — the safe end,
// and the same fail-closed default services/problem.js applies to an unknown code.
const REASON_BY_CODE = Object.freeze({
  [CODES.PROVIDER_UNAVAILABLE]: 'provider_unavailable',
  [CODES.NOT_FOUND]: 'not_found',
  [CODES.VALIDATION]: 'invalid_data',
});

function reasonFor(err) {
  return REASON_BY_CODE[err?.code] || 'internal';
}

const jobs = new Map();

// Single-flight key. A `self` job is per account; an `instance` job is per instance,
// so two administrators cannot start the same sweep twice and double every outbound
// request to the providers.
//
// This is a per-PROCESS lock, which is the one place the in-memory choice shows. Two
// backend containers against one database would each allow one — the sweeps are
// idempotent, so the cost is duplicated provider traffic rather than corruption, and
// this deployment runs a single backend. A real distributed lock belongs with a real
// job table, and neither is worth it until there is a second container.
function keyOf(kind, scope, ownerId) {
  return scope === 'self' ? `${kind}:self:${ownerId}` : `${kind}:instance`;
}

const isActive = (job) => job.status === 'queued' || job.status === 'running';

// Start a job. Returns immediately with the record; `work` runs off the response.
//
// `work` must RESOLVE to a JobResult and may reject; either way this catches it, so a
// throw inside a sweep cannot become an unhandled rejection that takes the process
// down under Node's default --unhandled-rejections=throw.
function start({ kind, scope, ownerId, work }) {
  if (!SCOPES.includes(scope)) {
    throw serviceError(CODES.VALIDATION, `scope must be one of: ${SCOPES.join(', ')}`, { field: 'scope' });
  }
  const key = keyOf(kind, scope, ownerId);
  for (const job of jobs.values()) {
    if (job.key === key && isActive(job)) {
      throw serviceError(CODES.CONFLICT, `a ${kind} job is already running`);
    }
  }

  evict();
  const job = {
    id: crypto.randomBytes(ID_BYTES).toString('base64url'),
    key,
    kind,
    scope,
    ownerId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);

  // Deliberately not awaited — that is the whole point — but every path is terminal:
  // resolve records the result, reject records a CLOSED reason, and neither rethrows.
  Promise.resolve()
    .then(() => work())
    .then((result) => {
      job.result = normaliseResult(result);
      job.status = 'succeeded';
    })
    .catch((err) => {
      // The detail goes to the log, the reason goes to the caller. Same split as
      // services/problem.js's `expose` column.
      console.error(`[Jobs] ${kind} (${scope}) failed:`, err?.message || err);
      job.error = reasonFor(err);
      job.status = 'failed';
    })
    .finally(() => { job.finishedAt = new Date().toISOString(); });

  return job;
}

// A job, ONLY for the account that started it.
//
// Ownership, not scope, is what protects an instance-wide job's result — its
// `failures[]` names game ids from every user's library. A job belonging to somebody
// else is indistinguishable from one that never existed.
function get(id, ownerId) {
  const job = jobs.get(String(id));
  if (!job || String(job.ownerId) !== String(ownerId)) return null;
  return job;
}

// Coerce whatever a runner returned into the published JobResult.
//
// Counts are numbers or they are absent — a NaN reaching the wire is worse than a
// missing field, because a client will happily render it. `failures` is truncated at
// 200 while `failed` keeps the true count, so a sweep where ten thousand games failed
// does not become a ten-thousand-element response.
const MAX_FAILURES = 200;

function normaliseResult(result) {
  const r = Object(result);
  const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
  const out = {
    processed: count(r.processed),
    succeeded: count(r.succeeded),
    failed: count(r.failed),
  };
  if (Array.isArray(r.failures)) {
    out.failures = r.failures.slice(0, MAX_FAILURES).map((f) => ({
      gameId: String(f?.gameId ?? ''),
      // An unrecognised reason becomes `internal` rather than travelling as-is. The
      // enum is a disclosure control, not documentation: a runner that put a
      // provider's message in here would otherwise publish it verbatim.
      reason: REASONS.includes(f?.reason) ? f.reason : 'internal',
    }));
  }
  return out;
}

// Test seam. The store is module state by design — there is one per process — and a
// test that could not clear it would be order-dependent.
function _reset() {
  jobs.clear();
}

// Oldest FINISHED job first, then anything past its TTL. A running job is never
// dropped: the caller is holding an id for work that is still going.
function evict() {
  for (const [id, job] of jobs) {
    if (!isActive(job) && Date.parse(job.startedAt) < Date.now() - TTL_MS) jobs.delete(id);
  }
  if (jobs.size < MAX_JOBS) return;
  const finished = [...jobs.values()].filter((j) => !isActive(j))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const job of finished) {
    if (jobs.size < MAX_JOBS) break;
    jobs.delete(job.id);
  }
}

module.exports = {
  start, get, reasonFor, normaliseResult,
  STATUSES, SCOPES, REASONS, MAX_JOBS, MAX_FAILURES, TTL_MS,
  _reset, _size: () => jobs.size,
};
