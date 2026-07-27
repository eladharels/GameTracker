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
const { serviceError, CODES } = require('./errors');
const { sanitizeText } = require('../user-rules');

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
      `search "${safeQuery}"; ${IGDB_FIELDS} limit ${limit};`,
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
    // see mergeResults: a nameless row rejects the search
    const rows = games.map(igdbRow).filter((game) => game.name);
    return { status: 'ok', results: rows };
  } catch (err) {
    logProviderError('IGDB', err);
    return { status: 'failed', results: [] };
  }
}

// The IGDB shape -> ours. EXTRACTED rather than left inline because fetchById asks the
// same endpoint with a different clause and must produce a byte-identical row: a game
// added by id and the same game added from a search result have to store the same
// cover, date and Steam App ID, or "add by id" quietly becomes a second normalisation
// with its own bugs. Same reasoning for the RAWG and TheGamesDB siblings below.
function igdbRow(game) {
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
}

// The field list is shared so the two IGDB calls cannot ask for different columns —
// igdbRow reads all of them and a missing one silently normalises to null.
const IGDB_FIELDS = 'fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid;';

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
    const rows = await Promise.all(games.map(async (game) =>
      rawgRow(game, await rawgSteamAppId(game.id, key))));
    return { status: 'ok', results: rows.filter((game) => game.name) };
  } catch (err) {
    logProviderError('RAWG', err);
    return { status: 'failed', results: [] };
  }
}

function rawgRow(game, steamAppId) {
  return {
    id: 'rawg_' + game.id,
    name: game.name,
    // `?? null`, not the bare property: RAWG omits `released` on an unannounced game,
    // and undefined disappears from JSON.stringify — a client would see the key
    // missing rather than explicitly dateless, and every other row here says null.
    releaseDate: game.released ?? null,
    coverUrl: game.background_image ?? null,
    source: 'rawg',
    steamAppId: steamAppId ?? null,
  };
}

// One game's Steam App ID, or null. Never throws: a detail lookup failing must cost
// that one id, not the whole provider's results.
async function rawgSteamAppId(gameId, key) {
  try {
    const detail = await axios.get(`https://api.rawg.io/api/games/${encodeURIComponent(gameId)}`, {
      ...REQUEST,
      params: { key },
    });
    return steamAppIdFromStores(detail.data.stores);
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
      || TGDB_IMAGE_BASE;
    // NOT data.include.boxart.data — the map is keyed directly on include.boxart.
    const boxartById = data.include?.boxart || {};

    const rows = games.slice(0, limit)
      .map((game) => theGamesDbRow(game, boxartById, baseUrl))
      .filter((game) => game.name);
    return { status: 'ok', results: rows };
  } catch (err) {
    logProviderError('TheGamesDB', err);
    return { status: 'failed', results: [] };
  }
}

function theGamesDbRow(game, boxartById, baseUrl) {
  return {
    id: 'thegamesdb_' + game.id,
    name: game.game_title || game.game_name || '',
    releaseDate: parseLooseDate(game.release_date),
    coverUrl: theGamesDbCover(boxartById[game.id], baseUrl),
    source: 'thegamesdb',
    // TheGamesDB does not expose Steam App IDs. mergeResults() may still fill one
    // in from an IGDB or RAWG result for the same title.
    steamAppId: null,
  };
}

// TheGamesDB's default image base, used when the response omits it.
const TGDB_IMAGE_BASE = 'https://cdn.thegamesdb.net/images/';

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

// --- The v2 surface ---------------------------------------------------------
//
// searchAll and findExactMatch above are the primitives the v1 routes already use.
// Everything below is the layer /api/v2 needs and v1 never had: input validation that
// throws instead of being re-decided per route, a total-outage signal, and resolution
// of a game reference to a game.

const MAX_QUERY = 200;

