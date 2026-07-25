const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const DBSOURCE = 'gametracker.db';
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
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const ldap = require('ldapjs');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Initialize SQLite DB
const db = new sqlite3.Database(DBSOURCE, (err) => {
  if (err) {
    console.error('[FATAL] Could not connect to database:', err.message);
    process.exit(1);
  }
});

// Schema creation + migrations.
//
// Everything here MUST run inside db.serialize(). node-sqlite3 defaults to
// PARALLEL mode, where queued statements may execute out of order — so the
// ALTER TABLE migrations were racing the CREATE TABLE statements above them and
// losing, failing with "no such table" on a FRESH database. Their error callbacks
// were empty (`() => {}`), so every failure was swallowed silently and a brand-new
// install came up missing user_games.backlog_order, users.telegram_chat_id,
// users.ntfy_url and users.gotify_url — breaking add-game, backlog ordering and
// the whole per-user notification feature. Long-lived databases were unaffected
// because they were migrated incrementally as each column was introduced, which is
// why this stayed hidden. The CI smoke test only asserts /api/health, so it passed.
function initializeSchema(done) {
  // SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so re-running a
  // migration against an already-migrated database is EXPECTED to fail with
  // exactly "duplicate column name". Anything else is a real fault and is logged
  // rather than discarded.
  const migrate = (sql) => db.run(sql, (err) => {
    if (err && !/duplicate column name/i.test(err.message)) {
      console.error(`[DB] Migration failed: ${sql.trim()} -> ${err.message}`);
    }
  });
  const create = (label, sql) => db.run(sql, (err) => {
    if (err) console.error(`[DB] Could not create ${label}:`, err.message);
  });

  db.serialize(() => {
    create('users', `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      can_manage_users INTEGER DEFAULT 0,
      email TEXT,
      ntfy_topic TEXT,
      gotify_token TEXT,
      created_at TEXT,
      origin TEXT DEFAULT 'local',
      display_name TEXT,
      shares_library INTEGER DEFAULT 0,
      notification_days TEXT DEFAULT '[0,7,30]'
    )`);
    create('user_games', `CREATE TABLE IF NOT EXISTS user_games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      game_id INTEGER,
      game_name TEXT,
      cover_url TEXT,
      release_date TEXT,
      status TEXT,
      steam_app_id TEXT,
      last_price TEXT,
      last_price_updated TEXT,
      crack_status TEXT,
      UNIQUE(user_id, game_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
    create('user_shares', `CREATE TABLE IF NOT EXISTS user_shares (
      from_user TEXT,
      to_user TEXT,
      shared_at TEXT,
      PRIMARY KEY (from_user, to_user),
      FOREIGN KEY (from_user) REFERENCES users(username),
      FOREIGN KEY (to_user) REFERENCES users(username)
    )`);

    // Add columns if missing (for migrations)
    migrate(`ALTER TABLE users ADD COLUMN origin TEXT DEFAULT 'local'`);
    migrate(`ALTER TABLE users ADD COLUMN display_name TEXT`);
    migrate(`ALTER TABLE user_games ADD COLUMN steam_app_id TEXT`);
    migrate(`ALTER TABLE user_games ADD COLUMN last_price TEXT`);
    migrate(`ALTER TABLE user_games ADD COLUMN last_price_updated TEXT`);
    migrate(`ALTER TABLE user_games ADD COLUMN crack_status TEXT`);
    migrate(`ALTER TABLE user_games ADD COLUMN backlog_order INTEGER`);
    migrate(`ALTER TABLE users ADD COLUMN gotify_token TEXT`);
    migrate(`ALTER TABLE users ADD COLUMN notification_days TEXT`);
    migrate(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT`);
    // Per-user notification server URLs — each user points at their own ntfy/Gotify
    // server (falls back to the optional admin-set global default if left empty).
    migrate(`ALTER TABLE users ADD COLUMN ntfy_url TEXT`);
    migrate(`ALTER TABLE users ADD COLUMN gotify_url TEXT`);

    // Runs last in the serialized queue: every statement above has completed.
    db.run('SELECT 1', () => {
      console.log('Database initialized');
      if (done) done();
    });
  });
}

// Ensure root user exists
const ensureRootUser = async () => {
  db.get('SELECT * FROM users WHERE username = ?', ['root'], async (err, user) => {
    if (err) {
      console.error('[FATAL] Could not check for the root user:', err.message);
      return;
    }
    if (!user) {
      // Use an operator-supplied ROOT_PASSWORD, or generate a strong random one and
      // print it ONCE at first boot — never ship a well-known default password.
      let rootPassword = process.env.ROOT_PASSWORD;
      let generated = false;
      if (!rootPassword) {
        rootPassword = crypto.randomBytes(12).toString('base64url');
        generated = true;
      }
      const hash = await bcrypt.hash(rootPassword, 10);
      db.run(
        'INSERT INTO users (username, password, can_manage_users, origin, display_name) VALUES (?, ?, 1, ?, ?)',
        ['root', hash, 'local', 'root']
      );
      if (generated) {
        console.log('====================================================================');
        console.log('Root user created with a GENERATED password (shown only once):');
        console.log('    ' + rootPassword);
        console.log('Log in as root and change it immediately, or set ROOT_PASSWORD.');
        console.log('====================================================================');
      } else {
        console.log('Root user created with the operator-supplied ROOT_PASSWORD.');
      }
    }
  });
};

