const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
// PostgreSQL. `db` keeps the same run/get/all callback surface node-sqlite3 had,
// so the call sites below are unchanged -- see db.js for why.
const db = require('./db');
const { migrateOrExit } = require('./schema-migrate');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
// JWT_SECRET must be supplied via the environment (.env / docker-compose). There is
// no hardcoded fallback: a shared/default secret lets anyone forge admin tokens.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'supersecretkey' || JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET is missing, too short, or set to the insecure default. ' +
    'Set a strong JWT_SECRET (>=16 chars) in the environment before starting.');
  process.exit(1);
}
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');
// ldapjs itself is no longer required here -- createLdapClient() is the only way
// this file should ever construct a client, and it lives in ./ldap-helpers.js.
const {
  buildUserSearchFilter,
  createLdapClient,
  warnIfCleartextLdap,
  entryAttributes,
  attrValue,
  attrValues,
  compatTreeAdvice,
} = require('./ldap-helpers');
// escapeIgdbSearch is no longer used here: every APIcalypse literal in the server
// is now built inside services/catalog.js, which is the point of the extraction.
const { loadSettings, resolveApiKey } = require('./settings-store');
// Service layer. Route handlers are adapters over these: they do auth and HTTP,
// the services do the work. Lets /api and the coming /api/v2 be two skins over one
// implementation instead of two implementations that drift.
const sharesService = require('./services/shares');
const libraryService = require('./services/library');
const catalogService = require('./services/catalog');
const jobsService = require('./services/jobs');
const usersService = require('./services/users');
const authService = require('./services/auth');
const settingsService = require('./services/settings');
const notifications = require('./services/notifications');
const { CODES: SVC } = require('./services/errors');
// One table maps a service error code to a status and decides whether its message
// may be shown to the caller. See services/problem.js — `expose` is the point.
const problem = require('./services/problem');
const { sanitizeText: sanitizeDirectoryText, RESERVED_USERNAMES, isValidEmailAddress, validatePassword } = require('./user-rules');

// Upper bound on PUT /api/user/:username/backlog-reorder.
const MAX_BACKLOG_REORDER = 1000;

const app = express();
const PORT = process.env.PORT || 3000;

// True only when this file is the process entry point (`node index.js`), false when
// a utility script `require`s it for its exports.
//
// The listener at the bottom of the file already keys off this. Background
// SCHEDULERS have to as well, and did not: `cron.schedule()` ran at module scope, so
// `node run_notifications.js` registered all three cron jobs as an import side
// effect. node-cron's timers keep the event loop alive, so the script printed
// "complete", closed the pool, and then hung forever.
//
// A stray process left hanging past the scheduled times then re-ran the jobs. The
// 03:00 price job and the 08:00 notification job both open with a query, so against
// the script's closed pool they fail immediately and do nothing. The 04:00 CrackWatch
// job touches no database at all -- it pages the CrackWatch API and rewrites the
// cache file -- so that one really did run a full unrequested sweep.
const isServerProcess = require.main === module;

// cron.schedule(), but only in the server process. Returns null in a script so a
// caller cannot accidentally act on a task that was never created.
function scheduleWhenServer(expression, handler) {
  if (!isServerProcess) return null;
  return cron.schedule(expression, handler);
}

// Trust the reverse proxy (nginx) in front of us so req.ip reflects the real client
// address (from X-Forwarded-For) rather than the proxy's — required for per-IP login
// rate limiting to work. Default to one hop; override with TRUST_PROXY if the topology
// differs. Do NOT set to `true` (trust all hops) — that lets clients spoof X-Forwarded-For.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);

// Simple rate limiting for login attempts
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

// CORS: browser calls from the web app are same-origin (nginx proxies /api to the
// backend), so no cross-origin allowance is needed by default. Any cross-origin
// browser origin that legitimately needs access can be allowlisted via CORS_ORIGINS
// (comma-separated). Non-browser clients (mobile app, curl) ignore CORS entirely, so
// route-level auth — not CORS — is what actually protects the data.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Allow non-browser / same-origin requests (no Origin header) and any explicitly
    // allowlisted origin; reject everything else (no ACAO header emitted).
    if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
app.use(express.json());

