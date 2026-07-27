// Game catalog — search across IGDB, RAWG and TheGamesDB.
//
// This existed three times: the search route, the bulk metadata refresh and the
// single-game refresh each carried their own copy of "call three providers, normalise
// the shapes, cross-fill the gaps, dedupe by name". The two refresh copies were 98%
// identical to each other and ~80% identical to the search one, which is to say they
// had already started to drift.
//
// THE CONTRACT IS "DEGRADE, DON'T FAIL". A provider that is down, rate-limited or
// unconfigured contributes zero results and the search still answers. That was v1's
// behaviour (each promise had its own .catch returning []) and it is the right one:
// three sources exist precisely so that one being unavailable is survivable.
//
// NOTHING FROM A PROVIDER REACHES THE CALLER. Their error bodies carry endpoint
// paths, quota state and occasionally the failing key. This module logs the detail
// and returns a STATUS per provider — 'ok' | 'skipped' | 'failed' — never a message.
// See services/problem.js for the same rule applied to service errors generally.
//
// The status matters, and a count would not have done. A count of 0 cannot tell
// "this provider had no results for that title" from "this provider is down", and
// the refresh path turns that distinction into a sentence a user acts on: during an
// outage it would otherwise report every game in the library as "not found in API
// search results", which reads as "these games no longer exist anywhere".

const axios = require('axios');
const { resolveApiKey } = require('../settings-store');
const { escapeIgdbSearch } = require('../igdb-helpers');

// Every outbound call is bounded. NONE of the three had a timeout on the search path
// — only the System Status probes did — so a hung provider held the user's request
// open until something else gave up. Same defect the SMTP transport had.
const TIMEOUT_MS = 10000;
const REQUEST = { timeout: TIMEOUT_MS, maxRedirects: 0 };

// Results requested per provider.
//
// TWO values, deliberately, because v1 had two and the difference is load-bearing:
// the interactive search asked for 20, both metadata-refresh paths asked for 10.
// Refresh only ever accepts an EXACT title match, so extra candidates buy it nothing
// — and it runs per game across the entire library, where each extra RAWG result
// costs another detail request (see the N+1 note below). Collapsing them onto 20
// would have doubled the outbound traffic of a whole-library sweep for no gain.
const LIMIT_SEARCH = 20;
const LIMIT_REFRESH = 10;

// A provider's raw error is logged, never returned. `hasKey` is a boolean, not the
// key: this line has to be safe to paste into an issue.
function logProviderError(provider, err, extra = {}) {
  console.error(`[Catalog] ${provider} search failed:`, {
    message: err?.message,
    status: err?.response?.status,
    ...extra,
  });
}

// --- IGDB ------------------------------------------------------------------

