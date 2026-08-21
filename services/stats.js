// Statistics derived from `user_game_status_events` (migration 005).
//
// Promise-based, no req/res. See services/shares.js for why the service layer exists.
//
// WHAT THIS DELIBERATELY DOES NOT RETURN. Status mix, release years, provider mix and
// library growth are all computable from the library response the page already fetches
// (`GET /api/user/:username/games`, which is `SELECT *`). Duplicating them here would
// be a second source for the same numbers, and the two would disagree the moment one
// changed. This file answers only what the event log can answer and nothing else can:
// WHEN things happened.
//
// EVERY ACHIEVEMENT QUERY FILTERS source = 'user'. That is not a detail — the 08:00
// sweep promotes `unreleased -> wishlist` when a release date passes, one library here
// has 58 unreleased games, and a single nightly run would otherwise be the largest
// number on the page while representing nobody doing anything. `metadata_refresh` is
// excluded for the same reason: a provider moved a date, not the user.
//
// COVERAGE IS PART OF THE ANSWER, not a footnote. The table starts empty — migration
// 005 refuses to invent timestamps for pre-existing rows, exactly as 004 did — so a
// library with 48 finished games reports 0 completions on day one. A page that renders
// that as a bare zero is lying by omission, so `coverage` is returned alongside the
// data and the page is expected to show it.
//
// `db.promises.*` through the MODULE, never destructured. The SQL text is the safety
// property here twice over: `WHERE user_id = ?` is the entire authorization boundary,
// and `source = 'user'` is what keeps system transitions out of a user's achievements.
// A destructured binding cannot be intercepted by a test — CLAUDE.md records that
// silent false pass happening once already.

const db = require('../db');
const { serviceError, CODES } = require('./errors');
const { STATUSES } = require('./library');

// Bounded so a caller cannot ask for an unbounded scan, and so the response stays a
// size the SPA can hold. Well above any realistic library: ~50 completions a year
// means a decade fits in half of this.
const MAX_ROWS = 2000;

// One constant and one rounding rule for every duration this file reports. Fractional
// days to one place: an integer would report every same-day finish as 0, which reads as
// "finished the moment it started" rather than "took under a day".
const MS_PER_DAY = 86400000;
const daysBetween = (from, to) =>
  Math.round(((new Date(to) - new Date(from)) / MS_PER_DAY) * 10) / 10;

// `::int` on every count. db.js divergence #8: Postgres returns bigint as a STRING, so
// COUNT(*) yields '12' rather than 12 — and `'3' + '4'` is '34'. The cast is the
// existing house workaround (services/library.js#countForUser).
async function eventCounts(userId) {
  const row = await db.promises.get(
    `SELECT COUNT(*)::int                                    AS total,
            COUNT(*) FILTER (WHERE source = 'user')::int     AS user_events,
            MIN(changed_at)                                  AS first_at
       FROM user_game_status_events
      WHERE user_id = ?`,
    [userId]
  );
  return {
    total: row?.total ?? 0,
    userEvents: row?.user_events ?? 0,
    // When tracking actually began FOR THIS USER, which is what the page must show
    // rather than the migration date: a user who changed nothing for a week has a
    // genuinely later start, and claiming otherwise implies missing data.
    firstAt: row?.first_at ?? null,
  };
}

// Every completion the USER recorded, oldest first.
//
// LEFT JOIN, not an inner one: the event table has no foreign key to user_games on
// purpose (see migration 005), so a game removed from the library keeps its history and
// must keep appearing here. An inner join would make "games finished this year" silently
// drop when someone tidies up — the exact failure the missing FK exists to prevent.
// `name` is null for those, and the page renders the id.
//
// Deliberately NOT bucketed in SQL. date_trunc would bucket in the SERVER's timezone,
// and a completion at 01:00 local lands in the previous day in UTC — so "games finished
// in July" would misplace anything near a month boundary for anyone not on UTC. The
// timestamps go out whole and the page buckets them against the viewer's own calendar,
// which is the only place the right timezone is actually known.
async function completions(userId) {
  return db.promises.all(
    `SELECT e.game_id, ug.game_name, e.changed_at
       FROM user_game_status_events e
       LEFT JOIN user_games ug
              ON ug.user_id = e.user_id AND ug.game_id = e.game_id
      WHERE e.user_id = ?
        AND e.to_status = 'done'
        AND e.source = 'user'
      -- DESC, then reversed in JS. Ordering ASC and limiting hands back the OLDEST
      -- rows, so a user past the cap loses their RECENT history and "finished this
      -- month" reads 0 permanently — a confident number the data does not support,
      -- which is the one thing this file exists not to do. MAX_ROWS + 1 so the caller
      -- can tell truncation happened and say so.
      ORDER BY e.changed_at DESC
      LIMIT ?`,
    [userId, MAX_ROWS + 1]
  );
}

