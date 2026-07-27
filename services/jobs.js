// The scheduled work: release checks and the weekly Steam price sync.
//
// These are FUNCTIONS, not cron registrations. index.js schedules them and the admin
// routes call the same functions, so "run it now" and "run it at 08:00" cannot drift
// — which they had: the daily cron and POST /api/admin/check-releases carried the
// same release sweep with two differences, one of them a bug (the cron lowercased the
// username in its UPDATE, the admin route did not, so the admin copy silently matched
// nothing for any non-lowercase caller and still reported success).
//
// Every job returns a REPORT rather than logging and forgetting. The admin routes
// serialise it; the cron logs it. Nothing here touches req/res.
//
// NON-THROWING PER ITEM, throwing overall: one user's or one game's failure must not
// abandon the sweep, but a failure to enumerate at all is a real error the caller
// should see.

const axios = require('axios');
const db = require('../db');
const { all } = db.promises;
const library = require('./library');
const notifications = require('./notifications');
const { sanitizeText } = require('../user-rules');

const safe = (v, n = 80) => sanitizeText(v, n);

// Steam's store API is a third party on the public internet and had NO timeout: the
// weekly sweep walks every game with a Steam App ID, so one hung request stalled the
// entire run indefinitely. Same defect the catalog providers had.
const STEAM_TIMEOUT_MS = 10000;

// --- Release checks --------------------------------------------------------

// Users who have at least one unreleased game with a date, and their reminder
// schedule — one query instead of the previous "list all users, then per user query
// their preferences, then query their games", which was three round trips per user
// and enumerated accounts with nothing to check.
async function usersWithPendingReleases() {
  return all(
    `SELECT u.username, u.notification_days
       FROM users u
      WHERE EXISTS (
        SELECT 1 FROM user_games g
         WHERE g.user_id = u.id AND g.status = 'unreleased' AND g.release_date IS NOT NULL
      )
      ORDER BY u.username ASC`,
    []
  );
}

// A user's reminder thresholds. Defaults to 0/7/30, matching the legacy behaviour;
// malformed JSON in the column falls back rather than throwing the sweep away.
function reminderDays(raw) {
  if (!raw) return [0, 7, 30];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d) => Number.isInteger(d)) : [0, 7, 30];
  } catch {
    return [0, 7, 30];
  }
}

// Opting out of deduplication has to be a WRITTEN decision, not an omission.
//
// checkReleases() with no argument used to disable dedup silently: optional chaining
// meant wasSent was never consulted, so every run re-sent every due reminder to real
// users, with no error and no warning. The natural call a v2 adapter author writes is
// exactly that one. This is the "decided by omission" pattern CLAUDE.md describes for
// route authorization, applied to push notifications.
const NO_DEDUPE = Symbol('send reminders without consulting the sent log');

