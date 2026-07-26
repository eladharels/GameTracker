/**
 * Populate steam_app_id for library entries that do not have one, by looking the
 * game up in RAWG and then IGDB.
 *
 * Run inside the backend container so the PG* variables and API keys are the same
 * ones the application uses:
 *
 *   docker compose -f docker-compose.yaml exec backend node backfill_steam_app_ids.js
 *
 * Add --dry-run to print what would be written without writing anything.
 */
const axios = require('axios');
require('dotenv').config();
const db = require('./db');

const DRY_RUN = process.argv.includes('--dry-run');

const RAWG_API_KEY = process.env.RAWG_API_KEY;
const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
const IGDB_BEARER_TOKEN = process.env.IGDB_BEARER_TOKEN;

async function getSteamAppIdFromRAWG(gameName) {
  if (!RAWG_API_KEY) return null;
  try {
    const searchRes = await axios.get('https://api.rawg.io/api/games', {
      params: { key: RAWG_API_KEY, search: gameName, page_size: 1 },
      timeout: 15000,
    });
    const game = searchRes.data.results && searchRes.data.results[0];
    if (!game) return null;
    const detailRes = await axios.get(`https://api.rawg.io/api/games/${game.id}`, {
      params: { key: RAWG_API_KEY },
      timeout: 15000,
    });
    const stores = detailRes.data.stores || [];
    const steamStore = stores.find(s => s.store && s.store.id === 1 && s.url_en);
    if (steamStore && steamStore.url_en) {
      const match = steamStore.url_en.match(/\/app\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function getSteamAppIdFromIGDB(gameName) {
  if (!IGDB_CLIENT_ID || !IGDB_BEARER_TOKEN) return null;
  try {
    const res = await axios.post(
      'https://api.igdb.com/v4/games',
      // The double quotes around the search term are IGDB's own syntax; a game name
      // containing a `"` would break out of it, so strip them.
      `search "${String(gameName).replace(/"/g, '')}"; fields external_games.category,external_games.uid; limit 1;`,
      {
        headers: {
          'Client-ID': IGDB_CLIENT_ID,
          'Authorization': `Bearer ${IGDB_BEARER_TOKEN}`,
          'Accept': 'application/json',
        },
        timeout: 15000,
      }
    );
    const game = res.data && res.data[0];
    if (!game || !Array.isArray(game.external_games)) return null;
    const steamExternal = game.external_games.find(ext => ext.category === 1 && ext.uid);
    return steamExternal ? String(steamExternal.uid) : null;
  } catch {
    return null;
  }
}

function gamesMissingSteamAppId() {
  return new Promise((resolve, reject) => {
    db.all(
      // `= ''` with SINGLE quotes. The SQLite original wrote `steam_app_id = ""`,
      // which Postgres parses as a zero-length QUOTED IDENTIFIER, not an empty
      // string -- the statement is a hard syntax error there, so this script could
      // not have run at all after the migration.
      "SELECT id, game_id, game_name FROM user_games " +
      "WHERE steam_app_id IS NULL OR steam_app_id = '' ORDER BY id",
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function saveSteamAppId(userGameId, steamAppId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE user_games SET steam_app_id = ? WHERE id = ?',
      [steamAppId, userGameId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function main() {
  if (!RAWG_API_KEY && !(IGDB_CLIENT_ID && IGDB_BEARER_TOKEN)) {
    console.error('[BACKFILL] Neither RAWG nor IGDB credentials are set — there is nothing to look up against.');
    process.exitCode = 1;
    return;
  }

  const games = await gamesMissingSteamAppId();
  console.log(`[BACKFILL] ${games.length} game(s) without a Steam App ID.${DRY_RUN ? ' (dry run)' : ''}`);

  let found = 0;
  let notFound = 0;

  for (const game of games) {
    let steamAppId = await getSteamAppIdFromRAWG(game.game_name);
    if (!steamAppId) steamAppId = await getSteamAppIdFromIGDB(game.game_name);

    if (!steamAppId) {
      notFound++;
      console.log(`[BACKFILL] No match for "${game.game_name}" (user_game ${game.id})`);
      continue;
    }
    if (DRY_RUN) {
      found++;
      console.log(`[BACKFILL] "${game.game_name}" (user_game ${game.id}) -> ${steamAppId} (not written)`);
      continue;
    }
    // AWAITED -- see the measured note in update_library_prices.js. Fire-and-forget
    // writes followed by db.close() silently drop the tail of the run: pool.end()
    // abandons queries still waiting for a connection and never calls their
    // callbacks, so the loss is invisible in the log.
    await saveSteamAppId(game.id, steamAppId);
    found++;
    console.log(`[BACKFILL] "${game.game_name}" (user_game ${game.id}) -> ${steamAppId}`);
  }

  console.log(`[BACKFILL] Complete. ${found} ${DRY_RUN ? 'would be set' : 'set'}, ${notFound} not found.`);
}

main()
  .catch((err) => {
    console.error('[BACKFILL] Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
