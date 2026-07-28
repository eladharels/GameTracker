// External service health — the checks behind the System Status page and
// `GET /api/v2/system/status`.
//
// Promise-based, no req/res. See services/shares.js for why the service layer exists.
//
// This was 120 lines inlined in a v1 route handler, which is why adding a v2 view of
// it meant either a second copy of six provider probes or this. The route now decides
// only who may ask and what the wire format is.
//
// WHAT AN UPSTREAM IS ALLOWED TO SAY BACK. Every message here goes through
// `safeMessage`, which strips URLs — a provider's error body routinely echoes the
// request, and these requests carry API keys in query parameters. That single
// substitution is the whole reason this is not just `err.message`. The policy matches
// services/catalog.js: nothing from a provider's error body reaches a caller
// unfiltered, and here even the filtered form is admin-only.
//
// UNCONFIGURED IS NOT AN ERROR, and the distinction is the point of the endpoint. A
// missing THEGAMESDB_API_KEY means that provider contributes nothing by choice; a
// failing one means something is broken. Reporting both as "error" makes the page cry
// wolf on every instance that never configured the optional provider — and reporting
// both as "ok" hides a real outage.

const axios = require('axios');
const db = require('../db');
const { resolveApiKey } = require('../settings-store');

// Long enough for a slow provider, short enough that six of them in parallel cannot
// hold the request open past a reverse proxy's patience.
const PROBE_TIMEOUT_MS = 8000;

// The services this reports on, in display order. Exported so a test can assert the
// set is complete rather than trusting the response it just produced.
const SERVICES = Object.freeze(['database', 'igdb', 'rawg', 'thegamesdb', 'steam', 'crackwatch']);

// A provider's error body routinely quotes the request URL, and these URLs carry API
// keys as query parameters. Redact before the message goes anywhere.
function safeMessage(err) {
  const msg = err.response?.data?.message
    || err.response?.data?.status_message
    || (Array.isArray(err.response?.data) && err.response.data[0]?.title)
    || err.message
    || 'Unknown error';
  return String(msg).replace(/https?:\/\/\S*/gi, '[URL redacted]');
}

// Run one probe and time it. Never throws: a check that threw would take the whole
// report down, and a report that cannot be produced during an outage is useless
// precisely when it is needed.
async function probe(name, fn, okCache) {
  const start = Date.now();
  try {
    await fn();
    const latency = Date.now() - start;
    // Persisted in its own try. A file-write failure must not turn a healthy service
    // into a reported outage — the cache is a convenience, the probe is the answer.
    try { okCache?.record?.(name, { lastOk: new Date().toISOString(), latency }); } catch { /* non-fatal */ }
    return { name, status: 'ok', latency };
  } catch (err) {
    return {
      name,
      status: 'error',
      latency: Date.now() - start,
      httpStatus: err.response?.status || null,
      message: safeMessage(err),
    };
  }
}

// Check everything, concurrently.
//
// `okCache` is injected rather than owned here because its file lives beside the other
// ephemeral caches under CACHE_DIR, which index.js already manages. It must expose
// `read(name)` and `record(name, entry)`; both are optional, and their absence
// degrades the report to "no last-OK known" rather than failing it.
//
// `crackWatchCacheSize` is passed in for the same reason: a populated DRM cache means
// the integration is working regardless of whether crackwatch.com answers right now,
// and only index.js knows that number.
async function checkAll({ okCache = null, crackWatchCacheSize = 0 } = {}) {
  const igdbClientId = resolveApiKey('IGDB_CLIENT_ID');
  const igdbBearerToken = resolveApiKey('IGDB_BEARER_TOKEN');
  const rawgApiKey = resolveApiKey('RAWG_API_KEY');
  const tgdbApiKey = resolveApiKey('THEGAMESDB_API_KEY');

  const dbCheck = () => db.promises.get('SELECT 1', []);

  const checks = await Promise.all([
    probe('database', dbCheck, okCache),

    (igdbClientId && igdbBearerToken)
      ? probe('igdb', () => axios.post(
        'https://api.igdb.com/v4/games',
        'fields id; limit 1;',
        {
          headers: {
            'Client-ID': igdbClientId,
            Authorization: `Bearer ${igdbBearerToken}`,
            Accept: 'application/json',
          },
          timeout: PROBE_TIMEOUT_MS,
        }
      ), okCache)
      : { name: 'igdb', status: 'unconfigured', message: 'IGDB_CLIENT_ID or IGDB_BEARER_TOKEN not set' },

    rawgApiKey
      ? probe('rawg', () => axios.get('https://api.rawg.io/api/games', {
        params: { key: rawgApiKey, page_size: 1, search: 'tetris' }, timeout: PROBE_TIMEOUT_MS,
      }), okCache)
      : { name: 'rawg', status: 'unconfigured', message: 'RAWG_API_KEY not set' },

    tgdbApiKey
      ? probe('thegamesdb', () => axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
        params: { apikey: tgdbApiKey, name: 'tetris', 'fields[games]': 'id' }, timeout: PROBE_TIMEOUT_MS,
      }), okCache)
      : { name: 'thegamesdb', status: 'unconfigured', message: 'THEGAMESDB_API_KEY not set (optional)' },

    probe('steam', () => axios.get('https://store.steampowered.com/api/featured', {
      timeout: PROBE_TIMEOUT_MS,
    }), okCache),

    // A populated cache IS the health signal here: the DRM data is served from it, so
    // the integration works whether or not crackwatch.com answers this second. Only an
    // EMPTY cache makes the upstream's reachability the question.
    crackWatchCacheSize > 0
      ? Promise.resolve({ name: 'crackwatch', status: 'ok', message: `Cache has ${crackWatchCacheSize} titles` })
      : probe('crackwatch', () => axios.get('https://api.crackwatch.com/api/games', {
        params: { page: 0, sort_by: 'release_date' }, timeout: PROBE_TIMEOUT_MS,
      }), okCache).then((r) => ({
        ...r,
        message: r.status === 'ok' ? 'Reachable (cache empty — run a refresh)' : r.message,
      })),
  ]);

  const services = checks.map((c) => ({
    ...c,
    lastOk: okCache?.read?.(c.name)?.lastOk || null,
    lastOkLatency: okCache?.read?.(c.name)?.latency || null,
  }));

  // `unconfigured` counts as healthy. An instance that deliberately never set the
  // optional TheGamesDB key is not degraded, and a status page that says otherwise
  // teaches its reader to ignore it.
  const allOk = services.every((c) => c.status === 'ok' || c.status === 'unconfigured');

  return { overall: allOk ? 'ok' : 'degraded', services, checkedAt: new Date().toISOString() };
}

module.exports = { checkAll, SERVICES, PROBE_TIMEOUT_MS, safeMessage };
