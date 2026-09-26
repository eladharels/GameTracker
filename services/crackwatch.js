// The DRM-status sources (ROADMAP UP-16, the first slice out of index.js): the CrackWatch
// cache -- a daily-refreshed map of title -> cracked -- and the CrackRelease page scraper
// for a single game. Moved VERBATIM from index.js; the routes there are adapters now.
//
// Module state, deliberately: there is one cache per process, and index.js's cron, its
// admin refresh route, the v2 job and the library read all have to see the SAME one.
// `init()` names the cache file (under CACHE_DIR, a tmpfs in production) before the
// first load; nothing else here touches the filesystem.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { safeForLog } = require('../user-rules');

// History worth keeping: these two constants were once deleted by accident (a slice of
// index.js cut at the wrong boundary). Every reference sat inside a try/catch, so nothing
// crashed -- the cache silently stopped loading and saving, and the refresh broke out of
// its pagination loop after page 0. `no-undef` in eslint.config.mjs is what catches that.
let CRACKWATCH_CACHE_FILE = path.join(__dirname, '..', 'crackwatch-cache.json');
const CRACKWATCH_RATE_MS = 1200; // 1.2s between requests to respect API limit

function init({ cacheDir } = {}) {
  if (cacheDir) CRACKWATCH_CACHE_FILE = path.join(cacheDir, 'crackwatch-cache.json');
}

/** In-memory cache: normalizedTitle -> true (cracked) | false (uncracked). Unknown = not in cache. */
let crackWatchCache = Object.create(null);
const cacheSize = () => Object.keys(crackWatchCache).length;
const sampleKeys = (n) => Object.keys(crackWatchCache).slice(0, n);
// Empty the cache. For the tests, so one cannot leave titles behind for the next.
const reset = () => { crackWatchCache = Object.create(null); };