// Security headers
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Basic XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip || req.connection.remoteAddress}`);
  next();
});

// The connection pool is created on require of ./db. Connections are established
// lazily, so a first-query failure -- not a require-time throw -- is how an
// unreachable database surfaces. The migration runner below is what actually
// proves the database is reachable and correctly shaped before we serve traffic.

// Schema creation + migrations now live in ./schema-migrate.js and migrations/*.sql.
//
// The previous implementation issued CREATE TABLE / ALTER TABLE statements whose
// error callbacks discarded anything that was not "duplicate column name". On a
// FRESH database the ALTERs raced the CREATEs, lost, and were silently swallowed,
// shipping installs missing user_games.backlog_order, users.telegram_chat_id,
// users.ntfy_url and users.gotify_url. Postgres removes the race, but the real
// defect was the swallowing -- so the replacement is transactional, tracked in a
// schema_migrations table, and FATAL on any error. See schema-migrate.js.

// Ensure root user exists.
//
// Promise-based, and the INSERT is AWAITED. It used to be a fire-and-forget db.run
// with no callback at all, which under the connection pool meant the row could be
// abandoned -- pool.end() drops queries still waiting for a connection without
// invoking their callbacks. The banner below would then print a generated password
// for an account that was never created, and nothing would report the failure.
// The password is shown exactly once, so that is unrecoverable without a manual
// reset. Announce the account only after the write is known to have landed.
const ensureRootUser = () => new Promise((resolve) => {
  db.get('SELECT * FROM users WHERE username = ?', ['root'], async (err, user) => {
    if (err) {
      console.error('[FATAL] Could not check for the root user:', err.message);
      return resolve();
    }
    if (user) return resolve();

    // Use an operator-supplied ROOT_PASSWORD, or generate a strong random one and
    // print it ONCE at first boot — never ship a well-known default password.
    let rootPassword = process.env.ROOT_PASSWORD;
    let generated = false;
    if (!rootPassword) {
      rootPassword = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
    try {
      const hash = await bcrypt.hash(rootPassword, 10);
      await db.query(
        'INSERT INTO users (username, password, can_manage_users, origin, display_name) VALUES (?, ?, 1, ?, ?)',
        ['root', hash, 'local', 'root']
      );
    } catch (insertErr) {
      console.error('[FATAL] Could not create the root user:', insertErr.message);
      return resolve();
    }
    if (generated) {
      console.log('====================================================================');
      console.log('Root user created with a GENERATED password (shown only once):');
      console.log('    ' + rootPassword);
      console.log('Log in as root and change it immediately, or set ROOT_PASSWORD.');
      console.log('====================================================================');
    } else {
      console.log('Root user created with the operator-supplied ROOT_PASSWORD.');
    }
    resolve();
  });
});

// Schema first, THEN the root user — ensureRootUser queries `users`, so running it
// before the tables exist raced the schema and failed with "no such table".
// migrateOrExit() terminates the process if the schema cannot be brought up to
// date, so nothing below ever runs against an unknown schema.
//
// Exported as `schemaReady` so the listener at the bottom of this file can wait
// on it. Without that the port opened before the tables existed and /api/health
// — the deploy gate — answered "ok" against an empty database.
//
// SERVER ONLY. Migrating the schema and seeding an administrator are DEPLOYMENT
// actions, not library ones, and this ran unconditionally at module scope -- so
// `node run_notifications.js` migrated production's schema as an import side effect,
// and on an empty database it also created the root user. It additionally raced that
// script's own db.close(), which surfaced as a bewildering "Cannot use a pool after
// calling end" from a notification script.
//
// A script running inside the backend container is, by construction, pointed at an
// already-migrated database. If it somehow is not, failing on a missing column is a
// far better outcome than silently migrating production from a maintenance script.
const schemaReady = isServerProcess
  ? migrateOrExit().then(() => ensureRootUser())
  : Promise.resolve();

// Helper: look up a user WITHOUT creating one.
//
// Use this everywhere except the LDAP login path. `getOrCreateUser` below INSERTs
// on a miss, so using it to *read* meant any request naming an unknown user
// silently provisioned a passwordless account — which then showed up in
// /api/all-users and the library-sharing picker. Reads call this and 404 instead.
//
// Calls back with (null, null) when the user does not exist; that is not an error.
function findUser(username, cb) {
  const normalizedUsername = username ? String(username).toLowerCase() : '';
  if (!normalizedUsername) return cb(null, null);
  db.get('SELECT * FROM users WHERE username = ?', [normalizedUsername], (err, user) => {
    if (err) return cb(err);
    cb(null, user || null);
  });
}

// Wrapper for the common route shape: resolve :username or end the response.
// Returns true when the caller should stop (a response has already been sent).
function withExistingUser(res, username, cb) {
  findUser(username, (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    cb(user);
  });
}

// Helper: get or create user.
//
// ONLY for the LDAP login path, where a successful directory authentication must
// provision a local row for a first-time user. Everything else must use findUser
// / withExistingUser — see the note above.
function getOrCreateUser(username, cb, opts = {}) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  db.get('SELECT * FROM users WHERE username = ?', [normalizedUsername], (err, user) => {
    if (user) {
      // Optionally update display_name/origin if provided
      if (opts.display_name || opts.origin) {
        db.run('UPDATE users SET display_name = COALESCE(?, display_name), origin = COALESCE(?, origin) WHERE username = ?', [opts.display_name, opts.origin, normalizedUsername]);
      }
      return cb(null, user);
    }
    // Use CN if provided and non-empty, otherwise fallback to username
    const displayNameToUse = (typeof opts.display_name === 'string' && opts.display_name.trim() !== '' ? opts.display_name : normalizedUsername);
    console.log('Creating user:', { username: safeForLog(normalizedUsername, 64), display_name: safeForLog(displayNameToUse, 64), origin: opts.origin });
    // RETURNING id: Postgres does not hand back an insert id implicitly the way
    // SQLite's lastID did. Without this clause `this.lastID` is undefined.
    db.run('INSERT INTO users (username, created_at, origin, display_name) VALUES (?, ?, ?, ?) RETURNING id', [normalizedUsername, new Date().toISOString(), opts.origin || 'local', displayNameToUse], function (err) {
      if (err) return cb(err);
      cb(null, { id: this.lastID, username: normalizedUsername, created_at: new Date().toISOString(), origin: opts.origin || 'local', display_name: displayNameToUse });
    });
  });
}

// Health check endpoint.
//
// UNAUTHENTICATED — it is the deploy gate and the container healthcheck, so it must
// stay open. That means it must also stay boring: it used to return the user count,
// the root account's id and username, and the raw DB error message to anyone who
// asked. Operational detail belongs in the admin-only /api/system-status.
app.get('/api/health', (req, res) => {
  db.get('SELECT 1', [], (err) => {
    if (err) {
      console.error('[Health] Database error:', err.message);
      return res.status(500).json({ status: 'error' });
    }
    res.json({ status: 'ok' });
  });
});

// --- System status last-OK persistence ---
// Directory for PURELY EPHEMERAL caches (system status, CrackWatch). These are
// rebuilt from scratch whenever they are missing and have never been persisted --
// neither file was ever bind-mounted, so both were already destroyed on every
// redeploy. Making the location configurable lets compose point them at a tmpfs,
// which is what allows the backend container to run with read_only: true.
// Defaults to __dirname, so behaviour is unchanged when CACHE_DIR is unset.
const CACHE_DIR = process.env.CACHE_DIR || __dirname;

const STATUS_CACHE_FILE = path.join(CACHE_DIR, 'system-status-cache.json');
let statusOkCache = {}; // { serviceName: { lastOk: ISO, latency: ms } }

(function loadStatusOkCache() {
  try {
    if (fs.existsSync(STATUS_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_CACHE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') statusOkCache = raw;
    }
  } catch { /* start fresh if file is corrupt */ }
})();

function saveStatusOkCache() {
  try { fs.writeFileSync(STATUS_CACHE_FILE, JSON.stringify(statusOkCache, null, 2), 'utf8'); } catch { /* non-fatal */ }
}

// System status endpoint — checks all external API connections
app.get('/api/system-status', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  try {
    // Strip URLs from error messages to prevent API keys in query params leaking back to the client
    const safeMessage = (err) => {
      const msg = err.response?.data?.message || err.response?.data?.status_message
                || (Array.isArray(err.response?.data) && err.response.data[0]?.title)
                || err.message || 'Unknown error';
      return String(msg).replace(/https?:\/\/\S*/gi, '[URL redacted]');
    };

    const check = async (name, fn) => {
      const start = Date.now();
      try {
        const meta = await fn();
        const latency = Date.now() - start;
        // Update cache in an isolated try so a file-write error never poisons the service result
        try {
          statusOkCache[name] = { lastOk: new Date().toISOString(), latency };
          saveStatusOkCache();
        } catch { /* non-fatal */ }
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
    };

    const dbCheck = () => new Promise((resolve, reject) => {
      db.get('SELECT 1', [], (err) => err ? reject(err) : resolve());
    });

    const igdbClientId    = resolveApiKey('IGDB_CLIENT_ID');
    const igdbBearerToken = resolveApiKey('IGDB_BEARER_TOKEN');
    const rawgApiKey      = resolveApiKey('RAWG_API_KEY');
    const tgdbApiKey      = resolveApiKey('THEGAMESDB_API_KEY');
    const cacheSize       = Object.keys(crackWatchCache).length;

    const checks = await Promise.all([
      check('database', dbCheck),

      (igdbClientId && igdbBearerToken)
        ? check('igdb', () => axios.post(
            'https://api.igdb.com/v4/games',
            'fields id; limit 1;',
            { headers: { 'Client-ID': igdbClientId, 'Authorization': `Bearer ${igdbBearerToken}`, 'Accept': 'application/json' }, timeout: 8000 }
          ))
        : { name: 'igdb', status: 'unconfigured', message: 'IGDB_CLIENT_ID or IGDB_BEARER_TOKEN not set' },

      rawgApiKey
        ? check('rawg', () => axios.get('https://api.rawg.io/api/games', { params: { key: rawgApiKey, page_size: 1, search: 'tetris' }, timeout: 8000 }))
        : { name: 'rawg', status: 'unconfigured', message: 'RAWG_API_KEY not set' },

      tgdbApiKey
        ? check('thegamesdb', () => axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', { params: { apikey: tgdbApiKey, name: 'tetris', 'fields[games]': 'id' }, timeout: 8000 }))
        : { name: 'thegamesdb', status: 'unconfigured', message: 'THEGAMESDB_API_KEY not set (optional)' },

      check('steam', () => axios.get('https://store.steampowered.com/api/featured', { timeout: 8000 })),

      cacheSize > 0
        ? Promise.resolve({ name: 'crackwatch', status: 'ok', message: `Cache has ${cacheSize} titles` })
        : check('crackwatch', () => axios.get('https://api.crackwatch.com/api/games', { params: { page: 0, sort_by: 'release_date' }, timeout: 8000 }))
            .then(r => ({ ...r, message: r.status === 'ok' ? 'Reachable (cache empty — run a refresh)' : r.message })),
    ]);

    // Merge persisted last-OK timestamps into each result
    const enriched = checks.map(c => ({
      ...c,
      lastOk:        statusOkCache[c.name]?.lastOk    || null,
      lastOkLatency: statusOkCache[c.name]?.latency   || null,
    }));

    const allOk = enriched.every(c => c.status === 'ok' || c.status === 'unconfigured');
    res.json({ overall: allOk ? 'ok' : 'degraded', services: enriched, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[System Status] Unexpected error:', err.message);
    res.status(500).json({ error: 'System status check failed: ' + err.message });
  }
});

// Unified search endpoint: IGDB + RAWG + TheGamesDB
app.get('/api/games/search', authRequired, async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing search query' });
  }
  try {
    const { results, counts, providers, degraded } = await catalogService.searchAll(query);
    console.log(`[Search] Query: "${safeForLog(query, 100)}", Results: ${results.length} games `
      + `(IGDB: ${counts.igdb}/${providers.igdb}, RAWG: ${counts.rawg}/${providers.rawg}, `
      + `TheGamesDB: ${counts.thegamesdb}/${providers.thegamesdb})`);
    // Still a bare array: v1's shape, and the SPA does `Array.isArray(res.data) ? ... : []`.
    // The partial-results signal goes in a header so it can be added without breaking
    // that, and so /api/v2 can put it in the envelope where it belongs.
    if (degraded) res.set('X-Catalog-Degraded', '1');
    res.json(results);
  } catch (error) {
    // searchAll degrades rather than rejecting — every provider has its own catch —
    // so reaching here means something structural, not a provider being down. The
    // message is NOT echoed: it would carry provider detail. (v1 sent err.message.)
    console.error('[Search] Failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch games from providers' });
  }
});

// Test endpoint for IGDB connectivity.
//
// Goes through catalogService.searchIgdb rather than calling axios itself. It used to
// be a fifth copy of the provider call, and it had drifted in three ways that this
// slice had just fixed everywhere else: no timeout, an unguarded
// `new Date(ts * 1000).toISOString()` that throws on an out-of-range value, and — the
// one that mattered — it returned `error.response.data`, the raw IGDB error body, to
// the caller. Admin-only, so the disclosure is to someone who can already read the
// keys in Settings; but it contradicted the policy stated at the top of
// services/catalog.js sixty lines above it.
app.get('/api/test/igdb', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  const testQuery = req.query.q || 'Mario';
  const hasClientId = !!resolveApiKey('IGDB_CLIENT_ID');
  const hasBearerToken = !!resolveApiKey('IGDB_BEARER_TOKEN');
  const testInfo = {
    credentials: {
      clientId: hasClientId ? 'SET' : 'MISSING',
      bearerToken: hasBearerToken ? 'SET' : 'MISSING',
      bothPresent: hasClientId && hasBearerToken,
    },
    testQuery,
  };

  if (!hasClientId || !hasBearerToken) {
    return res.status(400).json({ error: 'IGDB credentials missing', ...testInfo });
  }

  const { status, results } = await catalogService.searchIgdb(testQuery, 5);
  if (status !== 'ok') {
    // The reason is in the server log, sanitised by catalog's own egress filter.
    return res.status(502).json({
      success: false,
      ...testInfo,
      error: 'IGDB request failed — see the server log for the status and message.',
    });
  }
  res.json({
    success: true,
    ...testInfo,
    results: {
      count: results.length,
      games: results.map((g) => ({
        id: g.id,
        name: g.name,
        releaseDate: g.releaseDate,
        hasCover: !!g.coverUrl,
      })),
    },
  });
});

// --- CrackWatch cache (Option B: cached crack status) ---
// Ephemeral — see CACHE_DIR above.
//
// These two constants were deleted by accident in the catalog slice: that commit
// replaced the /api/test/igdb route using this function name as its end boundary,
// and swallowed the block in between. Every reference sits inside a try/catch, so
// nothing crashed — the cache silently stopped loading and saving, and the refresh
// broke out of its pagination loop after page 0.
const CRACKWATCH_CACHE_FILE = path.join(CACHE_DIR, 'crackwatch-cache.json');
const CRACKWATCH_RATE_MS = 1200; // 1.2s between requests to respect API limit

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

/** In-memory cache: normalizedTitle -> true (cracked) | false (uncracked). Unknown = not in cache. */
let crackWatchCache = Object.create(null);

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
// on a truncated file — which markNotificationSent can produce, since it rewrites
// sent_notifications.json with a bare writeFileSync on every reminder. A container
// kill mid-write would then have made the backend AND every operator script
// unbootable, including the ones you would use to diagnose it. Reconstructible caches
// must keep degrading.
//
// The real prevention for the original defect is static: `no-undef` catches all four
// references before merge, on every path, whether or not it executes.
function rethrowIfReferenceError(err) {
  if (err instanceof ReferenceError) throw err;
}

function loadCrackWatchCacheFromFile() {
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

function saveCrackWatchCacheToFile() {
  try {
    fs.writeFileSync(CRACKWATCH_CACHE_FILE, JSON.stringify(crackWatchCache, null, 0), 'utf8');
    console.log('[CrackWatch] Saved cache to file,', Object.keys(crackWatchCache).length, 'titles');
  } catch (err) {
    rethrowIfReferenceError(err);
    console.warn('[CrackWatch] Could not save cache file:', err.message);
  }
}

/** Fetch all pages from CrackWatch API (rate-limited), merge into crackWatchCache. */
async function refreshCrackWatchCache() {
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
      await delay(CRACKWATCH_RATE_MS);
    } catch (err) {
      rethrowIfReferenceError(err);
      console.warn('[CrackWatch] Refresh error at page', page, err.message || err, err.response?.status);
      break;
    }
  }
  console.log('[CrackWatch] Cache refresh done. Total entries:', total, 'Cache size:', Object.keys(crackWatchCache).length);
  saveCrackWatchCacheToFile();
}

loadCrackWatchCacheFromFile();

// Cron: refresh CrackWatch cache daily at 4:00 AM
scheduleWhenServer('0 4 * * *', () => {
  console.log('[CRON] Refreshing CrackWatch cache...');
  refreshCrackWatchCache().catch((err) => console.error('[CRON] CrackWatch refresh failed:', err));
});

// Optional: run first refresh 30s after startup if cache is empty.
// Server only -- in a script this timer both held the event loop open for 30s and
// then kicked off a full CrackWatch sweep the operator never asked for.
if (isServerProcess) {
  setTimeout(() => {
    if (Object.keys(crackWatchCache).length === 0) {
      console.log('[CrackWatch] Cache empty, running initial refresh in background...');
      refreshCrackWatchCache().catch((err) => console.error('[CrackWatch] Initial refresh failed:', err));
    }
  }, 30000);
}

// Admin: manually trigger CrackWatch cache refresh
app.post('/api/admin/refresh-crackwatch-cache', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  try {
    await refreshCrackWatchCache();
    res.json({ success: true, message: 'CrackWatch cache refreshed', count: Object.keys(crackWatchCache).length });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed', details: err.message });
  }
});

// --- CrackRelease HTML scraper for single-game status (fallback when API host is down) ---
function slugifyForCrackRelease(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function getCrackReleaseStatus(gameName) {
  const slug = slugifyForCrackRelease(gameName);
  if (!slug) {
    return { status: 'unknown', url: null, slug, gameName };
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
    return { status, url, slug, gameName };
  } catch (err) {
    console.warn('[CrackRelease] Error fetching status for', gameName, '-', err.message);
    return { status: 'unknown', url, slug, gameName, error: err.message };
  }
}

// Admin: check CrackRelease status for a specific game name (used only for testing in staging UI)
app.post('/api/admin/crackrelease-status', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  const { gameName } = req.body || {};
  if (!gameName || typeof gameName !== 'string' || !gameName.trim()) {
    return res.status(400).json({ error: 'Missing or invalid gameName' });
  }
  try {
    const result = await getCrackReleaseStatus(gameName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch CrackRelease status', details: err.message });
  }
});

// Update a specific user's game with CrackRelease status and persist to DB
app.post('/api/user/:username/games/:gameId/crackrelease-status', authRequired, ownershipRequired, async (req, res) => {
  const { username, gameId } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !gameId) {
    return res.status(400).json({ error: 'Missing username or gameId' });
  }
  withExistingUser(res, normalizedUsername, (user) => {
    db.get('SELECT game_name FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId], async (err, row) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      if (!row) return res.status(404).json({ error: 'Game not found for this user' });
      try {
        const result = await getCrackReleaseStatus(row.game_name);
        db.run('UPDATE user_games SET crack_status = ? WHERE user_id = ? AND game_id = ?', [result.status, user.id, gameId], (updateErr) => {
          if (updateErr) {
            console.error('[CrackRelease] Failed to update crack_status in DB:', updateErr);
          }
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: 'Failed to fetch CrackRelease status', details: e.message });
      }
    });
  });
});

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

// Optional: check if CrackWatch cache is populated (for debugging "all unknown")
app.get('/api/crack-status/cache-info', authRequired, (req, res) => {
  const keys = Object.keys(crackWatchCache);
  res.json({ count: keys.length, sampleKeys: keys.slice(0, 5) });
});

// Get crack status for a user's library (from cache only)
app.get('/api/user/:username/crack-status', authRequired, ownershipRequired, (req, res) => {
  const { username } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername) return res.status(400).json({ error: 'Missing username' });

  withExistingUser(res, normalizedUsername, (user) => {
    db.all('SELECT game_id, game_name, crack_status FROM user_games WHERE user_id = ?', [user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      const statusByGameId = {};
      for (const row of rows) {
        const key = normalizeTitleForCrackWatch(row.game_name || '');
        const cached = crackWatchCache[key] ?? lookupCrackStatus(key);
        const combined = row.crack_status || (cached === true ? 'cracked' : cached === false ? 'uncracked' : 'unknown');
        statusByGameId[row.game_id] = combined || 'unknown';
      }
      res.json(statusByGameId);
    });
  });
});

// Remove the in-memory cache for Steam prices
app.get('/api/game-price/:steamAppId', authRequired, async (req, res) => {
  const { steamAppId } = req.params;
  if (!steamAppId) {
    return res.status(400).json({ error: 'Missing Steam App ID' });
  }
  try {
    const response = await axios.get(`https://store.steampowered.com/api/appdetails`, {
      params: {
        appids: steamAppId,
        cc: 'il', // Israeli store
        l: 'en',
      },
    });
    const data = response.data[steamAppId];
    if (!data.success) {
      return res.status(404).json({ error: 'Game not found on Steam' });
    }
    const priceOverview = data.data.price_overview;
    if (!priceOverview) {
      return res.status(404).json({ error: 'Price not available for this game' });
    }
    res.json({
      price: priceOverview.final_formatted,
      currency: priceOverview.currency,
      discount: priceOverview.discount_percent,
      original_price: priceOverview.initial_formatted,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch price from Steam', details: error.message });
  }
});

