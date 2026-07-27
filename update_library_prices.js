/**
 * Manually run the Steam price update for every library game that has a Steam App ID.
 *
 * The on-demand equivalent of the Monday 03:00 cron — literally, now: both call
 * services/jobs.js#updatePrices. This used to be a second implementation carrying a
 * comment asking whoever touched it to "keep the two in step", and by the time the
 * jobs service was extracted they had already drifted on three things: the request
 * timeout (15s here, 10s in the cron), whether redirects were followed, and whether
 * STEAM_REGION was honoured at all — the cron ignored it and always used 'il'.
 *
 * The awaited-write lesson this file used to document at length now lives in
 * services/jobs.js#updatePrices, where it protects both callers instead of one:
 * pool.end() abandons queries still waiting for a connection WITHOUT invoking their
 * callbacks, so a fire-and-forget UPDATE followed by db.close() silently loses rows.
 *
 * Run inside the backend container so the PG* variables are the same ones the
 * application uses:
 *
 *   docker compose -f docker-compose.yaml exec backend node update_library_prices.js
 */
const db = require('./db');
const jobs = require('./services/jobs');

// Steam's storefront region. Prices are formatted in that region's currency.
const REGION = process.env.STEAM_REGION || 'il';

console.log('[SCRIPT] Starting manual Steam price update for all user libraries...');

jobs.updatePrices({ region: REGION })
  .then((report) => {
    console.log(`[SCRIPT] Manual Steam price update complete. ${report.updated} updated, `
      + `${report.withoutPrice} without a price, ${report.errors} failed `
      + `(${report.checked} checked).`);

    // Every single lookup failing is a systemic problem — no egress, Steam blocking
    // the region, the whole store down — not a run that happened to find no prices.
    // Say so in the exit code, so an operator running this from a shell or a wrapper
    // does not read a silent 0 as success.
    if (report.checked > 0 && report.errors === report.checked) {
      console.error('[SCRIPT] Every lookup failed. Check outbound network access to store.steampowered.com.');
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('[SCRIPT] Price update failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