// How long each finished game took: the most recent `playing` BEFORE each `done`.
//
// The correlated MAX is what makes a replayed game work. done -> playing -> done
// produces two completions, and each must pair with the `playing` that preceded IT, not
// with the first one ever — otherwise a game finished twice reports the second run as
// having taken as long as both.
//
// A `done` with no preceding `playing` (added straight as done, or marked done without
// ever starting) yields NULL and is dropped by the caller rather than falling back to
// `added_at`. Reporting "you took 400 days" because that is when the row appeared would
// be a fabricated number, which is the thing this whole feature refuses to do.
// completionRuns is the pairing rule itself: every user `done`, each carrying the latest
// user `playing` that preceded IT, or NULL when there was none. durations() drops the
// unpaired ones because a duration it cannot measure is not a duration; gameHistory KEEPS
// them, because "you finished this, we do not know when you started" is still a finish
// and dropping it would blank the modal's date for a game marked done without ever being
// marked playing. Same query, same ordering, two honest readings of it.
async function completionRuns(userId, gameId = null) {
  // The optional game filter is a fixed SQL fragment with a bound value, so the one
  // pairing rule serves both the whole-library projection and one game's headline.
  const gameFilter = gameId == null ? '' : '\n        AND d.game_id = ?';
  const params = gameId == null ? [userId, MAX_ROWS + 1] : [userId, gameId, MAX_ROWS + 1];
  const rows = await db.promises.all(
    `SELECT d.game_id,
            ug.game_name,
            d.changed_at AS finished_at,
            (SELECT MAX(p.changed_at)
               FROM user_game_status_events p
              WHERE p.user_id   = d.user_id
                AND p.game_id   = d.game_id
                AND p.to_status = 'playing'
                AND p.source    = 'user'
                AND p.changed_at < d.changed_at) AS started_at
       FROM user_game_status_events d
       LEFT JOIN user_games ug
              ON ug.user_id = d.user_id AND ug.game_id = d.game_id
      WHERE d.user_id = ?
        AND d.to_status = 'done'
        AND d.source = 'user'${gameFilter}
      ORDER BY d.changed_at DESC
      LIMIT ?`,
    params
  );
  // snake_case out of SQL, mapped here. Postgres folds unquoted identifiers to lower
  // case (db.js divergence #3), so `AS finishedAt` would arrive as `finishedat` and read
  // as undefined — which already broke backlog ordering once.
  return rows;
}

// Filtered AFTER the limit, deliberately: summary() decides truncation from the row count
// the database returned, so filtering first would let a page over the cap report itself
// complete.
async function durations(userId) {
  return (await completionRuns(userId)).filter((r) => r.started_at);
}

// Games the user is playing RIGHT NOW, and since when.
//
// This is the one thing on the page that the library response genuinely cannot answer.
// `status = 'playing'` is in every library row; WHEN it became playing exists only in the
// event log, and "you have been on this for 23 days" is the number people actually want.
//
// LEFT-ish by construction: the subquery yields NULL for a game that was already playing
// before tracking began, and those rows are RETURNED with startedAt null rather than
// filtered out. Dropping them would make the panel disagree with the library's own
// "playing" count for no reason the user can see, and "we do not know when you started"
// is a fact worth showing — the same rule the coverage banner follows.
//
// Ordered NULLS LAST so the games with a real start sort first; the unknowns collect at
// the bottom where they read as a footnote rather than as the headline.
async function inProgress(userId) {
  return db.promises.all(
    `SELECT ug.game_id, ug.game_name,
            (SELECT MAX(e.changed_at)
               FROM user_game_status_events e
              WHERE e.user_id   = ug.user_id
                AND e.game_id   = ug.game_id
                AND e.to_status = 'playing'
                AND e.source    = 'user') AS started_at
       FROM user_games ug
      WHERE ug.user_id = ? AND ug.status = 'playing'
      ORDER BY started_at DESC NULLS LAST, ug.game_name ASC
      LIMIT ?`,
    [userId, MAX_ROWS]
  );
}