// --- Notification Settings ---
// settings.json access lives in ./settings-store.js — one reader, one writer, one
// mtime-validated cache, and one definition of the settings-over-env key precedence
// (resolveApiKey, imported above). See that file for why a second copy of either
// is a bug generator rather than a convenience.

// API Keys — admin-only read/write
app.get('/api/settings/apikeys', authRequired, requirePermission('can_manage_users'), (req, res) => {
  try {
    res.json(settingsService.listApiKeys());
  } catch (err) {
    console.error('[API Keys] Read failed:', err.message);
    res.status(500).json({ error: 'Failed to read API keys.' });
  }
});

app.post('/api/settings/apikeys', authRequired, requirePermission('can_manage_users'), express.json(), (req, res) => {
  try {
    settingsService.writeApiKeys(req.body || {});
    res.json({ success: true });
  } catch (err) {
    problem.send(res, err, { log: '[API Keys] Write failed:', fallback: 'Failed to save API keys.' });
  }
});

// Mint a fresh IGDB bearer token from Twitch and store it.
//
// Stays in the adapter: it is an outbound OAuth exchange with a third party, not a
// settings operation. The service is only asked to persist the result.
app.post('/api/settings/apikeys/refresh-igdb-token', authRequired, requirePermission('can_manage_users'), express.json(), async (req, res) => {
  const clientId = resolveApiKey('IGDB_CLIENT_ID');
  // Through the resolver, so IGDB_CLIENT_SECRET works from the environment like
  // every other key. Reading settings.json directly here meant GET /api/settings/apikeys
  // reported the secret as set (it checks env too) while this route insisted it was not.
  const clientSecret = resolveApiKey('IGDB_CLIENT_SECRET');
  if (!clientId) return res.status(400).json({ error: 'IGDB Client ID is not set. Add it in API Keys first.' });
  if (!clientSecret) return res.status(400).json({ error: 'IGDB Client Secret is not set. Add it in API Keys first.' });
  let access_token; let expires_in;
  try {
    // Credentials in the POST BODY, not in `params`. As a query string they land in
    // the request line, which every TLS-terminating proxy and access log on the path
    // records — and RFC 6749 §2.3.1 says body. axios sets the form content type for
    // URLSearchParams itself.
    const resp = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
    }), { timeout: 15000 });
    access_token = resp.data?.access_token;
    expires_in = resp.data?.expires_in;
    if (!access_token) return res.status(502).json({ error: 'Twitch returned no access_token in response' });
  } catch (err) {
    // safeForLog: this string comes from a third party (or from whatever proxy sits
    // in front of it) and goes to both the log and the response. Unbounded and
    // unsanitised, it can forge log lines — and a response that echoes the request
    // URI would have carried the client secret with it before the change above.
    const raw = err.response?.data?.message || err.response?.data?.error_description || err.message || 'Unknown error';
    const msg = safeForLog(raw, 200);
    console.error('[IGDB] Token refresh failed:', msg);
    return res.status(502).json({ error: 'Twitch token request failed: ' + msg });
  }

  // Persisting is a SEPARATE try. Inside the one above, a failed write to
  // settings.json would be reported as 502 "Twitch token request failed" — sending
  // the admin to debug a third party that had just answered correctly.
  try {
    const masked = settingsService.storeIgdbToken(access_token);
    console.log('[IGDB] Bearer token refreshed via Twitch OAuth, expires_in:', expires_in);
    res.json({ success: true, expires_in, masked });
  } catch (err) {
    console.error('[IGDB] Token minted but could not be saved:', err.message);
    // The same 409 the other two adapters return. Without it an unreadable
    // settings.json presented as a generic 500 here, so the admin retried — and each
    // retry mints and discards another token instead of pointing at the real cause.
    problem.send(res, err, { fallback: 'Token was refreshed but could not be saved to settings.json.' });
  }
});

// --- Notification helpers ---

// A single valid address, with no comma or semicolon.
//

// Sentinel distinguishing "the directory returned several entries for this user"
// from "the directory has no such user". Both used to resolve as null, so the admin
// UI reported an ambiguous match as not_found_in_ldap.
const AMBIGUOUS_LDAP_MATCH = Symbol('ambiguous-ldap-match');

// Make a directory- or user-supplied value safe to put in a log line.
//
// Log files are read by humans and by log shippers that parse line by line, so a
// value containing CR/LF can inject entire fabricated lines. A directory that serves
// a cn of "bob\n[LDAP] Service account bind succeeded." writes a convincing lie into
// the audit trail. ldapjs escapes control characters inside a DN, but ATTRIBUTE
// values arrive raw, and the login path logs several of them.
//
// Also bounded: an attribute has no length limit, and a megabyte-long cn in the log
// is its own denial of service.
function safeForLog(value, maxLength = 200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flattened = text.replace(/[\r\n\t]/g, (ch) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' }[ch]))
    // Strip the remaining C0/C1 controls, which can move a terminal cursor around.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…[truncated]` : flattened;
}

// Clean a directory-supplied value before STORING it (safeForLog is for logs only,
// and deliberately renders control characters as visible escapes).
//
// A directory can serve a cn containing newlines; that value becomes users.display_name
// and is then rendered in the UI, included in notification subjects and written to
// exports. React escapes markup so this is not XSS, but a multi-line display name
// corrupts every one of those surfaces. Collapse whitespace, drop controls, bound it.
// sanitizeDirectoryText moved to user-rules.js — the game-name write path needs the
// same collapse, and two copies of a sanitiser is how they drift.

// Notification helpers and transports (escapeHtml, isSafeImageUrl, the
// instance-metadata host guard, sendEmail/sendNtfy/sendGotify/sendTelegram and the
// delivery-error sanitiser) now live in services/notifications.js, together with the
// fan-out that was duplicated across three call sites. Imported at the top of this file.

// --- LDAP primitives ---
// Moved to ./ldap-helpers.js so the operator scripts can use the SAME escaping and
// the SAME error-listening client without pulling in this entire file. See the
// header comment there for what went wrong when they could not.

// --- Notification Triggers ---
// Compose and deliver a library event. Delivery itself — which channels the user has,
// resolving their address through the directory, and never letting one channel's
// failure stop another — is services/notifications.js.
// Kept as a name because the upsert adapter reads well with it. The composing and
// the delivery both live in services/notifications.js now; index.js has no
// notification code left.
const notifyEvent = (type, game, username, status) =>
  notifications.notifyLibraryEvent(type, game, username, status);

// --- Settings API ---
// Secret masking, the __unchanged__ sentinel and the section merge now live in
// services/settings.js — one definition, shared by the current routes and by
// /api/v2. Keeping a second copy here is how the partial-write bug that silently
// deleted the LDAP bind password would have come back on one surface only.

app.get('/api/settings', authRequired, (req, res) => {
  // Content-dependent authorization: the BODY differs by role, which no middleware
  // can express. See services/settings.js. Non-admins get {} rather than 403 —
  // v1 behaviour the SPA depends on.
  const { sections, degraded } = settingsService.readForRoleWithStatus(!!req.user.can_manage_users);
  // `unreadable` sits alongside the sections rather than wrapping them, because the
  // SPA reads `data.smtp` / `data.ldap` directly and an envelope would be a breaking
  // change to v1. v2 gets a proper envelope. Present only when true, and only for
  // admins, so the ordinary response is byte-identical to before.
  res.json(degraded ? { ...sections, unreadable: true } : sections);
});

app.post('/api/settings', authRequired, express.json(), (req, res) => {
  console.log('POST /api/settings called by', safeForLog(req.user.username, 64));
  try {
    settingsService.write(req.body || {}, !!req.user.can_manage_users);
    res.json({ success: true });
  } catch (err) {
    problem.send(res, err, { log: 'Error in /api/settings:', fallback: 'Failed to save settings.' });
  }
});

// isReleaseInFuture is no longer needed here. Its only remaining callers were the
// two refresh-metadata routes, and the status re-sync they open-coded now lives in
// services/library.js#statusForDate alongside the upsert's copy of the same rule.

// --- Add/update a game status for a user (with notification) ---
app.post('/api/user/:username/games', authRequired, ownershipRequired, (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  const { gameId, gameName, coverUrl, releaseDate, status, steamAppId } = req.body;

  withExistingUser(res, normalizedUsername, (user) => {
    libraryService.upsertGame(user.id, { gameId, gameName, coverUrl, releaseDate, status, steamAppId })
      .then((result) => {
        // `status` and `coerced` are additive: v1 answered a bare {success:true}, so
        // a client that asked for 'playing' on a future-dated game was told it had
        // worked and only found out by refetching. Existing clients ignore the extra
        // fields; the SPA can use them without another round trip.
        res.json({ success: true, status: result.status, coerced: result.coerced });

        // AFTER the response, and after the write — both deliberate.
        //
        // Before: one notifyEvent ran BEFORE the INSERT (announcing a state change
        // that had not been persisted and might still fail), a second ran after it
        // but before res.json. Four channels of third-party latency therefore sat in
        // front of the user's button click, and the ntfy/Gotify URLs are per-user
        // settings — so anyone could point their own at a blackhole and make their
        // own request hang. A notification must not be able to fail adding a game;
        // it must not be able to delay it either.
        //
        // The terminal .catch() is mandatory: after res.json a rejection has nowhere
        // to go. notifyEvent already swallows, which is the one place that earns its
        // keep, but relying on that silently would be the kind of assumption this
        // codebase keeps paying for.
        // CHAINED, not fired together. A game leaving 'unreleased' produces two
        // events, and firing both at once makes their arrival order a race — the
        // user could read "changed status to playing" before "has been released!".
        // v1 was strictly sequential; only the position relative to the response
        // changed. Chaining also stops two concurrent per-user channel lookups.
        result.events.reduce(
          (prev, event) => prev.then(() =>
            notifyEvent(event, { gameName, coverUrl }, normalizedUsername, result.status)),
          Promise.resolve(),
        ).catch((err) => console.error('[Library] Notification dispatch failed:', err?.message || err));
      })
      .catch((err) => problem.send(res, err, { log: '[Library] Upsert failed:' }));
  });
});

// Debug endpoint to check game status
app.get('/api/debug/user/:username/game/:gameId', authRequired, ownershipRequired, (req, res) => {
  const { username, gameId } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  console.log(`[DEBUG] Debug request for user ${username}, game ${gameId}`);
  
  withExistingUser(res, normalizedUsername, (user) => {
    
    db.get('SELECT * FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId], (err, row) => {
      if (err) {
        console.log(`[DEBUG] Error querying game:`, err);
        return res.status(500).json({ error: 'DB error' });
      }
      
      if (!row) {
        console.log(`[DEBUG] Game not found for user ${normalizedUsername}, game ${gameId}`);
        return res.status(404).json({ error: 'Game not found' });
      }
      
      console.log(`[DEBUG] Game found:`, {
        game_id: row.game_id,
        game_name: row.game_name,
        status: row.status,
        user_id: row.user_id,
        username: normalizedUsername
      });
      
      res.json({
        game_id: row.game_id,
        game_name: row.game_name,
        status: row.status,
        user_id: row.user_id,
        username: normalizedUsername,
        timestamp: new Date().toISOString()
      });
    });
  });
});