// Schema first, THEN the root user — ensureRootUser queries `users`, so running it
// before the tables exist raced the schema and failed with "no such table".
initializeSchema(() => ensureRootUser());

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
    console.log('Creating user:', { username: normalizedUsername, display_name: displayNameToUse, origin: opts.origin });
    db.run('INSERT INTO users (username, created_at, origin, display_name) VALUES (?, ?, ?, ?)', [normalizedUsername, new Date().toISOString(), opts.origin || 'local', displayNameToUse], function (err) {
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
const STATUS_CACHE_FILE = path.join(__dirname, 'system-status-cache.json');
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
  // Escape double-quotes so a crafted query can't break out of the IGDB
  // APIcalypse `search "..."` string literal (query injection into the IGDB call).
  const safeQuery = String(query).replace(/["\\]/g, '\\$&');
  try {
    // IGDB request
    const hasIgdbCredentials = resolveApiKey('IGDB_CLIENT_ID') && resolveApiKey('IGDB_BEARER_TOKEN');
    if (!hasIgdbCredentials) {
      console.warn('[IGDB] Missing credentials - IGDB_CLIENT_ID or IGDB_BEARER_TOKEN not set');
    }
    
    // Verify credentials are loaded before making the API call
    const clientId = resolveApiKey('IGDB_CLIENT_ID');
    const bearerToken = resolveApiKey('IGDB_BEARER_TOKEN');
    
    if (!clientId || !bearerToken) {
      console.error('[IGDB] Credentials check failed:', {
        clientId: clientId ? 'SET' : 'MISSING',
        bearerToken: bearerToken ? 'SET' : 'MISSING'
      });
    }
    
    const igdbPromise = axios.post(
      'https://api.igdb.com/v4/games',
      `search "${safeQuery}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit 20;`,
      {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${bearerToken}`,
          'Accept': 'application/json',
        },
      }
    ).then(async response => {
      const games = response.data || [];
      console.log(`[IGDB] Query: "${query}", Found ${games.length} games`);
      // For each game, fetch external_games for Steam (category 1)
      return games.map(game => {
        let steamAppId = null;
        if (Array.isArray(game.external_games)) {
          const steamExternal = game.external_games.find(ext => ext.category === 1 && ext.uid);
          if (steamExternal) {
            steamAppId = steamExternal.uid;
          }
        }
        return {
          id: 'igdb_' + game.id,
          name: game.name,
          releaseDate: game.first_release_date
            ? new Date(game.first_release_date * 1000).toISOString().split('T')[0]
            : null,
          coverUrl: game.cover?.image_id
            ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
            : null,
          source: 'igdb',
          steamAppId,
        };
      });
    }).catch((err) => {
      console.error('[IGDB Search Error]', {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        hasCredentials: hasIgdbCredentials,
        clientId: resolveApiKey('IGDB_CLIENT_ID') ? 'SET' : 'MISSING',
        bearerToken: resolveApiKey('IGDB_BEARER_TOKEN') ? 'SET' : 'MISSING'
      });
      return [];
    });

    // RAWG request
    const rawgPromise = axios.get(
      'https://api.rawg.io/api/games',
      {
        params: {
          key: resolveApiKey('RAWG_API_KEY'),
          search: query,
          page_size: 20,
        }
      }
    ).then(async response => {
      const games = response.data.results || [];
      // For each game, fetch detailed info to get Steam App ID
      const detailedGames = await Promise.all(games.map(async (game) => {
        let steamAppId = null;
        try {
          const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
            params: { key: resolveApiKey('RAWG_API_KEY') }
          });
          const stores = detailRes.data.stores || [];
          const steamStore = stores.find(s => s.store && s.store.id === 1 && s.url_en);
          if (steamStore && steamStore.url_en) {
            // Extract App ID from the Steam URL
            const match = steamStore.url_en.match(/\/app\/(\d+)/);
            if (match) {
              steamAppId = match[1];
            }
          }
        } catch (e) {
          // Ignore errors, just no steamAppId
        }
        return {
          id: 'rawg_' + game.id,
          name: game.name,
          releaseDate: game.released,
          coverUrl: game.background_image,
          source: 'rawg',
          steamAppId,
        };
      }));
      return detailedGames;
    }).catch((err) => {
      console.error('[RAWG Search Error]', err.response?.data || err.message);
      return [];
    });

    // TheGamesDB request (optional - only if API key is configured)
    const thegamesdbPromise = resolveApiKey('THEGAMESDB_API_KEY')
      ? axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
          params: {
            apikey: resolveApiKey('THEGAMESDB_API_KEY'),
            name: query,
          }
        }).then(async response => {
          const data = response.data;
          if (!data || !data.data || !data.data.games) {
            return [];
          }
          const games = Array.isArray(data.data.games) ? data.data.games : [data.data.games];
          const baseUrl = data.include?.base_url?.image_base || data.data?.base_url?.image_base || 'https://cdn.thegamesdb.net/images/';
          
          return games.slice(0, 20).map(game => {
            // Find cover/boxart image
            let coverUrl = null;
            if (data.include && data.include.boxart) {
              const gameBoxart = data.include.boxart[game.id];
              if (gameBoxart && Array.isArray(gameBoxart)) {
                const frontCover = gameBoxart.find(img => img.side === 'front');
                if (frontCover) {
                  coverUrl = `${baseUrl}${frontCover.filename}`;
                } else if (gameBoxart[0]) {
                  coverUrl = `${baseUrl}${gameBoxart[0].filename}`;
                }
              } else if (gameBoxart && gameBoxart.filename) {
                coverUrl = `${baseUrl}${gameBoxart.filename}`;
              }
            }
            
            // Parse release date
            let releaseDate = null;
            if (game.release_date) {
              // TheGamesDB date format can vary, try to parse it
              const date = new Date(game.release_date);
              if (!isNaN(date.getTime())) {
                releaseDate = date.toISOString().split('T')[0];
              }
            }
            
            return {
              id: 'thegamesdb_' + game.id,
              name: game.game_title || game.game_name || '',
              releaseDate: releaseDate,
              coverUrl: coverUrl,
              source: 'thegamesdb',
              steamAppId: null, // TheGamesDB doesn't provide Steam App IDs
            };
          }).filter(game => game.name); // Filter out games without names
        }).catch((err) => {
          console.error('[TheGamesDB Search Error]', err.response?.data || err.message);
          return [];
        })
      : Promise.resolve([]);

    // Wait for all three
    const [igdbResults, rawgResults, thegamesdbResults] = await Promise.all([igdbPromise, rawgPromise, thegamesdbPromise]);

    // Merge and deduplicate by name (case-insensitive)
    const merged = [...igdbResults, ...rawgResults, ...thegamesdbResults].map(game => {
      // If game didn't provide a steamAppId, try to find one from IGDB or RAWG for the same game name
      if (!game.steamAppId) {
        const igdbMatch = igdbResults.find(igdbGame => igdbGame.name.toLowerCase() === game.name.toLowerCase() && igdbGame.steamAppId);
        if (igdbMatch) {
          return { ...game, steamAppId: igdbMatch.steamAppId };
        }
        const rawgMatch = rawgResults.find(rawgGame => rawgGame.name.toLowerCase() === game.name.toLowerCase() && rawgGame.steamAppId);
        if (rawgMatch) {
          return { ...game, steamAppId: rawgMatch.steamAppId };
        }
      }
      // If game didn't provide a coverUrl, try to find one from other sources
      if (!game.coverUrl) {
        const coverMatch = [...igdbResults, ...rawgResults, ...thegamesdbResults].find(otherGame => 
          otherGame.name.toLowerCase() === game.name.toLowerCase() && otherGame.coverUrl
        );
        if (coverMatch) {
          return { ...game, coverUrl: coverMatch.coverUrl };
        }
      }
      // Do NOT fill releaseDate from another result by name only — different games
      // can share the same name (e.g. "Judas" 2017 vs unreleased "Judas"), so we
      // only use each result's own releaseDate to avoid wrong dates.
      return game;
    });
    // Dedupe by name: prefer entry with no release date (unreleased) when multiple same-name results
    const byName = {};
    merged.forEach(g => {
      const k = g.name.toLowerCase();
      if (!byName[k]) byName[k] = [];
      byName[k].push(g);
    });
    const mergedDeduped = Object.values(byName).map(games =>
      games.find(g => !g.releaseDate) || games[0]
    );

    console.log(`[Search] Query: "${query}", Results: ${mergedDeduped.length} games (IGDB: ${igdbResults.length}, RAWG: ${rawgResults.length}, TheGamesDB: ${thegamesdbResults.length})`);
    res.json(mergedDeduped);
  } catch (error) {
    console.error('[Search Error]', error);
    res.status(500).json({ error: 'Failed to fetch games from providers', details: error.message });
  }
});

// Test endpoint for IGDB connectivity
app.get('/api/test/igdb', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  const testQuery = req.query.q || 'Mario';
  // Escape quotes/backslashes so the query can't break out of the IGDB search literal.
  const safeTestQuery = String(testQuery).replace(/["\\]/g, '\\$&');
  const hasClientId = !!resolveApiKey('IGDB_CLIENT_ID');
  const hasBearerToken = !!resolveApiKey('IGDB_BEARER_TOKEN');
  
  const testInfo = {
    credentials: {
      clientId: hasClientId ? 'SET' : 'MISSING',
      bearerToken: hasBearerToken ? 'SET' : 'MISSING',
      bothPresent: hasClientId && hasBearerToken
    },
    testQuery: testQuery
  };
  
  if (!hasClientId || !hasBearerToken) {
    return res.status(400).json({
      error: 'IGDB credentials missing',
      ...testInfo
    });
  }
  
  try {
    const response = await axios.post(
      'https://api.igdb.com/v4/games',
      `search "${safeTestQuery}"; fields id,name,first_release_date,cover.image_id; limit 5;`,
      {
        headers: {
          'Client-ID': resolveApiKey('IGDB_CLIENT_ID'),
          'Authorization': `Bearer ${resolveApiKey('IGDB_BEARER_TOKEN')}`,
          'Accept': 'application/json',
        },
      }
    );
    
    const games = response.data || [];
    res.json({
      success: true,
      ...testInfo,
      results: {
        count: games.length,
        games: games.map(g => ({
          id: g.id,
          name: g.name,
          releaseDate: g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().split('T')[0] : null,
          hasCover: !!g.cover?.image_id
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      ...testInfo,
      error: {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      }
    });
  }
});

// --- CrackWatch cache (Option B: cached crack status) ---
const CRACKWATCH_CACHE_FILE = path.join(__dirname, 'crackwatch-cache.json');
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

function loadCrackWatchCacheFromFile() {
  try {
    if (fs.existsSync(CRACKWATCH_CACHE_FILE)) {
      const raw = fs.readFileSync(CRACKWATCH_CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Copy onto a null-prototype object rather than adopting the parsed literal,
      // keeping the posture the initializer declares.
      if (data && typeof data === 'object') {
        crackWatchCache = Object.assign(Object.create(null), data);
      }
      console.log('[CrackWatch] Loaded cache from file,', Object.keys(crackWatchCache).length, 'titles');
    }
  } catch (err) {
    console.warn('[CrackWatch] Could not load cache file:', err.message);
  }
}

function saveCrackWatchCacheToFile() {
  try {
    fs.writeFileSync(CRACKWATCH_CACHE_FILE, JSON.stringify(crackWatchCache, null, 0), 'utf8');
    console.log('[CrackWatch] Saved cache to file,', Object.keys(crackWatchCache).length, 'titles');
  } catch (err) {
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
      console.warn('[CrackWatch] Refresh error at page', page, err.message || err, err.response?.status);
      break;
    }
  }
  console.log('[CrackWatch] Cache refresh done. Total entries:', total, 'Cache size:', Object.keys(crackWatchCache).length);
  saveCrackWatchCacheToFile();
}

loadCrackWatchCacheFromFile();

// Cron: refresh CrackWatch cache daily at 4:00 AM
cron.schedule('0 4 * * *', () => {
  console.log('[CRON] Refreshing CrackWatch cache...');
  refreshCrackWatchCache().catch((err) => console.error('[CRON] CrackWatch refresh failed:', err));
});

// Optional: run first refresh 30s after startup if cache is empty
setTimeout(() => {
  if (Object.keys(crackWatchCache).length === 0) {
    console.log('[CrackWatch] Cache empty, running initial refresh in background...');
    refreshCrackWatchCache().catch((err) => console.error('[CrackWatch] Initial refresh failed:', err));
  }
}, 30000);

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
// Absolute path. This was a bare relative 'settings.json', resolved against
// process.cwd() — so a utility script run from another directory silently read,
// or worse created, a DIFFERENT settings file. Matches STATUS_CACHE_FILE below.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const EMPTY_SETTINGS = { smtp: {}, ntfy: {}, gotify: {}, telegram: {}, ldap: {}, apikeys: {} };

// loadSettings() sits on the hot path — resolveApiKey() calls it ~10x per search,
// and every login, notification and settings read goes through it. Doing a
// synchronous readFileSync each time blocks the single-threaded event loop against
// a single-file Docker bind mount: if that host path ever stalls, the whole server
// stalls. Cache the parsed object and validate it with a much cheaper statSync.
//
// mtime validation (rather than only invalidating inside saveSettings) keeps
// EXTERNAL writers working — the utility scripts and any `docker exec` edit — so an
// admin's change still takes effect immediately, as CLAUDE.md advertises.
let settingsCache = null;
let settingsMtimeMs = -1;

function loadSettings() {
  try {
    const { mtimeMs } = fs.statSync(SETTINGS_FILE);
    if (settingsCache && mtimeMs === settingsMtimeMs) return settingsCache;
    settingsCache = { ...EMPTY_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    settingsMtimeMs = mtimeMs;
    return settingsCache;
  } catch (err) {
    // A missing file is normal on a fresh install. A corrupt one is NOT — it used
    // to degrade silently to "no SMTP, no LDAP, no API keys" with no log line at
    // all, which is a miserable thing to debug from the admin's side.
    if (err.code !== 'ENOENT') {
      console.error('[settings] Failed to read/parse settings.json:', err.message);
    }
    settingsCache = null;
    settingsMtimeMs = -1;
    return EMPTY_SETTINGS;
  }
}

function saveSettings(settings) {
  try {
    // mode 0600: this file holds the SMTP password, the LDAP bind password and the
    // Telegram bot token. The default 0644 made it world-readable in the container.
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { flag: 'w', mode: 0o600 });
    settingsCache = { ...EMPTY_SETTINGS, ...settings };
    try { settingsMtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs; } catch { settingsMtimeMs = -1; }
    console.log('settings.json created/updated.');
  } catch (err) {
    console.error('Failed to write settings.json:', err);
    // Never keep serving a cache we cannot vouch for.
    settingsCache = null;
    settingsMtimeMs = -1;
  }
}

// Resolve an API key: settings.json overrides env vars so admins can update keys via UI
function resolveApiKey(envName) {
  const fromSettings = loadSettings()?.apikeys?.[envName.toLowerCase()];
  return (fromSettings && fromSettings.trim()) ? fromSettings.trim() : (process.env[envName] || '');
}

// API Keys — admin-only read/write
app.get('/api/settings/apikeys', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const k = loadSettings().apikeys || {};
  const mask = v => v && v.trim() ? '••••••••' + v.trim().slice(-6) : '';
  const row  = (storedVal, envVar) => ({
    masked: mask(storedVal || process.env[envVar]),
    set:    !!(storedVal  || process.env[envVar]),
    source: storedVal ? 'settings' : (process.env[envVar] ? 'env' : 'none'),
  });
  res.json({
    igdb_client_id:      row(k.igdb_client_id,      'IGDB_CLIENT_ID'),
    igdb_client_secret:  row(k.igdb_client_secret,   'IGDB_CLIENT_SECRET'),
    igdb_bearer_token:   row(k.igdb_bearer_token,    'IGDB_BEARER_TOKEN'),
    rawg_api_key:        row(k.rawg_api_key,          'RAWG_API_KEY'),
    thegamesdb_api_key:  row(k.thegamesdb_api_key,   'THEGAMESDB_API_KEY'),
  });
});

app.post('/api/settings/apikeys', authRequired, requirePermission('can_manage_users'), express.json(), (req, res) => {
  try {
    const allowed = ['igdb_client_id', 'igdb_client_secret', 'igdb_bearer_token', 'rawg_api_key', 'thegamesdb_api_key'];
    const incoming = req.body || {};
    const clean = {};
    for (const k of allowed) {
      if (k in incoming) clean[k] = String(incoming[k] || '').trim();
    }
    const existing = loadSettings();
    saveSettings({ ...existing, apikeys: { ...(existing.apikeys || {}), ...clean } });
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving apikeys:', err);
    res.status(500).json({ error: 'Failed to save API keys.' });
  }
});

// Refresh IGDB bearer token using stored Client ID + Client Secret (calls Twitch OAuth)
app.post('/api/settings/apikeys/refresh-igdb-token', authRequired, requirePermission('can_manage_users'), express.json(), async (req, res) => {
  const clientId     = resolveApiKey('IGDB_CLIENT_ID');
  const clientSecret = resolveApiKey('IGDB_CLIENT_SECRET');
  if (!clientId)     return res.status(400).json({ error: 'IGDB Client ID is not set. Add it in API Keys first.' });
  if (!clientSecret) return res.status(400).json({ error: 'IGDB Client Secret is not set. Add it in API Keys first.' });
  try {
    const resp = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      null,
      { params: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }, timeout: 10000 }
    );
    const { access_token, expires_in } = resp.data;
    if (!access_token) return res.status(502).json({ error: 'Twitch returned no access_token in response' });
    // Auto-save the new bearer token
    const existing = loadSettings();
    saveSettings({ ...existing, apikeys: { ...(existing.apikeys || {}), igdb_bearer_token: access_token } });
    console.log('[IGDB] Bearer token refreshed via Twitch OAuth, expires_in:', expires_in);
    res.json({ success: true, expires_in, masked: '••••••••' + access_token.slice(-6) });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error_description || err.message || 'Unknown error';
    console.error('[IGDB] Token refresh failed:', msg);
    res.status(502).json({ error: 'Twitch token request failed: ' + msg });
  }
});

// --- Notification helpers ---

// A single valid address, with no comma or semicolon.
//
// Nodemailer treats a comma-separated `to` as a recipient LIST, so any value that
// smuggles a comma into users.email fans notifications out to arbitrary third
// parties from this deployment's SPF/DKIM-aligned domain. There are four writers
// (PUT /api/user/me/settings, POST /api/users, PUT /api/users/:id, and the LDAP
// sync + backfill), so this is enforced at the WRITE sites *and* again at the send
// sink in sendEmail — validating in only one place is how the hole stayed open.
function isValidEmailAddress(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '') return false;
  return /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]+$/.test(v);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Cover art comes from IGDB/RAWG/TheGamesDB, but the client supplies the value, so
// treat it as untrusted: https only, no credentials, and a known image host.
const ALLOWED_IMAGE_HOSTS = [
  'images.igdb.com', 'media.rawg.io', 'cdn.thegamesdb.net',
  'cdn.cloudflare.steamstatic.com', 'shared.akamai.steamstatic.com',
];
function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ALLOWED_IMAGE_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Per-user notification servers are deliberately allowed to be private/LAN
// addresses — users self-host ntfy and Gotify on their own networks, and blocking
// RFC1918 would break the documented feature. What is NOT acceptable is reaching a
// cloud instance-metadata endpoint, which is the one target that turns a blind
// SSRF into credential theft. Block those specifically.
const METADATA_HOSTS = ['169.254.169.254', 'metadata.google.internal', 'fd00:ec2::254', '100.100.100.200'];
// Raw axios errors distinguish ECONNREFUSED / 404 / timeout, which turns the
// Diagnostics "send test notification" button into an open/closed/filtered port
// scanner for the server's internal network. Collapse every network-level outcome
// into one indistinguishable message; the detail still goes to the server log where
// the operator (and only the operator) can see it.
function sanitizeDeliveryError(err, channel) {
  console.error(`[Notify] ${channel} delivery failed:`, err?.message || err);
  if (err?.message === 'Notification server host is not permitted') return err.message;
  return 'Delivery failed. Check the server URL and credentials in My Account, then try again.';
}

function isBlockedNotificationHost(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase()
      .replace(/^\[|\]$/g, '')   // strip IPv6 brackets
      .replace(/\.$/, '');       // "metadata.google.internal." resolves the same
    // Unwrap IPv4-mapped IPv6. Note that `new URL()` does NOT keep the readable
    // dotted form: it normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, so the
    // two 16-bit hex groups have to be decoded back to octets before the checks
    // below can see it. (Verified against Node's WHATWG URL parser.)
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    } else {
      const mappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (mappedDotted) host = mappedDotted[1];
    }
    if (METADATA_HOSTS.includes(host)) return true;
    // IPv4 link-local (169.254.0.0/16) covers the AWS/Azure/GCP metadata range.
    // new URL() already normalizes decimal/octal/hex IPv4 forms to dotted quads.
    if (/^169\.254\./.test(host)) return true;
    // IPv6 link-local
    if (/^fe80:/i.test(host)) return true;
    return false;
  } catch {
    return true; // unparseable -> refuse
  }
}

// --- Notification Functions ---
async function sendEmail(subject, text, toOverride, coverUrl) {
  const { smtp } = loadSettings();
  if (!smtp.host || !smtp.port || !smtp.from) {
    console.log('[Email] SMTP settings incomplete:', { host: smtp.host, port: smtp.port, from: smtp.from });
    return;
  }

  // Log the email destination decision process
  console.log('[Email] Determining recipient:', {
    userProvidedEmail: toOverride,
    settingsDefaultEmail: smtp.to,
    fallbackEmail: process.env.DEFAULT_EMAIL
  });

  const finalRecipient = toOverride;
  if (!finalRecipient) {
    console.log('[Email] No recipient email found, skipping email send');
    return;
  }
  // Last line of defence, at the sink. Even if a bad address reaches users.email
  // through a path that skipped validation, nodemailer never sees a recipient list.
  if (!isValidEmailAddress(finalRecipient)) {
    console.error('[Email] Refusing to send: recipient is not a single valid address.');
    return;
  }

  console.log('[Email] Will send email to:', finalRecipient);

  const options = {
    host: smtp.host,
    port: Number(smtp.port),
    secure: Number(smtp.port) === 465,
  };
  if (smtp.user && smtp.pass) {
    options.auth = { user: smtp.user, pass: smtp.pass };
  }

  console.log('[Email] SMTP Configuration:', {
    host: options.host,
    port: options.port,
    secure: options.secure,
    hasAuth: !!options.auth
  });

  const transporter = nodemailer.createTransport(options);
  // Both `text` and `coverUrl` derive from user-supplied game data (gameName /
  // coverUrl on POST /api/user/:username/games, and the test-notification body), so
  // interpolating them raw let an authenticated user author arbitrary HTML in a mail
  // sent from the deployment's own SPF/DKIM-aligned domain — a ready-made phishing
  // primitive. Escape the text, and only accept an https image URL.
  const safeText = escapeHtml(text);
  const safeCover = isSafeImageUrl(coverUrl) ? coverUrl : null;
  const html = safeCover
    ? `<div style="font-family:sans-serif;max-width:480px">` +
      `<img src="${escapeHtml(safeCover)}" alt="Game cover" style="max-width:200px;border-radius:6px;display:block;margin-bottom:12px">` +
      `<p style="margin:0;font-size:15px">${safeText}</p></div>`
    : `<div style="font-family:sans-serif;max-width:480px">` +
      `<p style="margin:0;font-size:15px">${safeText}</p></div>`;
  try {
    const result = await transporter.sendMail({
      from: smtp.from,
      to: finalRecipient,
      subject,
      text,
      ...(html && { html }),
    });
    console.log('[Email] Successfully sent email:', {
      messageId: result.messageId,
      recipient: finalRecipient,
      subject: subject
    });
  } catch (err) {
    console.error('[Email] Failed to send email:', {
      error: err.message,
      recipient: finalRecipient,
      subject: subject
    });
    throw err;  // Re-throw to let caller handle the error
  }
}

async function sendNtfy(title, message, topic, attachUrl, serverUrl) {
  // Prefer the user's own ntfy server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().ntfy?.url;
  if (!url || !topic) return;
  if (isBlockedNotificationHost(url)) {
    throw new Error('Notification server host is not permitted');
  }
  const headers = { Title: title };
  if (isSafeImageUrl(attachUrl)) headers.Attach = attachUrl;
  // encodeURIComponent: `topic` is unvalidated user input, so interpolating it raw
  // let the caller append their own path, query string and fragment to the request
  // — turning "pick your own server" into "craft an arbitrary request from the
  // server's network position".
  await axios.post(`${url.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, message, {
    headers,
    timeout: 10000,
    maxRedirects: 0,
  });
}

async function sendGotify(title, message, token, priority = 5, imageUrl, serverUrl) {
  // Prefer the user's own Gotify server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().gotify?.url;
  if (!url || !token) return;
  if (isBlockedNotificationHost(url)) {
    throw new Error('Notification server host is not permitted');
  }
  const body = { title, message, priority };
  if (isSafeImageUrl(imageUrl)) {
    body.extras = { 'client::notification': { bigImageUrl: imageUrl } };
  }
  // Token goes in the header, not the query string: query strings land in reverse
  // proxy and Gotify access logs. Header also removes the path-injection sink.
  await axios.post(`${url.replace(/\/$/, '')}/message`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': token },
    timeout: 10000,
    maxRedirects: 0,
  });
}

async function sendTelegram(title, message, chatId, photoUrl) {
  const { telegram } = loadSettings();
  const botToken = telegram?.bot_token;
  if (!botToken || !chatId) return;
  const text = `*${title}*\n${message}`;
  // Parity with sendNtfy/sendGotify: a hung api.telegram.org must not hold the
  // request open indefinitely.
  const opts = { timeout: 10000, maxRedirects: 0 };
  if (photoUrl) {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption: text,
      parse_mode: 'Markdown',
    }, opts);
  } else {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }, opts);
  }
}

// --- LDAP filter escaping (RFC 4515) ---
// A username goes straight into an LDAP search filter, so any of the filter
// metacharacters must be escaped or the caller can rewrite the filter. Without
// this, `username=*` matches every entry in the directory and the search picks an
// arbitrary one; `)(uid=admin` splices in a whole extra assertion.
// Backslash MUST be replaced first, or we would double-escape our own output.
function escapeLdapFilterValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

// Build the "find this user" filter used by both the login and the email lookup.
// Active Directory keys on sAMAccountName, FreeIPA on uid — match either.
function buildUserSearchFilter(username) {
  const safe = escapeLdapFilterValue(username);
  return `(|(sAMAccountName=${safe})(uid=${safe}))`;
}

// Create an ldapjs client that cannot take the process down.
//
// ldapjs Client is an EventEmitter that emits 'error' on socket-level failures
// (ECONNREFUSED, ETIMEDOUT, TCP reset, TLS failure). With no 'error' listener,
// Node treats that as an uncaught exception and EXITS — so an unreachable domain
// controller turned any anonymous POST /api/auth/login into a remote process kill,
// and one /api/admin/ldap-sync against a down directory was a guaranteed crash.
// The bind callback fires *first*, so the request itself often looked fine right
// before the server died. Every crash also wiped the in-memory login rate-limit
// counters, handing an attacker a lockout reset.
//
// `onError` lets a caller fail over (e.g. to local auth) exactly once.
function createLdapClient(url, onError) {
  const client = ldap.createClient({
    url,
    timeout: 10000,
    connectTimeout: 10000,
    reconnect: false,
  });
  let handled = false;
  client.on('error', (err) => {
    console.error('[LDAP] Client error:', err.message);
    try { client.destroy(); } catch { /* already gone */ }
    if (!handled) {
      handled = true;
      if (typeof onError === 'function') onError(err);
    }
  });
  // Mark the failover as spent once the caller has moved on, so a late socket
  // error cannot fire a second response on the same request.
  client.markHandled = () => { handled = true; };
  return client;
}

// Warn loudly about cleartext LDAP. A simple bind sends the user's password (and
// the service-account password) unencrypted in the BER payload, so plain `ldap://`
// exposes directory credentials to any passive observer on the path. We warn
// rather than refuse, because refusing would lock out an existing deployment
// mid-upgrade — but this should be `ldaps://` (or StartTLS) in any real network.
let warnedAboutCleartextLdap = false;
function warnIfCleartextLdap(url) {
  if (warnedAboutCleartextLdap || !url) return;
  if (/^ldap:\/\//i.test(String(url).trim())) {
    warnedAboutCleartextLdap = true;
    console.warn('[LDAP] WARNING: connecting over cleartext ldap://. Bind passwords ' +
      '(including the service account and every user password) traverse the network ' +
      'unencrypted. Switch the LDAP URL to ldaps:// — see SECURITY_HARDENING_2026-07.md.');
  }
}

// --- LDAP Email Lookup ---
async function getLdapEmail(username) {
  return new Promise((resolve) => {
    // Normalize username to lowercase to prevent case sensitivity issues
    const normalizedUsername = username ? username.toLowerCase() : '';
    const settings = loadSettings();
    const ldapSettings = settings.ldap || {};
    
    if (!ldapSettings.url || !ldapSettings.bindDn || !ldapSettings.bindPass) {
      resolve(null);
      return;
    }

    warnIfCleartextLdap(ldapSettings.url);
    // A socket error here resolves null (no email found) instead of crashing.
    const client = createLdapClient(ldapSettings.url, () => resolve(null));
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed for email lookup:', err.message);
        client.markHandled();
        client.unbind();
        resolve(null);
        return;
      }
      
      // Try multiple username attributes: first sAMAccountName (AD), then uid (FreeIPA).
      // Using an OR filter means if either matches, we get a result. The username is
      // RFC 4515-escaped so it cannot alter the filter's structure.
      const searchOptions = {
        filter: buildUserSearchFilter(normalizedUsername),
        scope: 'sub',
        attributes: ['mail', 'email']
      };
      
      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search failed for email lookup:', err);
          client.markHandled();
          client.unbind();
          resolve(null);
          return;
        }
        
        let foundEmail = null;
        searchRes.on('searchEntry', (entry) => {
          const attributes = {};
          entry.attributes.forEach(attr => {
            attributes[attr.type] = attr.vals.length === 1 ? attr.vals[0] : attr.vals;
          });
          foundEmail = attributes.mail || attributes.email || null;
        });
        
        searchRes.on('end', () => {
          client.markHandled();
          client.unbind();
          resolve(foundEmail);
        });
        
        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during email lookup:', err);
          client.markHandled();
          client.unbind();
          resolve(null);
        });
      });
    });
  });
}

