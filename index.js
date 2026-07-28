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
// The two credential-decision helpers are reached through the MODULE, not
// destructured. Which verification outcome yields a session is the safety property of
// the login route, and a destructured binding is captured at load time and cannot be
// intercepted — so a test asserting "an unrecognised reason must not authenticate"
// could not be written against it at all. A review had to mutate the module's exports
// before index.js loaded to prove the fail-open. That is the trap CLAUDE.md documents,
// on the one route where it matters most.
const ldapHelpers = require('./ldap-helpers');
// escapeIgdbSearch is no longer used here: every APIcalypse literal in the server
// is now built inside services/catalog.js, which is the point of the extraction.
const { resolveApiKey } = require('./settings-store');
// Through the module. Which settings the LOGIN route sees decides whether it consults
// the directory at all, so a test that cannot control it cannot reach the LDAP path —
// a contract test meant to prove the verification ladder silently exercised local auth
// instead and passed against a bypass. Same destructuring trap CLAUDE.md documents.
const settingsStore = require('./settings-store');
const loadSettings = (...args) => settingsStore.loadSettings(...args);
// Service layer. Route handlers are adapters over these: they do auth and HTTP,
// the services do the work. Lets /api and the coming /api/v2 be two skins over one
// implementation instead of two implementations that drift.
const sharesService = require('./services/shares');
const libraryService = require('./services/library');
const catalogService = require('./services/catalog');
const jobsService = require('./services/jobs');
const jobRunner = require('./services/job-runner');
const usersService = require('./services/users');
const authService = require('./services/auth');
const v2 = require('./services/v2');
const settingsService = require('./services/settings');
const notifications = require('./services/notifications');
const { CODES: SVC } = require('./services/errors');
// One table maps a service error code to a status and decides whether its message
// may be shown to the caller. See services/problem.js — `expose` is the point.
const problem = require('./services/problem');
// RESERVED_USERNAMES and validatePassword are no longer imported here: the last route
// that applied them by hand (POST /api/users) now calls services/users.js#create,
// which holds both rules for BOTH surfaces.
const { sanitizeText: sanitizeDirectoryText, isValidEmailAddress } = require('./user-rules');

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
// Read once at boot from package.json — the same value the image is built from.
// Not from an env var: a version a deployer can set independently of the code is a
// version that will eventually lie about what is running.
const SERVER_VERSION = require('./package.json').version;

// Flipped by the commit that mounts the v2 router, in the same diff. Kept as one
// named constant so "is v2 live" has exactly one answer, rather than a route
// advertising availability that the router does not back.
const V2_MOUNTED = true;

app.get('/api/health', (req, res) => {
  db.get('SELECT 1', [], (err) => {
    if (err) {
      console.error('[Health] Database error:', err.message);
      return res.status(500).json({ status: 'error' });
    }
    res.json({ status: 'ok' });
  });
});

// Version discovery. THE LAST CHANGE MADE TO v1 — after the freeze it cannot be
// added, and then no client can ever learn that anything beyond /api exists.
//
// The Android companion app is a build this repository does not control and has no
// way to discover /api/v2. Nor does an operator's script, or the planned MCP. Every
// one of them would otherwise have to hardcode a version and be redeployed to learn
// it was wrong.
//
// NOT on /api/health. That endpoint is the container healthcheck and the CI deploy
// gate; it answers `{status}` and nothing else, and it is one of only two
// unauthenticated routes in the entire API. Version and deployment detail belong
// behind a credential — this tells a caller which API surfaces exist and which are
// frozen, which is exactly the kind of reconnaissance an unauthenticated endpoint
// should not hand out for free.
//
// `deprecations` is deliberately present and deliberately empty. v1 is frozen and
// PERMANENTLY SUPPORTED, not deprecated-then-sunset: the phone is not a build this
// project can update on its own schedule. The key exists so a client can learn to
// read it now, while there is nothing there to read.
app.get('/api/capabilities', authRequired, (req, res) => {
  res.json({
    serverVersion: SERVER_VERSION,
    apiVersions: [
      {
        version: 'v1',
        basePath: '/api',
        status: 'frozen',
        // Frozen means: no new routes, no changed response shapes. It does NOT mean
        // unmaintained, and it does not mean a security defect stays put — the admin
        // user endpoints stopped returning other users' notification credentials
        // while frozen. See PRODUCTION_CHANGELOG.txt.
        description: 'Stable and permanently supported. No sunset date.',
      },
      {
        version: 'v2',
        basePath: '/api/v2',
        // Advertised only once it is actually mounted. Announcing a surface that
        // does not answer is worse than announcing nothing: a client would route to
        // it and get a 404 it has no way to interpret.
        status: V2_MOUNTED ? 'available' : 'planned',
        description: 'Token-authenticated redesign. See openapi/gametracker-v2.yaml.',
      },
    ],
    deprecations: [],
  });
});

// The v2 contract, served to a logged-in session so the SPA can render it.
//
// WHY THIS IS A v1 ROUTE. The document describes /api/v2, but it cannot live there:
// v2 takes personal access tokens only, and the whole point of this endpoint is to
// be readable by someone who does not have one yet. Serving the map of the API
// through the door the map tells you how to open is a bootstrap that never starts.
//
// WHY NOT A STATIC FILE IN THE FRONTEND IMAGE. nginx would serve it to anyone who
// asks. `authRequired` is what makes "any logged-in user, read-only" true rather
// than aspirational — the spec names every route, every admin operation and every
// field, which is reconnaissance worth one credential check.
//
// Read from disk per request, not cached at boot: the file is baked into the image
// and never changes at runtime, so a cache would only add a way for the two to
// disagree after a redeploy. It is ~50 KB and this is not a hot path.
const OPENAPI_V2_PATH = path.join(__dirname, 'openapi', 'gametracker-v2.yaml');

