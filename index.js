const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const DBSOURCE = 'gametracker.db';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const fs = require('fs');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const ldap = require('ldapjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple rate limiting for login attempts
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

app.use(cors());
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
    console.error('Could not connect to database', err);
  } else {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      can_manage_users INTEGER DEFAULT 0,
      email TEXT,
      ntfy_topic TEXT,
      created_at TEXT,
      origin TEXT DEFAULT 'local',
      display_name TEXT,
      shares_library INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS user_games (
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
      UNIQUE(user_id, game_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
    // Add columns if missing (for migrations)
    db.run(`ALTER TABLE users ADD COLUMN origin TEXT DEFAULT 'local'`, () => {});
    db.run(`ALTER TABLE users ADD COLUMN display_name TEXT`, () => {});
    db.run(`ALTER TABLE user_games ADD COLUMN steam_app_id TEXT`, () => {});
    db.run(`ALTER TABLE user_games ADD COLUMN last_price TEXT`, () => {});
    db.run(`ALTER TABLE user_games ADD COLUMN last_price_updated TEXT`, () => {});
    console.log('Database initialized');
  }
});

// Ensure root user exists
const ensureRootUser = async () => {
  db.get('SELECT * FROM users WHERE username = ?', ['root'], async (err, user) => {
    if (!user) {
      const hash = await bcrypt.hash('Qq123456', 10);
      db.run(
        'INSERT INTO users (username, password, can_manage_users, origin, display_name) VALUES (?, ?, 1, ?, ?)',
        ['root', hash, 'local', 'root']
      );
      console.log('Root user created.');
    }
  });
};
ensureRootUser();

// Helper: get or create user
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  // Check database connection
  db.get('SELECT COUNT(*) as count FROM users', [], (err, result) => {
    if (err) {
      console.error('[Health] Database error:', err);
      return res.status(500).json({ 
        status: 'error', 
        message: 'Database connection failed',
        error: err.message 
      });
    }
    
    // Check if root user exists
    db.get('SELECT id, username FROM users WHERE username = ?', ['root'], (err, rootUser) => {
      if (err) {
        console.error('[Health] Error checking root user:', err);
        return res.status(500).json({ 
          status: 'error', 
          message: 'Database error checking root user',
          error: err.message 
        });
      }
      
      res.json({ 
        status: 'ok',
        database: 'connected',
        totalUsers: result.count,
        rootUser: rootUser ? { id: rootUser.id, username: rootUser.username } : null,
        timestamp: new Date().toISOString()
      });
    });
  });
});

// Unified search endpoint: IGDB + RAWG + TheGamesDB
app.get('/api/games/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing search query' });
  }
  try {
    // IGDB request
    const igdbPromise = axios.post(
      'https://api.igdb.com/v4/games',
      `search "${query}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit 10;`,
      {
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          'Authorization': `Bearer ${process.env.IGDB_BEARER_TOKEN}`,
          'Accept': 'application/json',
        },
      }
    ).then(async response => {
      const games = response.data || [];
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
    }).catch(() => []);

    // RAWG request
    const rawgPromise = axios.get(
      'https://api.rawg.io/api/games',
      {
        params: {
          key: process.env.RAWG_API_KEY,
          search: query,
          page_size: 10,
        }
      }
    ).then(async response => {
      const games = response.data.results || [];
      // For each game, fetch detailed info to get Steam App ID
      const detailedGames = await Promise.all(games.map(async (game) => {
        let steamAppId = null;
        try {
          const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
            params: { key: process.env.RAWG_API_KEY }
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
    }).catch(() => []);

    // TheGamesDB request (optional - only if API key is configured)
    const thegamesdbPromise = process.env.THEGAMESDB_API_KEY
      ? axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
          params: {
            apikey: process.env.THEGAMESDB_API_KEY,
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
        }).catch(() => [])
      : Promise.resolve([]);

    // Wait for all three
    const [igdbResults, rawgResults, thegamesdbResults] = await Promise.all([igdbPromise, rawgPromise, thegamesdbPromise]);

    // Merge and deduplicate by name (case-insensitive)
    const seen = new Set();
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
      // If game didn't provide a releaseDate, try to find one from other sources
      if (!game.releaseDate) {
        const dateMatch = [...igdbResults, ...rawgResults, ...thegamesdbResults].find(otherGame => 
          otherGame.name.toLowerCase() === game.name.toLowerCase() && otherGame.releaseDate
        );
        if (dateMatch) {
          return { ...game, releaseDate: dateMatch.releaseDate };
        }
      }
      return game;
    }).filter(game => {
      const key = game.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(merged);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch games from providers', details: error.message });
  }
});