// Everything the page needs from the event log, in one round trip.
//
// `coverage` exists so the page can state what it does NOT know. `libraryDone` is the
// number of games currently marked done; `recordedCompletions` is how many of those the
// log actually saw. On day one that is 48 and 0, and the page says so instead of
// drawing an empty chart that reads as "you have finished nothing".
async function summary(userId) {
  if (!Number.isInteger(userId) || userId < 1) {
    throw serviceError(CODES.VALIDATION, 'a valid user id is required', { field: 'userId' });
  }

  const [countsRaw, doneRaw, pairedRaw, playingRaw, libraryDone] = await Promise.all([
    eventCounts(userId),
    completions(userId),
    durations(userId),
    inProgress(userId),
    db.promises.get(
      "SELECT COUNT(*)::int AS n FROM user_games WHERE user_id = ? AND status = 'done'",
      [userId]
    ),
  ]);

  // Both reads come back newest-first and one over the cap. Trim the extra, then
  // restore chronological order for the page, which buckets left-to-right.
  const truncated = doneRaw.length > MAX_ROWS || pairedRaw.length > MAX_ROWS;
  const counts = countsRaw;
  const done = doneRaw.slice(0, MAX_ROWS).reverse();
  const paired = pairedRaw.slice(0, MAX_ROWS).reverse();

  return {
    trackingSince: counts.firstAt ? new Date(counts.firstAt).toISOString() : null,
    coverage: {
      libraryDone: libraryDone?.n ?? 0,
      recordedCompletions: done.length,
      totalEvents: counts.total,
      userEvents: counts.userEvents,
      // The page must not present a capped list as a complete one.
      truncated,
    },
    completions: done.map((r) => ({
      gameId: r.game_id,
      name: r.game_name || null,
      at: new Date(r.changed_at).toISOString(),
    })),
    durations: paired.map((r) => ({
      gameId: r.game_id,
      name: r.game_name || null,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: new Date(r.finished_at).toISOString(),
      days: daysBetween(r.started_at, r.finished_at),
    })),
    // `days` is computed at READ time against now(), so it is elapsed-so-far rather than
    // a stored value that would go stale in the client's cache. null when the start is
    // unknown -- an em dash on the page, never a 0 that reads as "started today".
    inProgress: playingRaw.map((r) => ({
      gameId: r.game_id,
      name: r.game_name || null,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      days: r.started_at ? daysBetween(r.started_at, Date.now()) : null,
    })),
  };
}

// ONE game's history, for the detail view. Not part of summary(): that is a whole-library
// projection the library page fetches on every load, and carrying a timeline per game
// would grow it without bound for a panel that shows one game at a time.
//
// Returns EVERY source, unlike the achievement queries. Those filter source = 'user'
// because a nightly sweep is not something the user did; here the sweep IS part of the
// story -- "this moved to wishlist on its own when the release date passed" is exactly
// what a person opening the history wants explained. The source travels with each row so
// the page can label it rather than presenting a system action as the user's.
async function gameHistory(userId, gameId) {
  if (!Number.isInteger(userId) || userId < 1) {
    throw serviceError(CODES.VALIDATION, 'a valid user id is required', { field: 'userId' });
  }
  const id = String(gameId ?? '').trim();
  if (!id) {
    throw serviceError(CODES.VALIDATION, 'a gameId is required', { field: 'gameId' });
  }

  // `db.promises.all` through the MODULE: `WHERE user_id = ?` is the entire authorization
  // boundary for this read, so a test has to be able to intercept and assert the
  // statement actually issued. See CLAUDE.md on the destructured-binding trap.
  // DESC then reversed, NOT `ORDER BY changed_at ASC LIMIT`. completions() states the
  // rule 170 lines above and this read used to break it: ordering ASC and limiting hands
  // back the OLDEST rows, so a game past the cap would show its first 2000 transitions
  // and silently drop everything recent -- while the modal rendered `truncated` as
  // "older entries are not shown", which would then be false in both directions.
  //
  // The headline comes from durations(userId, id) rather than a second scan over these
  // rows. An earlier version re-derived the pairing here in JS and claimed in a comment
  // that "the two cannot disagree"; that held only because both happened to use a strict
  // `<` on the same event set. One rule, one place -- and it is now also immune to the
  // truncation above, since it is a separate bounded query rather than a read of a
  // capped list.
  const [rows, paired] = await Promise.all([
    db.promises.all(
      `SELECT e.from_status, e.to_status, e.changed_at, e.source
         FROM user_game_status_events e
        WHERE e.user_id = ? AND e.game_id = ?
        ORDER BY e.changed_at DESC, e.id DESC
        LIMIT ?`,
      [userId, id, MAX_ROWS + 1]
    ),
    completionRuns(userId, id),
  ]);
  const truncated = rows.length > MAX_ROWS;
  const events = rows.slice(0, MAX_ROWS).reverse().map((r) => ({
    from: r.from_status || null,
    to: r.to_status,
    at: new Date(r.changed_at).toISOString(),
    source: r.source,
  }));

  // Newest-first, so [0] is the most recent completion -- the run the card and the modal
  // both mean by "how long did this take". `started_at` is NULL for a `done` with no
  // preceding `playing`: the finish is still reported, the duration stays null rather
  // than becoming 0.
  const lastRun = paired[0] || null;

  return {
    gameId: id,
    events,
    truncated,
    // null, not 0, for every unknown: no history at all, never played, never finished.
    daysToFinish: lastRun && lastRun.started_at
      ? daysBetween(lastRun.started_at, lastRun.finished_at)
      : null,
    startedAt: lastRun && lastRun.started_at
      ? new Date(lastRun.started_at).toISOString()
      : null,
    finishedAt: lastRun ? new Date(lastRun.finished_at).toISOString() : null,
  };
}