app.get('/api/openapi/v2', authRequired, (req, res) => {
  fs.promises.readFile(OPENAPI_V2_PATH, 'utf8')
    .then((yaml) => {
      // text/yaml, not application/json: this IS the YAML source. Converting it here
      // would put a second representation of the contract in the response path, and
      // the renderers all parse YAML.
      res.type('text/yaml; charset=utf-8').send(yaml);
    })
    .catch((err) => {
      // The path is not caller-controlled, so this means the image was built wrong.
      console.error('[OpenAPI] Could not read the v2 spec:', err.message);
      res.status(500).json({ error: 'API specification unavailable' });
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
            // nobodyAnswered rather than `degraded`, and the widening is a correctness
            // fix, not a preference: `degraded` means "at least one provider FAILED", so
            // an instance whose providers are all merely SKIPPED — no API keys — is not
            // degraded, asked nobody, and reported every game in the library as not
            // existing in any database. Both message strings already existed; only the
            // condition choosing between them changed, so no response shape moves.
            const unavailable = catalogService.nobodyAnswered(lookup.providers);
            const why = unavailable
              ? 'Lookup unavailable — a game database did not respond'
              : 'Game not found in API search results';
            results.errors.push({ gameName: game.game_name, gameId: game.game_id, error: why });
            results.details.push({ gameName: game.game_name, gameId: game.game_id,
              changes: [], error: unavailable ? 'Lookup unavailable' : 'Not found' });
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
// v2's authentication: PERSONAL ACCESS TOKENS ONLY.
//
// Named, so test/api-surface.test.js can derive a v2 route's tier from the middleware
// chain exactly as it does for authRequired — an anonymous closure would make every
// v2 route indistinguishable from an unauthenticated one.
//
// A 12-hour session JWT is refused here, and the reason is not tidiness. A JWT carries
// NO SCOPE, so authorize() would hand it the account's full privilege; an API that
// declares an admin boundary and also accepts JWTs has that boundary bypassable by
// logging in with a password. v2 has no login endpoint precisely so this can hold.
//
// Everything else matches the v1 token path deliberately: the same verifier, the same
// database privilege re-read on every request, the same undifferentiated 401 for
// missing, malformed, unknown, expired and orphaned — telling a prober which of those
// applied confirms which guess was once real.
function patRequired(req, res, next) {
  const auth = req.headers.authorization;
  const credential = auth && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!authService.looksLikePat(credential)) {
    return v2.send(res, { code: SVC.UNAUTHENTICATED, message: 'this API accepts personal access tokens only' },
      { headers: v2.WWW_AUTHENTICATE });
  }
  return authService.verifyToken(credential)
    .then((identity) => {
      if (!identity) {
        // 401, not 403, and undifferentiated across missing/unknown/expired/orphaned.
        // 403 is what an insufficient SCOPE returns; conflating the two leaves a client
        // unable to tell "re-authenticate" from "stop retrying" except by reading
        // English out of `detail`, which Problem tells it never to do.
        return v2.send(res, { code: SVC.UNAUTHENTICATED, message: 'invalid or expired token' },
          { headers: v2.WWW_AUTHENTICATE });
      }
      req.user = authService.authorize(identity);
      req.auth = {
        kind: 'pat',
        scopes: identity.scopes,
        tokenId: identity.tokenId,
        expiresAt: identity.expiresAt,
      };
      next();
    })
    .catch((err) => v2.send(res, err, { log: '[v2] Token verification failed:' }));
}

// The v2 admin guard. Lands WITH the admin operations, not before them — a guard with
// no route to apply to is the unused-code problem a previous review raised.
//
// It reads `req.user.can_manage_users`, which authService.authorize() has ALREADY
// narrowed by the token's scopes: an admin account holding a library-scoped token
// arrives here with the flag false. That is the whole scope model in one line —
// re-deriving the answer from `req.auth.scopes` here would be a second copy of the
// rule, and the two would eventually disagree about which one is authoritative.
//
// NAMED and tagged with `.requiredPermission`, exactly like requirePermission: it is
// how test/api-surface.test.js derives the `pat-admin:` tier from the middleware chain
// and compares it against the spec's `x-required-scope`. An anonymous closure makes
// the strictest tier in the app the one the gate cannot see.
function requireAdminScope(req, res, next) {
  if (!req.user || !req.user.can_manage_users) {
    // 403, not 404. The caller is authenticated and the resource exists; hiding that
    // buys nothing here, because an administrative surface's existence is documented.
    return v2.send(res, {
      code: SVC.FORBIDDEN,
      message: 'this operation requires a token with the admin scope',
    });
  }
  return next();
}
requireAdminScope.requiredPermission = 'can_manage_users';

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

// The sudo-mode counter for POST /api/user/me/tokens, in its own key namespace.
//
// KEYED ON USER ID, not on IP and not on username, and each choice matters:
//   * IP would let one user lock out everyone behind the same NAT or proxy;
//   * the username namespace is the LOGIN counter, and sharing it means five
//     fat-fingered attempts on the token form lock you out of signing in — or,
//     worse, that an attacker can burn a victim's login budget from a session.
// The caller can only ever attack their OWN id here (verifyPassword takes
// req.user.id), so a per-id budget is exactly the right unit.
const sudoKeys = (userId) => [`sudo:${userId}`];

// A SECOND, independent budget covering every sudo-mode attempt that actually reaches
// the directory — successful, failed, or faulted alike.
//
// The wrong-password counter above cannot do this job. It deliberately does not count
// a directory FAULT (a user must not be locked out by an outage they did not cause)
// and it is CLEARED on success — so a review drove 40 sequential mints against a dead
// domain controller with zero throttling, and 60 concurrent ones held 60 sockets for
// ten seconds each. With the correct password it was worse: 40 successful mints cost
// the directory 80 binds and 40 subtree searches, unthrottled. Neither is an
// event-loop DoS here (LDAP is I/O-bound; /api/health stayed at 4ms) but both are an
// unbounded outbound flood at someone else's domain controller, startable by anyone
// holding any session.
//
// Deliberately generous and short: this is an amplification cap, not an auth control.
// It must not become a way to lock a user out of minting, so a legitimate burst costs
// a couple of minutes rather than the 15 the password counter imposes.
const DIRECTORY_KEYS = (userId) => [`sudo-dir:${userId}`];
const DIRECTORY_MAX_ATTEMPTS = 20;
const DIRECTORY_WINDOW_MS = 2 * 60 * 1000;

// Both counters share one store and one implementation. Writing a second copy of
// "count failures, lock out for a window" is how the two would drift on the day one
// of them is tuned — and the sweep below only evicts from the store it knows about.
function lockoutMinutes(keys, max = MAX_LOGIN_ATTEMPTS, duration = LOCKOUT_DURATION) {
  const now = Date.now();
  for (const key of keys) {
    const attempts = loginAttempts.get(key);
    if (!attempts) continue;
    if (attempts.count >= max) {
      const elapsed = now - attempts.firstAttempt;
      if (elapsed < duration) return Math.ceil((duration - elapsed) / 1000 / 60);
      loginAttempts.delete(key);
    }
  }
  return 0;
}

function trackFailures(keys) {
  const now = Date.now();
  for (const key of keys) {
    const attempts = loginAttempts.get(key) || { count: 0, firstAttempt: now };
    attempts.count++;
    if (attempts.count === 1) attempts.firstAttempt = now;
    loginAttempts.set(key, attempts);
  }
}

const clearFailures = (keys) => { for (const key of keys) loginAttempts.delete(key); };

// The login limiter, expressed in terms of the shared primitives above. Behaviour is
// unchanged — same keys, same window, same log line.
const isLockedOut = (clientIP, username) => lockoutMinutes(attemptKeys(clientIP, username));

function trackFailedAttempt(clientIP, username) {
  trackFailures(attemptKeys(clientIP, username));
  console.log(`[Auth] Failed login attempt from IP ${clientIP} for '${safeForLog(username || 'unknown', 64)}'.`);
}

// Clear only the keys belonging to the account that actually authenticated.
const clearFailedAttempts = (clientIP, username) => clearFailures(attemptKeys(clientIP, username));

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
  // Set once the directory has authenticated the caller. See the .catch at the end of
  // the LDAP path: past this point a bug must be a 500, never a fallback to local auth.
  let directoryVerified = false;
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

  // LDAP is configured: resolve the username to exactly one directory entry and
  // verify the password by binding as that entry.
  //
  // Steps 1-3 now live in ldap-helpers.js#verifyLdapCredentials, because minting a
  // personal access token has to make the SAME check and the alternative was a second
  // copy of them. Two of the branches below were once authentication bypasses, so
  // there is deliberately one implementation. What stays here is everything that is
  // specific to logging IN: the fallback policy, the group check, the user sync and
  // the session token.
  ldapHelpers.verifyLdapCredentials(ldapSettings, normalizedUsername, password).then((result) => {
    if (authCompleted) return;

    // FALL BACK on 'unreachable' and 'not_found', exactly as before. A directory
    // outage must not lock out local accounts, and a username the directory does not
    // know may still be a local one.
    if (result.reason === 'unreachable' || result.reason === 'not_found') {
      return fallbackLocalAuth();
    }

    // REFUSE on ambiguity — never fall back, never guess. If the search matched
    // several entries we cannot know which identity the caller meant, and binding as
    // an arbitrary one is an authentication bug.
    if (result.reason === 'ambiguous') {
      console.error(`[LDAP] Ambiguous login: ${result.dns.length} entries matched username '${safeForLog(normalizedUsername, 64)}'. Refusing to authenticate.`);
      // Overwhelmingly the cause is a search base that spans a compat tree. Say so —
      // this used to present as an unexplained total login outage.
      const advice = compatTreeAdvice(result.dns, ldapSettings.base);
      if (advice) console.error(`[LDAP] ${advice}`);
      trackFailedAttempt(clientIP, normalizedUsername);
      authCompleted = true;
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Wrong password for a directory account. Still falls back, as before: the same
    // username may also exist locally with a different password.
    if (result.reason === 'bad_password') {
      trackFailedAttempt(clientIP, normalizedUsername);
      return fallbackLocalAuth();
    }

    // POSITIVE test, and the ladder above is not trusted to have been exhaustive.
    //
    // This used to fall straight through to the success branch for any reason string
    // the ladder did not name — a review proved it by returning an unrecognised
    // reason and watching the route log "User password authentication succeeded" for
    // a FAILED verification. It fails closed today only by accident, because
    // `result.entry` is absent and reading `.dn` throws into the catch below. Add a
    // future non-ok reason that carries an entry — `password_expired` and
    // `account_locked` are both natural shapes for this function — and the route
    // issues a session for a verification that failed.
    //
    // Decided by omission is exactly how authorization has gone wrong here before.
    if (!result.ok) {
      console.error('[LDAP] Unrecognised verification result, refusing:', result.reason);
      return fallbackLocalAuth();
    }
    // The directory has now SPOKEN, and from here a thrown exception must not become a
    // local login. Everything below — the group test, the attribute reads, the user
    // sync — runs after authentication but before `authCompleted` is set, and the
    // terminal .catch used to answer that window with fallbackLocalAuth(). A review
    // forced it: with the group test throwing, a user OUT of the group and holding a
    // local password got a 200 and a session. Before the extraction the same throw
    // crashed the process, which was fail-CLOSED; the .catch traded that for fail-open.
    directoryVerified = true;

    const foundUser = result.entry;
    console.log('[LDAP] User password authentication succeeded.');

    // 4. Check group membership (Authorization).
    // The failed-attempt counter is deliberately NOT cleared yet: a user who
    // authenticates but is outside the required group is not authorized, so clearing
    // here would let them reset the throttle at will.
    if (ldapSettings.requiredGroup) {
      console.log('[LDAP] User is member of groups:', attrValues(foundUser, 'memberOf'));
      if (!ldapHelpers.satisfiesRequiredGroup(foundUser, ldapSettings.requiredGroup)) {
        console.log(`[LDAP] Authorization failed: User is not in required group '${ldapSettings.requiredGroup}'.`);
        authCompleted = true;
        return res.status(403).json({ error: 'Not a member of the required group' });
      }
      console.log('[LDAP] Authorization passed: Group membership check OK.');
    }
    // Fully authenticated AND authorized — now it is safe to clear.
    clearFailedAttempts(clientIP, normalizedUsername);

    // 5. Create the session.
    let cnValue = attrValue(foundUser, 'cn');
    if (!cnValue && foundUser.dn) {
      const match = foundUser.dn.match(/CN=([^,]+)/i);
      if (match) cnValue = match[1];
    }
    // Sanitised before it becomes users.display_name: a directory-supplied cn
    // containing newlines was stored verbatim and then rendered in the UI,
    // notification subjects and exports.
    const cleanCn = sanitizeDirectoryText(cnValue);
    const displayName = cleanCn !== '' ? cleanCn : normalizedUsername;
    const userEmail = attrValue(foundUser, 'mail', 'email');

    // safeForLog: these are raw directory attribute values. ldapjs escapes control
    // characters inside a DN but NOT inside attributes, so a cn of
    // "bob\n[LDAP] Service account bind succeeded." wrote a fabricated line straight
    // into the audit trail.
    console.log('[DEBUG] Extracted cnValue:', safeForLog(cnValue));
    console.log('[DEBUG] Final displayName:', safeForLog(displayName));
    console.log('[DEBUG] User email from LDAP:', safeForLog(userEmail));

    getOrCreateUser(normalizedUsername, (err, user) => {
      if (err) {
        if (authCompleted) return;
        authCompleted = true;
        return res.status(500).json({ error: 'DB error' });
      }
      const updates = ['display_name = ?, origin = ?'];
      const params = [displayName, 'ldap'];
      // Validated at THIS write site, not only at the send sink. The comment on
      // isValidEmailAddress names four writers that must all check; this one — the
      // LDAP login path — was not among them, so a directory-supplied address
      // smuggling a comma reached users.email and could fan notifications out to
      // arbitrary third parties from this deployment's SPF/DKIM-aligned domain.
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
        display_name: displayName,
      }, JWT_SECRET, { expiresIn: '12h' });
      if (authCompleted) return;
      authCompleted = true;
      res.json({ token });
    }, { origin: 'ldap', display_name: displayName });
  }).catch((ldapError) => {
    // verifyLdapCredentials never rejects, so this is a defect in the handling above
    // rather than a directory failure.
    console.error('[LDAP] Unexpected error handling the directory result:', ldapError);
    if (authCompleted) return;
    // AFTER the directory authenticated, a bug is a 500. Falling back here would let an
    // exception in the group test hand a session to someone the directory just refused
    // to authorize — fail-open on authorization, which is worse than an outage.
    if (directoryVerified) {
      authCompleted = true;
      return res.status(500).json({ error: 'Authentication error' });
    }
    // BEFORE it spoke, falling back is right: a bug here must not become a total login
    // outage for local accounts.
    return fallbackLocalAuth();
  });
});