async function searchIgdb(query, limit) {
  const clientId = resolveApiKey('IGDB_CLIENT_ID');
  const bearerToken = resolveApiKey('IGDB_BEARER_TOKEN');
  if (!clientId || !bearerToken) {
    console.warn('[Catalog] IGDB skipped:', {
      clientId: clientId ? 'SET' : 'MISSING',
      bearerToken: bearerToken ? 'SET' : 'MISSING',
    });
    return { status: 'skipped', results: [] };
  }
  // escapeIgdbSearch is the ONLY way to put a value inside an APIcalypse
  // `search "..."` literal — see igdb-helpers.js. A bare quote or trailing
  // backslash otherwise ends the literal and the rest of the query is attacker text.
  const safeQuery = escapeIgdbSearch(query);
  try {
    const response = await axios.post(
      'https://api.igdb.com/v4/games',
      `search "${safeQuery}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit ${limit};`,
      {
        ...REQUEST,
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${bearerToken}`,
          'Accept': 'application/json',
        },
      }
    );
    const games = response.data || [];
    const rows = games.map((game) => {
      let steamAppId = null;
      if (Array.isArray(game.external_games)) {
        // category 1 is Steam in IGDB's external_games taxonomy.
        const steamExternal = game.external_games.find((ext) => ext.category === 1 && ext.uid);
        if (steamExternal) steamAppId = steamExternal.uid;
      }
      return {
        id: 'igdb_' + game.id,
        name: game.name,
        releaseDate: igdbDate(game.first_release_date),
        coverUrl: game.cover?.image_id
          ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
          : null,
        source: 'igdb',
        steamAppId,
      };
    }).filter((game) => game.name);   // see mergeResults: a nameless row rejects the search
    return { status: 'ok', results: rows };
  } catch (err) {
    logProviderError('IGDB', err);
    return { status: 'failed', results: [] };
  }
}

// IGDB sends a Unix timestamp in SECONDS. The three copies all did
// `new Date(ts * 1000).toISOString()` unguarded, which THROWS a RangeError on a
// value outside ±8.64e15 ms — and a throw here escaped the .map, rejected the
// provider promise, and cost the whole provider's results rather than one game's
// date. TheGamesDB's parsing was guarded; IGDB's never was.
function igdbDate(seconds) {
  // Falsy means "no date", matching v1's `game.first_release_date ? ... : null`.
  // That deliberately includes 0: the epoch is not a game release date, and letting
  // it through would relabel such a row as released in 1970.
  if (!seconds) return null;
  const d = new Date(Number(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// --- RAWG ------------------------------------------------------------------

async function searchRawg(query, limit) {
  const key = resolveApiKey('RAWG_API_KEY');
  if (!key) return { status: 'skipped', results: [] };
  try {
    const response = await axios.get('https://api.rawg.io/api/games', {
      ...REQUEST,
      params: { key, search: query, page_size: limit },
    });
    // slice() BEFORE the detail fan-out. page_size is a request, not a guarantee:
    // a provider that ignores it (or is compromised) hands back an arbitrary number
    // of results and each one costs a detail request. Measured with a stub returning
    // 500 results: 500 concurrent outbound requests. IGDB is bounded by its `limit`
    // clause and TheGamesDB already sliced; RAWG was the one taking the provider's
    // word for it.
    const games = (response.data.results || []).slice(0, limit);
    // N+1, preserved from v1: RAWG only exposes store links on the DETAIL endpoint,
    // so finding a Steam App ID costs one extra request per result — up to 21 per
    // search. They run concurrently and each is individually bounded and individually
    // catchable, so the worst case is TIMEOUT_MS rather than 20x it. Dropping the
    // detail fetch would silently stop resolving Steam prices for RAWG-sourced games;
    // any fix belongs in a caching layer, not here.
    const rows = await Promise.all(games.map(async (game) => ({
      id: 'rawg_' + game.id,
      name: game.name,
      releaseDate: game.released,
      coverUrl: game.background_image,
      source: 'rawg',
      steamAppId: await rawgSteamAppId(game.id, key),
    })));
    return { status: 'ok', results: rows.filter((game) => game.name) };
  } catch (err) {
    logProviderError('RAWG', err);
    return { status: 'failed', results: [] };
  }
}

// One game's Steam App ID, or null. Never throws: a detail lookup failing must cost
// that one id, not the whole provider's results.
async function rawgSteamAppId(gameId, key) {
  try {
    const detail = await axios.get(`https://api.rawg.io/api/games/${encodeURIComponent(gameId)}`, {
      ...REQUEST,
      params: { key },
    });
    const stores = detail.data.stores || [];
    const steamStore = stores.find((s) => s.store && s.store.id === 1 && s.url_en);
    const match = steamStore?.url_en?.match(/\/app\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// --- TheGamesDB ------------------------------------------------------------

async function searchTheGamesDb(query, limit) {
  const key = resolveApiKey('THEGAMESDB_API_KEY');
  if (!key) return { status: 'skipped', results: [] };   // optional provider
  try {
    const response = await axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
      ...REQUEST,
      params: { apikey: key, name: query },
    });
    const data = response.data;
    if (!data?.data?.games) return { status: 'ok', results: [] };
    const games = Array.isArray(data.data.games) ? data.data.games : [data.data.games];
    const baseUrl = data.include?.base_url?.image_base
      || data.data?.base_url?.image_base
      || 'https://cdn.thegamesdb.net/images/';
    // NOT data.include.boxart.data — the map is keyed directly on include.boxart.
    const boxartById = data.include?.boxart || {};

    const rows = games.slice(0, limit).map((game) => ({
      id: 'thegamesdb_' + game.id,
      name: game.game_title || game.game_name || '',
      releaseDate: parseLooseDate(game.release_date),
      coverUrl: theGamesDbCover(boxartById[game.id], baseUrl),
      source: 'thegamesdb',
      // TheGamesDB does not expose Steam App IDs. mergeResults() may still fill one
      // in from an IGDB or RAWG result for the same title.
      steamAppId: null,
    })).filter((game) => game.name);
    return { status: 'ok', results: rows };
  } catch (err) {
    logProviderError('TheGamesDB', err);
    return { status: 'failed', results: [] };
  }
}

function theGamesDbCover(boxart, baseUrl) {
  if (!boxart) return null;
  const front = Array.isArray(boxart)
    ? (boxart.find((b) => b.side === 'front') || boxart[0])
    : boxart;
  return front?.filename ? `${baseUrl}${front.filename}` : null;
}

// TheGamesDB's date format varies, so this one was always guarded — unlike IGDB's.
function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// --- Merge -----------------------------------------------------------------

// Fill each result's gaps from same-named results, then collapse to one per name.
//
// releaseDate is DELIBERATELY never cross-filled. Different games genuinely share a
// name — "Judas" (2017) and the unreleased "Judas" — and borrowing a date by name
// alone dates one of them wrongly, which then drives the unreleased/released status
// coercion. Cover art and Steam App IDs are cosmetic enough to borrow; a date is not.
function mergeResults(igdb, rawg, thegamesdb) {
  const all = [...igdb, ...rawg, ...thegamesdb];
  // String(x ?? '') rather than x.toLowerCase(): this runs AFTER Promise.all, so
  // it is outside every provider's catch, and one nameless row would reject the
  // whole search — breaking the never-rejects contract stated above. The providers
  // now filter these out; this is the belt to that pair of braces.
  const sameName = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

  const filled = all.map((game) => {
    let out = game;
    if (!out.steamAppId) {
      const donor = igdb.find((g) => sameName(g.name, out.name) && g.steamAppId)
        || rawg.find((g) => sameName(g.name, out.name) && g.steamAppId);
      if (donor) out = { ...out, steamAppId: donor.steamAppId };
    }
    if (!out.coverUrl) {
      const donor = all.find((g) => sameName(g.name, out.name) && g.coverUrl);
      if (donor) out = { ...out, coverUrl: donor.coverUrl };
    }
    return out;
  });

  // One entry per name, preferring the one with NO release date — an unreleased
  // entry is the more useful answer when a title appears both ways.
  const byName = new Map();
  for (const game of filled) {
    const key = String(game.name ?? '').toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(game);
  }
  return [...byName.values()].map((group) => group.find((g) => !g.releaseDate) || group[0]);
}

// Search every provider. Never rejects: an unavailable provider contributes nothing.
//
// Returns { results, counts } — counts feed the one log line the routes emit, and
// tell a caller which providers actually answered without exposing why they didn't.
async function searchAll(query, { limit = LIMIT_SEARCH } = {}) {
  const empty = { igdb: 'skipped', rawg: 'skipped', thegamesdb: 'skipped' };
  const term = String(query ?? '').trim();
  if (!term) return { results: [], providers: empty, counts: { igdb: 0, rawg: 0, thegamesdb: 0 }, degraded: false };

  const [igdb, rawg, thegamesdb] = await Promise.all([
    searchIgdb(term, limit),
    searchRawg(term, limit),
    searchTheGamesDb(term, limit),
  ]);
  const providers = { igdb: igdb.status, rawg: rawg.status, thegamesdb: thegamesdb.status };
  return {
    results: mergeResults(igdb.results, rawg.results, thegamesdb.results),
    providers,
    counts: { igdb: igdb.results.length, rawg: rawg.results.length, thegamesdb: thegamesdb.results.length },
    // `degraded` is the one bit a caller usually wants: at least one provider that
    // should have answered did not, so "no results" is not evidence of absence.
    degraded: Object.values(providers).includes('failed'),
  };
}

// The best candidate for an EXISTING library entry: an exact, case-insensitive title
// match. Deliberately strict — a fuzzy match here silently rewrites the user's game
// with a different game's date and cover.
function findExactMatch(results, name) {
  const target = String(name ?? '').toLowerCase();
  if (!target) return null;
  return results.find((g) => String(g.name ?? '').toLowerCase() === target) || null;
}

module.exports = {
  TIMEOUT_MS, LIMIT_SEARCH, LIMIT_REFRESH,
  searchIgdb, searchRawg, searchTheGamesDb,
  igdbDate, parseLooseDate, theGamesDbCover,
  mergeResults, searchAll, findExactMatch,
};