// --- Notification Triggers ---
async function notifyEvent(type, game, username, status) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const coverUrl = game.coverUrl || null;
  let subject, text, title, message;
  if (type === 'add') {
    subject = `Game added: ${game.gameName}`;
    text = `User ${normalizedUsername} added "${game.gameName}" to their library.`;
    title = 'Game Added';
    message = `User ${normalizedUsername} added "${game.gameName}" to their library.`;
  } else if (type === 'status') {
    subject = `Game status changed: ${game.gameName}`;
    text = `User ${normalizedUsername} changed status of "${game.gameName}" to ${status}.`;
    title = 'Game Status Changed';
    message = `User ${normalizedUsername} changed status of "${game.gameName}" to ${status}.`;
  } else if (type === 'release') {
    subject = `Game released: ${game.gameName}`;
    text = `"${game.gameName}" has been released!`;
    title = 'Game Released';
    message = `"${game.gameName}" has been released!`;
  }
  
  // Get user details from database
  const userDetails = await new Promise((resolve, reject) => {
    db.get('SELECT email, ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id FROM users WHERE username = ?', [normalizedUsername], (err, userRow) => {
      if (err) {
        reject(err);
      } else {
        resolve(userRow);
      }
    });
  });

  let userEmail = userDetails && userDetails.email;
  const userNtfy = userDetails && userDetails.ntfy_topic;
  const userNtfyUrl = userDetails && userDetails.ntfy_url;
  const userGotifyToken = userDetails && userDetails.gotify_token;
  const userGotifyUrl = userDetails && userDetails.gotify_url;
  const userTelegramChatId = userDetails && userDetails.telegram_chat_id;

  // If no email in database, try LDAP
  if (!userEmail) {
    console.log('No email found in database for user:', normalizedUsername, 'trying LDAP...');
    try {
      userEmail = await getLdapEmail(normalizedUsername);
      if (userEmail) {
        console.log('Found email from LDAP:', userEmail);
        // Update the database with the LDAP email
        if (isValidEmailAddress(userEmail)) {
          db.run('UPDATE users SET email = ? WHERE username = ?', [userEmail, normalizedUsername]);
        } else {
          console.warn('[LDAP] Ignoring malformed mail attribute for', normalizedUsername);
          userEmail = null;
        }
      }
    } catch (ldapErr) {
      console.error('Error getting email from LDAP:', ldapErr);
    }
  }

  // Try to send email
  if (userEmail) {
    try {
      console.log('Attempting to send email to:', userEmail);
      await sendEmail(subject, text, userEmail, coverUrl);
      console.log('Email sent successfully');
    } catch (emailErr) {
      console.error('Error sending email:', emailErr);
    }
  }

  if (userNtfy) {
    try {
      await sendNtfy(title, message, userNtfy, coverUrl, userNtfyUrl);
      console.log(`[Notify Event] Ntfy sent successfully to topic ${userNtfy} for user ${normalizedUsername}`);
    } catch (ntfyErr) {
      console.error(`[Notify Event] Error sending ntfy for user ${normalizedUsername}:`, ntfyErr);
    }
  } else {
    console.log(`[Notify Event] No personal ntfy topic set for user ${normalizedUsername}, skipping ntfy`);
  }

  if (userGotifyToken) {
    try {
      await sendGotify(title, message, userGotifyToken, 5, coverUrl, userGotifyUrl);
      console.log(`[Notify Event] Gotify sent successfully for user ${normalizedUsername}`);
    } catch (gotifyErr) {
      console.error(`[Notify Event] Error sending Gotify for user ${normalizedUsername}:`, gotifyErr);
    }
  } else {
    console.log(`[Notify Event] No personal Gotify token set for user ${normalizedUsername}, skipping Gotify`);
  }

  if (userTelegramChatId) {
    try {
      await sendTelegram(title, message, userTelegramChatId, coverUrl);
      console.log(`[Notify Event] Telegram sent successfully for user ${normalizedUsername}`);
    } catch (telegramErr) {
      console.error(`[Notify Event] Error sending Telegram for user ${normalizedUsername}:`, telegramErr);
    }
  } else {
    console.log(`[Notify Event] No personal Telegram chat ID set for user ${normalizedUsername}, skipping Telegram`);
  }
}

