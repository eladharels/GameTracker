/**
 * Manually run the Steam price update for every library game that has a Steam App ID.
 *
 * This is the on-demand equivalent of the Monday 03:00 cron in index.js
 * (search "[CRON] Starting weekly Steam price update"). Keep the two in step.
 *
 * Run inside the backend container so the PG* variables are the same ones the
 * application uses:
 *
 *   docker compose -f docker-compose.yaml exec backend node update_library_prices.js
 */
const axios = require('axios');
const db = require('./db');

// Steam's storefront region. Prices are formatted in that region's currency.
const REGION = process.env.STEAM_REGION || 'il';

function gamesWithSteamAppId() {
  return new Promise((resolve, reject) => {
    db.all(
      // `<> ''` as well as NOT NULL: an empty steam_app_id can never resolve to a
      // price, and asking Steam for appids= produces a confusing 200-with-no-data.
      "SELECT id, game_id, game_name, steam_app_id FROM user_games " +
      "WHERE steam_app_id IS NOT NULL AND steam_app_id <> '' ORDER BY id",
      [],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function savePrice(userGameId, price) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE user_games SET last_price = ?, last_price_updated = ? WHERE id = ?',
      [price, new Date().toISOString(), userGameId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function main() {
  console.log('[SCRIPT] Starting manual Steam price update for all user libraries...');
  const games = await gamesWithSteamAppId();
  console.log(`[SCRIPT] ${games.length} game(s) with a Steam App ID.`);

  let updated = 0;
  let noPrice = 0;
  let failed = 0;

  for (const game of games) {
    try {
      const response = await axios.get('https://store.steampowered.com/api/appdetails', {
        params: { appids: game.steam_app_id, cc: REGION, l: 'en' },
        timeout: 15000,
      });
      const data = response.data[game.steam_app_id];
      if (data && data.success && data.data && data.data.price_overview) {
        const price = data.data.price_overview.final_formatted;
        // AWAITED, and that matters. The old version fired the update and moved on,
        // then called db.close() once the loop ended. pool.end() drains queries that
        // already hold a connection but abandons anything still waiting for one --
        // and the abandoned callbacks are never invoked, so nothing is logged and
        // nothing throws.
        //
        // Measured against a 50-row table: the old shape (fire-and-forget write with
        // an awaited HTTP call between iterations) wrote 49 and silently lost the
        // last one, every run. Dispatching all 50 without an await in between lost
        // all 50, with zero error callbacks. SQLite's serialised handle hid this
        // entirely. See db.js divergence #6.
        await savePrice(game.id, price);
        updated++;
        console.log(`[SCRIPT] ${game.game_name} (user_game ${game.id}): ${price}`);
      } else {
        noPrice++;
        console.log(`[SCRIPT] No price for Steam app_id ${game.steam_app_id} (${game.game_name})`);
      }
    } catch (err) {
      failed++;
      console.error(`[SCRIPT] Error for Steam app_id ${game.steam_app_id} (${game.game_name}): ${err.message}`);
    }
  }

  console.log(`[SCRIPT] Manual Steam price update complete. ${updated} updated, ${noPrice} without a price, ${failed} failed.`);

  // Every single lookup failing is a systemic problem -- no egress, Steam blocking
  // the region, the whole store down -- not a run that happened to find no prices.
  // Say so in the exit code, so an operator running this from a shell or a wrapper
  // does not read a silent 0 as success.
  if (games.length > 0 && failed === games.length) {
    console.error('[SCRIPT] Every lookup failed. Check outbound network access to store.steampowered.com.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('[SCRIPT] Price update failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