// --- Get current user's games for notification testing ---
app.get('/api/user/me/games', authRequired, (req, res) => {
  libraryService.listOwnGames(req.user.id)
    .then((rows) => {
      console.log(`[Library] ${req.user.username}: returned ${rows.length} games (self)`);
      res.json(rows);
    })
    .catch((err) => {
      console.error('[Library] Error querying own games:', err.message);
      res.status(500).json({ error: 'DB error' });
    });
});

// Get all games for a user
app.get('/api/user/:username/games', authRequired, ownershipRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  withExistingUser(res, normalizedUsername, (user) => {
    libraryService.listGamesWithAliases(user.id)
      .then((mapped) => {
        // One line per request. This previously logged every game in the library
        // individually, so a normal page load wrote hundreds of lines.
        console.log(`[Library] ${normalizedUsername}: returned ${mapped.length} games`);
        res.json(mapped);
      })
      .catch((err) => {
        console.error('[Library] Error querying games:', err.message);
        res.status(500).json({ error: 'DB error' });
      });
  });
});

// Remove a game from a user's list
app.delete('/api/user/:username/games/:gameId', authRequired, ownershipRequired, (req, res) => {
  const { username, gameId } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !gameId) {
    return res.status(400).json({ error: 'Missing username or gameId' });
  }
  withExistingUser(res, normalizedUsername, (user) => {
    // v1 reports success whether or not a row existed; `removed` is available but
    // deliberately not surfaced here, to keep the published response unchanged.
    libraryService.removeGame(user.id, gameId)
      .then(() => res.json({ success: true }))
      .catch(() => res.status(500).json({ error: 'DB error' }));
  });
});

// Reorder a game within the user's backlog (move up or down)
app.put('/api/user/:username/games/:gameId/backlog-order', authRequired, ownershipRequired, (req, res) => {
  const { username, gameId } = req.params;
  const { direction } = req.body; // 'up' or 'down'
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !gameId || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }
  withExistingUser(res, normalizedUsername, (user) => {
    libraryService.moveBacklogItem(user.id, gameId, direction)
      .then(() => res.json({ success: true }))   // boundary no-op also reports success, as in v1
      .catch((err) => {
        problem.send(res, err);
      });
  });
});

// Reorder entire backlog by providing a new ordered array of game IDs
app.put('/api/user/:username/backlog-reorder', authRequired, ownershipRequired, (req, res) => {
  const { username } = req.params;
  const { order } = req.body; // array of game_ids in desired order
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }
  // Bounded: one UPDATE per element inside a transaction, so an unbounded array
  // holds a pooled connection for as long as the caller cares to make it.
  if (order.length > MAX_BACKLOG_REORDER) {
    return res.status(400).json({ error: `order may contain at most ${MAX_BACKLOG_REORDER} games` });
  }
  withExistingUser(res, normalizedUsername, (user) => {
    libraryService.reorderBacklog(user.id, order)
      .then(() => res.json({ success: true }))
      .catch((err) => {
        console.error(`[Library] Backlog reorder failed for ${safeForLog(normalizedUsername, 64)}: ${err.message}`);
        res.status(500).json({ error: 'DB error' });
      });
  });
});

// Refresh metadata for all games in a user's library
app.post('/api/user/:username/refresh-metadata', authRequired, ownershipRequired, (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  if (!normalizedUsername) return res.status(400).json({ error: 'Missing username' });

  withExistingUser(res, normalizedUsername, (user) => {
    const run = async () => {
      const userGames = await libraryService.listGamesWithAliases(user.id);
      const results = { total: userGames.length, updated: 0, errors: [], details: [] };

      // SEQUENTIAL, as in v1. Each game costs up to 1 + 1 + 1 provider searches plus
      // RAWG's per-result detail lookups, so running a whole library concurrently
      // would burst hundreds of outbound requests and earn a rate-limit.
      for (const game of userGames) {
        try {
          const lookup = await catalogService.searchAll(game.game_name,
            { limit: catalogService.LIMIT_REFRESH });
          const match = catalogService.findExactMatch(lookup.results, game.game_name);
          if (!match) {
            // "Not found" and "we could not look it up" are different sentences, and
            // a user acts on them differently. During a provider outage every game in
            // the library would otherwise be reported as not existing in any database.
            const why = lookup.degraded
              ? 'Lookup unavailable — a game database did not respond'
              : 'Game not found in API search results';
            results.errors.push({ gameName: game.game_name, gameId: game.game_id, error: why });
            results.details.push({ gameName: game.game_name, gameId: game.game_id,
              changes: [], error: lookup.degraded ? 'Lookup unavailable' : 'Not found' });
            continue;
          }
          const applied = await libraryService.applyRefreshedMetadata(user.id, game, match);
          if (applied.updated) results.updated++;
          results.details.push({ gameName: game.game_name, gameId: game.game_id,
            changes: applied.changes });
        } catch (error) {
          // Per-game, so one bad game does not abandon the sweep. The message is the
          // service's or the database's, never a provider's — searchAll degrades
          // instead of throwing.
          console.error(`[Refresh] ${safeForLog(game.game_name, 80)} failed:`, error.message);
          results.errors.push({ gameName: game.game_name, gameId: game.game_id,
            error: 'Refresh failed' });
          results.details.push({ gameName: game.game_name, gameId: game.game_id,
            changes: [], error: 'Refresh failed' });
        }
      }

      res.json({
        success: true,
        message: `Metadata refresh completed. ${results.updated} games updated out of ${results.total} total games.`,
        results,
      });
    };

    run().catch((e) => {
      // Log the detail, return a generic message: e.message can be raw Postgres text
      // disclosing table and constraint names.
      console.error('[Refresh] Bulk refresh failed:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to refresh metadata' });
    });
  });
});

// Refresh metadata for a specific game in a user's library
app.post('/api/user/:username/games/:gameId/refresh-metadata', authRequired, ownershipRequired, (req, res) => {
  const { username, gameId } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !gameId) {
    return res.status(400).json({ error: 'Missing username or gameId' });
  }

  withExistingUser(res, normalizedUsername, (user) => {
    const run = async () => {
      const game = await libraryService.findGame(user.id, gameId);
      if (!game) return res.status(404).json({ error: 'Game not found in user library' });

      const results = { total: 1, updated: 0, errors: [], details: [] };
      const lookup = await catalogService.searchAll(game.game_name,
        { limit: catalogService.LIMIT_REFRESH });
      const match = catalogService.findExactMatch(lookup.results, game.game_name);

      if (!match) {
        // See the bulk route: an outage must not read as "this game does not exist".
        results.errors.push({ gameName: game.game_name, gameId: game.game_id,
          error: lookup.degraded
            ? 'Lookup unavailable — a game database did not respond'
            : 'Game not found in API search results' });
        results.details.push({ gameName: game.game_name, gameId: game.game_id,
          changes: [], error: lookup.degraded ? 'Lookup unavailable' : 'Not found' });
      } else {
        const applied = await libraryService.applyRefreshedMetadata(user.id, game, match);
        if (applied.updated) results.updated++;
        results.details.push({ gameName: game.game_name, gameId: game.game_id,
          changes: applied.changes });
      }

      res.json({
        success: true,
        results,
        message: `Metadata refresh completed for game ${game.game_name}.`,
      });
    };

    run().catch((error) => {
      // v1 put error.message into the RESPONSE here. It is the service's or the
      // database's message — searchAll degrades rather than throwing — so it could
      // carry Postgres table and constraint names to the caller.
      console.error(`[Refresh] game_id ${safeForLog(gameId, 80)} failed:`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to refresh metadata for game' });
      }
    });
  });
});