// --- Settings API ---
// Secret-bearing fields inside settings.json, as [section, key] pairs. These are
// never sent to a client in cleartext — not even to an admin. The admin UI needs
// to know *whether* a secret is set, not what it is, so a set secret is returned
// as SECRET_PLACEHOLDER and POST /api/settings maps that value back to whatever is
// already stored (see unmaskSecrets). This keeps the LDAP bind password and SMTP
// password out of browser memory, devtools, and any proxy log.
const SECRET_PLACEHOLDER = '__unchanged__';
const SECRET_FIELDS = [
  ['smtp', 'pass'],
  ['ldap', 'bindPass'],
  ['telegram', 'bot_token'],
];

function maskSecrets(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  for (const [section, key] of SECRET_FIELDS) {
    const val = out?.[section]?.[key];
    if (typeof val === 'string' && val !== '') out[section][key] = SECRET_PLACEHOLDER;
  }
  return out;
}

// Reverse of maskSecrets: an incoming SECRET_PLACEHOLDER means "leave as-is".
// An empty string is a genuine request to clear the secret and is honoured.
function unmaskSecrets(incomingSection, sectionName, existing) {
  const section = { ...(incomingSection || {}) };
  for (const [sec, key] of SECRET_FIELDS) {
    if (sec !== sectionName) continue;
    if (section[key] === SECRET_PLACEHOLDER) {
      const prior = existing?.[sectionName]?.[key];
      if (typeof prior === 'string') section[key] = prior;
      else delete section[key];
    }
  }
  return section;
}

app.get('/api/settings', authRequired, (req, res) => {
  const s = loadSettings();
  const isAdmin = !!req.user.can_manage_users;
  // Never expose the apikeys block here — it holds the IGDB client secret and is served
  // (masked) only by the admin-only GET /api/settings/apikeys endpoint.
  const { apikeys, ...rest } = s;
  if (isAdmin) {
    // Admins manage server infrastructure and need the current values to edit them,
    // but secrets go out masked — see SECRET_FIELDS above.
    return res.json(maskSecrets(rest));
  }
  // Non-admins configure their notifications entirely on the My Account page
  // (personal ntfy/Gotify server URL + topic/token, Telegram chat ID). The server
  // Settings sections are all administrator-only infrastructure, so a non-admin gets
  // nothing sensitive here.
  return res.json({});
});
// All server Settings sections are administrator-only. They hold secrets (SMTP/LDAP
// credentials, Telegram bot token) or act as an optional global default that would
// affect every user (the ntfy/Gotify server URLs) — per-user notification servers are
// set on My Account instead.
const ADMIN_ONLY_SETTINGS = ['smtp', 'ldap', 'telegram', 'ntfy', 'gotify'];
app.post('/api/settings', authRequired, express.json(), (req, res) => {
  console.log('POST /api/settings called by', req.user.username);
  try {
    const isAdmin = !!req.user.can_manage_users;
    // If a non-admin tried to write an admin-only section, reject plainly.
    if (!isAdmin && ADMIN_ONLY_SETTINGS.some(k => req.body[k] !== undefined)) {
      return res.status(403).json({ error: 'Only administrators can change SMTP, LDAP, or Telegram settings.' });
    }
    // Merge incoming sections with existing — only overwrite sections that were sent,
    // and only let admins overwrite the admin-only sections.
    const existing = loadSettings();
    const canWrite = (k) => req.body[k] !== undefined && (isAdmin || !ADMIN_ONLY_SETTINGS.includes(k));
    // GET returns secrets as SECRET_PLACEHOLDER, so a section saved without the
    // admin retyping the password comes back with the placeholder — map it to the
    // stored value rather than overwriting the credential with the mask.
    const section = (k) => unmaskSecrets(req.body[k], k, existing);
    const merged = {
      smtp: canWrite('smtp') ? section('smtp') : (existing.smtp || {}),
      ldap: canWrite('ldap') ? section('ldap') : (existing.ldap || {}),
      telegram: canWrite('telegram') ? section('telegram') : (existing.telegram || {}),
      ntfy: canWrite('ntfy') ? req.body.ntfy : (existing.ntfy || {}),
      gotify: canWrite('gotify') ? req.body.gotify : (existing.gotify || {}),
      apikeys: existing.apikeys || {},  // always preserve — managed via /api/settings/apikeys
    };
    saveSettings(merged);
    res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/settings:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// Date-only future check for release dates. 'YYYY-MM-DD' parses as UTC midnight,
// so compare date-only on both sides — matching the daily cron (search "[CRON]")
// so a game "releasing today" counts as released, not unreleased.
function isReleaseInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d > today;
}

// --- Add/update a game status for a user (with notification) ---
app.post('/api/user/:username/games', authRequired, ownershipRequired, async (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  let { gameId, gameName, coverUrl, releaseDate, status, steamAppId } = req.body;
  
  // Add debug logging
  console.log(`[DEBUG] Status update request for user ${normalizedUsername}:`, {
    gameId,
    gameName,
    status,
    releaseDate,
    steamAppId,
    originalUsername: username,
    normalizedUsername: normalizedUsername
  });
  
  if (!gameId || !gameName || !status) {
    console.log(`[DEBUG] Missing required fields:`, { gameId, gameName, status });
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Force 'unreleased' when there is no release date OR the date is still in the
  // future — a future-dated game must never be stored as a released status.
  if (!releaseDate || isReleaseInFuture(releaseDate)) {
    console.log(`[DEBUG] No/future release date (${releaseDate || 'none'}), setting status to 'unreleased'`);
    status = 'unreleased';
  }
  withExistingUser(res, normalizedUsername, async (user) => {
    console.log(`[DEBUG] User resolved:`, { userId: user.id, username: user.username });
    
    db.get('SELECT * FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId], async (err, row) => {
      if (err) {
        console.log(`[DEBUG] Error checking existing game:`, err);
        return res.status(500).json({ error: 'DB error' });
      }
      
      let eventType = 'add';
      if (row) {
        console.log(`[DEBUG] Existing game found:`, { 
          currentStatus: row.status, 
          newStatus: status, 
          gameId: row.game_id,
          gameName: row.game_name 
        });
        if (row.status !== status) eventType = 'status';
        if (row.status === 'unreleased' && status !== 'unreleased' && releaseDate && !isReleaseInFuture(releaseDate)) {
          await notifyEvent('release', { gameName, coverUrl }, normalizedUsername, status);
        }
      } else {
        console.log(`[DEBUG] New game being added`);
      }
      
      // Determine backlog_order
      const wasInBacklog = row && row.status === 'backlog';
      const isGoingToBacklog = status === 'backlog';
      let backlogOrder = null;
      if (isGoingToBacklog) {
        if (wasInBacklog) {
          backlogOrder = row.backlog_order;
        } else {
          const maxRow = await new Promise((resolve, reject) => {
            db.get('SELECT MAX(backlog_order) as maxOrder FROM user_games WHERE user_id = ?', [user.id], (err, r) => {
              if (err) reject(err); else resolve(r);
            });
          });
          backlogOrder = (maxRow && maxRow.maxOrder != null ? maxRow.maxOrder : 0) + 1;
        }
      }

      db.run(
        `INSERT INTO user_games (user_id, game_id, game_name, cover_url, release_date, status, steam_app_id, backlog_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, game_id) DO UPDATE SET status=excluded.status, steam_app_id=excluded.steam_app_id, backlog_order=excluded.backlog_order`,
        [user.id, gameId, gameName, coverUrl, releaseDate, status, steamAppId, backlogOrder],
        async function (err) {
          if (err) {
            console.log(`[DEBUG] Error updating game:`, err);
            return res.status(500).json({ error: 'DB error' });
          }

          // Add debug logging after update
          console.log(`[DEBUG] Status updated successfully for user ${normalizedUsername}, game ${gameId} to status: ${status}`);
          console.log(`[DEBUG] Rows affected: ${this.changes}, Last ID: ${this.lastID}`);

          await notifyEvent(eventType, { gameName, coverUrl }, normalizedUsername, status);
          res.json({ success: true });
        }
      );
    });
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
  const userId = req.user.id;
  console.log(`[DEBUG] Getting games for user ID: ${userId}`);
  
  db.all(`
    SELECT game_id, game_name, cover_url, release_date, status
    FROM user_games
    WHERE user_id = ?
    ORDER BY game_name ASC
  `, [userId], (err, rows) => {
    if (err) {
      console.error('[DEBUG] Database error:', err);
      return res.status(500).json({ error: 'DB error' });
    }
    console.log(`[DEBUG] Found ${rows.length} games for user ID ${userId}`);
    res.json(rows);
  });
});

// Get all games for a user
app.get('/api/user/:username/games', authRequired, ownershipRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  withExistingUser(res, normalizedUsername, (user) => {
    db.all('SELECT * FROM user_games WHERE user_id = ?', [user.id], (err, rows) => {
      if (err) {
        console.error('[Library] Error querying games:', err.message);
        return res.status(500).json({ error: 'DB error' });
      }

      // Ensure steamAppId is included in the response
      const mapped = rows.map(row => ({
        ...row,
        steamAppId: row.steam_app_id || null,
        crackStatus: row.crack_status || null
      }));

      // One line per request. This previously logged every game in the library
      // individually, so a normal page load wrote hundreds of lines.
      console.log(`[Library] ${normalizedUsername}: returned ${mapped.length} games`);
      res.json(mapped);
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
    db.run(
      'DELETE FROM user_games WHERE user_id = ? AND game_id = ?',
      [user.id, gameId],
      function (err) {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
      }
    );
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
    db.all(
      'SELECT id, game_id, backlog_order FROM user_games WHERE user_id = ? AND status = ? ORDER BY backlog_order ASC',
      [user.id, 'backlog'],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        const idx = rows.findIndex(r => String(r.game_id) === String(gameId));
        if (idx === -1) return res.status(404).json({ error: 'Game not in backlog' });
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= rows.length) {
          return res.json({ success: true }); // already at boundary
        }
        const game = rows[idx];
        const swapGame = rows[swapIdx];
        db.run('UPDATE user_games SET backlog_order = ? WHERE id = ?', [swapGame.backlog_order, game.id], (err) => {
          if (err) return res.status(500).json({ error: 'DB error' });
          db.run('UPDATE user_games SET backlog_order = ? WHERE id = ?', [game.backlog_order, swapGame.id], (err) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true });
          });
        });
      }
    );
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
  withExistingUser(res, normalizedUsername, (user) => {
    let completed = 0;
    let hasError = false;
    order.forEach((gameId, index) => {
      db.run(
        'UPDATE user_games SET backlog_order = ? WHERE user_id = ? AND game_id = ?',
        [index + 1, user.id, gameId],
        (err) => {
          if (err) hasError = true;
          completed++;
          if (completed === order.length) {
            if (hasError) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true });
          }
        }
      );
    });
  });
});

