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
const catalog = require('./catalog');
const { serviceError, CODES } = require('./errors');
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
// `db.promises.all` through the module, not the destructured `all`. updatePrices was
// refactored to share its Steam call with the v2 price route, and its three-way
// counting — updated / withoutPrice / errors — had no test at all, because the
// destructured binding made the query un-stubbable and the suite forbids a real
// database. That is the trap CLAUDE.md documents: not a false pass here, but a whole
// function left untestable and therefore untested.
async function priceableGames() {
  return db.promises.all(
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

// One Steam lookup. Extracted because there are now two callers — the weekly sweep
// below and `GET /api/v2/catalog/prices/{steamAppId}` — and the alternative was the
// route re-implementing the request, the timeout, the redirect refusal and the
// price-string sanitising. v1 does exactly that in an inline route handler, which is
// why its version has none of the last three.
//
// Returns a DISCRIMINATED result rather than a string or a throw, because "Steam says
// this game has no price" and "Steam could not be reached" are different answers and
// the caller must not collapse them: the sweep counts them separately, and the route
// answers 200 for one and 502 for the other.
//
//   { ok: true,  price }              a formatted price for that region
//   { ok: true,  price: null, reason } Steam answered; the game has no price there
//   { ok: false, error }              Steam could not be reached or was unusable
async function fetchSteamPrice(steamAppId, { region = 'il' } = {}) {
  const id = String(steamAppId);
  try {
    const response = await axios.get('https://store.steampowered.com/api/appdetails', {
      params: { appids: id, cc: region, l: 'en' },
      timeout: STEAM_TIMEOUT_MS,
      // No redirects: a 302 off store.steampowered.com is not an answer about a price,
      // and following it would send the request somewhere this code never named.
      maxRedirects: 0,
    });
    const data = response.data?.[id];
    // `success:false` is Steam's answer for an app id that is not in this region's
    // store at all — distinct from an app that is there and simply has no price_overview
    // (free, unreleased, or bundled).
    if (!data?.success) return { ok: true, price: null, reason: 'not_in_region' };
    const price = priceString(data?.data?.price_overview?.final_formatted);
    if (!price) return { ok: true, price: null, reason: 'free_or_unpriced' };
    return { ok: true, price, reason: null };
  } catch (err) {
    // Steam's message only, never the response body.
    return { ok: false, error: err.message };
  }
}

async function updatePrices({ region = 'il' } = {}) {
  const report = { checked: 0, updated: 0, withoutPrice: 0, errors: 0 };
  const games = await priceableGames();
  for (const game of games) {
    report.checked++;
    {
      const result = await fetchSteamPrice(game.steam_app_id, { region });
      if (!result.ok) {
        report.errors++;
        console.error(`[Jobs] Price lookup failed for app ${safe(game.steam_app_id, 20)}:`, result.error);
        continue;
      }
      const price = result.price;
      if (!price) { report.withoutPrice++; continue; }
      // AWAITED. v1 fired this through the callback shim without waiting, which
      // db.js divergence #9 says can be abandoned without its callback ever running —
      // so a price could be fetched, logged as updated, and never written.
      await db.promises.run(
        'UPDATE user_games SET last_price = ?, last_price_updated = ? WHERE id = ?',
        [price, new Date().toISOString(), game.id]
      );
      report.updated++;
    }
  }
  return report;
}

// --- Metadata refresh ------------------------------------------------------
//
// The FIFTH copy of "call the providers, take an exact title match, apply it" — and
// the last one still living in a route. `POST /api/user/:username/refresh-metadata`
// runs this inline, holding the request open for the whole library; here it is a
// function the job runner can run off the response, which is the only version of it
// that can honestly report what happened.
//
// SEQUENTIAL, as v1 is. Each game costs up to three provider searches plus RAWG's
// per-result detail lookups, so a whole library run concurrently bursts hundreds of
// outbound requests and earns a rate-limit.
async function refreshMetadata({ userId }) {
  const games = await library.listGamesWithAliases(userId);
  const result = { processed: 0, succeeded: 0, failed: 0, failures: [] };
  for (const game of games) {
    result.processed++;
    try {
      const lookup = await catalog.searchAll(game.game_name, { limit: catalog.LIMIT_REFRESH });
      const match = catalog.findExactMatch(lookup.results, game.game_name);
      if (!match) {
        result.failed++;
        // "Nobody has this game" and "we could not ask" are different facts and a user
        // acts on them differently — during a provider outage the whole library would
        // otherwise be reported as not existing in any database. The closed reason set
        // is what carries the difference; a message would have carried the provider's.
        result.failures.push({
          gameId: game.game_id,
          // nobodyAnswered, not `degraded`: an instance with no API keys configured
          // reports every provider `skipped`, which is not degraded and still asked
          // nobody — and reporting that as `not_found` tells a client every game in
          // the library has ceased to exist. Measured live before this line changed.
          reason: catalog.nobodyAnswered(lookup.providers) ? 'provider_unavailable' : 'not_found',
        });
        continue;
      }
      await library.applyRefreshedMetadata(userId, game, match);
      result.succeeded++;
    } catch (err) {
      // Per game: one bad row must not abandon the sweep.
      result.failed++;
      result.failures.push({ gameId: game.game_id, reason: 'internal' });
      console.error(`[Jobs] Metadata refresh failed for ${safe(game.game_name)}:`, err.message);
    }
  }
  return result;
}

// Every user's library, one after another. Same reasoning as above about
// concurrency, one level up.
async function refreshMetadataAll() {
  const users = await all('SELECT id FROM users ORDER BY id ASC', []);
  const total = { processed: 0, succeeded: 0, failed: 0, failures: [] };
  for (const user of users) {
    const one = await refreshMetadata({ userId: user.id });
    total.processed += one.processed;
    total.succeeded += one.succeeded;
    total.failed += one.failed;
    total.failures.push(...one.failures);
  }
  return total;
}

// --- The v2 job surface ------------------------------------------------------
//
// One table, so a kind cannot exist on the router without a runner or the reverse.
// Every entry returns the JobResult shape; the counts below are chosen so that a sweep
// where everything failed and one where everything succeeded cannot read the same —
// which the v1 price sweep genuinely could, reporting success while writing nothing.
const JOB_KINDS = Object.freeze(['refreshMetadata', 'checkReleases', 'refreshCrackStatus', 'updatePrices']);

// `deps` carries the two pieces of state this module does not own: the file-backed
// sent-notifications log, and the CrackWatch cache, which lives at module scope in
// index.js behind its own file. Both are required rather than defaulted — omitting the
// dedupe log silently re-sends every due reminder to real users, which is precisely
// the failure NO_DEDUPE was introduced to make impossible to reach by accident.
async function runJob(kind, { scope = 'instance', userId = null, deps = {} } = {}) {
  if (!JOB_KINDS.includes(kind)) {
    throw serviceError(CODES.VALIDATION, `kind must be one of: ${JOB_KINDS.join(', ')}`, { field: 'kind' });
  }

  if (kind === 'refreshMetadata') {
    return scope === 'self' ? refreshMetadata({ userId }) : refreshMetadataAll();
  }

  if (kind === 'checkReleases') {
    const report = await checkReleases({ dedupe: deps.dedupe });
    return {
      processed: report.usersChecked,
      // What the sweep DID, which is the number worth reporting: a run that checked
      // 40 users and promoted nothing is not 40 successes.
      succeeded: report.promoted.length + report.remindersSent.length,
      failed: report.errors.length,
    };
  }

  if (kind === 'updatePrices') {
    const report = await updatePrices();
    // `withoutPrice` is neither a success nor a failure — a game Steam has no price
    // for is a correct answer — so it is counted in `processed` and nowhere else.
    return { processed: report.checked, succeeded: report.updated, failed: report.errors };
  }

  // refreshCrackStatus. The cache is index.js's module state and its refresh is
  // all-or-nothing: it either rebuilds the map or it does not, with no per-item
  // outcome to report, so `processed` is the resulting cache size.
  if (typeof deps.refreshCrackStatus !== 'function') {
    throw serviceError(CODES.VALIDATION, 'refreshCrackStatus requires its cache refresher');
  }
  const count = await deps.refreshCrackStatus();
  const n = Number.isFinite(Number(count)) ? Number(count) : 0;
  return { processed: n, succeeded: n, failed: 0 };
}

module.exports = {
  NO_DEDUPE, checkReleases, updatePrices, reminderDays, usersWithPendingReleases, priceableGames,
  refreshMetadata, refreshMetadataAll, runJob, JOB_KINDS, fetchSteamPrice,
};