// Remove the in-memory cache for Steam prices
app.get('/api/game-price/:steamAppId', async (req, res) => {
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
const SETTINGS_FILE = 'settings.json';
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { smtp: {}, ntfy: {}, ldap: {} };
  }
}
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { flag: 'w' });
    console.log('settings.json created/updated.');
  } catch (err) {
    console.error('Failed to write settings.json:', err);
  }
}

// --- Notification Functions ---
async function sendEmail(subject, text, toOverride) {
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

  const finalRecipient = toOverride || smtp.to || process.env.DEFAULT_EMAIL;
  if (!finalRecipient) {
    console.log('[Email] No recipient email found, skipping email send');
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
  try {
    const result = await transporter.sendMail({
      from: smtp.from,
      to: finalRecipient,
      subject,
      text,
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

async function sendNtfy(title, message, topicOverride) {
  const { ntfy } = loadSettings();
  if (!ntfy.url || !ntfy.topic) return;
  await axios.post(`${ntfy.url.replace(/\/$/, '')}/${topicOverride || (ntfy && ntfy.topic) || process.env.DEFAULT_NTFY_TOPIC}`, message, {
    headers: { Title: title },
  });
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
    
    const client = ldap.createClient({ url: ldapSettings.url });
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed for email lookup:', err);
        client.unbind();
        resolve(null);
        return;
      }
      
      const searchOptions = {
        filter: `(sAMAccountName=${normalizedUsername})`,
        scope: 'sub',
        attributes: ['mail', 'email']
      };
      
      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search failed for email lookup:', err);
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
          client.unbind();
          resolve(foundEmail);
        });
        
        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during email lookup:', err);
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
    db.get('SELECT email, ntfy_topic FROM users WHERE username = ?', [normalizedUsername], (err, userRow) => {
      if (err) {
        reject(err);
      } else {
        resolve(userRow);
      }
    });
  });
  
  let userEmail = userDetails && userDetails.email;
  const userNtfy = userDetails && userDetails.ntfy_topic;
  
  // If no email in database, try LDAP
  if (!userEmail) {
    console.log('No email found in database for user:', normalizedUsername, 'trying LDAP...');
    try {
      userEmail = await getLdapEmail(normalizedUsername);
      if (userEmail) {
        console.log('Found email from LDAP:', userEmail);
        // Update the database with the LDAP email
        db.run('UPDATE users SET email = ? WHERE username = ?', [userEmail, normalizedUsername]);
      }
    } catch (ldapErr) {
      console.error('Error getting email from LDAP:', ldapErr);
    }
  }
  
  // Try to send email
  if (userEmail) {
    try {
      console.log('Attempting to send email to:', userEmail);
      await sendEmail(subject, text, userEmail);
      console.log('Email sent successfully');
    } catch (emailErr) {
      console.error('Error sending email:', emailErr);
    }
  }
  
  // Try to send ntfy - use user's personal topic or fall back to global
  const settings = loadSettings();
  const ntfyTopic = userNtfy || settings.ntfy?.topic;
  
  if (ntfyTopic) {
    try {
      await sendNtfy(title, message, ntfyTopic);
      console.log(`[Notify Event] Ntfy sent successfully to topic ${ntfyTopic} for user ${normalizedUsername}`);
    } catch (ntfyErr) {
      console.error(`[Notify Event] Error sending ntfy for user ${normalizedUsername}:`, ntfyErr);
    }
  } else {
    console.log(`[Notify Event] No ntfy topic configured (neither user-specific nor global) for user ${normalizedUsername}`);
  }
}