// --- Auth Middleware ---
// The token proves *identity*; the database is the authority on *privilege*.
//
// This previously trusted the JWT payload wholesale, so authorization was frozen
// for the token's full 12-hour life: revoking an admin's can_manage_users left them
// with complete admin access (create/delete users, reset any password, read API
// keys) until the token expired, and deleting a user entirely left their token
// working — every route still resolved, because nothing ever checked the row still
// existed. Re-reading the user costs one indexed primary-key lookup per request.
function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const credential = auth.slice(7);

  // Personal access tokens, ADDITIVE to v1 rather than a change to it: a new
  // credential type on an existing header, no route and no response shape altered,
  // so the freeze holds. It is here and not only in v2 because it is what lets a
  // script or an MCP server stop storing the owner's actual password today.
  //
  // Routed on the prefix, never authorized on it — a value shaped like a token is
  // still verified against the database, and one that is not is treated as a JWT
  // exactly as before.
  //
  // The login rate limiter is untouched by design: it lives inside the login route,
  // so token auth never reaches it. That matters — 5 retries from an MCP client
  // would otherwise lock the owner out of their own instance for 15 minutes.
  if (authService.looksLikePat(credential)) {
    return authService.verifyToken(credential)
      .then((identity) => {
        // One answer for unknown, expired and orphaned. Distinguishing them tells a
        // prober which of their guesses was once real.
        if (!identity) return res.status(401).json({ error: 'Invalid token' });
        // Scope NARROWS the account's privilege and can never widen it, so every
        // existing route keeps working unchanged: a library-scoped token simply
        // arrives with can_manage_users false and requirePermission refuses it.
        req.user = authService.authorize(identity);
        req.auth = { kind: 'pat', scopes: identity.scopes, tokenId: identity.tokenId };
        next();
      })
      .catch((err) => {
        console.error('[Auth] Token verification failed:', err.message);
        res.status(500).json({ error: 'DB error' });
      });
  }

  let payload;
  try {
    payload = jwt.verify(credential, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  db.get('SELECT id, username, can_manage_users, origin, display_name FROM users WHERE id = ?',
    [payload.id], (err, user) => {
      if (err) {
        console.error('[Auth] User lookup failed:', err.message);
        return res.status(500).json({ error: 'DB error' });
      }
      // Account deleted (or the DB was replaced) — the signature is still valid but
      // the identity is gone, so the token is worthless.
      if (!user) return res.status(401).json({ error: 'Invalid token' });
      req.user = {
        id: user.id,
        username: user.username,
        can_manage_users: !!user.can_manage_users,
        origin: user.origin || 'local',
        display_name: user.display_name || user.username,
      };
      // A password login carries no scope restriction — the interactive session is
      // the account. Recorded so a handler can tell the two credential types apart
      // without inspecting the header again.
      req.auth = { kind: 'jwt', scopes: authService.ALL_SCOPES, tokenId: null };
      next();
    });
}
function requirePermission(permission) {
  // NAMED, and tagged with the permission it enforces. Both matter: the Express
  // router exposes each route's middleware chain by function name, and
  // test/api-surface.test.js walks that chain to prove every route's authorization
  // tier is what the API contract says it is. An anonymous closure here made every
  // admin route indistinguishable from a merely-authenticated one, so the strictest
  // tier in the app was the one the check could not see.
  const requirePermissionMiddleware = (req, res, next) => {
    if (!req.user || !req.user[permission]) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
  requirePermissionMiddleware.requiredPermission = permission;
  return requirePermissionMiddleware;
}
// Self-only: the caller may act ONLY on their own :username resource. NO admin
// bypass, deliberately — sharing is the one place an administrator has no business
// reading or rewriting on someone else's behalf.
//
// This was five inline `if (req.user.username !== normalizedUsername)` checks. As
// inline code it was invisible to test/api-surface.test.js, which walks the router's
// middleware chain by NAME — so the gate could only assert the ABSENCE of
// ownershipRequired, never the PRESENCE of this. A review deleted the guard from two
// adapters and CI stayed green while a non-admin read and overwrote another user's
// share list. Named middleware makes the check assertable.
function selfOnly(message) {
  const selfOnlyMiddleware = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const target = (req.params.username || '').toLowerCase();
    if (target !== (req.user.username || '').toLowerCase()) {
      return res.status(403).json({ error: message });
    }
    next();
  };
  selfOnlyMiddleware.isSelfOnly = true;
  return selfOnlyMiddleware;
}

// Enforce that the authenticated user may only act on their OWN :username-scoped
// resources, unless they are an admin (can_manage_users). Usernames are normalized to
// lowercase everywhere, so compare case-insensitively. Must run AFTER authRequired.
function ownershipRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const target = (req.params.username || '').toLowerCase();
  const self = (req.user.username || '').toLowerCase();
  if (target && target === self) return next();
  if (req.user.can_manage_users) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// --- Helper Functions ---

// Login throttling.
//
// Counters are keyed on BOTH the client IP and the targeted account, because
// per-IP alone was trivially defeated: a successful login cleared the whole IP's
// counter, so anyone holding one valid account could guess four passwords for
// `root`, log into their own account to zero the counter, and repeat forever.
// Now a success only clears that user's own key, and the per-account counter
// (which an attacker cannot clear without already knowing the password) keeps
// counting. The account key also throttles an attacker who rotates IPs.
function attemptKeys(clientIP, username) {
  const keys = [`ip:${clientIP}`];
  if (username) keys.push(`user:${String(username).toLowerCase()}`);
  return keys;
}

function isLockedOut(clientIP, username) {
  const now = Date.now();
  for (const key of attemptKeys(clientIP, username)) {
    const attempts = loginAttempts.get(key);
    if (!attempts) continue;
    if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
      const elapsed = now - attempts.firstAttempt;
      if (elapsed < LOCKOUT_DURATION) {
        return Math.ceil((LOCKOUT_DURATION - elapsed) / 1000 / 60);
      }
      loginAttempts.delete(key); // lockout expired
    }
  }
  return 0;
}

// Track failed login attempts for rate limiting
function trackFailedAttempt(clientIP, username) {
  const now = Date.now();
  for (const key of attemptKeys(clientIP, username)) {
    const attempts = loginAttempts.get(key) || { count: 0, firstAttempt: now };
    attempts.count++;
    if (attempts.count === 1) attempts.firstAttempt = now;
    loginAttempts.set(key, attempts);
  }
  console.log(`[Auth] Failed login attempt from IP ${clientIP} for '${safeForLog(username || 'unknown', 64)}'.`);
}

// Clear only the keys belonging to the account that actually authenticated.
function clearFailedAttempts(clientIP, username) {
  for (const key of attemptKeys(clientIP, username)) loginAttempts.delete(key);
}

// Entries for IPs that fail a few times and never return were never evicted — an
// unbounded slow leak under background scanning traffic. Sweep hourly.
setInterval(() => {
  const cutoff = Date.now() - LOCKOUT_DURATION;
  for (const [key, attempts] of loginAttempts) {
    if (attempts.firstAttempt < cutoff) loginAttempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

// --- Auth Endpoints ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Server-side validation to ensure both fields are provided and not empty
  if (!username || !password || !username.trim() || !password.trim()) {
    console.log('[Auth] Login attempt with missing or empty credentials from IP:', clientIP);
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username.toLowerCase();

  // Check rate limiting (per-IP AND per-account — see attemptKeys above)
  const lockedFor = isLockedOut(clientIP, normalizedUsername);
  if (lockedFor) {
    console.log(`[Auth] Rate limited: IP ${clientIP} / user '${safeForLog(normalizedUsername, 64)}'. ${lockedFor} minutes remaining.`);
    return res.status(429).json({
      error: `Too many login attempts. Please try again in ${lockedFor} minutes.`
    });
  }

  const settings = loadSettings();
  const ldapSettings = settings.ldap || {};

  // The LDAP path has several independent failure signals that can each decide to
  // fall back: the bind callback, the search callback, and the client's 'error'
  // event — and they do NOT arrive in a fixed order (on a refused connection the
  // socket error usually beats the bind callback). Without this latch the fallback
  // ran twice and the second run threw ERR_HTTP_HEADERS_SENT.
  let authCompleted = false;
  function fallbackLocalAuth() {
    if (authCompleted) return;
    authCompleted = true;
    console.log('[Auth] Using fallback local authentication for user:', safeForLog(normalizedUsername, 64));
    db.get('SELECT * FROM users WHERE username = ?', [normalizedUsername], async (err, user) => {
      if (err) {
        console.error('[Auth] Database error during user lookup:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (!user) {
        console.log('[Auth] Local user not found:', safeForLog(normalizedUsername, 64));
        // Track failed attempt
        trackFailedAttempt(clientIP, normalizedUsername);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      console.log('[Auth] Found user in database:', { id: user.id, username: safeForLog(user.username, 64), origin: user.origin });
      try {
        // LDAP users have no local password — reject cleanly instead of crashing bcrypt.
        // The reason goes to the server log only: telling the *client* that this is
        // an LDAP account confirmed both that the username exists and that it is a
        // domain account, which is a ready-made target list for spraying against AD.
        if (!user.password || typeof user.password !== 'string') {
          console.log(`[Auth] User '${safeForLog(normalizedUsername, 64)}' has no local password (origin=${user.origin}). Local auth not possible.`);
          trackFailedAttempt(clientIP, normalizedUsername);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(String(password), user.password);
        if (!valid) {
          console.log('[Auth] Local password validation failed for user:', safeForLog(normalizedUsername, 64));
          // Track failed attempt
          trackFailedAttempt(clientIP, normalizedUsername);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        console.log('[Auth] Password validation successful for user:', safeForLog(normalizedUsername, 64));
        // Clear failed attempts on successful login
        clearFailedAttempts(clientIP, normalizedUsername);
        const token = jwt.sign({
          id: user.id,
          username: user.username,
          can_manage_users: !!user.can_manage_users,
          origin: user.origin || 'local',
          display_name: user.display_name || user.username
        }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token });
      } catch (bcryptError) {
        console.error('[Auth] Error during password comparison:', bcryptError);
        return res.status(500).json({ error: 'Authentication error' });
      }
    });
  }

  // Check if LDAP is properly configured with all required fields
  const isLdapConfigured = ldapSettings.url && 
                          ldapSettings.base && 
                          ldapSettings.bindDn && 
                          ldapSettings.bindPass &&
                          ldapSettings.url.trim() !== '' &&
                          ldapSettings.base.trim() !== '' &&
                          ldapSettings.bindDn.trim() !== '' &&
                          ldapSettings.bindPass.trim() !== '';

  // If LDAP is not properly configured, use local auth immediately
  if (!isLdapConfigured) {
    console.log('[Auth] LDAP not properly configured. Using local authentication.');
    return fallbackLocalAuth();
  }

  // If LDAP is enabled with a service account, use the reliable search-then-bind method.
  try {
    warnIfCleartextLdap(ldapSettings.url);
    // If the directory is unreachable, fall back to local auth instead of letting an
    // unhandled 'error' event kill the process (an anonymous login request used to
    // be enough to take the server down whenever the DC was down).
    const client = createLdapClient(ldapSettings.url, () => fallbackLocalAuth());

    // 1. Bind as service account
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed:', err.message);
        client.markHandled();
        client.unbind();
        return fallbackLocalAuth();
      }
      console.log('[LDAP] Service account bind succeeded.');

      // 2. Search for the user by username using multiple attributes:
      //    Active Directory: sAMAccountName, FreeIPA: uid. The username is
      //    RFC 4515-escaped so it cannot alter the filter's structure.
      const searchOptions = {
        filter: buildUserSearchFilter(normalizedUsername),
        scope: 'sub',
        attributes: ['dn', 'memberOf', 'displayName', 'cn', 'mail', 'email']
      };
      console.log(`[LDAP] Searching for user with filter: ${searchOptions.filter}`);

      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search initiation failed:', err);
          client.markHandled();
          client.unbind();
          return fallbackLocalAuth();
        }

        // Entries are BUFFERED rather than folded down as they arrive, because
        // whether a cn=compat entry is a redundant mirror or somebody's only account
        // cannot be judged from that entry alone -- it depends on whether its
        // cn=accounts counterpart is elsewhere in the same result set. Deciding per
        // entry is what made the first version of this an authentication bypass.
        // Nothing is discarded; see the 'end' handler.
        const rawEntries = [];
        searchRes.on('searchEntry', (entry) => {
          console.log('[LDAP] Search entry received for user lookup.');
          rawEntries.push(entry);
        });

        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during processing:', err.message);
          client.markHandled();
          client.unbind();
          return fallbackLocalAuth();
        });

        searchRes.on('end', (result) => {
          console.log('[LDAP] Search finished. Result status:', result ? result.status : 'N/A');

          // NOTHING IS FILTERED OUT HERE, deliberately. Two attempts to recognise
          // and discard FreeIPA's cn=compat duplicate were both authentication
          // bypasses, because a DN is a name rather than evidence: any shape treated
          // as proof that two entries are the same person can be created by an
          // attacker who can add a directory entry. See ldap-helpers.js.
          //
          // Every matched entry therefore counts, and the fail-closed ambiguity
          // refusal below decides. A too-broad search base is reported as the
          // configuration error it is.
          const entries = rawEntries;
          const matchCount = entries.length;

          // Read anything out of this with attrValue/attrValues, never by property
          // access -- the keys carry whatever casing the directory sent.
          const foundUser = matchCount
            ? { dn: entries[0].dn.toString(), ...entryAttributes(entries[0]) }
            : null;
          // Log the DN only. Dumping the whole entry put mail addresses and full
          // group membership into shared logs for every single login.
          if (foundUser) console.log('[LDAP] Parsed user object for DN:', foundUser.dn);

          if (!foundUser) {
            console.log('[LDAP] User object was not populated from search. This could be a permissions issue or the user truly does not exist in the search base.');
            client.markHandled();
            client.unbind();
            return fallbackLocalAuth();
          }
          // A username must identify exactly one directory entry. If the search
          // matched several, we cannot know which identity the caller meant — the
          // old code silently kept whichever arrived last. Refuse instead of
          // guessing; binding as an arbitrary matched DN is an authentication bug.
          if (matchCount > 1) {
            console.error(`[LDAP] Ambiguous login: ${matchCount} entries matched username '${normalizedUsername}'. Refusing to authenticate.`);
            // Overwhelmingly the cause is a search base that spans a compat tree.
            // Say so — this used to present as an unexplained total login outage.
            const advice = compatTreeAdvice(entries.map((e) => e.dn.toString()), ldapSettings.base);
            if (advice) console.error(`[LDAP] ${advice}`);
            client.markHandled();
            client.unbind();
            trackFailedAttempt(clientIP, normalizedUsername);
            if (authCompleted) return;
            authCompleted = true;
            return res.status(401).json({ error: 'Invalid credentials' });
          }

          const userDn = foundUser.dn;
          console.log(`[LDAP] Found user's correct DN: ${userDn}`);

          // 3. Authenticate as the found user (verifies their password)
          client.bind(userDn, password, (err) => {
            if (err) {
              console.log('[LDAP] User password authentication failed:', err);
              client.markHandled();
              client.unbind();
              // Track failed attempt
              trackFailedAttempt(clientIP, normalizedUsername);
              return fallbackLocalAuth(); // Incorrect password for this user
            }
            console.log('[LDAP] User password authentication succeeded.');

            // 4. Check group membership (Authorization).
            // The failed-attempt counter is deliberately NOT cleared yet: a user who
            // authenticates but is outside the required group is not authorized, so
            // clearing here would let them reset the throttle at will.
            if (ldapSettings.requiredGroup) {
                // Case-insensitive: a directory answering `memberof` used to leave
                // this undefined, which read as "member of nothing" and refused every
                // login with requiredGroup set. It fails closed, so it presented as a
                // directory outage rather than as a bug here.
                const groups = attrValues(foundUser, 'memberOf');
                console.log('[LDAP] User is member of groups:', groups);

                const isMember = groups.some(group =>
                    group.toLowerCase() === ldapSettings.requiredGroup.toLowerCase() ||
                    group.toLowerCase().includes(`cn=${ldapSettings.requiredGroup.toLowerCase()}`)
                );

                if (!isMember) {
                    console.log(`[LDAP] Authorization failed: User is not in required group '${ldapSettings.requiredGroup}'.`);
                    client.markHandled();
                    client.unbind();
                    if (authCompleted) return;
                    authCompleted = true;
                    return res.status(403).json({ error: 'Not a member of the required group' });
                }
                console.log('[LDAP] Authorization passed: Group membership check OK.');
            }
            // Fully authenticated AND authorized — now it is safe to clear.
            clearFailedAttempts(clientIP, normalizedUsername);

            // 5. User is authenticated and authorized, create token.
            client.markHandled();
            client.unbind();
            // Try to get CN from attribute, else extract from DN
            let cnValue = attrValue(foundUser, 'cn');
            if (!cnValue && foundUser.dn) {
              // Extract CN from DN string
              const match = foundUser.dn.match(/CN=([^,]+)/i);
              if (match) cnValue = match[1];
            }
            // Sanitised before it becomes users.display_name: a directory-supplied cn
            // containing newlines was stored verbatim and then rendered in the UI,
            // notification subjects and exports.
            const cleanCn = sanitizeDirectoryText(cnValue);
            const displayName = cleanCn !== '' ? cleanCn : normalizedUsername;
            
            // Get email from LDAP attributes
            const userEmail = attrValue(foundUser, 'mail', 'email');
            
            // safeForLog: these are raw directory attribute values. ldapjs escapes
            // control characters inside a DN but NOT inside attributes, so a cn of
            // "bob\n[LDAP] Service account bind succeeded." wrote a fabricated line
            // straight into the audit trail.
            console.log('[DEBUG] Extracted cnValue:', safeForLog(cnValue));
            console.log('[DEBUG] Final displayName:', safeForLog(displayName));
            console.log('[DEBUG] User email from LDAP:', safeForLog(userEmail));

            getOrCreateUser(normalizedUsername, (err, user) => {
              if (err) {
                if (authCompleted) return;
                authCompleted = true;
                return res.status(500).json({ error: 'DB error' });
              }
              // Update display_name, origin, and email for LDAP users
              const updates = ['display_name = ?, origin = ?'];
              const params = [displayName, 'ldap'];
              
              // Validated at THIS write site, not only at the send sink. The
              // comment on isValidEmailAddress names four writers that must all
              // check; this one — the LDAP login path — was not among them, so a
              // directory-supplied address smuggling a comma reached users.email and
              // could fan notifications out to arbitrary third parties from this
              // deployment's SPF/DKIM-aligned domain.
              if (isValidEmailAddress(userEmail)) {
                updates.push('email = ?');
                params.push(userEmail.trim());
              } else if (userEmail) {
                console.warn('[LDAP] Ignoring malformed email from directory:', safeForLog(userEmail));
              }
              
              params.push(normalizedUsername);
              db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, params);
              
              const token = jwt.sign({
                id: user.id,
                username: user.username,
                can_manage_users: !!user.can_manage_users,
                origin: 'ldap',
                display_name: displayName
              }, JWT_SECRET, { expiresIn: '12h' });
              if (authCompleted) return;
              authCompleted = true;
              res.json({ token });
            }, { origin: 'ldap', display_name: displayName });
          });
        });
      });
    });
  } catch (ldapError) {
    console.error('[LDAP] Error creating LDAP client:', ldapError);
    return fallbackLocalAuth();
  }
});