// GameRef, parsed. The pattern is the one in openapi/gametracker-v2.yaml — the two are
// kept in step by test/openapi.test.js rather than by remembering.
const GAME_REF_PATTERN = '^(igdb|rawg|thegamesdb)_[A-Za-z0-9_-]+$';
const GAME_REF = /^(igdb|rawg|thegamesdb)_([A-Za-z0-9_-]+)$/;
const MAX_REF = 200;

function parseGameRef(ref) {
  const value = typeof ref === 'string' || typeof ref === 'number' ? String(ref).trim() : '';
  if (!value || value.length > MAX_REF) return null;
  const m = GAME_REF.exec(value);
  if (!m) return null;
  return { ref: value, source: m[1], id: m[2] };
}

// Validated search. The adapter does no checking of its own — that is the whole point
// of the service layer, and v1's route open-coded `if (!query)` and nothing else.
//
// Throws `provider_unavailable` when NOT ONE provider answered. A caller cannot
// distinguish that from "no such game" by looking at an empty array, and an LLM-driven
// client reading `[]` will state as fact that a game does not exist. `degraded` covers
// the partial case; this covers the total one.
//
// The test is "did anybody answer", not "did everybody fail", and the difference is a
// real deployment: an instance with no API keys configured at all reports every
// provider `skipped`, which is not a failure — so the every-failed form let it answer
// 200 with an empty list to every search forever, and told an agent that no game in
// existence exists. One provider answering is enough; `degraded` reports the rest.
//
// `deps` is a TEST SEAM, not configuration. searchAll is called through it because a
// direct call to a function in this module cannot be intercepted — the same trap
// CLAUDE.md records for destructured `db.promises` bindings, where the stub is
// installed, never called, and the assertion passes against nothing. The rules below
// (total outage is a 502, a skipped provider is not an outage) are the point of this
// function, and a rule no test can reach is a rule that decays.
async function search(query, { limit = LIMIT_SEARCH } = {}, deps = {}) {
  const searchProviders = deps.searchAll || searchAll;
  const term = String(query ?? '').trim();
  if (!term) {
    throw serviceError(CODES.VALIDATION, 'q is required', { field: 'q' });
  }
  if (term.length > MAX_QUERY) {
    throw serviceError(CODES.VALIDATION,
      `q must be at most ${MAX_QUERY} characters`, { field: 'q' });
  }
  const result = await searchProviders(term, { limit: boundedLimit(limit) });
  if (nobodyAnswered(result.providers)) {
    throw serviceError(CODES.PROVIDER_UNAVAILABLE, 'no catalog provider answered');
  }
  return result;
}

// Did any provider actually answer?
//
// THE rule, in one place, because every caller that reports "not found" has to consult
// it first. `degraded` is not that rule: it means "at least one failed", so a lookup
// where all three were SKIPPED — an instance with no API keys — is not degraded and
// still asked nobody. The metadata refresh had exactly that bug, reporting every game
// in the library as not existing in any database on an instance that had never been
// given a key. Exported so the two v2 callers and the v1 refresh route share it.
function nobodyAnswered(providers) {
  return !Object.values(providers || {}).includes('ok');
}

// 1..LIMIT_SEARCH. A caller-supplied limit multiplies outbound provider traffic — the
// RAWG path costs one extra request PER RESULT — so this clamps rather than trusting.
function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return LIMIT_SEARCH;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_SEARCH) {
    throw serviceError(CODES.VALIDATION,
      `limit must be an integer between 1 and ${LIMIT_SEARCH}`, { field: 'limit' });
  }
  return n;
}

// Resolve one game reference to a game, asking ONLY the provider that issued it.
//
// Returns {status, game}: 'ok' with a game, 'ok' with null when that provider is
// certain there is no such game, 'skipped' when the provider is not configured, and
// 'failed' when it was asked and did not answer. Those last two are why this does not
// simply return the game or null — "we could not ask" must not be reported as "no such
// game", which is the same distinction searchAll's provider statuses exist for.
async function fetchById(ref) {
  const parsed = parseGameRef(ref);
  if (!parsed) {
    throw serviceError(CODES.VALIDATION,
      'gameId must look like igdb_12345, rawg_3498 or thegamesdb_1234', { field: 'gameId' });
  }
  if (parsed.source === 'igdb') return fetchIgdbById(parsed.id);
  if (parsed.source === 'rawg') return fetchRawgById(parsed.id);
  return fetchTheGamesDbById(parsed.id);
}