// --- User Management Endpoints ---
// Postgres raises 22P02 when a non-numeric value is compared against an INTEGER
// column, so an unvalidated :id surfaced as an opaque 500 (and filled the log with
// fake database errors) where SQLite simply matched nothing and 404'd.
// See divergence 5 in db.js.
function parseRouteId(value) {
  if (!/^[0-9]+$/.test(String(value))) return null;
  const n = Number(value);
  // BOUNDED, not merely numeric. Every id this parses addresses a Postgres `integer`
  // column, and a value past int4 reaches the driver as an out-of-range error that
  // surfaces as `500 {"error":"DB error"}` — a request that is simply not found
  // reported as a server fault, plus log noise on every scan. `99999999999999999999`
  // did this on both DELETE /api/users/:id and DELETE /api/user/me/tokens/:tokenId.
  //
  // MAX_SAFE_INTEGER is not the right ceiling either: beyond it, Number() silently
  // rounds, so two different ids would parse to the same number.
  const INT4_MAX = 2147483647;
  return n >= 1 && n <= INT4_MAX ? n : null;
}

// Create user (admin only)
app.post('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  // The WHOLE body to the service, same as the update path and for the same reasons:
  // every rule this route used to spell out — the string check that keeps a JSON
  // number away from bcrypt.hash, the password policy, the email validation, the
  // reserved-name list, the notification-target refusal — now lives in
  // services/users.js#create, where /api/v2 gets exactly the same ones.
  usersService.create(req.body || {})
    .then((created) => res.json({ success: true, id: created.id }))
    .catch((err) => {
      // v1's ONE deliberate divergence from the taxonomy, and it is a compatibility
      // shim rather than a rule: a duplicate username has always answered 400 here,
      // and the service reports CONFLICT, which problem.js maps to 409. v2 gets the
      // 409 its spec documents; this keeps the status v1 clients have seen since the
      // beginning. The message is unchanged in both.
      if (err && err.code === SVC.CONFLICT) {
        return res.status(400).json({ error: 'User already exists' });
      }
      problem.send(res, err, { log: '[Users] Create failed:', fallback: 'Failed to create user' });
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

// ─────────────────────────────────────────────────────────────────────────────
// /api/v2 — the first routes
// ─────────────────────────────────────────────────────────────────────────────
//
// A SEPARATE ROUTER, mounted once. That is what lets test/api-surface.test.js walk
// v2 as its own surface (KNOWN_MOUNTS has listed '/api/v2' since before any of it
// existed) and what keeps `patRequired` off every v1 route.
//
// These adapters are THIN by contract: auth and HTTP here, work in the services, so
// /api and /api/v2 remain two skins over one implementation. Nothing below reaches
// into the database or reimplements a rule — where v2 differs from v1 it is because
// the SERVICE offers a different function, not because the adapter behaves differently.
//
// openapi/gametracker-v2.yaml is the source for these, not a description of them:
// every operation here matches an `x-implemented: true` operation in that document,
// and test/api-surface.test.js fails if the two disagree in either direction.
const v2Router = express.Router();

// Every v2 route is token-authenticated. Applied to the ROUTER rather than repeated
// per route, so a new route cannot be added unauthenticated by forgetting a word.
v2Router.use(patRequired);

// GET /api/v2/me — identity and EFFECTIVE privilege, for orientation.
v2Router.get('/me', (req, res) => {
  res.json(v2.me(req.user, req.auth));
});

// GET /api/v2/tokens — this account's tokens. The secret is never returned.
v2Router.get('/tokens', (req, res) => {
  authService.listTokens(req.user.id)
    .then((rows) => res.json({ data: rows.map(v2.token) }))
    .catch((err) => v2.send(res, err, { log: '[v2] token list failed:' }));
});

// POST /api/v2/tokens — mint one. The secret is in this response and nowhere else.
//
// `grantedScopes` is the PRESENTING credential's effective scope set, so a token can
// never mint one carrying a scope it does not itself hold. Without that this operation
// is an escape hatch out of the whole scope system: the library-scoped token handed to
// the MCP would mint itself an admin token and be an administrator one call later.
v2Router.post('/tokens', (req, res) => {
  const body = req.body || {};
  authService.createToken({
    userId: req.user.id,
    name: body.name,
    scopes: body.scopes,
    expiresAt: body.expiresAt ?? null,
    grantedScopes: req.auth.scopes,
  })
    .then((result) => res.status(201).json(v2.tokenCreated(result)))
    .catch((err) => v2.send(res, err, { log: '[v2] token create failed:' }));
});

// DELETE /api/v2/tokens/:tokenId — revocation is the whole point of the design.
// Owner-scoped inside the DELETE, so another account's id removes nothing and says so.
v2Router.delete('/tokens/:tokenId', (req, res) => {
  const id = parseRouteId(req.params.tokenId);
  if (id === null) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such token' });
  authService.revokeToken(id, req.user.id)
    .then(() => res.status(204).end())
    .catch((err) => v2.send(res, err, { log: '[v2] token revoke failed:' }));
});

// GET /api/v2/me/notifications — the caller's own delivery targets.
v2Router.get('/me/notifications', (req, res) => {
  usersService.readNotificationSettings(req.user.id)
    .then((row) => res.json(v2.notificationSettings(row)))
    .catch((err) => v2.send(res, err, { log: '[v2] notification read failed:' }));
});

// PATCH /api/v2/me/notifications — partial; absent keys are left alone.
v2Router.patch('/me/notifications', (req, res) => {
  usersService.updateNotificationSettings(req.user.id, req.body || {})
    .then((row) => res.json(v2.notificationSettings(row)))
    .catch((err) => v2.send(res, err, { log: '[v2] notification write failed:' }));
});

// GET /api/v2/library/games — filtered, sorted, paged SERVER-SIDE.
v2Router.get('/library/games', (req, res) => {
  libraryService.listPage(req.user.id, {
    status: req.query.status,
    sort: req.query.sort,
    order: req.query.order,
    limit: req.query.limit,
    cursor: req.query.cursor,
  })
    .then((page) => res.json({
      data: page.data.map(v2.libraryGame),
      meta: page.meta,
    }))
    .catch((err) => v2.send(res, err, { log: '[v2] library list failed:' }));
});

// GET /api/v2/library/games/:gameId — v1 had no per-game read outside a route
// literally named /api/debug/, so reading one game meant fetching the whole library.
v2Router.get('/library/games/:gameId', (req, res) => {
  libraryService.findGame(req.user.id, req.params.gameId)
    .then((row) => {
      if (!row) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such game in your library' });
      res.json(v2.libraryGame(row));
    })
    .catch((err) => v2.send(res, err, { log: '[v2] game read failed:' }));
});

// DELETE /api/v2/library/games/:gameId — 204, or 404 when there was nothing to
// delete. v1 answered {"success":true} either way, so a mistyped id was a silent
// no-op reported as success: the worst possible shape for an LLM-driven client.
v2Router.delete('/library/games/:gameId', (req, res) => {
  libraryService.removeGame(req.user.id, req.params.gameId)
    .then(({ removed }) => {
      if (!removed) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such game in your library' });
      res.status(204).end();
    })
    .catch((err) => v2.send(res, err, { log: '[v2] game delete failed:' }));
});

// PATCH /api/v2/library/games/:gameId — status only, re-derived from the STORED date.
//
// There is deliberately no releaseDate in the body. Accepting one is what let v1 write
// an already-released game back to `unreleased` and then announce it to every
// notification channel on the next correct write.
v2Router.patch('/library/games/:gameId', (req, res) => {
  const body = req.body || {};
  if (!Object.hasOwn(body, 'status')) {
    return v2.send(res, {
      code: SVC.VALIDATION,
      message: 'status is the only updatable field; send it',
      details: { field: 'status' },
    });
  }
  libraryService.setStatus(req.user.id, req.params.gameId, body.status)
    .then(({ game }) => res.json(v2.libraryGame(game)))
    .catch((err) => v2.send(res, err, { log: '[v2] status change failed:' }));
});

// GET /api/v2/library/backlog — the backlog in display order.
v2Router.get('/library/backlog', (req, res) => {
  libraryService.listBacklog(req.user.id)
    .then((rows) => res.json({ data: rows.map(v2.backlogEntry) }))
    .catch((err) => v2.send(res, err, { log: '[v2] backlog read failed:' }));
});

// PUT /api/v2/library/backlog — replace the order wholesale.
//
// Bulk BY DESIGN: ordering is a set operation, and applying it as a sequence of moves
// leaves a half-ordered list on any failure. One transaction under one advisory lock.
v2Router.put('/library/backlog', (req, res) => {
  const order = (req.body || {}).order;
  if (!Array.isArray(order)) {
    return v2.send(res, {
      code: SVC.VALIDATION, message: 'order must be an array of game ids',
      details: { field: 'order' },
    });
  }
  if (order.length > 1000) {
    return v2.send(res, {
      code: SVC.VALIDATION, message: 'order may contain at most 1000 ids',
      details: { field: 'order' },
    });
  }
  libraryService.reorderBacklog(req.user.id, order)
    .then((meta) => libraryService.listBacklog(req.user.id)
      .then((rows) => res.json({ data: rows.map(v2.backlogEntry), meta })))
    .catch((err) => v2.send(res, err, { log: '[v2] reorder failed:' }));
});

// GET /api/v2/catalog/search — the merged provider search, with the outage signal in
// the envelope instead of a header.
//
// v1 returns a BARE ARRAY and puts the degradation flag in X-Catalog-Degraded, because
// the SPA does `Array.isArray(res.data) ? res.data : []` and an envelope would have
// broken it. A header is the wrong place for a fact a client must branch on — generated
// clients drop them, and an LLM reading the body sees an ordinary empty list. Here it
// is `meta.degraded`, alongside per-provider statuses, and a TOTAL outage is a 502
// rather than an empty array (services/catalog.js#search).
v2Router.get('/catalog/search', (req, res) => {
  catalogService.search(req.query.q, { limit: req.query.limit })
    .then((result) => res.json({
      data: result.results.map(v2.catalogGame),
      meta: v2.searchMeta(result),
    }))
    .catch((err) => v2.send(res, err, { log: '[v2] catalog search failed:' }));
});

// POST /api/v2/library/games — add by id, or by name.
//
// TWO service calls and no rules of its own: catalog decides WHICH game, library
// decides what storing it means. The name path collapses search-then-add into one
// call, and an ambiguous name is a 409 carrying the candidates rather than a guess.
v2Router.post('/library/games', (req, res) => {
  const body = req.body || {};
  catalogService.resolveGame({ gameId: body.gameId, name: body.name })
    // `status` is passed through UNDEFAULTED. The default — and the rule that omitting
    // it must not demote a game already in the library — belongs to the service; a
    // `?? 'wishlist'` here would silently override the stored status on every re-add.
    .then((game) => libraryService.addResolvedGame(req.user.id, game, body.status)
      .then((result) => {
        // 201 vs 200 is the ONLY signal that a retried call did not create a second
        // entry. Idempotent by gameId is what makes an agent's retry safe; saying so
        // is what stops it reporting the game as newly added twice.
        res.status(result.created ? 201 : 200).json(v2.libraryGame(result.game));

        // AFTER the response, chained, terminally caught — the same three properties
        // the v1 adapter needs and for the same reasons (see POST
        // /api/user/:username/games). A user's own ntfy box being unreachable must not
        // fail, or delay, adding a game.
        result.events.reduce(
          (prev, event) => prev.then(() => notifyEvent(
            event, { gameName: game.name, coverUrl: game.coverUrl },
            req.user.username, result.status)),
          Promise.resolve(),
        ).catch((e) => console.error('[v2] notification dispatch failed:', e?.message || e));
      }))
    .catch((err) => v2.send(res, err, { log: '[v2] add game failed:' }));
});

// GET /api/v2/shares — both directions in one call.
//
// v1 needs three requests and a directory fetch to build this: one for outgoing, one
// for incoming, and the whole user list to turn usernames into display names.
// GET /api/v2/users/directory — who can this library be shared WITH.
//
// Library-scoped, not admin. Sharing needs a target, and `listUsers` is admin-only —
// so before this, a non-admin credential could reach POST /shares/outgoing and had no
// way to discover a single valid value for it. A write whose only argument is
// undiscoverable is not a usable operation, and an MCP client hits that wall first.
//
// Username and display name ONLY. Every credential on the instance can read this, so
// it carries what a share picker needs and nothing else — the admin listing keeps the
// email, the permission flag and the origin.
v2Router.get('/users/directory', (req, res) => {
  sharesService.listDirectory()
    .then((rows) => res.json({
      data: rows.map((r) => ({
        username: r.username,
        // Falls back to the username rather than emitting null: this field exists to
        // be rendered, and a picker showing a blank row is worse than a plain one.
        displayName: r.display_name || r.username,
      })),
    }))
    .catch((err) => v2.send(res, err, { log: '[v2] directory list failed:' }));
});

// GET /api/v2/catalog/prices/:steamAppId — a LIVE price, unlike the library row's
// `lastPrice`, which is whatever the weekly sweep last stored.
//
// The three outcomes are kept distinct on purpose. A game Steam has no price for
// answers 200 with a null price and a reason — free and unreleased titles are the
// common case, and a caller that reads "no price" as a failure reports an outage every
// time someone asks about one. Steam being unreachable is a 502, because that is this
// server's problem and not an answer about the game.
v2Router.get('/catalog/prices/:steamAppId', (req, res) => {
  const steamAppId = String(req.params.steamAppId || '');
  // Validated here rather than passed through: this value goes into an outbound URL,
  // and the spec's pattern is only a promise until something enforces it.
  if (!/^[0-9]{1,10}$/.test(steamAppId)) {
    return v2.send(res, { code: SVC.VALIDATION, message: 'steamAppId must be a Steam application id' });
  }
  const region = req.query.region === undefined ? 'il' : String(req.query.region);
  if (!/^[a-z]{2}$/.test(region)) {
    return v2.send(res, { code: SVC.VALIDATION, message: 'region must be a two-letter country code' });
  }
  jobsService.fetchSteamPrice(steamAppId, { region })
    .then((result) => {
      if (!result.ok) {
        // The upstream message is logged, never returned — it is a third party's error
        // text about a request this caller did not make.
        console.error(`[v2] Steam price lookup failed for ${safeForLog(steamAppId, 20)}:`, result.error);
        return v2.send(res, { code: SVC.PROVIDER_UNAVAILABLE, message: 'Steam could not be reached' });
      }
      res.json({ steamAppId, region, price: result.price, reason: result.reason });
    })
    .catch((err) => v2.send(res, err, { log: '[v2] price lookup failed:' }));
});

v2Router.get('/shares', (req, res) => {
  Promise.all([
    sharesService.listOutgoingShares(req.user.username),
    sharesService.listIncomingShares(req.user.username),
  ])
    .then(([outgoing, incoming]) => res.json({
      outgoing: outgoing.map(v2.share),
      incoming: incoming.map(v2.share),
    }))
    .catch((err) => v2.send(res, err, { log: '[v2] share list failed:' }));
});

// PUT /api/v2/shares/outgoing — REPLACE, and spelled as the verb that means it.
//
// v1 spells this POST while giving it replace semantics, so an agent "adding a share"
// by posting one name silently revoked every other one. Same service call, honest
// method; POST below adds.
v2Router.put('/shares/outgoing', (req, res) => {
  const usernames = (req.body || {}).usernames;
  if (!Array.isArray(usernames)) {
    return v2.send(res, {
      code: SVC.VALIDATION, message: 'usernames must be an array',
      details: { field: 'usernames' },
    });
  }
  if (usernames.length > 200) {
    return v2.send(res, {
      code: SVC.VALIDATION, message: 'usernames may contain at most 200 entries',
      details: { field: 'usernames' },
    });
  }
  sharesService.replaceOutgoing(req.user.username, usernames)
    .then(() => sharesService.listOutgoingShares(req.user.username))
    .then((rows) => res.json({ data: rows.map(v2.share) }))
    .catch((err) => v2.send(res, err, { log: '[v2] share replace failed:' }));
});

// POST /api/v2/shares/outgoing — add ONE. Additive and idempotent.
v2Router.post('/shares/outgoing', (req, res) => {
  sharesService.addOutgoing(req.user.username, (req.body || {}).username)
    // 201 on the idempotent path too: the resource named in the request exists after
    // this call either way, and a 200/201 split here would only tell the caller
    // whether they had already done it — which is not a fact worth a branch.
    .then((row) => res.status(201).json(v2.share(row)))
    .catch((err) => v2.send(res, err, { log: '[v2] share add failed:' }));
});

// DELETE /api/v2/shares/outgoing/:username — revoke one.
//
// The 404 is decided by whether a ROW was deleted, never by whether the account
// exists. See services/shares.js#removeOutgoing: the alternative is a username oracle.
v2Router.delete('/shares/outgoing/:username', (req, res) => {
  sharesService.removeOutgoing(req.user.username, req.params.username)
    .then(({ removed }) => {
      if (!removed) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such share' });
      res.status(204).end();
    })
    .catch((err) => v2.send(res, err, { log: '[v2] share revoke failed:' }));
});

// GET /api/v2/shares/incoming/:username/games — read a library shared with you.
//
// THE ONE OPERATION WHERE BEING AN ADMINISTRATOR GRANTS NOTHING, and the reason there
// is no ownership middleware on this route: the grant check is the authorization, and
// it is a consent relationship between two accounts rather than a resource the server
// owns. A 403 here is deliberately indistinguishable from a library that does not
// exist.
v2Router.get('/shares/incoming/:username/games', (req, res) => {
  sharesService.readSharedPage(req.params.username, req.user.username, {
    limit: req.query.limit,
    cursor: req.query.cursor,
  })
    .then((page) => res.json({ data: page.data.map(v2.libraryGame), meta: page.meta }))
    .catch((err) => v2.send(res, err, { log: '[v2] shared library read failed:' }));
});

// --- admin -------------------------------------------------------------------
//
// `requireAdminScope` is repeated per route rather than applied with a path-scoped
// `v2Router.use('/users', ...)`. Both work; only one is visible to
// test/api-surface.test.js, which credits a `.use()` to a route only when it is
// mounted at the router root — deliberately, because attributing a path-scoped
// middleware to every route in a router is the fail-open reporting that gate was
// fixed for. Repeating the word makes each route's tier derivable from its own chain.

// GET /api/v2/users — every account, without a single notification target.
v2Router.get('/users', requireAdminScope, (req, res) => {
  usersService.listAll()
    .then((rows) => res.json({ data: rows.map(v2.user) }))
    .catch((err) => v2.send(res, err, { log: '[v2] user list failed:' }));
});

// POST /api/v2/users — create an account. 409 on a duplicate, which is the status the
// v1 route answers 400 for; see that route for why the two differ.
v2Router.post('/users', requireAdminScope, (req, res) => {
  let fields;
  try {
    fields = v2.userWrite(req.body || {}, { create: true });
  } catch (err) { return v2.send(res, err); }
  usersService.create(fields)
    .then((created) => usersService.listAll()
      .then((rows) => {
        // From the admin projection, not from what was sent: it is the shape every
        // other user response uses, and building this one from the request would let
        // a client learn a value the database does not actually hold.
        const row = rows.find((r) => r.id === created.id);
        res.status(201).json(v2.user(row));
      }))
    .catch((err) => v2.send(res, err, { log: '[v2] user create failed:' }));
});

// PATCH /api/v2/users/:userId — partial update. PATCH, because that is what it does;
// v1 spells the same partial semantics PUT.
v2Router.patch('/users/:userId', requireAdminScope, (req, res) => {
  const id = parseRouteId(req.params.userId);
  if (id === null) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such user' });
  let fields;
  try {
    fields = v2.userWrite(req.body || {}, { create: false });
  } catch (err) { return v2.send(res, err); }
  usersService.update(id, fields, req.user.id)
    .then(() => usersService.listAll())
    .then((rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such user' });
      res.json(v2.user(row));
    })
    .catch((err) => v2.send(res, err, { log: '[v2] user update failed:' }));
});

// DELETE /api/v2/users/:userId — 204. The service refuses self-deletion and `root`.
v2Router.delete('/users/:userId', requireAdminScope, (req, res) => {
  const id = parseRouteId(req.params.userId);
  if (id === null) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such user' });
  usersService.remove(id, req.user.id)
    .then(() => res.status(204).end())
    .catch((err) => v2.send(res, err, { log: '[v2] user delete failed:' }));
});

// --- another account's tokens (admin) ------------------------------------------
//
// The deprovisioning surface. Blocking new mints is not revoking old ones: a token
// minted before its holder was removed from ldap.requiredGroup keeps working and has
// no expiry unless one was set — and until these routes existed, destroying it meant
// DELETING THE ACCOUNT, taking the user's library with it.
//
// requireAdminScope is repeated on each, never applied with a path-scoped
// v2Router.use('/users', ...). Both work at runtime; only this form is visible to the
// drift gate, which credits a `.use()` to a route only when it is mounted at the
// router root. See CLAUDE.md.

// GET /api/v2/users/:userId/tokens — you cannot revoke what you cannot see.
v2Router.get('/users/:userId/tokens', requireAdminScope, (req, res) => {
  const id = parseRouteId(req.params.userId);
  if (id === null) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such user' });
  authService.listTokensForUser(id)
    .then((rows) => {
      // LOGGED, like the two deletes. Enumerating which accounts hold admin-scoped
      // tokens and when each was last used is the reconnaissance step before using a
      // stolen admin token — and it was the one step in this group that left no trace.
      console.log(`[v2] '${safeForLog(req.user.username, 64)}' listed ${rows.length} token(s) for user ${id}`);
      res.json({ data: rows.map(v2.token) });
    })
    .catch((err) => v2.send(res, err, { log: '[v2] admin token list failed:' }));
});

// DELETE /api/v2/users/:userId/tokens — revoke ALL of them.
//
// 200 with a count, not 204, and zero is a success. "That account had nothing to
// revoke" is the outcome the administrator wanted; making it an error would train them
// to ignore errors from the one call whose whole job is to be trusted in an incident.
v2Router.delete('/users/:userId/tokens', requireAdminScope, (req, res) => {
  const id = parseRouteId(req.params.userId);
  if (id === null) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such user' });
  authService.revokeAllTokensForUser(id)
    .then((result) => {
      // Logged unconditionally, including the zero case. This is the audit record for
      // an action taken on someone else's credentials, and "nothing happened" is worth
      // as much as "seven revoked" when reconstructing an incident afterwards.
      console.log(`[v2] '${safeForLog(req.user.username, 64)}' revoked ${result.revoked} token(s) for user ${id}`);
      res.json({ revoked: result.revoked });
    })
    .catch((err) => v2.send(res, err, { log: '[v2] admin bulk revoke failed:' }));
});

// DELETE /api/v2/users/:userId/tokens/:tokenId — revoke exactly one.
//
// For a single leaked credential, where revoking everything would be an outage the
// incident does not call for. BOTH ids are matched in the service's WHERE clause, so a
// mistyped userId cannot destroy a token from an account nobody meant to touch.
v2Router.delete('/users/:userId/tokens/:tokenId', requireAdminScope, (req, res) => {
  const userId = parseRouteId(req.params.userId);
  const tokenId = parseRouteId(req.params.tokenId);
  if (userId === null || tokenId === null) {
    return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such token' });
  }
  authService.revokeTokenForUser(tokenId, userId)
    .then(() => {
      console.log(`[v2] '${safeForLog(req.user.username, 64)}' revoked token ${tokenId} for user ${userId}`);
      res.status(204).end();
    })
    .catch((err) => v2.send(res, err, { log: '[v2] admin revoke failed:' }));
});

// GET /api/v2/settings — server configuration, secrets masked.
//
// A non-admin gets 403 here. v1 answers 200 with `{}`, which for a browser rendering
// the Diagnostics tab is harmless and for a programmatic client is a correctness hole:
// `{}` cannot be told apart from "this server has no SMTP configured", so an agent
// reasoning over it states something false about the system.
v2Router.get('/settings', requireAdminScope, (req, res) => {
  try {
    const { sections, degraded } = settingsService.readForRoleWithStatus(true);
    res.json(v2.maskedSettings(sections, settingsService.listApiKeys(), degraded));
  } catch (err) {
    v2.send(res, err, { log: '[v2] settings read failed:' });
  }
});

// PATCH /api/v2/settings — partial, per section.
//
// TWO stores behind one operation: services/settings.js#write owns the five sections,
// #writeApiKeys owns `apikeys`. They are separate because API keys are write-only —
// there is no masked form to send back, which is what makes a read-modify-write here
// unable to destroy them. Both refuse outright when the file could not be read, since
// a merge on top of a failed load erases every credential on the instance.
v2Router.patch('/settings', requireAdminScope, (req, res) => {
  try {
    const { sections, apikeys } = v2.settingsUpdate(req.body || {});
    // Sections first. If the API-key write then throws, the sections are already
    // saved — the alternative is a two-file transaction over a single JSON document,
    // which does not exist. Both writers are refused as a unit by the same unreadable
    // -file check, so the case this leaves open is a disk error mid-write, which
    // loadForWrite() already refuses to compound.
    settingsService.write(sections, true);
    if (apikeys) settingsService.writeApiKeys(apikeys);
    const { sections: after, degraded } = settingsService.readForRoleWithStatus(true);
    res.json(v2.maskedSettings(after, settingsService.listApiKeys(), degraded));
  } catch (err) {
    v2.send(res, err, { log: '[v2] settings write failed:' });
  }
});

// --- jobs --------------------------------------------------------------------
//
// The two pieces of state services/jobs.js does not own, passed in once. `dedupe` is
// the file-backed sent-notifications log; without it every run re-sends every due
// reminder to real users, which is why jobs.js REQUIRES it rather than defaulting.
// `refreshCrackStatus` wraps the module-scope cache below, returning its size so the
// job has a count to report.
// A FUNCTION, evaluated per request, not a module-scope object. `dedupe` is declared
// several hundred lines below this point, so building the object here would read it in
// its temporal dead zone and `require('./index')` would throw ReferenceError before the
// server ever listened — the same class of failure the exports block at the end of
// services/library.js carries a comment about. Deferring the read costs nothing and
// removes the ordering dependency entirely.
const jobDeps = () => ({
  dedupe,
  refreshCrackStatus: async () => {
    await refreshCrackWatchCache();
    return Object.keys(crackWatchCache).length;
  },
});

// POST /api/v2/library/refresh — the caller's OWN library. 202, never inline.
//
// Separate from POST /jobs, and that separation is the control: an instance-wide
// `kind` enum on one admin-only operation is how "refresh my library" quietly becomes
// "refresh everyone's". This one is library-scoped and hard-wired to scope 'self'.
v2Router.post('/library/refresh', (req, res) => {
  try {
    const record = jobRunner.start({
      kind: 'refreshMetadata',
      scope: 'self',
      ownerId: req.user.id,
      work: () => jobsService.runJob('refreshMetadata', { scope: 'self', userId: req.user.id, deps: jobDeps() }),
    });
    res.status(202).location(`/api/v2/jobs/${record.id}`).json(v2.job(record));
  } catch (err) {
    v2.send(res, err, { log: '[v2] refresh start failed:' });
  }
});

// POST /api/v2/jobs — the INSTANCE-WIDE sweeps. Admin-only by definition.
v2Router.post('/jobs', requireAdminScope, (req, res) => {
  const kind = (req.body || {}).kind;
  if (!jobsService.JOB_KINDS.includes(kind)) {
    return v2.send(res, {
      code: SVC.VALIDATION,
      message: `kind must be one of: ${jobsService.JOB_KINDS.join(', ')}`,
      details: { field: 'kind' },
    });
  }
  try {
    const record = jobRunner.start({
      kind,
      scope: 'instance',
      ownerId: req.user.id,
      work: () => jobsService.runJob(kind, { scope: 'instance', deps: jobDeps() }),
    });
    res.status(202).location(`/api/v2/jobs/${record.id}`).json(v2.job(record));
  } catch (err) {
    v2.send(res, err, { log: '[v2] job start failed:' });
  }
});

// GET /api/v2/jobs/:jobId — status and result, for the account that STARTED it.
//
// library-scoped, not admin: POST /library/refresh is, and an operation that hands
// back a job its own caller cannot poll is not an operation. OWNERSHIP is what
// protects an instance-wide job's result, which matters because its `failures[]` names
// game ids from every user's library. Someone else's id is a 404, never a 403 — which
// is only worth having because the ids are 24 random bytes rather than sequential.
v2Router.get('/jobs/:jobId', (req, res) => {
  const record = jobRunner.get(req.params.jobId, req.user.id);
  if (!record) return v2.send(res, { code: SVC.NOT_FOUND, message: 'no such job' });
  res.json(v2.job(record));
});

// ─── EVERY v2 ROUTE MUST BE REGISTERED ABOVE THIS LINE ───────────────────────
//
// Express matches layers in stack order, so the catch-all below answers anything
// declared after it. Three routes were added below it once and every one of them
// returned 404 with the middleware and the inventory both looking correct — the
// authorization gate cannot see this, because the routes exist on the router and
// carry the right tier; they are simply unreachable. Only booting the server found
// it. test/api-surface.test.js now asserts the ordering directly.

// An unknown /api/v2 path, answered in v2's format. Without this the app-level
// terminal handler replies `{"error":"Not found"}` as application/json — the v1
// envelope, on a surface whose entire contract says problem+json, so a generated
// client's problem parser fails on the one response it is most likely to meet.
v2Router.use((req, res) => {
  v2.send(res, { code: SVC.NOT_FOUND, message: 'no such endpoint' });
});

// Same reasoning for anything thrown past a v2 handler. Four arguments: Express
// identifies an error handler by arity, so `next` must stay even though it is unused.
// eslint-disable-next-line no-unused-vars
v2Router.use((err, req, res, next) => {
  v2.send(res, err, { log: '[v2] unhandled:' });
});

app.use('/api/v2', v2Router);

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

// --- Personal access tokens, managed from the browser ------------------------
//
// The BOOTSTRAP surface, and the second (and intended last) documented exception to
// the v1 freeze — same reason as GET /api/openapi/v2, stated in CLAUDE.md: /api/v2
// takes tokens only, so the endpoint that MINTS your first token cannot itself
// require one. `POST /api/v2/tokens` still exists and is the right call for a script
// that already holds a token; this is how a human gets the first one without a shell
// on the server, which until now was the only way.
//
// All three are session-authenticated and operate on `req.user.id` — the caller's own
// row, never a path parameter. There is no user to pass wrongly, which is why these
// need neither ownershipRequired nor selfOnly.

// The caller's own tokens. The secret is not stored in plaintext and cannot be
// re-derived, so this is a list of what exists, not of what they are.
app.get('/api/user/me/tokens', authRequired, (req, res) => {
  authService.listTokens(req.user.id)
    .then((rows) => res.json({ tokens: rows }))
    .catch((err) => problem.send(res, err, { log: '[Tokens] List failed:' }));
});

// Mint one. The plaintext is in this response and nowhere else, ever again.
app.post('/api/user/me/tokens', authRequired, (req, res) => {
  const body = req.body || {};

  // SUDO MODE, and its LIMIT stated honestly.
  //
  // What it does: a NON-ADMIN session cannot turn itself into a credential that
  // outlives it. That is a real persistence escalation — the token never expires,
  // where the session lasts twelve hours — and re-entering the password is what
  // GitHub and GitLab both require here.
  //
  // What it does NOT do, and an earlier version of this comment wrongly claimed it
  // did: stop a stolen ADMIN session. An admin may PUT /api/users/:id against their
  // own id to set a new password with no knowledge of the old one, then mint with the
  // password they just chose. A security review demonstrated it in two requests.
  // Nothing is lost by it — a stolen admin session can already create a second admin
  // account and persist that way — but a comment asserting a guarantee its code does
  // not provide is worse than no comment, which is this codebase's own standard.
  //
  // Closing it means requiring the current password on a self-targeted password
  // change in PUT /api/users/:id. That route is v1 and frozen, and adding a required
  // field would break the admin UI, so it is recorded here rather than done quietly.
  //
  // RATE LIMITED, per user id. Without this the check below is an unthrottled
  // password oracle — measured at 11.6 guesses/second sustained, against a control
  // whose whole job is to be hard to pass, while the identical check in the login
  // route stops after five. It is also the first route in this codebase that lets a
  // non-admin trigger unbounded bcrypt work: 30 concurrent mints took /api/health
  // from 2ms to 2.5 SECONDS, because bcryptjs is pure JS on the shared event loop.
  // One limiter fixes both, and it must run BEFORE bcrypt to fix the second.
  const lockedFor = lockoutMinutes(sudoKeys(req.user.id));
  if (lockedFor) {
    return res.status(429).json({
      error: `Too many incorrect password attempts. Try again in ${lockedFor} minutes.`,
    });
  }
  // The directory-load cap, checked separately and BEFORE the check runs, because for
  // a directory account the check itself is the expensive thing being bounded.
  const dirLockedFor = lockoutMinutes(
    DIRECTORY_KEYS(req.user.id), DIRECTORY_MAX_ATTEMPTS, DIRECTORY_WINDOW_MS);
  if (dirLockedFor) {
    return res.status(429).json({
      error: `Too many token requests. Try again in ${dirLockedFor} minutes.`,
    });
  }

  usersService.verifyPassword(req.user.id, body.password)
    .then((check) => {
      // Counted for ANY outcome that cost a round trip — success included. The two
      // exemptions that made the wrong-password counter unable to bound this (faults
      // are not counted, success clears it) are exactly why this is a separate budget.
      if (check.viaDirectory) trackFailures(DIRECTORY_KEYS(req.user.id));

      if (!check.ok) {
        // A directory FAULT is not a wrong password and must not be reported as one:
        // the user cannot fix an unreachable domain controller by retyping, and being
        // told "incorrect password" sends them to reset a password that was right.
        // 503, not 4xx — the request was well-formed and the fault is this end's.
        if (check.reason === 'directory_unreachable') {
          return res.status(503).json({
            error: 'Could not reach the directory to confirm your password. Try again in a moment.',
          });
        }
        if (check.reason === 'directory_not_authorized') {
          // Authenticated but no longer authorized: the account is outside
          // ldap.requiredGroup right now, whatever the session says. 403, and the same
          // message the login route gives, because it is the same refusal.
          console.log(`[Tokens] '${safeForLog(req.user.username, 64)}' is outside the required group; refusing to mint.`);
          return res.status(403).json({ error: 'Not a member of the required group' });
        }
        if (check.reason === 'directory_ambiguous' || check.reason === 'no_directory') {
          // Both are server misconfiguration the user can do nothing about, and both
          // are already loud in the log. Say so rather than blaming their typing.
          return res.status(503).json({
            error: 'Your account cannot be verified against the directory. Ask an administrator '
              + 'to check the LDAP configuration.',
          });
        }
        // directory_not_found falls through to the same 403 as a wrong password: it
        // means the account exists locally but the directory does not know it, and
        // distinguishing that would confirm which usernames the directory holds.
        // COUNTED, and logged. The review found neither: a failed attempt here left
        // no trace at all, so an attacker guessing against a stolen session produced
        // no detection signal anywhere. `not_local` is deliberately not counted — it
        // fails for every attempt on a directory account regardless of the password,
        // so counting it would lock those users out of a control they cannot use.
        trackFailures(sudoKeys(req.user.id));
        console.log(`[Tokens] Failed password confirmation for '${safeForLog(req.user.username, 64)}'.`);
        // One answer for a missing password and a wrong one. Distinguishing them
        // turns this into an oracle for whether the SESSION is still the right
        // account's, which is exactly what an attacker holding a stolen JWT probes.
        return res.status(403).json({ error: 'Incorrect password.' });
      }

      // Cleared on success, so a user who mistypes twice and then gets it right does
      // not carry a stale budget into their next legitimate mint.
      clearFailures(sudoKeys(req.user.id));

      // The scope FLOOR, applied here rather than trusted from the body: a token may
      // never carry a privilege the account itself does not hold. The service already
      // refuses to widen beyond `grantedScopes`; this is what that set is for a
      // browser session, which — unlike a token — has no scopes of its own to narrow.
      const granted = req.user.can_manage_users
        ? [authService.SCOPES.LIBRARY, authService.SCOPES.ADMIN]
        : [authService.SCOPES.LIBRARY];

      return authService.createToken({
        userId: req.user.id,
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt ?? null,
        grantedScopes: granted,
      }).then((result) => {
        console.log(`[Tokens] '${safeForLog(req.user.username, 64)}' minted a token `
          + `(scopes: ${result.scopes.join(',')})`);
        res.status(201).json(result);
      });
    })
    .catch((err) => problem.send(res, err, { log: '[Tokens] Create failed:' }));
});

// Revocation is the whole point of the design — and the reason the list above is
// worth rendering at all: a token you did not create is only actionable if you can
// see it and remove it. Owner-scoped inside the DELETE, so another account's id
// removes nothing.
app.delete('/api/user/me/tokens/:tokenId', authRequired, (req, res) => {
  const id = parseRouteId(req.params.tokenId);
  if (id === null) return res.status(404).json({ error: 'Token not found' });
  authService.revokeToken(id, req.user.id)
    .then(() => res.json({ success: true }))
    .catch((err) => problem.send(res, err, {
      log: '[Tokens] Revoke failed:', messages: { [SVC.NOT_FOUND]: 'Token not found' },
    }));
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
  // Exported for test/api-contract.test.js, which asserts that exhausting the
  // token-minting gate does NOT lock the same account out of logging in. The two
  // counters share a store and an implementation but not a key namespace, and
  // nothing else can observe that they stayed separate.
  isLockedOut,
};