// Refresh metadata for all games in a user's library
app.post('/api/user/:username/refresh-metadata', authRequired, ownershipRequired, async (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  if (!normalizedUsername) {
    return res.status(400).json({ error: 'Missing username' });
  }

  withExistingUser(res, normalizedUsername, (user) => {

    const run = async () => {
      const userGames = await new Promise((resolve, reject) => {
        db.all('SELECT * FROM user_games WHERE user_id = ?', [user.id], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      const results = {
        total: userGames.length,
        updated: 0,
        errors: [],
        details: []
      };

      // Process each game
      for (const game of userGames) {
        try {
          // Search for the game using the same logic as the search endpoint
          const query = game.game_name;
          // Escape quotes/backslashes in the stored name so it can't break out of the IGDB search literal.
          const safeQuery = String(query).replace(/["\\]/g, '\\$&');

          // IGDB request
          const igdbPromise = axios.post(
            'https://api.igdb.com/v4/games',
            `search "${safeQuery}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit 10;`,
            {
              headers: {
                'Client-ID': resolveApiKey('IGDB_CLIENT_ID'),
                'Authorization': `Bearer ${resolveApiKey('IGDB_BEARER_TOKEN')}`,
                'Accept': 'application/json',
              },
            }
          ).then(async response => {
            const games = response.data || [];
            return games.map(game => {
              let steamAppId = null;
              if (Array.isArray(game.external_games)) {
                const steamExternal = game.external_games.find(ext => ext.category === 1 && ext.uid);
                if (steamExternal) {
                  steamAppId = steamExternal.uid;
                }
              }
              return {
                id: 'igdb_' + game.id,
                name: game.name,
                releaseDate: game.first_release_date
                  ? new Date(game.first_release_date * 1000).toISOString().split('T')[0]
                  : null,
                coverUrl: game.cover?.image_id
                  ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
                  : null,
                source: 'igdb',
                steamAppId,
              };
            });
          }).catch(() => []);

          // RAWG request
          const rawgPromise = axios.get(
            'https://api.rawg.io/api/games',
            {
              params: {
                key: resolveApiKey('RAWG_API_KEY'),
                search: query,
                page_size: 10,
              }
            }
          ).then(async response => {
            const games = response.data.results || [];
            const detailedGames = await Promise.all(games.map(async (game) => {
              let steamAppId = null;
              try {
                const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
                  params: { key: resolveApiKey('RAWG_API_KEY') }
                });
                const stores = detailRes.data.stores || [];
                const steamStore = stores.find(s => s.store && s.store.id === 1 && s.url_en);
                if (steamStore && steamStore.url_en) {
                  const match = steamStore.url_en.match(/\/app\/(\d+)/);
                  if (match) {
                    steamAppId = match[1];
                  }
                }
              } catch (e) {
                // Ignore errors
              }
              return {
                id: 'rawg_' + game.id,
                name: game.name,
                releaseDate: game.released,
                coverUrl: game.background_image,
                source: 'rawg',
                steamAppId,
              };
            }));
            return detailedGames;
          }).catch(() => []);

          // TheGamesDB request (optional - only if API key is configured)
          const thegamesdbPromise = resolveApiKey('THEGAMESDB_API_KEY')
            ? axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
                params: {
                  apikey: resolveApiKey('THEGAMESDB_API_KEY'),
                  name: query,
                }
              }).then(async response => {
                const data = response.data;
                if (!data || !data.data || !data.data.games) {
                  return [];
                }
                const games = Array.isArray(data.data.games) ? data.data.games : [data.data.games];
                const baseUrl = data.include?.base_url?.image_base || data.data?.base_url?.image_base || 'https://cdn.thegamesdb.net/images/';
                
                return games.slice(0, 10).map(game => {
                  // Find cover/boxart image
                  let coverUrl = null;
                  if (data.include && data.include.boxart) {
                    const gameBoxart = data.include.boxart[game.id];
                    if (gameBoxart && Array.isArray(gameBoxart)) {
                      const frontCover = gameBoxart.find(img => img.side === 'front');
                      if (frontCover) {
                        coverUrl = `${baseUrl}${frontCover.filename}`;
                      } else if (gameBoxart[0]) {
                        coverUrl = `${baseUrl}${gameBoxart[0].filename}`;
                      }
                    } else if (gameBoxart && gameBoxart.filename) {
                      coverUrl = `${baseUrl}${gameBoxart.filename}`;
                    }
                  }
                  
                  // Parse release date
                  let releaseDate = null;
                  if (game.release_date) {
                    const date = new Date(game.release_date);
                    if (!isNaN(date.getTime())) {
                      releaseDate = date.toISOString().split('T')[0];
                    }
                  }
                  
                  return {
                    id: 'thegamesdb_' + game.id,
                    name: game.game_title || game.game_name || '',
                    releaseDate: releaseDate,
                    coverUrl: coverUrl,
                    source: 'thegamesdb',
                    steamAppId: null,
                  };
                }).filter(game => game.name);
              }).catch(() => [])
            : Promise.resolve([]);

          // Wait for all three APIs
          const [igdbResults, rawgResults, thegamesdbResults] = await Promise.all([igdbPromise, rawgPromise, thegamesdbPromise]);

          // Merge and deduplicate by name (case-insensitive)
          const merged = [...igdbResults, ...rawgResults, ...thegamesdbResults].map(g => {
            // If game didn't provide a steamAppId, try to find one from IGDB or RAWG
            if (!g.steamAppId) {
              const igdbMatch = igdbResults.find(igdbGame => igdbGame.name.toLowerCase() === g.name.toLowerCase() && igdbGame.steamAppId);
              if (igdbMatch) {
                return { ...g, steamAppId: igdbMatch.steamAppId };
              }
              const rawgMatch = rawgResults.find(rawgGame => rawgGame.name.toLowerCase() === g.name.toLowerCase() && rawgGame.steamAppId);
              if (rawgMatch) {
                return { ...g, steamAppId: rawgMatch.steamAppId };
              }
            }
            // If game didn't provide a coverUrl, try to find one from other sources
            if (!g.coverUrl) {
              const coverMatch = [...igdbResults, ...rawgResults, ...thegamesdbResults].find(otherGame => 
                otherGame.name.toLowerCase() === g.name.toLowerCase() && otherGame.coverUrl
              );
              if (coverMatch) {
                return { ...g, coverUrl: coverMatch.coverUrl };
              }
            }
            // Do NOT fill releaseDate from another result by name only (avoids wrong date from different game with same name)
            return g;
          });
          // Dedupe by name: prefer entry with no release date (unreleased) when multiple same-name results
          const byNameBulk = {};
          merged.forEach(g => {
            const k = g.name.toLowerCase();
            if (!byNameBulk[k]) byNameBulk[k] = [];
            byNameBulk[k].push(g);
          });
          const mergedDedupedBulk = Object.values(byNameBulk).map(games =>
            games.find(g => !g.releaseDate) || games[0]
          );

          // Find the best match (exact name match, case-insensitive)
          const match = mergedDedupedBulk.find(g => g.name.toLowerCase() === game.game_name.toLowerCase());
          
          if (match) {
            let updated = false;
            const updates = [];
            const params = [];

            // Check release date
            if (match.releaseDate !== game.release_date) {
              updates.push('release_date = ?');
              params.push(match.releaseDate);
              updated = true;
              // Re-sync status to the new date: future -> lock as unreleased;
              // past/now on a currently-unreleased game -> promote to wishlist
              // (mirrors the daily cron auto-transition).
              if (isReleaseInFuture(match.releaseDate)) {
                if (game.status !== 'unreleased') {
                  updates.push('status = ?');
                  params.push('unreleased');
                }
              } else if (game.status === 'unreleased') {
                updates.push('status = ?');
                params.push('wishlist');
              }
            }

            // Check cover URL
            if (match.coverUrl !== game.cover_url) {
              updates.push('cover_url = ?');
              params.push(match.coverUrl);
              updated = true;
            }

            // Check Steam App ID (update if we found one and don't have one)
            if (match.steamAppId && !game.steam_app_id) {
              updates.push('steam_app_id = ?');
              params.push(match.steamAppId);
              updated = true;
            }

            if (updated) {
              params.push(user.id, game.game_id);
              await new Promise((resolve, reject) => {
                db.run(
                  `UPDATE user_games SET ${updates.join(', ')} WHERE user_id = ? AND game_id = ?`,
                  params,
                  function (err) {
                    if (err) {
                      reject(err);
                    } else {
                      resolve();
                    }
                  }
                );
              });
              results.updated++;
              results.details.push({
                gameName: game.game_name,
                gameId: game.game_id,
                changes: updates.map(u => u.split(' = ')[0])
              });
            } else {
              results.details.push({
                gameName: game.game_name,
                gameId: game.game_id,
                changes: []
              });
            }
          } else {
            results.errors.push({
              gameName: game.game_name,
              gameId: game.game_id,
              error: 'Game not found in API search results'
            });
            results.details.push({
              gameName: game.game_name,
              gameId: game.game_id,
              changes: [],
              error: 'Not found'
            });
          }
        } catch (error) {
          results.errors.push({
            gameName: game.game_name,
            gameId: game.game_id,
            error: error.message
          });
          results.details.push({
            gameName: game.game_name,
            gameId: game.game_id,
            changes: [],
            error: error.message
          });
        }
      }

      res.json({
        success: true,
        message: `Metadata refresh completed. ${results.updated} games updated out of ${results.total} total games.`,
        results
      });
    };

    run().catch((e) => {
      console.error('Bulk refresh metadata error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: e.message || 'Failed to refresh metadata' });
      }
    });
  });
});

// Refresh metadata for a specific game in a user's library
app.post('/api/user/:username/games/:gameId/refresh-metadata', authRequired, ownershipRequired, async (req, res) => {
  const { username, gameId } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';

  if (!normalizedUsername || !gameId) {
    return res.status(400).json({ error: 'Missing username or gameId' });
  }

  withExistingUser(res, normalizedUsername, async (user) => {

    db.get('SELECT * FROM user_games WHERE user_id = ? AND game_id = ?', [user.id, gameId], async (err, game) => {
      if (err) {
        return res.status(500).json({ error: 'DB error' });
      }
      if (!game) {
        return res.status(404).json({ error: 'Game not found in user library' });
      }

      const results = {
        total: 1,
        updated: 0,
        errors: [],
        details: []
      };

      try {
        const query = game.game_name;
        // Escape quotes/backslashes in the stored name so it can't break out of the IGDB search literal.
        const safeQuery = String(query).replace(/["\\]/g, '\\$&');

        const igdbPromise = axios.post(
          'https://api.igdb.com/v4/games',
          `search "${safeQuery}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit 10;`,
          {
            headers: {
              'Client-ID': resolveApiKey('IGDB_CLIENT_ID'),
              'Authorization': `Bearer ${resolveApiKey('IGDB_BEARER_TOKEN')}`,
              'Accept': 'application/json',
            },
          }
        ).then(async response => {
          const games = response.data || [];
          return games.map(game => {
            let steamAppId = null;
            if (Array.isArray(game.external_games)) {
              const steamExternal = game.external_games.find(ext => ext.category === 1 && ext.uid);
              if (steamExternal) {
                steamAppId = steamExternal.uid;
              }
            }
            return {
              id: 'igdb_' + game.id,
              name: game.name,
              releaseDate: game.first_release_date
                ? new Date(game.first_release_date * 1000).toISOString().split('T')[0]
                : null,
              coverUrl: game.cover?.image_id
                ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
                : null,
              source: 'igdb',
              steamAppId,
            };
          });
        }).catch(() => []);

        const rawgPromise = axios.get(
          'https://api.rawg.io/api/games',
          {
            params: {
              key: resolveApiKey('RAWG_API_KEY'),
              search: query,
              page_size: 10,
            }
          }
        ).then(async response => {
          const games = response.data.results || [];
          const detailedGames = await Promise.all(games.map(async (game) => {
            let steamAppId = null;
            try {
              const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
                params: { key: resolveApiKey('RAWG_API_KEY') }
              });
              const stores = detailRes.data.stores || [];
              const steamStore = stores.find(s => s.store && s.store.id === 1 && s.url_en);
              if (steamStore && steamStore.url_en) {
                const match = steamStore.url_en.match(/\/app\/(\d+)/);
                if (match) {
                  steamAppId = match[1];
                }
              }
            } catch (e) {
              // Ignore errors
            }
            return {
              id: 'rawg_' + game.id,
              name: game.name,
              releaseDate: game.released,
              coverUrl: game.background_image,
              source: 'rawg',
              steamAppId,
            };
          }));
          return detailedGames;
        }).catch(() => []);

        const thegamesdbPromise = resolveApiKey('THEGAMESDB_API_KEY')
          ? axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
              params: {
                apikey: resolveApiKey('THEGAMESDB_API_KEY'),
                name: query,
              }
            }).then(async response => {
              const data = response.data;
              if (!data || !data.data || !data.data.games) {
                return [];
              }
              const games = Array.isArray(data.data.games) ? data.data.games : [data.data.games];
              const baseUrl = data.include?.base_url?.image_base || data.data?.base_url?.image_base || 'https://cdn.thegamesdb.net/images/';
              
              return games.slice(0, 10).map(game => {
                let coverUrl = null;
                if (data.include && data.include.boxart) {
                  const gameBoxart = data.include.boxart[game.id];
                  if (gameBoxart && Array.isArray(gameBoxart)) {
                    const frontCover = gameBoxart.find(img => img.side === 'front');
                    if (frontCover) {
                      coverUrl = `${baseUrl}${frontCover.filename}`;
                    } else if (gameBoxart[0]) {
                      coverUrl = `${baseUrl}${gameBoxart[0].filename}`;
                    }
                  } else if (gameBoxart && gameBoxart.filename) {
                    coverUrl = `${baseUrl}${gameBoxart.filename}`;
                  }
                }
                
                let releaseDate = null;
                if (game.release_date) {
                  const date = new Date(game.release_date);
                  if (!isNaN(date.getTime())) {
                    releaseDate = date.toISOString().split('T')[0];
                  }
                }
                
                return {
                  id: 'thegamesdb_' + game.id,
                  name: game.game_title || game.game_name || '',
                  releaseDate: releaseDate,
                  coverUrl: coverUrl,
                  source: 'thegamesdb',
                  steamAppId: null,
                };
              }).filter(game => game.name);
            }).catch(() => [])
          : Promise.resolve([]);

        const [igdbResults, rawgResults, thegamesdbResults] = await Promise.all([igdbPromise, rawgPromise, thegamesdbPromise]);

        const merged = [...igdbResults, ...rawgResults, ...thegamesdbResults].map(g => {
          if (!g.steamAppId) {
            const igdbMatch = igdbResults.find(igdbGame => igdbGame.name.toLowerCase() === g.name.toLowerCase() && igdbGame.steamAppId);
            if (igdbMatch) return { ...g, steamAppId: igdbMatch.steamAppId };
            const rawgMatch = rawgResults.find(rawgGame => rawgGame.name.toLowerCase() === g.name.toLowerCase() && rawgGame.steamAppId);
            if (rawgMatch) return { ...g, steamAppId: rawgMatch.steamAppId };
          }
          if (!g.coverUrl) {
            const coverMatch = [...igdbResults, ...rawgResults, ...thegamesdbResults].find(otherGame =>
              otherGame.name.toLowerCase() === g.name.toLowerCase() && otherGame.coverUrl
            );
            if (coverMatch) return { ...g, coverUrl: coverMatch.coverUrl };
          }
          // Do NOT fill releaseDate from another result by name only (avoids wrong date from different game with same name)
          return g;
        });
        // Dedupe by name: prefer entry with no release date (unreleased) when multiple same-name results
        const byNameSingle = {};
        merged.forEach(g => {
          const k = g.name.toLowerCase();
          if (!byNameSingle[k]) byNameSingle[k] = [];
          byNameSingle[k].push(g);
        });
        const mergedDedupedSingle = Object.values(byNameSingle).map(games =>
          games.find(g => !g.releaseDate) || games[0]
        );

        const match = mergedDedupedSingle.find(g => g.name.toLowerCase() === game.game_name.toLowerCase());

        if (match) {
          let updated = false;
          const updates = [];
          const params = [];

          if (match.releaseDate !== game.release_date) {
            updates.push('release_date = ?');
            params.push(match.releaseDate);
            updated = true;
            // Re-sync status to the new date (see bulk refresh above).
            if (isReleaseInFuture(match.releaseDate)) {
              if (game.status !== 'unreleased') {
                updates.push('status = ?');
                params.push('unreleased');
              }
            } else if (game.status === 'unreleased') {
              updates.push('status = ?');
              params.push('wishlist');
            }
          }
          if (match.coverUrl !== game.cover_url) {
            updates.push('cover_url = ?');
            params.push(match.coverUrl);
            updated = true;
          }
          if (match.steamAppId && !game.steam_app_id) {
            updates.push('steam_app_id = ?');
            params.push(match.steamAppId);
            updated = true;
          }

          if (updated) {
            params.push(user.id, game.game_id);
            await new Promise((resolve, reject) => {
              db.run(
                `UPDATE user_games SET ${updates.join(', ')} WHERE user_id = ? AND game_id = ?`,
                params,
                function (err) {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
            results.updated++;
            results.details.push({
              gameName: game.game_name,
              gameId: game.game_id,
              changes: updates.map(u => u.split(' = ')[0])
            });
          } else {
            results.details.push({
              gameName: game.game_name,
              gameId: game.game_id,
              changes: []
            });
          }
        } else {
          results.errors.push({
            gameName: game.game_name,
            gameId: game.game_id,
            error: 'Game not found in API search results'
          });
          results.details.push({
            gameName: game.game_name,
            gameId: game.game_id,
            changes: [],
            error: 'Not found'
          });
        }

        return res.json({
          success: true,
          results,
          message: `Metadata refresh completed for game ${game.game_name}.`,
        });
      } catch (error) {
        console.error(`Error refreshing metadata for game_id ${gameId}:`, error);
        results.errors.push({
          gameName: game.game_name,
          gameId: game.game_id,
          error: error.message || 'Unknown error'
        });
        return res.status(500).json({
          error: 'Failed to refresh metadata for game',
          results
        });
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
  let payload;
  try {
    payload = jwt.verify(auth.slice(7), JWT_SECRET);
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
      next();
    });
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !req.user[permission]) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
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
  console.log(`[Auth] Failed login attempt from IP ${clientIP} for '${username || 'unknown'}'.`);
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
    console.log(`[Auth] Rate limited: IP ${clientIP} / user '${normalizedUsername}'. ${lockedFor} minutes remaining.`);
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
    console.log('[Auth] Using fallback local authentication for user:', normalizedUsername);
    db.get('SELECT * FROM users WHERE username = ?', [normalizedUsername], async (err, user) => {
      if (err) {
        console.error('[Auth] Database error during user lookup:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (!user) {
        console.log('[Auth] Local user not found:', normalizedUsername);
        // Track failed attempt
        trackFailedAttempt(clientIP, normalizedUsername);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      console.log('[Auth] Found user in database:', { id: user.id, username: user.username, origin: user.origin });
      try {
        // LDAP users have no local password — reject cleanly instead of crashing bcrypt.
        // The reason goes to the server log only: telling the *client* that this is
        // an LDAP account confirmed both that the username exists and that it is a
        // domain account, which is a ready-made target list for spraying against AD.
        if (!user.password || typeof user.password !== 'string') {
          console.log(`[Auth] User '${normalizedUsername}' has no local password (origin=${user.origin}). Local auth not possible.`);
          trackFailedAttempt(clientIP, normalizedUsername);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(String(password), user.password);
        if (!valid) {
          console.log('[Auth] Local password validation failed for user:', normalizedUsername);
          // Track failed attempt
          trackFailedAttempt(clientIP, normalizedUsername);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        console.log('[Auth] Password validation successful for user:', normalizedUsername);
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

        let foundUser = null;
        let matchCount = 0;
        searchRes.on('searchEntry', (entry) => {
          matchCount++;
          console.log('[LDAP] Search entry received for user lookup.');

          // Manually construct the user object from the entry's properties.
          // This is more reliable than the .object getter.
          const attributes = {};
          entry.attributes.forEach(attr => {
            attributes[attr.type] = attr.vals.length === 1 ? attr.vals[0] : attr.vals;
          });

          foundUser = {
            dn: entry.dn.toString(),
            ...attributes
          };
          // Log the DN only. Dumping the whole entry put mail addresses and full
          // group membership into shared logs for every single login.
          console.log('[LDAP] Parsed user object for DN:', foundUser.dn);
        });

        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during processing:', err.message);
          client.markHandled();
          client.unbind();
          return fallbackLocalAuth();
        });

        searchRes.on('end', (result) => {
          console.log('[LDAP] Search finished. Result status:', result ? result.status : 'N/A');
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
                const memberOf = foundUser.memberOf || [];
                const groups = Array.isArray(memberOf) ? memberOf : [memberOf];
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
            let cnValue = Array.isArray(foundUser.cn) ? foundUser.cn[0] : foundUser.cn;
            if (!cnValue && foundUser.dn) {
              // Extract CN from DN string
              const match = foundUser.dn.match(/CN=([^,]+)/i);
              if (match) cnValue = match[1];
            }
            const displayName = (typeof cnValue === 'string' && cnValue.trim() !== '') ? cnValue : normalizedUsername;
            
            // Get email from LDAP attributes
            const userEmail = foundUser.mail || foundUser.email || null;
            
            console.log('[DEBUG] Extracted cnValue:', cnValue);
            console.log('[DEBUG] Final displayName:', displayName);
            console.log('[DEBUG] User email from LDAP:', userEmail);

            getOrCreateUser(normalizedUsername, (err, user) => {
              if (err) {
                if (authCompleted) return;
                authCompleted = true;
                return res.status(500).json({ error: 'DB error' });
              }
              // Update display_name, origin, and email for LDAP users
              const updates = ['display_name = ?, origin = ?'];
              const params = [displayName, 'ldap'];
              
              if (userEmail) {
                updates.push('email = ?');
                params.push(userEmail);
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
// `me` would be shadowed by the /api/user/me/* routes registered before
// /api/user/:username/*; `root`/`admin` are reserved to avoid impersonation
// confusion with the seeded administrator account.
const RESERVED_USERNAMES = ['me', 'root', 'admin'];

// Create user (admin only)
app.post('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { username, password, can_manage_users = 0, email = '', ntfy_topic = '', gotify_token = '', shares_library = 0 } = req.body;
  
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
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
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
      'INSERT INTO users (username, password, can_manage_users, email, ntfy_topic, gotify_token, created_at, origin, display_name, shares_library) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [normalizedUsername, hash, can_manage_users ? 1 : 0, email, ntfy_topic, gotify_token, new Date().toISOString(), 'local', normalizedUsername, shares_library ? 1 : 0],
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
  db.all('SELECT id, username, can_manage_users, email, ntfy_topic, gotify_token, created_at, origin, display_name, shares_library FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Edit user (manager only)
app.put('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { id } = req.params;
  const { password, can_manage_users, email, ntfy_topic, gotify_token, shares_library } = req.body;
  const updates = [];
  const params = [];
  if (typeof can_manage_users !== 'undefined') {
    updates.push('can_manage_users = ?');
    params.push(can_manage_users ? 1 : 0);
  }
  if (typeof email !== 'undefined') {
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
  if (typeof gotify_token !== 'undefined') {
    updates.push('gotify_token = ?');
    params.push(gotify_token);
  }
  if (typeof shares_library !== 'undefined') {
    updates.push('shares_library = ?');
    params.push(shares_library ? 1 : 0);
  }
  // Nothing to change: an empty body previously produced `UPDATE users SET  WHERE
  // id = ?`, i.e. a SQL syntax error surfacing as an opaque 500.
  if (updates.length === 0 && !password) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  // An admin must not be able to lock the instance out of its own administration by
  // demoting themselves — there may be no other admin left to undo it.
  if (typeof can_manage_users !== 'undefined' && !can_manage_users && String(req.user.id) === String(id)) {
    return res.status(400).json({ error: 'You cannot remove your own admin permission.' });
  }

  const applyUpdate = () => {
    params.push(id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
    });
  };

  if (password) {
    // Must be a string: a JSON number passes `.length < 8` (undefined < 8 is false)
    // and then rejects inside bcrypt.hash, crashing the process.
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string' });
    }
    // Password strength validation
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    bcrypt.hash(password, 10).then(hash => {
      updates.push('password = ?');
      params.push(hash);
      applyUpdate();
    }).catch(err => {
      console.error('[Users] Password hashing failed:', err.message);
      res.status(500).json({ error: 'Failed to update user' });
    });
  } else {
    applyUpdate();
  }
});

// Delete user (manager only)
app.delete('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { id } = req.params;
  // Deleting yourself, or deleting the seeded `root` account, can leave the
  // instance with no way back in. Both are refused.
  if (String(req.user.id) === String(id)) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  db.get('SELECT username FROM users WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.username === 'root') {
      return res.status(400).json({ error: 'The root account cannot be deleted.' });
    }
    db.run('DELETE FROM users WHERE id = ?', [id], function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      // Shares reference usernames, not ids, and SQLite does not enforce the
      // declared foreign keys — clean them up so the deleted user does not linger
      // in other people's sharing lists.
      db.run('DELETE FROM user_shares WHERE from_user = ? OR to_user = ?', [row.username, row.username]);
      res.json({ success: true });
    });
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
    
    const results = {
      email: { sent: false, error: null },
      ntfy: { sent: false, error: null },
      gotify: { sent: false, error: null },
      telegram: { sent: false, error: null },
    };

    // Get current user's email, ntfy topic, gotify token, and telegram chat id
    const userId = req.user.id;
    const userDetails = await new Promise((resolve, reject) => {
      db.get('SELECT email, ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id FROM users WHERE id = ?', [userId], (err, userRow) => {
        if (err) {
          reject(err);
        } else {
          resolve(userRow);
        }
      });
    });

    // Send email notification if requested
    if (service === 'email' || service === 'both') {
      if (userDetails && userDetails.email) {
        try {
          await sendEmail(subject, text, userDetails.email, coverUrl);
          results.email.sent = true;
          console.log(`[Test Notification] Email sent successfully to ${userDetails.email}`);
        } catch (error) {
          results.email.error = sanitizeDeliveryError(error, 'email');
        }
      } else {
        results.email.error = 'No email configured for current user';
      }
    }

    // Send ntfy notification if requested
    if (service === 'ntfy' || service === 'both') {
      if (userDetails?.ntfy_topic) {
        try {
          await sendNtfy(title, message, userDetails.ntfy_topic, coverUrl, userDetails.ntfy_url);
          results.ntfy.sent = true;
          console.log(`[Test Notification] Ntfy sent successfully to topic ${userDetails.ntfy_topic}`);
        } catch (error) {
          results.ntfy.error = sanitizeDeliveryError(error, 'ntfy');
        }
      } else {
        results.ntfy.error = 'No personal NTFY topic set — configure it in My Account';
      }
    }

    // Send Gotify notification if requested
    if (service === 'gotify' || service === 'both') {
      if (userDetails?.gotify_token) {
        try {
          await sendGotify(title, message, userDetails.gotify_token, 5, coverUrl, userDetails.gotify_url);
          results.gotify.sent = true;
          console.log(`[Test Notification] Gotify sent successfully`);
        } catch (error) {
          results.gotify.error = sanitizeDeliveryError(error, 'gotify');
        }
      } else {
        results.gotify.error = 'No personal Gotify token set — configure it in My Account';
      }
    }

    // Send Telegram notification if requested
    if (service === 'telegram' || service === 'both') {
      if (userDetails?.telegram_chat_id) {
        try {
          await sendTelegram(title, message, userDetails.telegram_chat_id, coverUrl);
          results.telegram.sent = true;
          console.log(`[Test Notification] Telegram sent successfully`);
        } catch (error) {
          results.telegram.error = sanitizeDeliveryError(error, 'telegram');
        }
      } else {
        results.telegram.error = 'No personal Telegram chat ID set — configure it in My Account';
      }
    }

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

              let found = false;
              searchRes.on('searchEntry', (entry) => {
                console.log(`[LDAP Sync] Found user in LDAP: ${user.username}`);
                const attrs = entry.attributes.reduce((acc, attr) => {
                  acc[attr.type] = attr.vals[0];
                  return acc;
                }, {});
                found = true;
                resolve(attrs);
              });

              searchRes.on('end', () => {
                if (!found) {
                  console.log(`[LDAP Sync] User not found in LDAP: ${user.username}`);
                  resolve(null); // User not found in LDAP
                }
              });

              searchRes.on('error', (err) => {
                console.error(`[LDAP Sync] Search error for ${user.username}:`, err.message);
                reject(new Error(`LDAP search error: ${err.message}`));
              });
            });
          });

          // (the socket is closed in the finally block below, on every path)

          if (userData) {
            // User found in LDAP, update their information
            const newDisplayName = userData.displayName || user.username;
            const newEmail = userData.mail || user.email;
            
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
  db.all('SELECT id, username, display_name, origin FROM users WHERE shares_library = 1', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
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
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const isUnsafeKey = (k) => UNSAFE_KEYS.includes(String(k));

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
function wasNotificationSent(username, gameId, type) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (isUnsafeKey(normalizedUsername) || isUnsafeKey(gameId) || isUnsafeKey(type)) return false;
  return sentNotifications[normalizedUsername] && sentNotifications[normalizedUsername][gameId] && sentNotifications[normalizedUsername][gameId][type];
}
function getAllUsers(cb) {
  db.all('SELECT username FROM users', [], (err, rows) => {
    if (err) return cb(err);
    cb(null, rows.map(r => r.username));
  });
}
function getUserGames(username, cb) {
  // Read-only, single round trip. Callers are the cron sweep (users always exist)
  // and the shared-library view, where `fromUser` may have been deleted — the
  // declared foreign keys on user_shares are not enforced, so orphan share rows
  // are possible. An unknown user is simply an empty library, never a reason to
  // provision an account (this used to call getOrCreateUser and did exactly that).
  db.all(
    'SELECT ug.* FROM user_games ug JOIN users u ON u.id = ug.user_id WHERE u.username = ?',
    [username ? String(username).toLowerCase() : ''],
    cb
  );
}
async function sendReleaseReminder(username, game, days) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const coverUrl = game.cover_url || null;
  let when = days === 0 ? 'today' : `in ${days} days`;
  let subject = `Reminder: "${game.game_name}" releases ${when}!`;
  let text = `The game "${game.game_name}" you are following releases ${when} (${game.release_date}).`;
  let title = 'Game Release Reminder';
  let message = text;

  // Get user's email from database or LDAP
  const userEmail = await getUserEmail(normalizedUsername);
  if (userEmail) {
    await sendEmail(subject, text, userEmail, coverUrl);
  }
  
  // Get user's ntfy topic, gotify token, and telegram chat id
  const userPushSettings = await new Promise((resolve) => {
    db.get('SELECT ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id FROM users WHERE username = ?', [normalizedUsername], (err, userRow) => {
      if (err || !userRow) {
        resolve({});
      } else {
        resolve(userRow);
      }
    });
  });

  if (userPushSettings.ntfy_topic) {
    try {
      await sendNtfy(title, message, userPushSettings.ntfy_topic, coverUrl, userPushSettings.ntfy_url);
      console.log(`[Release Reminder] Ntfy sent successfully to topic ${userPushSettings.ntfy_topic} for user ${normalizedUsername}`);
    } catch (error) {
      console.error(`[Release Reminder] Ntfy failed for user ${normalizedUsername}:`, error.message);
    }
  } else {
    console.log(`[Release Reminder] No personal ntfy topic set for user ${normalizedUsername}, skipping ntfy`);
  }

  if (userPushSettings.gotify_token) {
    try {
      await sendGotify(title, message, userPushSettings.gotify_token, 5, coverUrl, userPushSettings.gotify_url);
      console.log(`[Release Reminder] Gotify sent successfully for user ${normalizedUsername}`);
    } catch (error) {
      console.error(`[Release Reminder] Gotify failed for user ${normalizedUsername}:`, error.message);
    }
  } else {
    console.log(`[Release Reminder] No personal Gotify token set for user ${normalizedUsername}, skipping Gotify`);
  }

  if (userPushSettings.telegram_chat_id) {
    try {
      await sendTelegram(title, message, userPushSettings.telegram_chat_id, coverUrl);
      console.log(`[Release Reminder] Telegram sent successfully for user ${normalizedUsername}`);
    } catch (error) {
      console.error(`[Release Reminder] Telegram failed for user ${normalizedUsername}:`, error.message);
    }
  } else {
    console.log(`[Release Reminder] No personal Telegram chat ID set for user ${normalizedUsername}, skipping Telegram`);
  }
}

// Helper function to get user email from LDAP if not in database
async function getUserEmail(username) {
  return new Promise((resolve) => {
    // Normalize username to lowercase to prevent case sensitivity issues
    const normalizedUsername = username ? username.toLowerCase() : '';
    db.get('SELECT email FROM users WHERE username = ?', [normalizedUsername], async (err, userRow) => {
      if (err || !userRow || !userRow.email) {
        // Try to get email from LDAP
        const ldapEmail = await getLdapEmail(normalizedUsername);
        if (ldapEmail) {
          // Update database with LDAP email
          db.run('UPDATE users SET email = ? WHERE username = ?', [ldapEmail, normalizedUsername]);
        }
        resolve(ldapEmail);
      } else {
        resolve(userRow.email);
      }
    });
  });
}

console.log('About to schedule cron job');
cron.schedule('0 8 * * *', () => {
  console.log('[CRON] Running scheduled notification check...');
  getAllUsers((err, users) => {
    if (err) return console.error('Error fetching users for notifications:', err);
    users.forEach(username => {
      // Load user's notification day preferences
      db.get('SELECT notification_days FROM users WHERE username = ?', [username.toLowerCase()], (err, userRow) => {
        let notifDays = [0, 7, 30]; // default matches legacy behaviour
        if (!err && userRow && userRow.notification_days) {
          try { notifDays = JSON.parse(userRow.notification_days); } catch {}
        }
        getUserGames(username, (err, games) => {
          if (err) return;
          let found = false;
          games.forEach(game => {
            if (game.status === 'unreleased' && game.release_date) {
              const releaseDate = new Date(game.release_date);
              const today = new Date();
              today.setHours(0,0,0,0);
              releaseDate.setHours(0,0,0,0);
              const diffDays = Math.ceil((releaseDate - today) / (1000 * 60 * 60 * 24));
              console.log(`[CRON] User: ${username}, Game: ${game.game_name}, Release: ${game.release_date}, diffDays: ${diffDays}, notifDays: ${JSON.stringify(notifDays)}`);

              // Check if game has been released (diffDays <= 0)
              if (diffDays <= 0) {
                console.log(`[CRON] Game "${game.game_name}" has been released! Updating status from unreleased to wishlist for user ${username}`);
                db.run(
                  'UPDATE user_games SET status = ? WHERE user_id = (SELECT id FROM users WHERE username = ?) AND game_id = ?',
                  ['wishlist', username.toLowerCase(), game.game_id],
                  function(err) {
                    if (err) {
                      console.error(`[CRON] Failed to update status for game ${game.game_name} (user: ${username}):`, err);
                    } else {
                      console.log(`[CRON] Successfully updated status for game ${game.game_name} (user: ${username}) from unreleased to wishlist`);
                      notifyEvent('release', { gameName: game.game_name, coverUrl: game.cover_url }, username, 'wishlist').catch(err => {
                        console.error(`[CRON] Failed to send release notification for game ${game.game_name} (user: ${username}):`, err);
                      });
                    }
                  }
                );
                found = true;
              } else {
                // Check if this diffDays value matches any of the user's configured reminder days
                if (notifDays.includes(diffDays)) {
                  const type = `${diffDays}days`;
                  if (!wasNotificationSent(username, game.game_id, type)) {
                    console.log(`[CRON] Sending ${type} reminder to ${username} for game ${game.game_name}`);
                    sendReleaseReminder(username, game, diffDays).then(() => {
                      markNotificationSent(username, game.game_id, type);
                      console.log(`Sent ${type} release reminder to ${username} for game ${game.game_name}`);
                    }).catch(err => {
                      console.error(`Failed to send ${type} reminder to ${username} for game ${game.game_name}:`, err);
                    });
                    found = true;
                  } else {
                    console.log(`[CRON] Notification already sent for ${username}, game ${game.game_name}, type ${type}`);
                  }
                }
              }
            }
          });
          if (!found) {
            console.log(`[CRON] No matching unreleased games for user ${username}`);
          }
        });
      });
    });
  });
});

// --- Per-user Library Sharing (persistent) ---
// The user_shares table is created by initializeSchema() at boot, alongside the
// other tables and inside the same db.serialize() block — creating it here as well
// raced everything else in the file.

// Share a user's list with one or more users
app.post('/api/user/:username/share', authRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const { toUsers } = req.body;
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only share your own library.' });
  if (!Array.isArray(toUsers)) return res.status(400).json({ error: 'No users to share with.' });

  // Usernames are stored lowercase everywhere and every lookup compares lowercase,
  // so a mixed-case entry here would be written but never match — a share the user
  // sees as active that silently does nothing. Normalize, drop blanks and self-shares,
  // and de-duplicate before touching the table.
  const requested = [...new Set(
    toUsers
      .filter(u => typeof u === 'string')
      .map(u => u.trim().toLowerCase())
      .filter(u => u && u !== normalizedUsername)
  )];

  // The declared foreign keys on user_shares are not enforced (SQLite runs with
  // PRAGMA foreign_keys OFF by default), so verify the targets exist ourselves
  // rather than storing shares pointing at accounts that were never created.
  const verifyTargets = (cb) => {
    if (requested.length === 0) return cb(null, []);
    const placeholders = requested.map(() => '?').join(',');
    db.all(`SELECT username FROM users WHERE username IN (${placeholders})`, requested, (err, rows) => {
      if (err) return cb(err);
      cb(null, rows.map(r => r.username));
    });
  };

  verifyTargets((err, existingUsers) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    const unknown = requested.filter(u => !existingUsers.includes(u));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown user(s): ${unknown.join(', ')}` });
    }
    // Remove all existing shares for this user
    db.run('DELETE FROM user_shares WHERE from_user = ?', [normalizedUsername], (err) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      // Add new shares
      if (existingUsers.length === 0) return res.json({ success: true });
      const now = new Date().toISOString();
      const stmt = db.prepare('INSERT OR IGNORE INTO user_shares (from_user, to_user, shared_at) VALUES (?, ?, ?)');
      existingUsers.forEach(toUser => {
        stmt.run(normalizedUsername, toUser, now);
      });
      stmt.finalize((err) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
      });
    });
  });
});

// Get lists shared with the current user
app.get('/api/user/:username/shared-with-me', authRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only view your own shares.' });
  db.all('SELECT from_user, shared_at FROM user_shares WHERE to_user = ?', [normalizedUsername], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Get a specific user's shared list (read-only, only if shared with you)
app.get('/api/user/:username/shared/:fromUser', authRequired, (req, res) => {
  const { username, fromUser } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const normalizedFromUser = fromUser ? fromUser.toLowerCase() : '';
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only view your own shares.' });
  db.get('SELECT 1 FROM user_shares WHERE from_user = ? AND to_user = ?', [normalizedFromUser, normalizedUsername], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(403).json({ error: 'Not shared with you.' });
    getUserGames(normalizedFromUser, (err, games) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(games);
    });
  });
});

// Revoke a share from a user
app.delete('/api/user/:username/revoke-share/:fromUser', authRequired, (req, res) => {
  const { username, fromUser } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const normalizedFromUser = fromUser ? fromUser.toLowerCase() : '';
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only revoke your own shares.' });
  db.run('DELETE FROM user_shares WHERE from_user = ? AND to_user = ?', [normalizedFromUser, normalizedUsername], function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

// List all users (for sharing UI, not just admins)
app.get('/api/all-users', authRequired, (req, res) => {
  db.all('SELECT username, display_name, origin FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Get the list of users I am sharing with
app.get('/api/user/:username/share', authRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only view your own shares.' });
  db.all('SELECT to_user FROM user_shares WHERE from_user = ?', [normalizedUsername], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ toUsers: rows.map(r => r.to_user) });
  });
});

// Manual trigger for release status updates (for testing)
app.post('/api/admin/check-releases', authRequired, requirePermission('can_manage_users'), (req, res) => {
  console.log('[MANUAL API] Running release status check...');
  let updatedGames = [];
  let notificationsSent = [];
  
  getAllUsers((err, users) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch users' });
    
    let processedUsers = 0;
    users.forEach(username => {
      getUserGames(username, (err, games) => {
        if (err) return;
        games.forEach(game => {
          if (game.status === 'unreleased' && game.release_date) {
            const releaseDate = new Date(game.release_date);
            const today = new Date();
            today.setHours(0,0,0,0);
            releaseDate.setHours(0,0,0,0);
            const diffDays = Math.ceil((releaseDate - today) / (1000 * 60 * 60 * 24));
            
            // Check if game has been released (diffDays <= 0)
            if (diffDays <= 0) {
              console.log(`[MANUAL API] Game "${game.game_name}" has been released! Updating status for user ${username}`);
              
              // Update the game status from unreleased to wishlist
              db.run(
                'UPDATE user_games SET status = ? WHERE user_id = (SELECT id FROM users WHERE username = ?) AND game_id = ?',
                ['wishlist', username, game.game_id],
                function(err) {
                  if (err) {
                    console.error(`[MANUAL API] Failed to update status for game ${game.game_name} (user: ${username}):`, err);
                  } else {
                    console.log(`[MANUAL API] Successfully updated status for game ${game.game_name} (user: ${username})`);
                    updatedGames.push({ username, gameName: game.game_name, gameId: game.game_id });
                    
                    // Send release notification
                    notifyEvent('release', { gameName: game.game_name, coverUrl: game.cover_url }, username, 'wishlist').then(() => {
                      notificationsSent.push({ username, gameName: game.game_name });
                    }).catch(err => {
                      console.error(`[MANUAL API] Failed to send release notification for game ${game.game_name} (user: ${username}):`, err);
                    });
                  }
                }
              );
            }
          }
        });
        
        processedUsers++;
        if (processedUsers === users.length) {
          res.json({ 
            success: true, 
            message: 'Release status check completed',
            updatedGames,
            notificationsSent,
            totalUsers: users.length
          });
        }
      });
    });
  });
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
cron.schedule('0 3 * * 1', async () => { // Every Monday at 3:00 AM
  console.log('[CRON] Starting weekly Steam price update for all user libraries...');
  db.all('SELECT * FROM user_games WHERE steam_app_id IS NOT NULL', [], async (err, games) => {
    if (err) {
      console.error('[CRON] Failed to fetch user games for price update:', err);
      return;
    }
    for (const game of games) {
      try {
        const response = await axios.get('https://store.steampowered.com/api/appdetails', {
          params: {
            appids: game.steam_app_id,
            cc: 'il',
            l: 'en',
          },
        });
        const data = response.data[game.steam_app_id];
        if (data && data.success && data.data && data.data.price_overview) {
          const price = data.data.price_overview.final_formatted;
          db.run('UPDATE user_games SET last_price = ?, last_price_updated = ? WHERE id = ?', [
            price,
            new Date().toISOString(),
            game.id
          ], (err) => {
            if (err) {
              console.error(`[CRON] Failed to update price for game_id ${game.game_id} (user_game id ${game.id}):`, err);
            } else {
              console.log(`[CRON] Updated price for game_id ${game.game_id} (user_game id ${game.id}): ${price}`);
            }
          });
        } else {
          console.log(`[CRON] No price found for Steam app_id ${game.steam_app_id} (game_id ${game.game_id})`);
        }
      } catch (err) {
        console.error(`[CRON] Error fetching price for Steam app_id ${game.steam_app_id} (game_id ${game.game_id}):`, err.message);
      }
    }
    console.log('[CRON] Weekly Steam price update complete.');
  });
});

// Only bind a port when run directly (`node index.js`). The utility scripts
// `require('./index.js')` for its exports — which used to start a second HTTP
// listener and register all the cron jobs as a side effect of the import, so
// `node run_notifications.js` left a server running and never exited.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export functions for manual scripts
module.exports = {
  app,
  db,
  getAllUsers,
  getUserGames,
  wasNotificationSent,
  markNotificationSent,
  sendReleaseReminder,
  notifyEvent
};