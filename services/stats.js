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

// Bounded so a caller cannot ask for an unbounded scan, and so the response stays a
// size the SPA can hold. Well above any realistic library: ~50 completions a year
// means a decade fits in half of this.
const MAX_ROWS = 2000;

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
      ORDER BY e.changed_at ASC
      LIMIT ?`,
    [userId, MAX_ROWS]
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
async function durations(userId) {
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
        AND d.source = 'user'
      ORDER BY d.changed_at ASC
      LIMIT ?`,
    [userId, MAX_ROWS]
  );
  // snake_case out of SQL, mapped here. Postgres folds unquoted identifiers to lower
  // case (db.js divergence #3), so `AS finishedAt` would arrive as `finishedat` and read
  // as undefined — which already broke backlog ordering once.
  return rows.filter((r) => r.started_at);
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

  const [counts, done, paired, libraryDone] = await Promise.all([
    eventCounts(userId),
    completions(userId),
    durations(userId),
    db.promises.get(
      "SELECT COUNT(*)::int AS n FROM user_games WHERE user_id = ? AND status = 'done'",
      [userId]
    ),
  ]);

  const MS_PER_DAY = 86400000;
  return {
    trackingSince: counts.firstAt ? new Date(counts.firstAt).toISOString() : null,
    coverage: {
      libraryDone: libraryDone?.n ?? 0,
      recordedCompletions: done.length,
      totalEvents: counts.total,
      userEvents: counts.userEvents,
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
      // Fractional days, rounded to one place. An integer would report every
      // same-day finish as 0 and make the histogram's first bucket meaningless.
      days: Math.round(
        ((new Date(r.finished_at) - new Date(r.started_at)) / MS_PER_DAY) * 10
      ) / 10,
    })),
  };
}

module.exports = { summary, MAX_ROWS };
