const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');

const DBSOURCE = 'gametracker.db';
const db = new sqlite3.Database(DBSOURCE);

async function updateAllLibraryPrices() {
  console.log('[SCRIPT] Starting manual Steam price update for all user libraries...');
  db.all('SELECT * FROM user_games WHERE steam_app_id IS NOT NULL', [], async (err, games) => {
    if (err) {
      console.error('[SCRIPT] Failed to fetch user games for price update:', err);
      process.exit(1);
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
              console.error(`[SCRIPT] Failed to update price for game_id ${game.game_id} (user_game id ${game.id}):`, err);
            } else {
              console.log(`[SCRIPT] Updated price for game_id ${game.game_id} (user_game id ${game.id}): ${price}`);
            }
          });
        } else {
          console.log(`[SCRIPT] No price found for Steam app_id ${game.steam_app_id} (game_id ${game.game_id})`);
        }
      } catch (err) {
        console.error(`[SCRIPT] Error fetching price for Steam app_id ${game.steam_app_id} (game_id ${game.game_id}):`, err.message);
      }
    }
    console.log('[SCRIPT] Manual Steam price update complete.');
    db.close();
  });
}

updateAllLibraryPrices(); 