// --- User Management Endpoints ---
// Postgres raises 22P02 when a non-numeric value is compared against an INTEGER
// column, so an unvalidated :id surfaced as an opaque 500 (and filled the log with
// fake database errors) where SQLite simply matched nothing and 404'd.
// See divergence 5 in db.js.
function parseRouteId(value) {
  return /^[0-9]+$/.test(String(value)) ? Number(value) : null;
}

// `me` would be shadowed by the /api/user/me/* routes registered before
// /api/user/:username/*; `root`/`admin` are reserved to avoid impersonation
// confusion with the seeded administrator account.
// RESERVED_USERNAMES now lives in ./user-rules.js so create-local-admin.js — which
// creates an ADMIN account — is held to the same rule. It was not.

// Create user (admin only)
app.post('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { username, password, can_manage_users = 0, email = '', shares_library = 0 } = req.body || {};

  // Same rule as the update path, from the same place. Creation was the other half
  // of the write: an admin could not overwrite a user's notification target, but
  // could plant one at provisioning time — and that survives the new user changing
  // their password, so it outlives them taking ownership of the account.
  //
  // Checked before bcrypt.hash and before the INSERT. The columns are nullable, so
  // the row is created without them and the user sets them on My Account.
  try {
    usersService.assertNotUserOwned(req.body);
  } catch (err) {
    return problem.send(res, err, { log: '[Users] Create rejected:' });
  }

  // Enhanced validation. Both fields must be STRINGS — a JSON number reaching
  // bcrypt.hash rejects with "Illegal arguments", and an unhandled rejection takes
  // the whole process down under Node's default --unhandled-rejections=throw.
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password must be strings' });
  }

  if (!username.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Username and password cannot be empty' });
  }

  // Password strength requirements
  // ONE definition of the policy, shared with services/users.js. Create and update
  // already drifted once: extracting the users service dropped both the type and
  // length rules from the update path while create kept them, so a one-character
  // password was settable on any account — including an admin's.
  //
  // The typeof check above still runs first, so its combined username+password
  // message is unchanged; validatePassword supplies the length rule.
  const passwordProblem = validatePassword(password);
  if (passwordProblem) {
    return res.status(400).json({ error: passwordProblem });
  }

  if (email !== '' && !isValidEmailAddress(email)) {
    return res.status(400).json({ error: 'email must be a single valid address, or empty' });
  }

  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username.toLowerCase();

  // `me` collides with the /api/user/me/* routes, which are registered first and
  // would shadow this account entirely; the others are reserved to avoid confusion
  // with the seeded administrator.
  if (RESERVED_USERNAMES.includes(normalizedUsername)) {
    return res.status(400).json({ error: `'${normalizedUsername}' is a reserved username.` });
  }

  bcrypt.hash(password, 10).then(hash => {
    db.run(
      // RETURNING id -- required for this.lastID under Postgres. See db.js.
      'INSERT INTO users (username, password, can_manage_users, email, created_at, origin, display_name, shares_library) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [normalizedUsername, hash, can_manage_users ? 1 : 0, email, new Date().toISOString(), 'local', normalizedUsername, shares_library ? 1 : 0],
      function (err) {
        if (err) return res.status(400).json({ error: 'User already exists' });
        res.json({ success: true, id: this.lastID });
      }
    );
  }).catch(err => {
    console.error('[Users] Password hashing failed:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  });
});

// List users (manager only)
app.get('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  usersService.listAll()
    .then((rows) => res.json(rows))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// Edit user (manager only)
app.put('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const id = parseRouteId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'User not found' });
  // The WHOLE body goes to the service, deliberately.
  //
  // This route used to hand-list the fields it forwarded. That made the list a second
  // copy of the service's rule with nothing asserting the two agreed: a field the
  // service refuses is only refused if the route bothered to forward it, so adding a
  // column to the service's list silently failed to guard it, and "tidying" a name
  // out of the route turned a 400 back into a silent ignore. There is now nothing to
  // forget — the service sees everything that was sent.
  //
  // Safe because update()'s write path is structurally an allowlist: it appends only
  // hardcoded `column = ?` literals for the four fields an admin may set, so nothing
  // caller-controlled can reach the SQL string regardless of what the body contains.
  // A prototype-polluted body fails CLOSED in both directions: the guard reads
  // through the prototype chain so an inherited `gotify_token` is still refused,
  // while every write reads own-properties only so an inherited value is never
  // written. See services/users.js#update.
  //
  // `|| {}` because express.json() leaves req.body undefined on an unmatched
  // Content-Type; without it the service threw a TypeError, which is not a
  // ServiceError, so the caller got a misleading 500 "DB error" instead of a 400.
  usersService.update(id, req.body || {}, req.user.id)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      problem.send(res, err, { log: '[Users] Update failed:', messages: { [SVC.NOT_FOUND]: 'User not found' } });
    });
});

app.delete('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const id = parseRouteId(req.params.id);
  if (id === null) return res.status(404).json({ error: 'User not found' });
  usersService.remove(id, req.user.id)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      problem.send(res, err, { log: '[Users] Delete failed:', messages: { [SVC.NOT_FOUND]: 'User not found' } });
    });
});

