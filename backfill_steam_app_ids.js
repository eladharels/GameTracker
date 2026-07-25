// ===========================================================================
// NOT YET PORTED TO POSTGRESQL.
//
// This script still opens the legacy SQLite file, which is no longer the source
// of truth. node-sqlite3 opens with OPEN_CREATE by default, so without this
// guard it would silently CREATE an empty gametracker.db and then cheerfully
// report "no rows found" -- looking like a successful no-op while the real
// database was untouched. Fail loudly instead.
//
// To port: replace the sqlite3 handle with `require('./db')`, which exposes the
// same run/get/all callback surface. See reset-root-password.js for a worked
// example. Remove this guard when done.
// ===========================================================================
if (!process.env.ALLOW_LEGACY_SQLITE_SCRIPT) {
  console.error('[UNPORTED] ' + __filename.split('/').pop() + ' still targets SQLite, which GameTracker no longer uses.');
  console.error('           Porting it to ./db is required before it will do anything useful.');
  console.error('           Set ALLOW_LEGACY_SQLITE_SCRIPT=1 only to run it against an old .db file on purpose.');
  process.exit(1);
}

const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
require('dotenv').config();

const DBSOURCE = 'gametracker.db';
const db = new sqlite3.Database(DBSOURCE);

const RAWG_API_KEY = process.env.RAWG_API_KEY;
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
const IGDB_BEARER_TOKEN = process.env.IGDB_BEARER_TOKEN;

async function getSteamAppIdFromRAWG(gameName) {
  try {
    const searchRes = await axios.get('https://api.rawg.io/api/games', {
      params: {
        key: RAWG_API_KEY,
        search: gameName,
        page_size: 1,
      }
    });
    const game = searchRes.data.results && searchRes.data.results[0];
    if (!game) return null;
    // Get detailed info
    const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
      params: { key: RAWG_API_KEY }
    });
    const stores = detailRes.data.stores || [];
    const steamStore = stores.find(s => s.store && s.store.id === 1 && s.url_en);
    if (steamStore && steamStore.url_en) {
      const match = steamStore.url_en.match(/\/app\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getSteamAppIdFromIGDB(gameName) {
  try {
    const res = await axios.post(
      'https://api.igdb.com/v4/games',
      `search "${gameName}"; fields external_games.category,external_games.uid; limit 1;`,
      {
        headers: {
          'Client-ID': IGDB_CLIENT_ID,
          'Authorization': `Bearer ${IGDB_BEARER_TOKEN}`,
          'Accept': 'application/json',
        },
      }
    );
    const game = res.data && res.data[0];
    if (!game || !Array.isArray(game.external_games)) return null;
    const steamExternal = game.external_games.find(ext => ext.category === 1 && ext.uid);
    if (steamExternal) return steamExternal.uid;
    return null;
  } catch (e) {
    return null;
  }
}

async function backfillSteamAppIds() {
  db.all('SELECT * FROM user_games WHERE steam_app_id IS NULL OR steam_app_id = ""', [], async (err, games) => {
    if (err) {
      console.error('[BACKFILL] Failed to fetch user games:', err);
      process.exit(1);
    }
    for (const game of games) {
      let steamAppId = null;
      // Try RAWG first
      steamAppId = await getSteamAppIdFromRAWG(game.game_name);
      if (!steamAppId) {
        // Try IGDB as fallback
        steamAppId = await getSteamAppIdFromIGDB(game.game_name);
      }
      if (steamAppId) {
        db.run('UPDATE user_games SET steam_app_id = ? WHERE id = ?', [steamAppId, game.id], (err) => {
          if (err) {
            console.error(`[BACKFILL] Failed to update steam_app_id for game_id ${game.game_id} (user_game id ${game.id}):`, err);
          } else {
            console.log(`[BACKFILL] Updated steam_app_id for game_id ${game.game_id} (user_game id ${game.id}): ${steamAppId}`);
          }
        });
      } else {
        console.log(`[BACKFILL] Could not find steam_app_id for game: ${game.game_name} (user_game id ${game.id})`);
      }
    }
    console.log('[BACKFILL] Backfill complete.');
    db.close();
  });
}

backfillSteamAppIds(); 