/** Normalize game title for matching: lowercase, trim, collapse spaces, remove most punctuation */
function normalizeTitleForCrackWatch(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/['':\-–—]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Keys that must never be written into a plain object built from external data:
// assigning them mutates Object.prototype instead of the object. Defined HERE, above
// every consumer -- these were `const` declarations further down the file, and
// loadCrackWatchCacheFromFile() runs at module scope, so it hit the temporal dead
// zone and silently lost the whole DRM cache on every boot behind a try/catch.
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const isUnsafeKey = (k) => UNSAFE_KEYS.includes(String(k));

// A ReferenceError from our own code is a bug, not a runtime condition, and a catch
// that means "this network call might fail" should not absorb it — that is how a
// deleted `const CRACKWATCH_CACHE_FILE` degraded silently for a whole deploy cycle.
//
// NARROW, and deliberately so. An earlier version of this also rethrew SyntaxError
// and TypeError, which was WORSE than the bug it was written for: both cache loaders
// below JSON.parse a mutable file at MODULE SCOPE, and JSON.parse throws SyntaxError
// on a truncated file — which the reminder log could produce while it lived in
// sent_notifications.json, rewritten with a bare writeFileSync on every reminder
// (it is a table now, migration 006; the CrackWatch cache is still a file). A container
// kill mid-write would then have made the backend AND every operator script
// unbootable, including the ones you would use to diagnose it. Reconstructible caches
// must keep degrading.
//
// The real prevention for the original defect is static: `no-undef` catches all four
// references before merge, on every path, whether or not it executes.
function rethrowIfReferenceError(err) {
  if (err instanceof ReferenceError) throw err;
}

function loadFromFile() {
  try {
    if (fs.existsSync(CRACKWATCH_CACHE_FILE)) {
      const raw = fs.readFileSync(CRACKWATCH_CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Copy onto a null-prototype object rather than adopting the parsed literal,
      // keeping the posture the initializer declares. Copied key-by-key with the
      // dangerous keys rejected, rather than via Object.assign — a bulk copy of
      // externally-sourced data into an object is a mass-assignment shape, and this
      // way the guarantee is visible in the code instead of assumed.
      if (data && typeof data === 'object') {
        const fresh = Object.create(null);
        for (const [k, v] of Object.entries(data)) {
          if (!isUnsafeKey(k)) fresh[k] = v;
        }
        crackWatchCache = fresh;
      }
      console.log('[CrackWatch] Loaded cache from file,', Object.keys(crackWatchCache).length, 'titles');
    }
  } catch (err) {
    // No rethrow here: this JSON.parses a mutable file at module scope, so a
    // truncated cache must degrade to empty, not stop the process booting.
    console.warn('[CrackWatch] Could not load cache file:', err.message);
  }
}

function saveToFile() {
  try {
    fs.writeFileSync(CRACKWATCH_CACHE_FILE, JSON.stringify(crackWatchCache, null, 0), 'utf8');
    console.log('[CrackWatch] Saved cache to file,', Object.keys(crackWatchCache).length, 'titles');
  } catch (err) {
    rethrowIfReferenceError(err);
    console.warn('[CrackWatch] Could not save cache file:', err.message);
  }
}

/** Fetch all pages from CrackWatch API (rate-limited), merge into crackWatchCache. */
// `rateMs` exists for the tests, which would otherwise wait out the real delay per page.
async function refresh({ rateMs = CRACKWATCH_RATE_MS } = {}) {
  const baseUrl = 'https://api.crackwatch.com/api/games';
  let page = 0;
  let total = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('[CrackWatch] Starting cache refresh...');
  while (true) {
    try {
      const res = await axios.get(baseUrl, {
        params: { page, sort_by: 'release_date' },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      const data = res.data;
      let list = Array.isArray(data) ? data : null;
      if (!list && data && typeof data === 'object') {
        list = data.data || data.results || data.games || data.items || [];
      }
      if (!Array.isArray(list) || !list.length) {
        if (page === 0) console.log('[CrackWatch] API response shape:', Array.isArray(data) ? 'array' : data ? Object.keys(data) : 'null');
        break;
      }

      for (const item of list) {
        const title = item.title || item.name;
        if (!title) continue;
        const key = normalizeTitleForCrackWatch(title);
        if (!key) continue;
        const cracked = item.isCracked === true || (Array.isArray(item.groups) && item.groups.length > 0) || !!(item.crackDate || item.date_cracked);
        crackWatchCache[key] = cracked;
        if (item.slug && typeof item.slug === 'string') {
          const slugKey = item.slug.toLowerCase().replace(/-/g, ' ');
          if (slugKey && slugKey !== key) crackWatchCache[slugKey] = cracked;
        }
      }
      total += list.length;
      page++;
      await delay(rateMs);
    } catch (err) {
      rethrowIfReferenceError(err);
      console.warn('[CrackWatch] Refresh error at page', page, err.message || err, err.response?.status);
      break;
    }
  }
  console.log('[CrackWatch] Cache refresh done. Total entries:', total, 'Cache size:', Object.keys(crackWatchCache).length);
  saveToFile();
}


function slugifyForCrackRelease(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Returns the v1 response body. `scrapeCrackRelease` below also says whether the page
// was actually READ, which the response cannot carry without changing its shape.
async function getCrackReleaseStatus(gameName) {
  return (await scrapeCrackRelease(gameName)).result;
}

async function scrapeCrackRelease(gameName) {
  const slug = slugifyForCrackRelease(gameName);
  if (!slug) {
    return { fetched: false, result: { status: 'unknown', url: null, slug, gameName } };
  }
  const url = `https://crackrelease.com/${slug}/`;
  try {
    const response = await axios.get(url, { timeout: 15000 });
    const html = String(response.data || '');
    const statusMatch = html.match(/>\s*(UNCRACKED|CRACKED|UNRELEASED)\s*</i);
    const raw = statusMatch ? statusMatch[1].toUpperCase() : null;
    let status = 'unknown';
    if (raw === 'CRACKED') status = 'cracked';
    else if (raw === 'UNCRACKED') status = 'uncracked';
    else if (raw === 'UNRELEASED') status = 'unreleased';
    // `fetched` means CrackRelease ANSWERED, not merely that a page loaded: a 200 with
    // no status word on it (a parked domain, a layout change, a challenge page) says
    // nothing about the game, and treating it as an answer wrote `unknown` over a known
    // status -- the same erasure CC-11 exists to stop (from the Architect review).
    return { fetched: raw !== null, result: { status, url, slug, gameName } };
  } catch (err) {
    // safeForLog, not JSON.stringify: the name is user-controlled, and JSON.stringify
    // passes C1 controls and DEL (a CSI can move a terminal cursor) through raw.
    console.warn('[CrackRelease] Error fetching status for', safeForLog(gameName, 80), '-', safeForLog(err.message));
    // `error` stays in the body (v1 shape) but is OUR sentence, not the upstream's:
    // err.message named hosts and ports, and this reaches non-admin callers.
    return {
      fetched: false,
      result: { status: 'unknown', url, slug, gameName, error: 'Could not reach CrackRelease' },
    };
  }
}

// What may be STORED in user_games.crack_status: the documented three. The scraper can
// also answer `unreleased`, which the response still carries, but the column does not.
const STORABLE_CRACK_STATUS = Object.freeze({ cracked: 'cracked', uncracked: 'uncracked' });

/** Look up crack status by normalized game name: exact match, then best substring match. */
function lookupCrackStatus(normalizedGameName) {
  if (!normalizedGameName) return undefined;
  const exact = crackWatchCache[normalizedGameName];
  if (exact === true || exact === false) return exact;
  const keys = Object.keys(crackWatchCache);
  let bestMatch = null;
  let bestLen = 0;
  for (const k of keys) {
    const val = crackWatchCache[k];
    if (val !== true && val !== false) continue;
    const inKey = normalizedGameName.includes(k) && k.length >= 3;
    const keyInName = k.includes(normalizedGameName) && normalizedGameName.length >= 3;
    if (inKey && k.length > bestLen) { bestMatch = val; bestLen = k.length; }
    if (keyInName && normalizedGameName.length > bestLen) { bestMatch = val; bestLen = normalizedGameName.length; }
  }
  return bestMatch;
}


// The library read's combined answer for one row: the stored per-game status wins, then
// the cache, exact before substring. Was inline in the /crack-status route.
function statusForRow(row) {
  const key = normalizeTitleForCrackWatch(row.game_name || '');
  const cached = crackWatchCache[key] ?? lookupCrackStatus(key);
  const combined = row.crack_status || (cached === true ? 'cracked' : cached === false ? 'uncracked' : 'unknown');
  return combined || 'unknown';
}

// --- The two library-facing operations (UP-26) ---------------------------------------
// The rows come from user_games; the answer from the cache or the scraper above. Through the
// db MODULE, in the callback form the routes used, so the contract suite's stubs still see
// them. Like every service: no req/res.
const db = require('../db');
const { serviceError, CODES } = require('./errors');
const dbGet = (sql, params) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbAll = (sql, params) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

// {game_id: status} for one library, from the stored status and the cache only (no fetch).
async function libraryStatuses(userId) {
  const rows = await dbAll('SELECT game_id, game_name, crack_status FROM user_games WHERE user_id = ?', [userId]);
  const statusByGameId = {};
  for (const row of rows) statusByGameId[row.game_id] = statusForRow(row);
  return statusByGameId;
}

// Scrape CrackRelease for one library game and store what was READ (ROADMAP CC-11):
//   - only a page that was actually read may change the stored value -- an outage used to
//     write `unknown` over every KNOWN status it touched;
//   - only the documented values are stored; anything else read is `unknown`;
//   - AWAITED: a failed write is logged, and the caller still gets the answer.
// NOT_FOUND when the game is not in this library; a database failure of the lookup
// propagates as itself; a scraper defect is tagged `scrapeFailed`.
async function checkLibraryGame(userId, gameId) {
  const row = await dbGet('SELECT game_name FROM user_games WHERE user_id = ? AND game_id = ?', [userId, gameId]);
  if (!row) throw serviceError(CODES.NOT_FOUND, 'Game not found for this user');
  let scraped;
  try {
    scraped = await scrapeCrackRelease(row.game_name);
  } catch (err) {
    throw Object.assign(new Error(`CrackRelease scrape failed: ${err.message}`), { scrapeFailed: true });
  }
  if (scraped.fetched) {
    try {
      await db.promises.run('UPDATE user_games SET crack_status = ? WHERE user_id = ? AND game_id = ?',
        [STORABLE_CRACK_STATUS[scraped.result.status] || 'unknown', userId, gameId]);
    } catch (updateErr) {
      console.error('[CrackRelease] Failed to update crack_status in DB:', safeForLog(updateErr.message));
    }
  }
  return scraped.result;
}

module.exports = {
  libraryStatuses, checkLibraryGame,
  init, cacheSize, sampleKeys, reset,
  normalizeTitleForCrackWatch, loadFromFile, saveToFile, refresh, lookupCrackStatus, statusForRow,
  slugifyForCrackRelease, getCrackReleaseStatus, scrapeCrackRelease, STORABLE_CRACK_STATUS,
  rethrowIfReferenceError, isUnsafeKey,
};