// --- Test Notification endpoint for admins ---
app.post('/api/admin/test-notification', authRequired, async (req, res) => {
  try {
    const { service, gameId, gameName, releaseDate, coverUrl } = req.body;
    
    if (!service || !gameId || !gameName) {
      return res.status(400).json({ error: 'Missing required parameters: service, gameId, gameName' });
    }
    
    if (!['email', 'ntfy', 'gotify', 'telegram', 'both'].includes(service)) {
      return res.status(400).json({ error: 'Invalid service. Must be email, ntfy, gotify, telegram, or both' });
    }
    
    // Calculate days until release
    let daysUntilRelease = null;
    let releaseText = 'Date N/A';
    
    if (releaseDate) {
      const releaseDateObj = new Date(releaseDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      releaseDateObj.setHours(0, 0, 0, 0);
      daysUntilRelease = Math.ceil((releaseDateObj - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilRelease === 0) {
        releaseText = 'releases today';
      } else if (daysUntilRelease > 0) {
        releaseText = `releases in ${daysUntilRelease} days`;
      } else {
        releaseText = `released ${Math.abs(daysUntilRelease)} days ago`;
      }
    }
    
    const subject = `Test Notification: "${gameName}" ${releaseText}`;
    const text = `This is a test notification for "${gameName}". ${releaseText} (${releaseDate || 'Date N/A'}).`;
    const title = 'Test Notification';
    const message = text;
    
    // 'both' is the name the value had when there were two channels; it has gated
    // ALL of them since Gotify and Telegram were added, and it is what the SPA sends
    // by default, labelled "All Services". undefined = every channel.
    const only = service === 'both' ? undefined : [service];
    const channels = await notifications.channelsForId(req.user.id);
    const results = await notifications.dispatch(
      channels,
      { subject, text, title, message, coverUrl },
      { only },
    );

    res.json({
      success: true,
      message: `Test notification sent for "${gameName}"`,
      results,
      gameInfo: {
        name: gameName,
        releaseDate: releaseDate || 'Date N/A',
        daysUntilRelease,
        releaseText
      }
    });
    
  } catch (error) {
    console.error('[Test Notification] Error:', error);
    res.status(500).json({ error: `Test notification failed: ${error.message}` });
  }
});

// --- LDAP Sync endpoint for admins ---
app.post('/api/admin/ldap-sync', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  try {
    const settings = loadSettings();
    const ldapSettings = settings.ldap || {};
    
    // Check if LDAP is properly configured
    const isLdapConfigured = ldapSettings.url &&
      ldapSettings.base &&
      ldapSettings.bindDn &&
      ldapSettings.bindPass &&
      ldapSettings.url.trim() !== '' &&
      ldapSettings.base.trim() !== '' &&
      ldapSettings.bindDn.trim() !== '' &&
      ldapSettings.bindPass.trim() !== '';
    
    if (!isLdapConfigured) {
      return res.status(400).json({ error: 'LDAP is not properly configured' });
    }

    console.log('[LDAP Sync] Starting sync process...');
    console.log('[LDAP Sync] LDAP Settings:', {
      url: ldapSettings.url,
      base: ldapSettings.base,
      bindDn: ldapSettings.bindDn
    });

    // Get all LDAP users from database
    db.all("SELECT id, username, email, display_name FROM users WHERE origin = 'ldap'", [], async (err, ldapUsers) => {
      if (err) {
        console.error('[LDAP Sync] Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      console.log(`[LDAP Sync] Found ${ldapUsers.length} LDAP users in database`);

      const syncResults = {
        total: ldapUsers.length,
        updated: 0,
        errors: [],
        details: []
      };

      // Process each LDAP user
      for (const user of ldapUsers) {
        console.log(`[LDAP Sync] Processing user: ${user.username}`);
        
        // Declared outside the try so the finally block can always close the socket:
        // the previous version returned early on the reject paths without ever
        // calling unbind(), leaking one connection per failing user in this loop.
        let client = null;
        try {
          warnIfCleartextLdap(ldapSettings.url);
          await new Promise((resolve, reject) => {
            // Without an 'error' listener an unreachable directory here was a
            // guaranteed process crash — this loop builds a fresh client per user.
            client = createLdapClient(ldapSettings.url, (err) => reject(err));
            client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
              if (err) {
                console.error(`[LDAP Sync] Bind failed for ${user.username}:`, err.message);
                reject(new Error(`LDAP bind failed: ${err.message}`));
                return;
              }
              console.log(`[LDAP Sync] Bind successful for ${user.username}`);
              resolve();
            });
          });

          // Search for user in LDAP using multiple username attributes
          // (Active Directory: sAMAccountName, FreeIPA: uid). Escaped even though
          // the username comes from our own DB — LDAP-origin rows are created from
          // directory data, so this is second-order untrusted input.
          const searchOptions = {
            filter: buildUserSearchFilter(user.username),
            scope: 'sub',
            attributes: ['displayName', 'mail', 'sAMAccountName', 'uid']
          };

          console.log(`[LDAP Sync] Searching for user with filter: ${searchOptions.filter}`);

          const userData = await new Promise((resolve, reject) => {
            client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
              if (err) {
                console.error(`[LDAP Sync] Search failed for ${user.username}:`, err.message);
                reject(new Error(`LDAP search failed: ${err.message}`));
                return;
              }

              // Buffered so the SAME pairing rule as the login path can be applied;
              // resolving on the first entry could not tell a redundant mirror from
              // a compat-only account's single real entry.
              const rawEntries = [];
              searchRes.on('searchEntry', (entry) => rawEntries.push(entry));

              searchRes.on('end', () => {
                // No compat filtering — see ldap-helpers.js.
                const entries = rawEntries;
                if (!entries.length) {
                  console.log(`[LDAP Sync] User not found in LDAP: ${user.username}`);
                  return resolve(null); // User not found in LDAP
                }
                // Ambiguous here means we cannot tell whose attributes these are, and
                // this writes display_name/email onto an account. Skip rather than
                // guess; the login path refuses the same shape outright.
                if (entries.length > 1) {
                  console.warn(`[LDAP Sync] ${entries.length} entries matched '${user.username}' — ambiguous, skipping.`);
                  // A distinct sentinel, not null. Folding this into "not found"
                  // told the admin UI the account had been REMOVED from the
                  // directory when in fact it was found twice — opposite diagnoses,
                  // opposite remedies.
                  return resolve(AMBIGUOUS_LDAP_MATCH);
                }
                console.log(`[LDAP Sync] Found user in LDAP: ${user.username}`);
                resolve(entryAttributes(entries[0]));
              });

              searchRes.on('error', (err) => {
                console.error(`[LDAP Sync] Search error for ${user.username}:`, err.message);
                reject(new Error(`LDAP search error: ${err.message}`));
              });
            });
          });

          // (the socket is closed in the finally block below, on every path)

          if (userData === AMBIGUOUS_LDAP_MATCH) {
            // Reported distinctly: "found twice" and "not there" are opposite
            // diagnoses. Nothing is written for this user.
            syncResults.details.push({
              username: user.username,
              action: 'ambiguous_ldap_match',
              changes: []
            });
          } else if (userData) {
            // User found in LDAP, update their information
            // attrValue, not property access: `displayname` from the directory used
            // to miss here and silently reset every synced user's display name to
            // their username.
            //
            // Deliberately NOT falling back to `cn` here, though the login path does
            // (see the cnValue block above). Adding it would change which value gets
            // written for users who have no displayName, which is a policy decision
            // and not part of this casing fix. The inconsistency is pre-existing.
            // Same sanitising and the same email validation as the login path — this
            // is the other writer of display_name/email from directory data.
            const newDisplayName = sanitizeDirectoryText(attrValue(userData, 'displayName')) || user.username;
            const syncedEmail = attrValue(userData, 'mail', 'email');
            const newEmail = isValidEmailAddress(syncedEmail) ? syncedEmail.trim() : user.email;
            
            console.log(`[LDAP Sync] User data for ${user.username}:`, {
              current: { display_name: user.display_name, email: user.email },
              ldap: { displayName: newDisplayName, email: newEmail }
            });
            
            const updates = [];
            const params = [];
            
            if (newDisplayName !== user.display_name) {
              updates.push('display_name = ?');
              params.push(newDisplayName);
              console.log(`[LDAP Sync] Will update display_name for ${user.username}: "${user.display_name}" -> "${newDisplayName}"`);
            }
            
            if (newEmail !== user.email) {
              updates.push('email = ?');
              params.push(newEmail);
              console.log(`[LDAP Sync] Will update email for ${user.username}: "${user.email}" -> "${newEmail}"`);
            }
            
            if (updates.length > 0) {
              params.push(user.id);
              await new Promise((resolve, reject) => {
                db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
                  if (err) {
                    console.error(`[LDAP Sync] Database update failed for ${user.username}:`, err.message);
                    reject(new Error(`Database update failed: ${err.message}`));
                  } else {
                    console.log(`[LDAP Sync] Successfully updated ${user.username}`);
                    syncResults.updated++;
                    syncResults.details.push({
                      username: user.username,
                      action: 'updated',
                      changes: updates.map(update => update.split(' = ')[0])
                    });
                    resolve();
                  }
                });
              });
            } else {
              console.log(`[LDAP Sync] No changes needed for ${user.username}`);
              syncResults.details.push({
                username: user.username,
                action: 'no_changes',
                changes: []
              });
            }
          } else {
            // User not found in LDAP - could be deleted or moved
            console.log(`[LDAP Sync] User not found in LDAP: ${user.username}`);
            syncResults.details.push({
              username: user.username,
              action: 'not_found_in_ldap',
              changes: []
            });
          }
        } catch (error) {
          console.error(`[LDAP Sync] Error processing ${user.username}:`, error.message);
          syncResults.errors.push({
            username: user.username,
            error: error.message
          });
          syncResults.details.push({
            username: user.username,
            action: 'error',
            error: error.message
          });
        } finally {
          // Always close the socket, including on the bind/search reject paths.
          if (client) {
            try { client.markHandled(); client.unbind(); } catch { /* already closed */ }
          }
        }
      }

      console.log(`[LDAP Sync] Sync completed. ${syncResults.updated} users updated out of ${syncResults.total} total LDAP users.`);
      
      res.json({
        success: true,
        message: `LDAP sync completed. ${syncResults.updated} users updated out of ${syncResults.total} total LDAP users.`,
        results: syncResults
      });
    });
  } catch (error) {
    console.error('[LDAP Sync] General error:', error);
    res.status(500).json({ error: `LDAP sync failed: ${error.message}` });
  }
});

// --- Get current user's profile/settings ---
app.get('/api/user/me', authRequired, (req, res) => {
  const userId = req.user.id;
  db.get('SELECT id, username, email, ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id, notification_days, display_name, shares_library FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(404).json({ error: 'User not found' });
    let notificationDays = [0, 7, 30];
    try { notificationDays = JSON.parse(row.notification_days); } catch {}
    res.json({ ...row, notification_days: notificationDays });
  });
});