// --- Settings API ---
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});
app.post('/api/settings', express.json(), (req, res) => {
  console.log('POST /api/settings called');
  console.log('Received settings:', req.body);
  try {
    saveSettings(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/settings:', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// --- Add/update a game status for a user (with notification) ---
app.post('/api/user/:username/games', async (req, res) => {
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
  // If no releaseDate, always set status to 'unreleased'
  if (!releaseDate) {
    console.log(`[DEBUG] No release date provided, setting status to 'unreleased'`);
    status = 'unreleased';
  }
  getOrCreateUser(normalizedUsername, async (err, user) => {
    if (err) {
      console.log(`[DEBUG] Error getting/creating user:`, err);
      return res.status(500).json({ error: 'DB error' });
    }
    console.log(`[DEBUG] User found/created:`, { userId: user.id, username: user.username });
    
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
        if (row.status === 'unreleased' && status !== 'unreleased' && releaseDate && new Date(releaseDate) <= new Date()) {
          await notifyEvent('release', { gameName }, normalizedUsername, status);
        }
      } else {
        console.log(`[DEBUG] New game being added`);
      }
      
      db.run(
        `INSERT INTO user_games (user_id, game_id, game_name, cover_url, release_date, status, steam_app_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, game_id) DO UPDATE SET status=excluded.status, steam_app_id=excluded.steam_app_id`,
        [user.id, gameId, gameName, coverUrl, releaseDate, status, steamAppId],
        async function (err) {
          if (err) {
            console.log(`[DEBUG] Error updating game:`, err);
            return res.status(500).json({ error: 'DB error' });
          }
          
          // Add debug logging after update
          console.log(`[DEBUG] Status updated successfully for user ${normalizedUsername}, game ${gameId} to status: ${status}`);
          console.log(`[DEBUG] Rows affected: ${this.changes}, Last ID: ${this.lastID}`);
          
          await notifyEvent(eventType, { gameName }, normalizedUsername, status);
          res.json({ success: true });
        }
      );
    });
  });
});

// Debug endpoint to check game status
app.get('/api/debug/user/:username/game/:gameId', (req, res) => {
  const { username, gameId } = req.params;
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  console.log(`[DEBUG] Debug request for user ${username}, game ${gameId}`);
  
  getOrCreateUser(normalizedUsername, (err, user) => {
    if (err) {
      console.log(`[DEBUG] Error getting user:`, err);
      return res.status(500).json({ error: 'DB error' });
    }
    
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
    SELECT game_id, game_name, release_date, status 
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
app.get('/api/user/:username/games', (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  console.log(`[DEBUG] GET /api/user/${username}/games requested`);
  console.log(`[DEBUG] Original username: ${username}, Normalized: ${normalizedUsername}`);
  
  getOrCreateUser(normalizedUsername, (err, user) => {
    if (err) {
      console.log(`[DEBUG] Error getting user:`, err);
      return res.status(500).json({ error: 'DB error' });
    }
    
    console.log(`[DEBUG] User found:`, { userId: user.id, username: user.username });
    
    db.all('SELECT * FROM user_games WHERE user_id = ?', [user.id], (err, rows) => {
      if (err) {
        console.log(`[DEBUG] Error querying games:`, err);
        return res.status(500).json({ error: 'DB error' });
      }
      
      // Add debug logging
      console.log(`[DEBUG] GET /api/user/${normalizedUsername}/games - Found ${rows.length} games`);
      if (rows.length > 0) {
        console.log(`[DEBUG] Sample game data:`, {
          game_id: rows[0].game_id,
          game_name: rows[0].game_name,
          status: rows[0].status,
          release_date: rows[0].release_date,
          user_id: rows[0].user_id
        });
        
        // Log all games with their statuses
        rows.forEach((game, index) => {
          console.log(`[DEBUG] Game ${index + 1}:`, {
            game_id: game.game_id,
            game_name: game.game_name,
            status: game.status,
            user_id: game.user_id
          });
        });
      }
      
      // Ensure steamAppId is included in the response
      const mapped = rows.map(row => ({
        ...row,
        steamAppId: row.steam_app_id || null
      }));
      
      console.log(`[DEBUG] Sending response with ${mapped.length} games`);
      res.json(mapped);
    });
  });
});

// Remove a game from a user's list
app.delete('/api/user/:username/games/:gameId', (req, res) => {
  const { username, gameId } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!normalizedUsername || !gameId) {
    return res.status(400).json({ error: 'Missing username or gameId' });
  }
  getOrCreateUser(normalizedUsername, (err, user) => {
    if (err) return res.status(500).json({ error: 'DB error' });
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

// Refresh metadata for all games in a user's library
app.post('/api/user/:username/refresh-metadata', async (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  
  if (!normalizedUsername) {
    return res.status(400).json({ error: 'Missing username' });
  }

  getOrCreateUser(normalizedUsername, async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'DB error' });
    }

    // Get all games for the user
    db.all('SELECT * FROM user_games WHERE user_id = ?', [user.id], async (err, userGames) => {
      if (err) {
        return res.status(500).json({ error: 'DB error' });
      }

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
          
          // IGDB request
          const igdbPromise = axios.post(
            'https://api.igdb.com/v4/games',
            `search "${query}"; fields id,name,first_release_date,cover.image_id,external_games.category,external_games.uid; limit 10;`,
            {
              headers: {
                'Client-ID': process.env.IGDB_CLIENT_ID,
                'Authorization': `Bearer ${process.env.IGDB_BEARER_TOKEN}`,
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
                key: process.env.RAWG_API_KEY,
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
                  params: { key: process.env.RAWG_API_KEY }
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
          const thegamesdbPromise = process.env.THEGAMESDB_API_KEY
            ? axios.get('https://api.thegamesdb.net/v1/Games/ByGameName', {
                params: {
                  apikey: process.env.THEGAMESDB_API_KEY,
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
          const seen = new Set();
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
            // If game didn't provide a releaseDate, try to find one from other sources
            if (!g.releaseDate) {
              const dateMatch = [...igdbResults, ...rawgResults, ...thegamesdbResults].find(otherGame => 
                otherGame.name.toLowerCase() === g.name.toLowerCase() && otherGame.releaseDate
              );
              if (dateMatch) {
                return { ...g, releaseDate: dateMatch.releaseDate };
              }
            }
            return g;
          }).filter(g => {
            const key = g.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          // Find the best match (exact name match, case-insensitive)
          const match = merged.find(g => g.name.toLowerCase() === game.game_name.toLowerCase());
          
          if (match) {
            let updated = false;
            const updates = [];
            const params = [];

            // Check release date
            if (match.releaseDate !== game.release_date) {
              updates.push('release_date = ?');
              params.push(match.releaseDate);
              updated = true;
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
    });
  });
});

// --- Auth Middleware ---
function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !req.user[permission]) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// --- Helper Functions ---

// Track failed login attempts for rate limiting
function trackFailedAttempt(clientIP) {
  const now = Date.now();
  const attempts = loginAttempts.get(clientIP) || { count: 0, firstAttempt: now };
  attempts.count++;
  if (attempts.count === 1) {
    attempts.firstAttempt = now;
  }
  loginAttempts.set(clientIP, attempts);
  console.log(`[Auth] Failed login attempt from IP ${clientIP}. Total attempts: ${attempts.count}`);
}

// --- Auth Endpoints ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Server-side validation to ensure both fields are provided and not empty
  if (!username || !password || !username.trim() || !password.trim()) {
    console.log('[Auth] Login attempt with missing or empty credentials from IP:', clientIP);
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  // Check rate limiting
  const now = Date.now();
  const attempts = loginAttempts.get(clientIP) || { count: 0, firstAttempt: now };
  
  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    const timeSinceFirst = now - attempts.firstAttempt;
    if (timeSinceFirst < LOCKOUT_DURATION) {
      const remainingTime = Math.ceil((LOCKOUT_DURATION - timeSinceFirst) / 1000 / 60);
      console.log(`[Auth] IP ${clientIP} is rate limited. Remaining lockout time: ${remainingTime} minutes`);
      return res.status(429).json({ 
        error: `Too many login attempts. Please try again in ${remainingTime} minutes.` 
      });
    } else {
      // Reset after lockout duration
      loginAttempts.delete(clientIP);
    }
  }
  
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username.toLowerCase();
  const settings = loadSettings();
  const ldapSettings = settings.ldap || {};

  function fallbackLocalAuth() {
    console.log('[Auth] Using fallback local authentication for user:', normalizedUsername);
    db.get('SELECT * FROM users WHERE username = ?', [normalizedUsername], async (err, user) => {
      if (err) {
        console.error('[Auth] Database error during user lookup:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (!user) {
        console.log('[Auth] Local user not found:', normalizedUsername);
        // Track failed attempt
        trackFailedAttempt(clientIP);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      console.log('[Auth] Found user in database:', { id: user.id, username: user.username });
      try {
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
          console.log('[Auth] Local password validation failed for user:', normalizedUsername);
          // Track failed attempt
          trackFailedAttempt(clientIP);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        console.log('[Auth] Password validation successful for user:', normalizedUsername);
        // Clear failed attempts on successful login
        loginAttempts.delete(clientIP);
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
    const client = ldap.createClient({ url: ldapSettings.url });

    // 1. Bind as service account
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed:', err);
        client.unbind();
        return fallbackLocalAuth();
      }
      console.log('[LDAP] Service account bind succeeded.');

      // 2. Search for the user by sAMAccountName
      const searchOptions = {
        filter: `(sAMAccountName=${normalizedUsername})`,
        scope: 'sub',
        attributes: ['dn', 'memberOf', 'displayName', 'cn', 'mail', 'email']
      };
      console.log(`[LDAP] Searching for user with filter: ${searchOptions.filter}`);

      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search initiation failed:', err);
          client.unbind();
          return fallbackLocalAuth();
        }

        let foundUser = null;
        searchRes.on('searchEntry', (entry) => {
          console.log('[LDAP] Raw search entry received:', entry.toString());

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
          console.log('[LDAP] Successfully parsed user object:', JSON.stringify(foundUser, null, 2));
        });

        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during processing:', err.message);
          client.unbind();
          return fallbackLocalAuth();
        });

        searchRes.on('end', (result) => {
          console.log('[LDAP] Search finished. Result status:', result ? result.status : 'N/A');
          if (!foundUser) {
            console.log('[LDAP] User object was not populated from search. This could be a permissions issue or the user truly does not exist in the search base.');
            client.unbind();
            return fallbackLocalAuth();
          }

          const userDn = foundUser.dn;
          console.log(`[LDAP] Found user's correct DN: ${userDn}`);

          // 3. Authenticate as the found user (verifies their password)
          client.bind(userDn, password, (err) => {
            if (err) {
              console.log('[LDAP] User password authentication failed:', err);
              client.unbind();
              // Track failed attempt
              trackFailedAttempt(clientIP);
              return fallbackLocalAuth(); // Incorrect password for this user
            }
            console.log('[LDAP] User password authentication succeeded.');
            // Clear failed attempts on successful login
            loginAttempts.delete(clientIP);

            // 4. Check group membership (Authorization)
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
                    client.unbind();
                    return res.status(403).json({ error: 'Not a member of the required group' });
                }
                console.log('[LDAP] Authorization passed: Group membership check OK.');
            }

            // 5. User is authenticated and authorized, create token.
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
              if (err) return res.status(500).json({ error: 'DB error' });
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
// Create user (admin only)
app.post('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { username, password, can_manage_users = 0, email = '', ntfy_topic = '', shares_library = 0 } = req.body;
  
  // Enhanced validation
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }
  
  if (!username.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Username and password cannot be empty' });
  }
  
  // Password strength requirements
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username.toLowerCase();
  bcrypt.hash(password, 10).then(hash => {
    db.run(
      'INSERT INTO users (username, password, can_manage_users, email, ntfy_topic, created_at, origin, display_name, shares_library) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [normalizedUsername, hash, can_manage_users ? 1 : 0, email, ntfy_topic, new Date().toISOString(), 'local', normalizedUsername, shares_library ? 1 : 0],
      function (err) {
        if (err) return res.status(400).json({ error: 'User already exists' });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

// List users (manager only)
app.get('/api/users', authRequired, requirePermission('can_manage_users'), (req, res) => {
  db.all('SELECT id, username, can_manage_users, email, ntfy_topic, created_at, origin, display_name, shares_library FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

// Edit user (manager only)
app.put('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { id } = req.params;
  const { password, can_manage_users, email, ntfy_topic, shares_library } = req.body;
  const updates = [];
  const params = [];
  if (typeof can_manage_users !== 'undefined') {
    updates.push('can_manage_users = ?');
    params.push(can_manage_users ? 1 : 0);
  }
  if (typeof email !== 'undefined') {
    updates.push('email = ?');
    params.push(email);
  }
  if (typeof ntfy_topic !== 'undefined') {
    updates.push('ntfy_topic = ?');
    params.push(ntfy_topic);
  }
  if (typeof shares_library !== 'undefined') {
    updates.push('shares_library = ?');
    params.push(shares_library ? 1 : 0);
  }
  if (password) {
    // Password strength validation
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    
    bcrypt.hash(password, 10).then(hash => {
      updates.push('password = ?');
      params.push(hash);
      params.push(id);
      db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
      });
    });
  } else {
    params.push(id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
    });
  }
});

// Delete user (manager only)
app.delete('/api/users/:id', authRequired, requirePermission('can_manage_users'), (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM users WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true });
  });
});

// --- Test Notification endpoint for admins ---
app.post('/api/admin/test-notification', authRequired, requirePermission('can_manage_users'), async (req, res) => {
  try {
    const settings = loadSettings();
    const { service, gameId, gameName, releaseDate } = req.body;
    
    if (!service || !gameId || !gameName) {
      return res.status(400).json({ error: 'Missing required parameters: service, gameId, gameName' });
    }
    
    if (!['email', 'ntfy', 'both'].includes(service)) {
      return res.status(400).json({ error: 'Invalid service. Must be email, ntfy, or both' });
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
      ntfy: { sent: false, error: null }
    };
    
    // Get current user's email and ntfy topic
    const userId = req.user.id;
    const userDetails = await new Promise((resolve, reject) => {
      db.get('SELECT email, ntfy_topic FROM users WHERE id = ?', [userId], (err, userRow) => {
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
          await sendEmail(subject, text, userDetails.email);
          results.email.sent = true;
          console.log(`[Test Notification] Email sent successfully to ${userDetails.email}`);
        } catch (error) {
          results.email.error = error.message;
          console.error(`[Test Notification] Email failed:`, error.message);
        }
      } else {
        results.email.error = 'No email configured for current user';
      }
    }
    
    // Send ntfy notification if requested
    if (service === 'ntfy' || service === 'both') {
      // Try user's personal ntfy topic first, then fall back to global settings
      const ntfyTopic = userDetails?.ntfy_topic || settings.ntfy?.topic;
      
      if (ntfyTopic) {
        try {
          await sendNtfy(title, message, ntfyTopic);
          results.ntfy.sent = true;
          console.log(`[Test Notification] Ntfy sent successfully to topic ${ntfyTopic}`);
        } catch (error) {
          results.ntfy.error = error.message;
          console.error(`[Test Notification] Ntfy failed:`, error.message);
        }
      } else {
        results.ntfy.error = 'No ntfy topic configured (neither user-specific nor global)';
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
        
        try {
          const client = ldap.createClient({ url: ldapSettings.url });
          
          // Bind to LDAP
          await new Promise((resolve, reject) => {
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

          // Search for user in LDAP using sAMAccountName
          const searchOptions = {
            filter: `(sAMAccountName=${user.username})`,
            scope: 'sub',
            attributes: ['displayName', 'mail', 'sAMAccountName']
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

          client.unbind();

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

// --- Per-user settings endpoint ---
// Authenticated user can update their own email/ntfy_topic
app.put('/api/user/me/settings', authRequired, (req, res) => {
  const userId = req.user.id;
  const { email, ntfy_topic } = req.body;
  const updates = [];
  const params = [];
  if (typeof email !== 'undefined') {
    updates.push('email = ?');
    params.push(email);
  }
  if (typeof ntfy_topic !== 'undefined') {
    updates.push('ntfy_topic = ?');
    params.push(ntfy_topic);
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
let sentNotifications = {};
if (fs.existsSync(SENT_NOTIFICATIONS_FILE)) {
  try {
    sentNotifications = JSON.parse(fs.readFileSync(SENT_NOTIFICATIONS_FILE, 'utf8'));
  } catch {
    sentNotifications = {};
  }
}
function markNotificationSent(username, gameId, type) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  if (!sentNotifications[normalizedUsername]) sentNotifications[normalizedUsername] = {};
  if (!sentNotifications[normalizedUsername][gameId]) sentNotifications[normalizedUsername][gameId] = {};
  sentNotifications[normalizedUsername][gameId][type] = new Date().toISOString();
  fs.writeFileSync(SENT_NOTIFICATIONS_FILE, JSON.stringify(sentNotifications, null, 2));
}
function wasNotificationSent(username, gameId, type) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  return sentNotifications[normalizedUsername] && sentNotifications[normalizedUsername][gameId] && sentNotifications[normalizedUsername][gameId][type];
}
function getAllUsers(cb) {
  db.all('SELECT username FROM users', [], (err, rows) => {
    if (err) return cb(err);
    cb(null, rows.map(r => r.username));
  });
}
function getUserGames(username, cb) {
  getOrCreateUser(username, (err, user) => {
    if (err) return cb(err);
    db.all('SELECT * FROM user_games WHERE user_id = ?', [user.id], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows);
    });
  });
}
async function sendReleaseReminder(username, game, days) {
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  let when = days === 0 ? 'today' : `in ${days} days`;
  let subject = `Reminder: "${game.game_name}" releases ${when}!`;
  let text = `The game "${game.game_name}" you are following releases ${when} (${game.release_date}).`;
  let title = 'Game Release Reminder';
  let message = text;
  
  // Get user's email from database or LDAP
  const userEmail = await getUserEmail(normalizedUsername);
  if (userEmail) {
    await sendEmail(subject, text, userEmail);
  }
  
  // Get user's ntfy topic and send notification
  const userNtfy = await new Promise((resolve) => {
    db.get('SELECT ntfy_topic FROM users WHERE username = ?', [normalizedUsername], (err, userRow) => {
      if (err || !userRow) {
        resolve(undefined);
      } else {
        resolve(userRow.ntfy_topic);
      }
    });
  });
  
  // Try user's personal ntfy topic first, then fall back to global settings
  const settings = loadSettings();
  const ntfyTopic = userNtfy || settings.ntfy?.topic;
  
  if (ntfyTopic) {
    try {
      await sendNtfy(title, message, ntfyTopic);
      console.log(`[Release Reminder] Ntfy sent successfully to topic ${ntfyTopic} for user ${normalizedUsername}`);
    } catch (error) {
      console.error(`[Release Reminder] Ntfy failed for user ${normalizedUsername}:`, error.message);
    }
  } else {
    console.log(`[Release Reminder] No ntfy topic configured (neither user-specific nor global) for user ${normalizedUsername}`);
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
            console.log(`[CRON] User: ${username}, Game: ${game.game_name}, Release: ${game.release_date}, diffDays: ${diffDays}`);
            
            // Check if game has been released (diffDays <= 0)
            if (diffDays <= 0) {
              console.log(`[CRON] Game "${game.game_name}" has been released! Updating status from unreleased to wishlist for user ${username}`);
              
              // Update the game status from unreleased to wishlist
              db.run(
                'UPDATE user_games SET status = ? WHERE user_id = (SELECT id FROM users WHERE username = ?) AND game_id = ?',
                ['wishlist', username.toLowerCase(), game.game_id],
                function(err) {
                  if (err) {
                    console.error(`[CRON] Failed to update status for game ${game.game_name} (user: ${username}):`, err);
                  } else {
                    console.log(`[CRON] Successfully updated status for game ${game.game_name} (user: ${username}) from unreleased to wishlist`);
                    // Send release notification
                    notifyEvent('release', { gameName: game.game_name }, username, 'wishlist').catch(err => {
                      console.error(`[CRON] Failed to send release notification for game ${game.game_name} (user: ${username}):`, err);
                    });
                  }
                }
              );
              found = true;
            } else {
              // Handle pre-release notifications (30 days, 7 days, release day)
              let type = null;
              if (diffDays === 30) type = '30days';
              if (diffDays === 7) type = '7days';
              if (diffDays === 0) type = 'release';
              if (type && !wasNotificationSent(username, game.game_id, type)) {
                console.log(`[CRON] Sending ${type} reminder to ${username} for game ${game.game_name}`);
                sendReleaseReminder(username, game, diffDays).then(() => {
                  markNotificationSent(username, game.game_id, type);
                  console.log(`Sent ${type} release reminder to ${username} for game ${game.game_name}`);
                }).catch(err => {
                  console.error(`Failed to send ${type} reminder to ${username} for game ${game.game_name}:`, err);
                });
                found = true;
              } else if (type && wasNotificationSent(username, game.game_id, type)) {
                console.log(`[CRON] Notification already sent for ${username}, game ${game.game_name}, type ${type}`);
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

// --- Per-user Library Sharing (persistent) ---
const ensureUserShareTable = () => {
  db.run(`CREATE TABLE IF NOT EXISTS user_shares (
    from_user TEXT,
    to_user TEXT,
    shared_at TEXT,
    PRIMARY KEY (from_user, to_user),
    FOREIGN KEY (from_user) REFERENCES users(username),
    FOREIGN KEY (to_user) REFERENCES users(username)
  )`);
};
ensureUserShareTable();

// Share a user's list with one or more users
app.post('/api/user/:username/share', authRequired, (req, res) => {
  const { username } = req.params;
  // Normalize username to lowercase to prevent case sensitivity issues
  const normalizedUsername = username ? username.toLowerCase() : '';
  const { toUsers } = req.body;
  if (req.user.username !== normalizedUsername) return res.status(403).json({ error: 'You can only share your own library.' });
  if (!Array.isArray(toUsers)) return res.status(400).json({ error: 'No users to share with.' });
  // Remove all existing shares for this user
  db.run('DELETE FROM user_shares WHERE from_user = ?', [normalizedUsername], (err) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    // Add new shares
    if (toUsers.length === 0) return res.json({ success: true });
    const now = new Date().toISOString();
    const stmt = db.prepare('INSERT OR IGNORE INTO user_shares (from_user, to_user, shared_at) VALUES (?, ?, ?)');
    toUsers.forEach(toUser => {
      stmt.run(normalizedUsername, toUser, now);
    });
    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
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
app.post('/api/admin/check-releases', authRequired, requirePermission('manage_users'), (req, res) => {
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
                    notifyEvent('release', { gameName: game.game_name }, username, 'wishlist').then(() => {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Export functions for manual scripts
module.exports = {
  db,
  getAllUsers,
  getUserGames,
  wasNotificationSent,
  markNotificationSent,
  sendReleaseReminder,
  notifyEvent
};