// The APIcalypse body for a by-id lookup, or null if the id cannot be one.
//
// DIGITS ONLY, and the reason is not the GameRef pattern. This value lands in a `where`
// CLAUSE, not inside a quoted string literal, so escapeIgdbSearch — the module that
// exists precisely to make interpolation safe — does not apply here: there is no
// quoting to escape, and anything that is not a bare number is simply more query.
// `igdb_1;fields *` satisfies GameRef's pattern in full.
//
// A separate exported function rather than an inline `if`, so a test can assert the
// STRING THAT IS ACTUALLY SENT. Asserting that fetchIgdbById returns null for a bad id
// would pass just as well against a version that built the query first and threw the
// result away — the query text is the safety property, so the query text is what the
// test reads. (Same reasoning as CLAUDE.md's rule for SQL that is itself a control.)
function igdbByIdQuery(id) {
  if (!/^\d+$/.test(String(id))) return null;
  return `where id = ${id}; ${IGDB_FIELDS} limit 1;`;
}

async function fetchIgdbById(id) {
  const clientId = resolveApiKey('IGDB_CLIENT_ID');
  const bearerToken = resolveApiKey('IGDB_BEARER_TOKEN');
  if (!clientId || !bearerToken) return { status: 'skipped', game: null };
  const body = igdbByIdQuery(id);
  // null means the id could not be put into a query safely — see igdbByIdQuery. Not a
  // provider failure: there is no such game, because there is no such IGDB id.
  if (!body) return { status: 'ok', game: null };
  try {
    const response = await axios.post(
      'https://api.igdb.com/v4/games',
      body,
      {
        ...REQUEST,
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${bearerToken}`,
          'Accept': 'application/json',
        },
      }
    );
    const game = (response.data || [])[0];
    if (!game || !game.name) return { status: 'ok', game: null };
    return { status: 'ok', game: igdbRow(game) };
  } catch (err) {
    logProviderError('IGDB', err);
    return { status: 'failed', game: null };
  }
}

async function fetchRawgById(id) {
  const key = resolveApiKey('RAWG_API_KEY');
  if (!key) return { status: 'skipped', game: null };
  try {
    const detail = await axios.get(
      `https://api.rawg.io/api/games/${encodeURIComponent(id)}`,
      { ...REQUEST, params: { key } }
    );
    const game = detail.data;
    if (!game?.name) return { status: 'ok', game: null };
    // The detail response already carries `stores`, so the search path's extra
    // per-result request is not needed here — but the extraction must stay identical,
    // which is why it is one function called by both.
    return { status: 'ok', game: rawgRow(game, steamAppIdFromStores(game.stores)) };
  } catch (err) {
    // A 404 is an ANSWER — that game does not exist — not a provider failure. Treating
    // it as one would turn a mistyped id into a 502 that invites a retry loop.
    if (err?.response?.status === 404) return { status: 'ok', game: null };
    logProviderError('RAWG', err);
    return { status: 'failed', game: null };
  }
}

async function fetchTheGamesDbById(id) {
  const key = resolveApiKey('THEGAMESDB_API_KEY');
  if (!key) return { status: 'skipped', game: null };
  if (!/^\d+$/.test(id)) return { status: 'ok', game: null };
  try {
    const response = await axios.get('https://api.thegamesdb.net/v1/Games/ByGameID', {
      ...REQUEST,
      params: { apikey: key, id, include: 'boxart' },
    });
    const data = response.data;
    const raw = data?.data?.games;
    const games = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const game = games[0];
    if (!game) return { status: 'ok', game: null };
    const baseUrl = data.include?.base_url?.image_base
      || data.data?.base_url?.image_base
      || TGDB_IMAGE_BASE;
    const row = theGamesDbRow(game, data.include?.boxart || {}, baseUrl);
    return { status: 'ok', game: row.name ? row : null };
  } catch (err) {
    logProviderError('TheGamesDB', err);
    return { status: 'failed', game: null };
  }
}

// Resolve "which game does the caller mean" — by reference, or by name.
//
// THE MATCH RULE LIVES HERE, on the server, because there are three clients and only
// one of them is in this repository. v1 pushed it onto them: search, pick, post the id
// back. The web app implemented "pick" one way, the Android app another, and the MCP
// would have invented a third — and an LLM picking a title out of twenty candidates is
// exactly the client you least want deciding it.
//
// AMBIGUITY IS A REFUSAL, NEVER A GUESS. Anything other than one exact,
// case-insensitive title match throws CONFLICT carrying the candidates, so a caller
// resolves it and retries with an id. Zero matches is the same refusal as five: both
// are "this did not resolve to exactly one game", and inventing a nearest-title match
// here would silently add the wrong game to somebody's library.
//
// Never touches the database — the caller writes. Keeping the provider knowledge out
// of services/library.js and the SQL out of this file is what stops either from
// growing a second copy of the other's rules.
async function resolveGame({ gameId, name } = {}, deps = {}) {
  const doFetch = deps.fetchById || fetchById;
  const doSearch = deps.search || search;
  const hasId = gameId !== undefined && gameId !== null && String(gameId).trim() !== '';
  const hasName = name !== undefined && name !== null && String(name).trim() !== '';
  if (hasId && hasName) {
    throw serviceError(CODES.VALIDATION, 'supply gameId or name, not both', { field: 'gameId' });
  }
  if (!hasId && !hasName) {
    throw serviceError(CODES.VALIDATION, 'supply gameId or name', { field: 'gameId' });
  }

  if (hasId) {
    const { status, game } = await doFetch(gameId);
    // 'failed' and 'skipped' both mean THE QUESTION COULD NOT BE ASKED. Answering
    // "no such game" for either would be a lie the caller acts on — and for an agent
    // retrying an add, a lie that looks like a permanent 400 rather than a transient
    // one. The message is not exposed (see services/problem.js), so the two do not
    // leak which providers this instance has keys for.
    if (status !== 'ok') {
      throw serviceError(CODES.PROVIDER_UNAVAILABLE,
        status === 'skipped'
          ? 'that provider is not configured on this instance'
          : 'that provider could not be reached');
    }
    if (!game) {
      throw serviceError(CODES.VALIDATION, 'no game with that id', { field: 'gameId' });
    }
    return game;
  }

  // search() throws PROVIDER_UNAVAILABLE when EVERY provider failed, so an empty
  // result set below always means "asked, and nobody had it" — which is what makes
  // the refusal honest.
  const result = await doSearch(name);
  const match = findExactMatch(result.results, name);
  if (match) return match;
  throw serviceError(CODES.CONFLICT,
    `"${sanitizeText(name, 80)}" did not resolve to exactly one game`,
    { candidates: result.results });
}

// Shared by the RAWG search detail lookup and the RAWG by-id fetch.
function steamAppIdFromStores(stores) {
  const steamStore = (stores || []).find((s) => s.store && s.store.id === 1 && s.url_en);
  const match = steamStore?.url_en?.match(/\/app\/(\d+)/);
  return match ? match[1] : null;
}

module.exports = {
  TIMEOUT_MS, LIMIT_SEARCH, LIMIT_REFRESH, MAX_QUERY,
  searchIgdb, searchRawg, searchTheGamesDb,
  igdbDate, parseLooseDate, theGamesDbCover,
  mergeResults, searchAll, findExactMatch,
  search, fetchById, resolveGame, parseGameRef, boundedLimit, steamAppIdFromStores,
  igdbByIdQuery, GAME_REF_PATTERN, nobodyAnswered,
};