// --- the agent-facing projection --------------------------------------------------
//
// Same data, AGGREGATED. `summary()` returns a row per completion because the SPA draws
// them; handing that to an LLM is hundreds of rows of JSON to answer "how many did I
// finish in March", and every one of them costs context it could spend on the answer.
//
// This is the whole point of the service layer: /api and /api/v2 are two skins over one
// implementation, so the agent's view is a different PROJECTION of the same queries
// rather than a second source that can disagree with the page.
//
// It DOES return statusCounts, which summary() deliberately omits. The reasoning that
// excluded it there — the page already has the library, so a second source would
// disagree — inverts here: an agent's only alternative is downloading the entire
// library to count five numbers. Different consumer, different cost, same data.

const PERIODS = Object.freeze(['week', 'month', 'year']);

// IANA names only, and conservatively. The value is interpolated by Postgres as a
// VALUE (AT TIME ZONE ?), never as SQL text, so this is defence in depth rather than
// the injection boundary — but an unrecognised zone raises 22023, which would surface
// as a 500 rather than telling the caller their input was wrong.
const TZ_RE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+._-]+){0,2}$/;

async function agentSummary(userId, { period = 'month', timeZone = 'UTC' } = {}) {
  if (!Number.isInteger(userId) || userId < 1) {
    throw serviceError(CODES.VALIDATION, 'a valid user id is required', { field: 'userId' });
  }
  if (!PERIODS.includes(period)) {
    throw serviceError(CODES.VALIDATION,
      `period must be one of: ${PERIODS.join(', ')}`, { field: 'period' });
  }
  if (!TZ_RE.test(timeZone)) {
    throw serviceError(CODES.VALIDATION,
      'timeZone must be an IANA name such as Asia/Jerusalem', { field: 'timeZone' });
  }

  // Bucketed in SQL here, unlike the page — and that is a real difference, not an
  // inconsistency. The page buckets client-side because only the browser knows the
  // viewer's calendar; an agent has no calendar, so the zone has to be named explicitly
  // and echoed back. Defaulting to UTC and SAYING so beats bucketing in whatever zone
  // the server happens to run in and saying nothing.
  let buckets;
  try {
    buckets = await db.promises.all(
      `SELECT to_char(date_trunc(?, changed_at AT TIME ZONE ?), ?) AS period,
              COUNT(*)::int AS count
         FROM user_game_status_events
        WHERE user_id = ? AND to_status = 'done' AND source = 'user'
        GROUP BY 1
        ORDER BY 1`,
      [period, timeZone, period === 'year' ? 'YYYY' : period === 'month' ? 'YYYY-MM' : 'IYYY-"W"IW',
       userId]
    );
  } catch (err) {
    // 22023 is Postgres refusing an unrecognised time zone. A caller's bad input is a
    // 400, not the 500 an unmapped driver error would produce.
    if (err && err.code === '22023') {
      throw serviceError(CODES.VALIDATION, `unknown time zone: ${timeZone}`, { field: 'timeZone' });
    }
    throw err;
  }

  const statusRows = await db.promises.all(
    'SELECT status, COUNT(*)::int AS count FROM user_games WHERE user_id = ? GROUP BY status',
    [userId]
  );

  const base = await summary(userId);
  const days = base.durations.map((d) => d.days).sort((a, b) => a - b);
  const pct = (p) => (days.length ? days[Math.min(days.length - 1, Math.floor(days.length * p))] : null);

  return {
    trackingSince: base.trackingSince,
    timeZone,
    period,
    completedPerPeriod: buckets.map((b) => ({ period: b.period, count: b.count })),
    timeToFinish: {
      measured: days.length,
      medianDays: days.length ? pct(0.5) : null,
      shortestDays: days.length ? days[0] : null,
      longestDays: days.length ? days[days.length - 1] : null,
    },
    // ALL five, zero-filled. An absent key would make a caller decide whether it means
    // "none" or "unknown", which is the same ambiguity this whole feature refuses.
    statusCounts: STATUSES.reduce((acc, st) => {
      acc[st] = statusRows.find((r) => r.status === st)?.count ?? 0;
      return acc;
    }, {}),
    coverage: {
      ...base.coverage,
      // Named rather than left as arithmetic. This is the number an agent must state
      // when answering "how many have I finished" — the log knows fewer than the
      // library does, and a confident total would be wrong.
      unrecordedCompletions: Math.max(0, base.coverage.libraryDone - base.coverage.recordedCompletions),
    },
  };
}
module.exports = { summary, agentSummary, gameHistory, PERIODS, MAX_ROWS };