// --- Per-user settings endpoint ---
// Authenticated user can update their own email/ntfy_topic/gotify_token/telegram_chat_id/notification_days
app.put('/api/user/me/settings', authRequired, (req, res) => {
  const userId = req.user.id;
  const { email, ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id, notification_days } = req.body;
  const updates = [];
  const params = [];
  // Only accept http(s) URLs for the per-user notification servers (or empty to clear).
  const isValidServerUrl = (u) => u === '' || /^https?:\/\/\S+$/i.test(u);
  if (typeof email !== 'undefined') {
    // Basic shape check + no commas. Nodemailer treats a comma-separated `to` as a
    // recipient LIST, so an unvalidated value here let one account fan a
    // notification out to arbitrary third parties from the deployment's own domain.
    const cleanEmail = String(email).trim();
    if (cleanEmail !== '' && !isValidEmailAddress(cleanEmail)) {
      return res.status(400).json({ error: 'email must be a single valid address, or empty' });
    }
    updates.push('email = ?');
    params.push(cleanEmail);
  }
  if (typeof ntfy_topic !== 'undefined') {
    updates.push('ntfy_topic = ?');
    params.push(ntfy_topic);
  }
  if (typeof ntfy_url !== 'undefined') {
    if (!isValidServerUrl(String(ntfy_url).trim())) {
      return res.status(400).json({ error: 'ntfy_url must be an http(s) URL or empty' });
    }
    updates.push('ntfy_url = ?');
    params.push(String(ntfy_url).trim());
  }
  if (typeof gotify_token !== 'undefined') {
    updates.push('gotify_token = ?');
    params.push(gotify_token);
  }
  if (typeof gotify_url !== 'undefined') {
    if (!isValidServerUrl(String(gotify_url).trim())) {
      return res.status(400).json({ error: 'gotify_url must be an http(s) URL or empty' });
    }
    updates.push('gotify_url = ?');
    params.push(String(gotify_url).trim());
  }
  if (typeof telegram_chat_id !== 'undefined') {
    updates.push('telegram_chat_id = ?');
    params.push(telegram_chat_id);
  }
  if (typeof notification_days !== 'undefined') {
    if (!Array.isArray(notification_days) || notification_days.length === 0 || !notification_days.every(d => Number.isInteger(d) && d >= 0)) {
      return res.status(400).json({ error: 'notification_days must be a non-empty array of non-negative integers' });
    }
    updates.push('notification_days = ?');
    params.push(JSON.stringify(notification_days));
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No settings to update' });
  }
  params.push(userId);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

// --- Per-user sharing toggle endpoint ---
// Authenticated user can update their own shares_library
app.put('/api/user/me/sharing', authRequired, (req, res) => {
  const userId = req.user.id;
  const { shares_library } = req.body;
  if (typeof shares_library === 'undefined') {
    return res.status(400).json({ error: 'Missing shares_library value' });
  }
  db.run('UPDATE users SET shares_library = ? WHERE id = ?', [shares_library ? 1 : 0, userId], function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

// --- List all users who share their library ---
app.get('/api/shared-libraries', authRequired, (req, res) => {
  sharesService.listSharingUsers()
    .then((rows) => res.json(rows))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// --- Scheduled Notifications for Unreleased Games ---
const SENT_NOTIFICATIONS_FILE = path.join(__dirname, 'sent_notifications.json');
// Null-prototype maps throughout.
//
// game_id is attacker-controlled (POST /api/user/:username/games) and SQLite's
// flexible typing happily stores the string "__proto__" in an INTEGER column. With
// a normal object literal, `sentNotifications[user]["__proto__"]` returns
// Object.prototype — truthy, so the "create if missing" guard is skipped — and the
// following write lands on the PROTOTYPE. After that `wasNotificationSent()` returns
// truthy for every user/game/type combination and release notifications silently
// stop firing for everyone. Object.create(null) removes the sink entirely.

let sentNotifications = Object.create(null);
if (fs.existsSync(SENT_NOTIFICATIONS_FILE)) {
  try {
    // JSON.parse itself does not pollute, but assigning its result would reintroduce
    // a normal prototype — copy the entries onto null-prototype objects instead.
    const raw = JSON.parse(fs.readFileSync(SENT_NOTIFICATIONS_FILE, 'utf8'));
    for (const [user, games] of Object.entries(raw || {})) {
      if (isUnsafeKey(user)) continue;
      const userEntry = Object.create(null);
      for (const [gameId, types] of Object.entries(games || {})) {
        if (isUnsafeKey(gameId)) continue;
        userEntry[gameId] = Object.assign(Object.create(null), types);
      }
      sentNotifications[user] = userEntry;
    }
  } catch (err) {
    // No rethrow: same reason as the CrackWatch loader. This file is rewritten on
    // every reminder, so a truncated one is a live possibility, and it is
    // reconstructible — losing it re-sends at worst.
    console.warn('[Notifications] Could not read sent_notifications.json:', err.message);
    sentNotifications = Object.create(null);
  }
}
function markNotificationSent(username, gameId, type) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (isUnsafeKey(normalizedUsername) || isUnsafeKey(gameId) || isUnsafeKey(type)) return;
  if (!sentNotifications[normalizedUsername]) sentNotifications[normalizedUsername] = Object.create(null);
  if (!sentNotifications[normalizedUsername][gameId]) sentNotifications[normalizedUsername][gameId] = Object.create(null);
  sentNotifications[normalizedUsername][gameId][type] = new Date().toISOString();
  fs.writeFileSync(SENT_NOTIFICATIONS_FILE, JSON.stringify(sentNotifications, null, 2));
}
// The reminder dedup log, as the pair services/jobs.js takes. Injected rather than
// required, because this is file-backed state owned by the server process — a service
// that wrote sent_notifications.json would make every test and every operator script
// touch it.
const dedupe = {
  wasSent: (username, gameId, type) => !!wasNotificationSent(username, gameId, type),
  markSent: (username, gameId, type) => markNotificationSent(username, gameId, type),
};

function wasNotificationSent(username, gameId, type) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (isUnsafeKey(normalizedUsername) || isUnsafeKey(gameId) || isUnsafeKey(type)) return false;
  return sentNotifications[normalizedUsername] && sentNotifications[normalizedUsername][gameId] && sentNotifications[normalizedUsername][gameId][type];
}
// getAllUsers/getUserGames are gone: they existed only so the four copies of the
// release sweep could enumerate. services/jobs.js does its own enumeration, with one
// query instead of three round trips per user.
console.log('About to schedule cron job');
scheduleWhenServer('0 8 * * *', () => {
  console.log('[CRON] Running scheduled release check...');
  jobsService.checkReleases({ dedupe })
    .then((r) => console.log('[CRON] Release check complete:', {
      usersChecked: r.usersChecked, promoted: r.promoted.length,
      remindersSent: r.remindersSent.length, errors: r.errors.length,
    }))
    .catch((err) => console.error('[CRON] Release check failed:', err.message));
});

// --- Per-user Library Sharing (persistent) ---
// The user_shares table is created by migrations/001_initial_schema.sql, applied
// at boot by schema-migrate.js. Never create it here as well.

// Share a user's list with one or more users
app.post('/api/user/:username/share', authRequired, selfOnly('You can only share your own library.'), (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  // Self-only: deliberately NO admin bypass, unlike ownershipRequired. Kept in the
  // adapter next to req.user so test/api-surface.test.js can see it.
  if (!Array.isArray(req.body.toUsers)) return res.status(400).json({ error: 'No users to share with.' });

  sharesService.replaceOutgoing(normalizedUsername, req.body.toUsers)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      problem.send(res, err, { log: '[Shares] Failed to update shares:' });
    });
});

// Get lists shared with the current user
app.get('/api/user/:username/shared-with-me', authRequired, selfOnly('You can only view your own shares.'), (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  sharesService.listIncoming(normalizedUsername)
    .then((rows) => res.json(rows))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// Get a specific user's shared list (read-only, only if shared with you)
app.get('/api/user/:username/shared/:fromUser', authRequired, selfOnly('You can only view your own shares.'), (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  const normalizedFromUser = req.params.fromUser ? req.params.fromUser.toLowerCase() : '';
  sharesService.readSharedLibrary(normalizedFromUser, normalizedUsername)
    .then((games) => res.json(games))
    .catch((err) => {
      problem.send(res, err);
    });
});

// Revoke a share from a user
app.delete('/api/user/:username/revoke-share/:fromUser', authRequired, selfOnly('You can only revoke your own shares.'), (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  const normalizedFromUser = req.params.fromUser ? req.params.fromUser.toLowerCase() : '';
  sharesService.revokeIncoming(normalizedUsername, normalizedFromUser)
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// List all users (for sharing UI, not just admins)
app.get('/api/all-users', authRequired, (req, res) => {
  sharesService.listDirectory()
    .then((rows) => res.json(rows))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// Get the list of users I am sharing with
app.get('/api/user/:username/share', authRequired, selfOnly('You can only view your own shares.'), (req, res) => {
  const normalizedUsername = req.params.username ? req.params.username.toLowerCase() : '';
  sharesService.listOutgoing(normalizedUsername)
    .then((toUsers) => res.json({ toUsers }))
    .catch(() => res.status(500).json({ error: 'DB error' }));
});

// Manual trigger for release status updates (for testing)
app.post('/api/admin/check-releases', authRequired, requirePermission('can_manage_users'), (req, res) => {
  console.log('[MANUAL API] Running release status check...');
  // The SAME function the 08:00 cron runs. These were two copies of the sweep with
  // two differences, one of them a bug: the cron lowercased the username in its
  // UPDATE and this route did not, so for any non-lowercase caller it matched no rows
  // and still reported the game as updated.
  jobsService.checkReleases({ dedupe })
    .then((report) => res.json({
      success: true,
      message: `Release check completed. ${report.promoted.length} games updated.`,
      updatedGames: report.promoted,
      notificationsSent: report.remindersSent,
      errors: report.errors,
    }))
    .catch((err) => problem.send(res, err, { log: '[MANUAL API] Release check failed:',
      fallback: 'Failed to check releases' }));
});

// --- Terminal handlers (must be registered after every route) ---

// An unmatched /api/* path used to fall through to Express's default handler, which
// replies with HTML — the frontend then reported an unintelligible JSON parse error.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express's built-in final handler includes err.stack in the RESPONSE BODY whenever
// NODE_ENV !== 'production' — and staging runs NODE_ENV=staging, so unhandled errors
// there leaked absolute filesystem paths and internal structure to the client.
// Express 5 also forwards rejected promises from async handlers here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.path}:`, err?.stack || err);
  if (res.headersSent) return;
  res.status(err?.status || 500).json({ error: 'Internal server error' });
});

// A rejected promise with no handler exits the process under Node's default
// --unhandled-rejections=throw. Log loudly instead of dying mid-request.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

// --- Scheduled Weekly Price Update for User Libraries ---
scheduleWhenServer('0 3 * * 1', () => {   // Every Monday at 3:00 AM
  console.log('[CRON] Starting weekly Steam price update for all user libraries...');
  // STEAM_REGION passed through: the cron used to hardcode 'il' while
  // update_library_prices.js honoured the variable, so the two produced prices in
  // different currencies for the same library.
  jobsService.updatePrices({ region: process.env.STEAM_REGION || 'il' })
    .then((r) => console.log('[CRON] Weekly Steam price update complete:', r))
    .catch((err) => console.error('[CRON] Price update failed:', err.message));
});

// Only bind a port when run directly (`node index.js`). The utility scripts
// `require('./index.js')` for its exports — which used to start a second HTTP
// listener and register all the cron jobs as a side effect of the import, so
// `node run_notifications.js` left a server running and never exited.
if (isServerProcess) {
  // Bind the port only AFTER the schema is verified. Previously app.listen() ran
  // synchronously during module evaluation while migrateOrExit() was still a
  // pending promise, so there was a window in which the port was open and
  // /api/health answered {"status":"ok"} against a database with no tables.
  // That endpoint is both the container healthcheck and the CI deploy gate, so a
  // green answer there must mean the schema is actually present.
  schemaReady
    .then(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error(`[FATAL] Refusing to start: ${err.message}`);
      process.exit(1);
    });
}

// Export functions for manual scripts
// Exported for the operator scripts. `dedupe` is what run_notifications.js needs to
// run the SAME release sweep the cron runs — it used to reimplement the sweep, which
// its own header admitted had already drifted twice.
module.exports = {
  app,
  db,
  parseRouteId,
  dedupe,
};