// Promote everything that has come out, and send each user's due reminders.
//
// `dedupe` is the sent-notifications log — `{ wasSent, markSent }` — injected because
// it is file-backed state owned by the server process. Pass NO_DEDUPE to run without
// it deliberately.
async function checkReleases({ dedupe } = {}) {
  if (!dedupe) {
    throw new Error('checkReleases requires a dedupe log ({wasSent, markSent}), '
      + 'or jobs.NO_DEDUPE to run without one deliberately — omitting it re-sends '
      + 'every due reminder on every run.');
  }
  const log = dedupe === NO_DEDUPE ? null : dedupe;
  const report = { usersChecked: 0, promoted: [], remindersSent: [], errors: [] };
  const users = await usersWithPendingReleases();

  for (const user of users) {
    report.usersChecked++;
    const days = reminderDays(user.notification_days);
    let games;
    try {
      games = await library.listGamesFor(user.username);
    } catch (err) {
      report.errors.push({ username: user.username, error: 'Could not read library' });
      console.error(`[Jobs] Could not read library for ${safe(user.username, 64)}:`, err.message);
      continue;
    }

    for (const game of games) {
      if (game.status !== 'unreleased') continue;
      // null for a date we cannot reason about. The two copies of this used a bare
      // `new Date(...)`, so an unparseable date produced NaN, every comparison below
      // was false, and the row was skipped forever while logging `diffDays: NaN`.
      const diff = library.daysUntilRelease(game.release_date);
      if (diff === null) continue;

      try {
        if (diff <= 0) {
          const { promoted } = await library.promoteReleased(user.username, game.game_id);
          if (!promoted) continue;   // someone else got there first
          report.promoted.push({ username: user.username, gameName: game.game_name, gameId: game.game_id });
          // Non-throwing by contract; the result is advisory.
          await notifications.notifyLibraryEvent(
            library.EVENTS.RELEASED,
            { gameName: game.game_name, coverUrl: game.cover_url },
            user.username, 'wishlist'
          );
          continue;
        }

        if (!days.includes(diff)) continue;
        const type = `${diff}days`;
        if (log?.wasSent(user.username, game.game_id, type)) continue;

        const results = await notifications.notifyReleaseReminder(user.username, game, diff);
        // Mark sent only if a channel ACTUALLY delivered — dispatch no longer rejects
        // on a channel failure, so the retry decision has to be made from the result
        // or a total outage is recorded as delivered and never retried.
        if (notifications.anyDelivered(results)) {
          log?.markSent(user.username, game.game_id, type);
          report.remindersSent.push({ username: user.username, gameName: game.game_name, days: diff });
        } else {
          // Not "will retry": diff decrements daily and is matched against the user's
          // thresholds, so a failed 30-day reminder is not re-attempted at 30 — the
          // next threshold is the next chance.
          console.warn(`[Jobs] No channel delivered the ${type} reminder to `
            + `${safe(user.username, 64)} for ${safe(game.game_name)} — not marking it sent`);
        }
      } catch (err) {
        // Per game: one bad row must not abandon the sweep.
        report.errors.push({ username: user.username, gameName: game.game_name, error: 'Release check failed' });
        console.error(`[Jobs] Release check failed for ${safe(game.game_name)}:`, err.message);
      }
    }
  }
  return report;
}

// --- Steam prices ----------------------------------------------------------

// `<> ''` as well as NOT NULL, matching update_library_prices.js: an empty
// steam_app_id can never resolve to a price, and `appids=` makes Steam answer 200
// with an empty body, which reads in the log like a game that simply has no price.
async function priceableGames() {
  return all(
    "SELECT id, game_id, steam_app_id FROM user_games WHERE steam_app_id IS NOT NULL AND steam_app_id <> '' ORDER BY id",
    []
  );
}

// A formatted price is a short string like "₪59.99". Bounded and type-checked
// because it is third-party text going into a column the SPA renders: a 2 MiB
// `final_formatted` was written verbatim, and a non-string was coerced, so
// `{"evil":"<img src=x onerror=1>"}` landed in last_price as "[object Object]"
// while the run reported success. React escapes it, so this was never XSS — it is
// unbounded external text in a user-visible column, which is enough.
const MAX_PRICE_LEN = 64;
function priceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = sanitizeText(value, MAX_PRICE_LEN);
  return trimmed || null;
}

async function updatePrices({ region = 'il' } = {}) {
  const report = { checked: 0, updated: 0, withoutPrice: 0, errors: 0 };
  const games = await priceableGames();
  for (const game of games) {
    report.checked++;
    try {
      const response = await axios.get('https://store.steampowered.com/api/appdetails', {
        params: { appids: game.steam_app_id, cc: region, l: 'en' },
        timeout: STEAM_TIMEOUT_MS,
        maxRedirects: 0,
      });
      const data = response.data?.[game.steam_app_id];
      const price = priceString(data?.success && data?.data?.price_overview?.final_formatted);
      if (!price) { report.withoutPrice++; continue; }
      // AWAITED. v1 fired this through the callback shim without waiting, which
      // db.js divergence #9 says can be abandoned without its callback ever running —
      // so a price could be fetched, logged as updated, and never written.
      await db.promises.run(
        'UPDATE user_games SET last_price = ?, last_price_updated = ? WHERE id = ?',
        [price, new Date().toISOString(), game.id]
      );
      report.updated++;
    } catch (err) {
      report.errors++;
      // Steam's message only, never the response body.
      console.error(`[Jobs] Price lookup failed for app ${safe(game.steam_app_id, 20)}:`, err.message);
    }
  }
  return report;
}

module.exports = { NO_DEDUPE, checkReleases, updatePrices, reminderDays, usersWithPendingReleases, priceableGames };
