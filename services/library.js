// A user's game library (`user_games`).
//
// Promise-based, no req/res. See services/shares.js for why the service layer
// exists at all.
//
// Reminders that bite every query in this file:
//   * `game_id` is TEXT — 'igdb_12345', never a number. Never coerce or compare it
//     numerically, and never let it reach an OpenAPI schema as `integer`. Compare
//     with String() on both sides, as the backlog lookup below does.
//   * A SELECT with no ORDER BY has no stable order in Postgres, and an UPDATE
//     physically moves the row to the end. Invisible while every read is
//     unpaginated; it produces duplicated and missing rows the moment one is paged.
//   * `backlog_order` may be NULL on rows predating the column. Postgres sorts NULL
//     LAST on ASC where SQLite sorted it FIRST, so ordered reads must say
//     NULLS FIRST explicitly or those rows silently jump to the bottom.

const db = require('../db');
// Shared promise surface — see db.js. Four services had each written their own.
const { all, get, run } = db.promises;
const { serviceError, CODES } = require('./errors');
const { sanitizeText } = require('../user-rules');

const norm = (v) => (v ? String(v).toLowerCase() : '');


// Every game row for a user, by username.
//
// An unknown user is an empty library, never a reason to provision an account —
// this once called getOrCreateUser and did exactly that. Orphaned share rows make
// that a live case: user_shares' foreign keys went unenforced under SQLite, so a
// share may name an account that no longer exists.
//
// NOTE: deliberately unordered, preserving the existing v1 response. The callers
// (the cron sweep and the shared-library view) do not rely on order, and both
// frontends re-sort client-side. v2's library endpoint will order explicitly.
async function listGamesFor(username) {
  return all(
    'SELECT ug.* FROM user_games ug JOIN users u ON u.id = ug.user_id WHERE u.username = ?',
    [norm(username)]
  );
}

// Trimmed projection for the authenticated user's own library, by user id.
//
// This is a DIFFERENT resource from listGamesWithAliases despite both being "my
// library": five columns, ordered, and deliberately without steam_app_id,
// backlog_order, crack_status or last_price. `db.promises.all` so the contract test
// can observe the projection — a client that switches between the two endpoints
// silently loses fields, which is worth pinning rather than rediscovering.
async function listOwnGames(userId) {
  return db.promises.all(
    `SELECT game_id, game_name, cover_url, release_date, status
       FROM user_games
      WHERE user_id = ?
      ORDER BY game_name ASC`,
    [userId]
  );
}

// v1's published library-row shape: the raw row plus two camelCase aliases emitted
// ALONGSIDE their snake_case originals, not instead of them.
//
// The duplication is intentional here and ONLY here — the SPA reads both spellings,
// and the Android client is a build this repo does not control. Extracted as a pure
// function so test/api-contract.test.js can pin it without a database: this is the
// single most likely thing for someone to "tidy up", and doing so breaks every v1
// client while CI stays green. v2 emits camelCase once, from a single mapper.
function withAliases(row) {
  return {
    ...row,
    steamAppId: row.steam_app_id || null,
    crackStatus: row.crack_status || null,
  };
}

async function listGamesWithAliases(userId) {
  const rows = await all('SELECT * FROM user_games WHERE user_id = ?', [userId]);
  return rows.map(withAliases);
}

// Remove one game. `removed` reports whether a row actually went; v1 reports success
// either way, so the adapter ignores it. v2 should not.
async function removeGame(userId, gameId) {
  const ctx = await run(
    'DELETE FROM user_games WHERE user_id = ? AND game_id = ?',
    [userId, String(gameId)]
  );
  return { removed: ctx.changes };
}

// One row from a user's library, or undefined.
async function findGame(userId, gameId) {
  return get('SELECT * FROM user_games WHERE user_id = ? AND game_id = ?', [userId, String(gameId)]);
}

// The backlog, in display order.
async function listBacklog(userId) {
  return all(
    // game_name is selected for v2's BacklogEntry.name. v1's callers ignore the extra
    // column; without it the v2 backlog can only return opaque ids, which is the shape
    // an LLM-driven client is least able to do anything with.
    'SELECT id, game_id, game_name, backlog_order FROM user_games WHERE user_id = ? AND status = ? ORDER BY backlog_order ASC NULLS FIRST, id ASC',
    [userId, 'backlog']
  );
}

// Move one game up or down one place in the backlog, swapping positions with its
// neighbour. Returns { moved: false } at a boundary — v1 reports success for that,
// making a no-op indistinguishable from a move, which v2 should fix.
//
// Throws NOT_IN_BACKLOG (as a plain code on the error) when the game is not there.
//
// TRANSACTIONAL, unlike v1. It previously issued two sequential UPDATEs through the
// shim, which db.js divergence #9 says run on DIFFERENT pooled connections and
// therefore cannot be rolled back together: a failure between them left two games
// holding the same backlog_order. The success path is unchanged; only the failure
// path is now all-or-nothing.
async function moveBacklogItem(userId, gameId, direction) {
  const rows = await listBacklog(userId);
  const idx = rows.findIndex((r) => String(r.game_id) === String(gameId));
  if (idx === -1) {
    throw serviceError(CODES.NOT_IN_BACKLOG, 'Game not in backlog');
  }
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return { moved: false };

  const game = rows[idx];
  const swap = rows[swapIdx];
  await db.withTransaction(async (tx) => {
    // Same lock the upsert takes. Without it this two-row swap and reorderBacklog's
    // row-by-row rewrite grab the same rows in opposite orders and deadlock —
    // measured at 55 in 60 rounds of four concurrent writers, surfacing to the user
    // as a bare 500 on a drag. Taking one lock first means there is no ordering left
    // to invert.
    await tx.query('SELECT pg_advisory_xact_lock(?, ?)', [db.LOCKS.BACKLOG_ORDER, userId]);
    await tx.query('UPDATE user_games SET backlog_order = ? WHERE id = ?', [swap.backlog_order, game.id]);
    await tx.query('UPDATE user_games SET backlog_order = ? WHERE id = ?', [game.backlog_order, swap.id]);
  });
  return { moved: true };
}

// Replace the backlog order wholesale from an ordered list of game ids.
//
// TRANSACTIONAL, unlike v1. It previously dispatched one fire-and-forget db.run per
// element inside a forEach and replied once a counter reached the array length —
// so a partial failure returned 500 over a HALF-APPLIED order that stayed on disk,
// and per db.js divergence #6 the writes were not even ordered with respect to one
// another. All-or-nothing now.
//
// Ids not in the user's library match nothing and are silently ignored, as before;
// `updated` reports how many rows actually moved so a caller can notice.
async function reorderBacklog(userId, order) {
  let updated = 0;
  await db.withTransaction(async (tx) => {
    // See moveBacklogItem: every writer of backlog_order for a user takes this first.
    await tx.query('SELECT pg_advisory_xact_lock(?, ?)', [db.LOCKS.BACKLOG_ORDER, userId]);
    for (let i = 0; i < order.length; i++) {
      const result = await tx.query(
        'UPDATE user_games SET backlog_order = ? WHERE user_id = ? AND game_id = ?',
        [i + 1, userId, String(order[i])]
      );
      updated += result.rowCount;
    }
  });
  return { updated, requested: order.length };
}


// The five statuses a game may hold. Nothing validated this before, so `status` was
// stored verbatim: production carries a row with 'Done' where every read and every
// filter expects 'done', which is invisible to the SPA's own controls and can only
// be fixed by hand in SQL. The frontend has always sent exactly these (STATUSES in
// App.jsx, plus 'unreleased' which the server assigns).
const STATUSES = Object.freeze(['wishlist', 'playing', 'done', 'backlog', 'unreleased']);

// The facts an upsert can produce. The notification layer MAPS these to text; it does
// not define them. Before this they were bare string literals here that happened to
// match notifyEvent's `type` parameter — an undeclared string match between two
// modules, which is the drift the service layer exists to prevent.
const EVENTS = Object.freeze({
  ADDED: 'add',
  STATUS_CHANGED: 'status',
  RELEASED: 'release',
});

// Bounds. game_id is part of a unique btree index, whose per-row limit is 2704 bytes
// — exceeding it raised a 500 where a 400 belongs. game_name reaches email subjects
// and push notification bodies.
const MAX_GAME_ID = 200;
const MAX_GAME_NAME = 400;

// A release date we are willing to reason about: YYYY-MM-DD (optionally with a time
// suffix) that actually parses. Returns null for anything else, which the caller
// treats as "no date".
function validReleaseDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

// Date-only comparison. 'YYYY-MM-DD' parses as UTC midnight, so both sides are
// flattened to local midnight — a game releasing TODAY counts as released, matching
// the daily cron.
function isReleaseInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d > today;
}

// Which events an upsert produces, given the status before and after.
//
// Pure and exported so it can be asserted without a database: it decides how many
// push notifications real people receive, and it was previously only reachable
// through a transaction.
//
// v1's rules, preserved exactly — including the wart in the last line.
// THE one place that writes status history (migrations/005). Every path that changes
// user_games.status calls this; nothing else inserts into the table.
//
// `db.promises.run` through the MODULE, never the destructured `run` at the top of this
// file. The SQL text here IS the safety property — the `source` value decides whether a
// row counts as something the user did, and `user_id` is the whole authorization
// scoping — so a test has to be able to intercept and assert the statement that was
// actually issued. A destructured binding is captured at module load and a stub of
// db.promises.run would never be called: CLAUDE.md records that exact silent false pass
// happening once already.
//
// `tx` is passed by callers already inside a transaction, so the event and the write it
// describes commit together or not at all. Without it the two would land on different
// pooled connections (db.js divergence #9) and a crash between them would leave a
// history entry for a status change that was rolled back.
async function recordStatusEvent({ userId, gameId, from, to, source }, tx) {
  // A re-save that changes nothing is not history. The v1 add route passes the body's
  // status straight into the upsert, so the SPA re-sending a game it already has would
  // otherwise log an event per save — and decideEvents deliberately still emits ADDED
  // in that case, so this cannot be inferred from the event list it returns.
  if (from === to) return;
  const sql = `INSERT INTO user_game_status_events
                 (user_id, game_id, from_status, to_status, source)
               VALUES (?, ?, ?, ?, ?)`;
  const params = [userId, String(gameId), from ?? null, to, source];
  if (tx) await tx.query(sql, params);
  else await db.promises.run(sql, params);
}

function decideEvents(priorStatus, status) {
  const events = [];
  // A game leaving 'unreleased' for anything else has, by definition of the coercion
  // above, a real release date that is not in the future. The extra `releaseDate &&
  // !isReleaseInFuture(...)` conjuncts v1 carried here were provably redundant.
  if (priorStatus === 'unreleased' && status !== 'unreleased') {
    events.push(EVENTS.RELEASED);
  }
  // NOTE for v2 (also recorded on the v2 list, not only here): re-saving a row with
  // an UNCHANGED status emits ADDED, so the user is told a game was added to a
  // library it was already in. Left alone because changing it changes how many
  // notifications people receive, which is not a refactor's call to make.
  events.push(priorStatus !== null && priorStatus !== status ? EVENTS.STATUS_CHANGED : EVENTS.ADDED);
  return events;
}

// Add a game, or update the one already there.
//
// Returns what HAPPENED, not just success: the status actually stored, whether that
// differs from the one asked for, and which notification events the caller should
// dispatch. The adapter needs all three and previously had to re-derive them.
//
// THE COERCION IS REPORTED, not silent. A game with no release date, or one dated in
// the future, is forced to 'unreleased' — correct, because a future-dated game must
// never sit in a released status. But v1 answered a plain {success:true}, so a client
// that asked for 'playing' was told it succeeded and had to refetch to discover it
// had not. `coerced` says so.
//
// TRANSACTIONAL, for backlog_order. The old code read MAX(backlog_order) and then
// INSERTed on two different pooled connections (db.js divergence #9), so two
// concurrent adds could read the same maximum and both claim it — a duplicate
// position that makes the up/down reorder a no-op between the pair.
async function upsertGame(userId, fields) {
  // Bounded, and only real strings. An object became the literal '[object Object]',
  // so two different objects collided onto ONE row; and a 5000-character id blew past
  // the btree index limit (2704 bytes) and surfaced as a 500 "DB error" rather than a
  // 400 — measured. express.json()'s 100kb default was the only ceiling in place.
  const gameId = typeof fields.gameId === 'string' || typeof fields.gameId === 'number'
    ? String(fields.gameId).trim() : '';
  const gameName = sanitizeText(fields.gameName, MAX_GAME_NAME);
  if (gameId.length > MAX_GAME_ID) {
    throw serviceError(CODES.VALIDATION,
      `gameId must be at most ${MAX_GAME_ID} characters`, { field: 'gameId' });
  }
  // Normalised BEFORE the allowlist, not after. Rejecting 'Done' outright would be a
  // new 400 on input v1 accepted, and we know something has been sending capitalised
  // statuses — the stored 'Done' row is the evidence, and the SPA carries a
  // normalizeStatus() that lowercases on read. GameTracker-mobile is a live REST
  // client against this API and cannot be inspected from here. So fold the case,
  // which still stores exactly one spelling, and reject only genuine junk.
  const requested = String(fields.status ?? '').trim().toLowerCase();
  if (!gameId || !gameName || !requested) {
    throw serviceError(CODES.VALIDATION, 'gameId, gameName and status are required');
  }
  if (!STATUSES.includes(requested)) {
    throw serviceError(CODES.VALIDATION,
      `status must be one of: ${STATUSES.join(', ')}`, { field: 'status' });
  }

  // A releaseDate that is present but UNPARSEABLE used to defeat the coercion
  // entirely: 'not-a-date' is truthy, so `!releaseDate` was false, and
  // isReleaseInFuture compares NaN and returns false — so the game kept the status
  // the caller asked for, with a garbage date, and the one control this function
  // exists to enforce never fired. Anything that is not a real YYYY-MM-DD is treated
  // as ABSENT, which routes it to 'unreleased'. Deliberately not a 400: v1 accepted
  // these, and the safe default costs the caller nothing.
  const releaseDate = validReleaseDate(fields.releaseDate);
  const status = isReleased(releaseDate) ? requested : 'unreleased';

  return db.withTransaction(async (tx) => {
    const prior = (await tx.query(
      'SELECT status, backlog_order FROM user_games WHERE user_id = ? AND game_id = ?',
      [userId, gameId]
    )).rows[0];

    const events = decideEvents(prior ? prior.status : null, status);

    let backlogOrder = null;
    if (status === 'backlog') {
      if (prior && prior.status === 'backlog') {
        backlogOrder = prior.backlog_order;
      } else {
        // Serialise position allocation FOR THIS USER only. A transaction alone is
        // not enough: Postgres defaults to READ COMMITTED, so concurrent
        // transactions each read the same MAX before any of them commits and all
        // claim the same position. Measured — five concurrent adds produced the
        // positions 1,2,2,2,3, and duplicates make the up/down reorder a permanent
        // no-op between the tied rows. (v1 was strictly worse: the read and the
        // write were not even in one transaction.)
        //
        // Advisory rather than a row lock, because the thing being contended is the
        // NEXT position, and there is no row to lock for a value that does not exist
        // yet. Held to the end of this transaction and scoped by user_id, so two
        // different users never wait on each other. The namespace lives in db.js
        // because advisory lock keys are database-global.
        await tx.query('SELECT pg_advisory_xact_lock(?, ?)', [db.LOCKS.BACKLOG_ORDER, userId]);
        // The alias MUST stay double-quoted. Postgres folds unquoted identifiers to
        // lower case, so `AS maxOrder` returns a `maxorder` property, `.maxOrder`
        // reads undefined, and every new backlog item silently gets order 1 — which
        // also makes the up/down reorder a permanent no-op, since every row shares
        // the same value.
        const maxRow = (await tx.query(
          'SELECT MAX(backlog_order) AS "maxOrder" FROM user_games WHERE user_id = ?', [userId]
        )).rows[0];
        backlogOrder = (maxRow && maxRow.maxOrder != null ? Number(maxRow.maxOrder) : 0) + 1;
      }
    }

    await tx.query(
      `INSERT INTO user_games (user_id, game_id, game_name, cover_url, release_date, status, steam_app_id, backlog_order, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- added_at is ABSENT from the DO UPDATE list on purpose: re-saving a game
       -- must not reset when it was added. The upsert is how a status change is
       -- written, so overwriting it here would make every row's added_at mean "last
       -- touched", which is a different fact under the same name.
       ON CONFLICT(user_id, game_id) DO UPDATE SET status=excluded.status,
         -- COALESCE, not a bare overwrite: the frontend's status-change call omits
         -- steamAppId, which bound as NULL and WIPED the stored Steam App ID every
         -- time a game moved between statuses. Prices then silently stopped
         -- resolving until backfill_steam_app_ids.js was run -- which is why that
         -- script kept finding work to do. Omitted now means unchanged.
         steam_app_id=COALESCE(excluded.steam_app_id, user_games.steam_app_id),
         backlog_order=excluded.backlog_order`,
      [userId, gameId, gameName, fields.coverUrl || null, releaseDate, status,
       fields.steamAppId || null, backlogOrder, new Date().toISOString()]
    );

    // History, in the SAME transaction as the write above. This is the SPA's status
    // change as well as its add — the frontend has no dedicated status route and posts
    // the full upsert either way — so `prior` being absent is what distinguishes the
    // two, and recordStatusEvent drops the no-op re-save.
    await recordStatusEvent(
      { userId, gameId, from: prior ? prior.status : null, to: status, source: 'user' },
      tx
    );

    return { status, requested, coerced: status !== requested, events, created: !prior };
  });
}


// THE shared primitive: may this date be treated as released?
//
// Absent, unparseable and future all answer no. Both write paths in this file depend
// on it, and this is the part that genuinely IS one rule — an earlier version of the
// comment below claimed the whole status decision was shared, and it was not: the two
// disagreed on exactly the null/unparseable case, because only one of them ran the
// date through validReleaseDate first.
function isReleased(releaseDate) {
  const valid = validReleaseDate(releaseDate);
  return !!valid && !isReleaseInFuture(valid);
}

// What a REFRESH does to a status when the release date changes. NOT the same rule as
// the upsert's, deliberately, and the difference is the point:
//
//   upsert   — the caller is choosing a status. An unreleasable date overrides that
//              choice with 'unreleased'; otherwise the choice stands.
//   refresh  — nobody is choosing anything. A game sitting in 'unreleased' whose date
//              has arrived is promoted to 'wishlist', mirroring the daily cron. Any
//              other status is the user's own and is left alone.
//
// What they share is isReleased(), which is what "shared rule" should have meant.
function statusForDate(releaseDate, currentStatus) {
  if (!isReleased(releaseDate)) return 'unreleased';
  return currentStatus === 'unreleased' ? 'wishlist' : currentStatus;
}

// What a REFRESH does, which is NOT what statusForDate does — and conflating the two
// destroyed data.
//
// statusForDate answers "the caller is asking for this status; is it available?", and
// coercing a request for `done` on an unreleased game to `unreleased` is right, because
// a caller asked and gets told (`coerced`). setStatus is its only remaining user.
//
// A refresh asks nothing. The comment above has always said "any other status is the
// user's own and is left alone", and the code did the opposite: `if (!isReleased) return
// 'unreleased'` fired regardless of the current status. So a provider moving a release
// date into the future — a delay, a re-release, a bad record — demoted a game the user
// had marked `done` to `unreleased`, and the next 08:00 sweep promoted it to `wishlist`
// (jobs.js#checkReleases). The `done` was then gone, unrecoverably, and the user's
// finished count silently decreased. Verified by deriving this function's own output for
// each status against a future date.
//
// Only the two DATE-DERIVED statuses may be rewritten here. `unreleased` and `wishlist`
// are the pre-order pair the calendar moves between, and swapping them loses nothing —
// the sweep restores it. `done`, `playing` and `backlog` are statements a person made,
// and no provider's metadata may overwrite one.
function statusAfterDateChange(nextDate, currentStatus) {
  if (currentStatus !== 'unreleased' && currentStatus !== 'wishlist') return currentStatus;
  return isReleased(nextDate) ? 'wishlist' : 'unreleased';
}

// Apply a catalog match to an existing library row.
//
// Only fields that actually differ are written, and `changes` names them — v1 built
// exactly this list to report back to the SPA, so it is the response, not debugging.
//
// Returns { updated:false, changes: [] } when the match brings nothing new, which the
// bulk path reports as "checked, unchanged" rather than as an error.
async function applyRefreshedMetadata(userId, game, match) {
  const updates = [];
  const params = [];
  // Set only when the status actually moves, so the event write below can tell a
  // metadata-only refresh from a status change.
  let nextStatus = null;

  // FILL AND CORRECT, NEVER ERASE — the same rule the Steam App ID already had.
  //
  // Two things conspired here. mergeResults resolves same-name duplicates by
  // preferring the entry with NO release date, which is right for a search (show the
  // unreleased title) and wrong for a refresh. And a provider's date is not validated
  // by this path, unlike upsertGame's. So a provider returning the same title with a
  // missing or unparseable date won the merge, and the row's real date was
  // overwritten with NULL — which for an unreleased game ALSO promoted it to
  // 'wishlist' and lost its reminder schedule. Reproduced against a live database.
  //
  // A date that legitimately CHANGES (a delay) still writes; only the erase is
  // refused. validReleaseDate is applied so garbage is treated as absent rather than
  // stored verbatim, matching upsertGame.
  const nextDate = validReleaseDate(match.releaseDate);
  if (nextDate && nextDate !== game.release_date) {
    updates.push('release_date = ?');
    params.push(nextDate);
    // Re-sync status to the NEW date. Only on a date change, matching v1: a refresh
    // that leaves the date alone must not quietly reassign a status the user chose.
    //
    // statusAfterDateChange, NOT statusForDate — see that function. The latter demoted
    // `done` to `unreleased` here, and the nightly sweep then finished the job.
    const next = statusAfterDateChange(nextDate, game.status);
    if (next !== game.status) {
      updates.push('status = ?');
      params.push(next);
      nextStatus = next;
    }
  }
  if (match.coverUrl && match.coverUrl !== game.cover_url) {
    updates.push('cover_url = ?');
    params.push(match.coverUrl);
  }
  // Only FILLS a missing Steam App ID; never overwrites one. A stored id may have
  // been corrected by hand or by the backfill script, and the providers disagree
  // with each other often enough that overwriting would flap.
  if (match.steamAppId && !game.steam_app_id) {
    updates.push('steam_app_id = ?');
    params.push(match.steamAppId);
  }

  if (updates.length === 0) return { updated: false, changes: [] };

  params.push(userId, String(game.game_id));
  await run(`UPDATE user_games SET ${updates.join(', ')} WHERE user_id = ? AND game_id = ?`, params);
  // source = 'metadata_refresh', deliberately neither 'user' nor 'release_sweep'. A
  // person asked for a refresh, but a PROVIDER's date picked the status — so counting
  // it as something the user did is wrong, and so is filing it with the nightly cron.
  // Only reachable now for the unreleased/wishlist pair; statusAfterDateChange refuses
  // to touch anything else.
  if (nextStatus) {
    await recordStatusEvent(
      { userId, gameId: game.game_id, from: game.status, to: nextStatus, source: 'metadata_refresh' });
  }
  return { updated: true, changes: updates.map((u) => u.split(' = ')[0]) };
}


// Whole days until a game releases: 0 today, negative once out, null when there is
// no date we can reason about.
//
// The crons each did `new Date(game.release_date)` bare, with no guard. An
// unparseable date yields NaN, so `diffDays <= 0` is false and
// `notifDays.includes(NaN)` is false — the row is silently skipped forever, with a
// log line reporting `diffDays: NaN`. Routed through validReleaseDate so the whole
// codebase agrees on which dates are usable.
function daysUntilRelease(releaseDate) {
  const valid = validReleaseDate(releaseDate);
  if (!valid) return null;
  const d = new Date(valid); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((d - today) / 86400000);
}

// Promote a released game out of 'unreleased'.
//
// ONE definition of this write. It existed twice — the daily cron and
// POST /api/admin/check-releases — with the same SQL and DIFFERENT arguments: the
// cron lowercased the username, the admin route passed it through raw. Usernames are
// stored lowercase, so the admin copy matched nothing whenever a caller used any
// other casing, and did so silently: `changes` was never checked, so the route
// reported the game as updated either way.
//
// Returns whether a row actually moved, so a caller can stop claiming it did.
async function promoteReleased(username, gameId) {
  // ONE statement, with the history written by a CTE off the UPDATE's RETURNING.
  //
  // Two properties fall out of that and neither is incidental. The event is atomic
  // with the update without needing a transaction — these run through the shim on a
  // pooled connection (db.js divergence #9), so two statements could not be rolled
  // back together. And the INSERT sees a row ONLY when the UPDATE actually moved one,
  // which is exactly the existing `promoted` semantics: the WHERE pins status to
  // 'unreleased', so a game already promoted produces no row and no event.
  //
  // source = 'release_sweep', and this is the column the statistics page lives or dies
  // on. Nobody did anything here — a date passed. One nightly run across a library
  // with 58 unreleased games would otherwise post 58 "status changes" and dwarf every
  // real number on the page.
  const ctx = await db.promises.run(
    `WITH moved AS (
       UPDATE user_games SET status = 'wishlist'
        WHERE user_id = (SELECT id FROM users WHERE username = ?)
          AND game_id = ?
          AND status = 'unreleased'
        RETURNING user_id, game_id
     )
     INSERT INTO user_game_status_events
       (user_id, game_id, from_status, to_status, source)
     SELECT user_id, game_id, 'unreleased', 'wishlist', 'release_sweep' FROM moved`,
    [norm(username), String(gameId)]
  );
  // rowCount is now the INSERT's, which equals the number of rows the UPDATE moved.
  return { promoted: ctx.changes > 0 };
}


// --- v2 paginated read -------------------------------------------------------
//
// Server-side filter, sort and page. "What is in my backlog, in order" must not mean
// shipping an entire library through a model's context window.
//
// KEYSET, not OFFSET. Offset paging re-runs the query per page, so a row inserted or
// moved between two requests shifts every later page — the reader silently skips a
// game or sees one twice. Keyset asks "what comes after this exact row", which is
// stable under concurrent writes. It also costs the same at page 50 as at page 1.
//
// THE ORDER IS TOTAL, ALWAYS. Three of the four sort keys are non-unique and two are
// nullable, so `ORDER BY key` alone leaves ties in engine-defined order and keyset
// paging over it duplicates and drops rows. Every sort carries an `id` tiebreaker,
// and NULLS LAST is stated explicitly because Postgres defaults to NULLS LAST on ASC
// and NULLS FIRST on DESC — and this data outlived a migration from SQLite, which
// defaulted the other way.

// Wire name -> column. An allowlist, not a mapping applied to caller input: the value
// is interpolated into the ORDER BY, which is the one place in this file where a
// caller-supplied string reaches the SQL text.
const SORT_COLUMNS = Object.freeze({
  name: 'game_name',
  releaseDate: 'release_date',
  backlogOrder: 'backlog_order',
  addedAt: 'added_at',
});
const SORTS = Object.freeze(Object.keys(SORT_COLUMNS));
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

// The cursor is server-generated and validated on receipt. It is NEVER an
// authorization input: every query below is scoped by user_id regardless of what the
// cursor contains, so a forged one can only produce a wrong page of the caller's own
// library, never someone else's row.
function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(raw, expected) {
  let state;
  try {
    state = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    throw serviceError(CODES.VALIDATION, 'cursor is not a cursor this server issued', { field: 'cursor' });
  }
  if (!state || typeof state !== 'object') {
    throw serviceError(CODES.VALIDATION, 'cursor is not a cursor this server issued', { field: 'cursor' });
  }
  // The cursor PINS the query. Changing sort, order or filter mid-page would otherwise
  // resume from a position that means something different in the new ordering, and the
  // caller would get a page that is neither the old sequence nor the new one — silently.
  // This is the first thing a client hits when it changes sort while paging.
  // TYPE-validated, not just shape-validated. `lastId` is compared against an INTEGER
  // column: a forged cursor carrying a string produces SQLSTATE 22P02 and a 500, where
  // the spec promises a 400. This is db.js divergence #5 — the same class parseRouteId
  // exists to prevent for route params, and the cursor was the one integer comparison
  // in this file without such a guard.
  if (!Number.isSafeInteger(state.lastId)) {
    throw serviceError(CODES.VALIDATION, 'cursor is not a cursor this server issued', { field: 'cursor' });
  }
  if (state.lastKey !== null && typeof state.lastKey !== 'string' && typeof state.lastKey !== 'number') {
    throw serviceError(CODES.VALIDATION, 'cursor is not a cursor this server issued', { field: 'cursor' });
  }
  for (const key of ['sort', 'order', 'status']) {
    if (String(state[key] ?? '') !== String(expected[key] ?? '')) {
      throw serviceError(CODES.VALIDATION,
        `cursor was issued for ${key}='${state[key] ?? ''}' but this request asks for `
        + `'${expected[key] ?? ''}' — start a new page when you change the query`,
        { field: 'cursor' });
    }
  }
  return state;
}

async function listPage(userId, opts = {}) {
  // A repeated query parameter (?order=asc&order=desc) arrives as an ARRAY. Taking the
  // first element turns what was a TypeError and a 500 into ordinary validation, which
  // then answers 400 like every other bad input.
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const sort = one(opts.sort) ?? 'name';
  const order = String(one(opts.order) ?? 'asc').toLowerCase();
  const status = one(opts.status) ?? null;

  if (!SORTS.includes(sort)) {
    throw serviceError(CODES.VALIDATION, `sort must be one of: ${SORTS.join(', ')}`, { field: 'sort' });
  }
  if (order !== 'asc' && order !== 'desc') {
    throw serviceError(CODES.VALIDATION, "order must be 'asc' or 'desc'", { field: 'order' });
  }
  if (status !== null && !STATUSES.includes(status)) {
    throw serviceError(CODES.VALIDATION, `status must be one of: ${STATUSES.join(', ')}`, { field: 'status' });
  }
  // Ordering by backlog position across statuses is not a meaningful question: every
  // row outside the backlog has NULL there, so the answer is "the backlog, then
  // everything else in id order" dressed up as a sort.
  if (sort === 'backlogOrder' && status !== 'backlog') {
    throw serviceError(CODES.VALIDATION,
      "sort=backlogOrder is only meaningful with status=backlog", { field: 'sort' });
  }

  // Refused rather than silently coerced: `?limit=abc` becoming 50 tells the caller
  // their request was understood when it was not.
  const rawLimit = one(opts.limit);
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== ''
      && !/^\d+$/.test(String(rawLimit))) {
    throw serviceError(CODES.VALIDATION, 'limit must be a positive integer', { field: 'limit' });
  }
  const limit = Math.min(Math.max(Number(rawLimit) || DEFAULT_PAGE, 1), MAX_PAGE);
  const column = SORT_COLUMNS[sort];               // allowlisted above, never raw input
  const direction = order === 'asc' ? 'ASC' : 'DESC';

  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }

  // The FILTER is what `total` counts. Captured before the cursor clause is appended:
  // sharing one `where` between the count and the page made `total` shrink on every
  // page — it reported rows REMAINING while the spec promises "rows matching the
  // filter, ignoring paging" and a client renders "12 of 340" from it. Correct on
  // page 1, wrong from page 2, which is the shape of defect that survives a demo.
  const filterWhere = [...where];
  const filterParams = [...params];

  if (opts.cursor) {
    const state = decodeCursor(opts.cursor, { sort, order, status });
    // Explicit rather than a row comparison: a NULL anywhere inside a Postgres row
    // comparison makes the whole comparison NULL, which silently drops every row it
    // touches instead of ordering them.
    if (state.lastKey === null) {
      // Already past the non-null block; only later NULL rows remain.
      where.push(`${column} IS NULL AND id > ?`);
      params.push(state.lastId);
    } else {
      const cmp = order === 'asc' ? '>' : '<';
      where.push(`((${column} IS NOT NULL AND (${column} ${cmp} ? OR (${column} = ? AND id > ?))) OR ${column} IS NULL)`);
      params.push(state.lastKey, state.lastKey, state.lastId);
    }
  }

  const whereSql = where.join(' AND ');
  // Counted against the FILTER, never the cursor-narrowed set. A second count per page;
  // at this scale that is the right trade, and the spec states it as a promise rather
  // than leaving it optional.
  const totalRow = await db.promises.get(
    `SELECT COUNT(*)::int AS total FROM user_games WHERE ${filterWhere.join(' AND ')}`,
    filterParams);

  // One extra row decides whether another page exists, without a second query.
  const rows = await db.promises.all(
    `SELECT * FROM user_games
      WHERE ${whereSql}
      ORDER BY ${column} ${direction} NULLS LAST, id ASC
      LIMIT ?`,
    [...params, limit + 1]
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ sort, order, status, lastKey: last[column] ?? null, lastId: last.id })
    : null;

  return { data: page, meta: { total: totalRow ? totalRow.total : 0, limit, nextCursor } };
}

// Change a game's status, deriving the result from the STORED release date.
//
// THIS IS THE FIX FOR v1'S WORST TRAP, expressed as its own function rather than as a
// flag on upsertGame. There, status was computed from the `releaseDate` in the REQUEST:
// send `{gameId, gameName, status:'done'}` for a game released in 2020 and omit the
// date, and validReleaseDate(undefined) is null, isReleased(null) is false, so the row
// was written `unreleased` — while release_date was PRESERVED, because it is not in the
// ON CONFLICT DO UPDATE list. The row then read `release_date='2020-01-01',
// status='unreleased'`, and the next correct write made decideEvents emit RELEASED and
// push "has been released!" to four channels for a six-year-old game.
//
// The SPA never tripped it because it always resends the date. A script or an MCP is
// exactly the client that will not, which is why v2 does not accept a date here at all.
async function setStatus(userId, gameId, status) {
  const requested = String(status ?? '').trim().toLowerCase();
  if (!STATUSES.includes(requested)) {
    throw serviceError(CODES.VALIDATION,
      `status must be one of: ${STATUSES.join(', ')}`, { field: 'status' });
  }
  const row = await get(
    'SELECT id, release_date, status, backlog_order FROM user_games WHERE user_id = ? AND game_id = ?',
    [userId, String(gameId)]
  );
  if (!row) throw serviceError(CODES.NOT_FOUND, 'no such game in your library');

  // The stored date decides whether `unreleased` is even available. Asking for it on a
  // game that is already out is a contradiction the server resolves rather than stores.
  const resolved = statusForDate(row.release_date, requested);

  // Entering the backlog needs a position; leaving it must give one up, or the row
  // keeps a stale slot that the reorder then has to reason about.
  let backlogOrder = row.backlog_order;
  if (resolved === 'backlog' && row.status !== 'backlog') {
    await db.withTransaction(async (tx) => {
      // Same lock every other writer of backlog_order takes. Without it this read of
      // MAX and the reorder's row-by-row rewrite interleave and produce duplicate
      // positions, which make the up/down move a permanent no-op.
      await tx.query('SELECT pg_advisory_xact_lock(?, ?)', [db.LOCKS.BACKLOG_ORDER, userId]);
      const maxRow = (await tx.query(
        'SELECT MAX(backlog_order) AS "maxOrder" FROM user_games WHERE user_id = ?', [userId]
      )).rows[0];
      const next = (maxRow && maxRow.maxOrder != null ? Number(maxRow.maxOrder) : 0) + 1;
      await tx.query('UPDATE user_games SET status = ?, backlog_order = ? WHERE id = ?',
        [resolved, next, row.id]);
      await recordStatusEvent(
        { userId, gameId, from: row.status, to: resolved, source: 'user' }, tx);
    });
  } else {
    backlogOrder = resolved === 'backlog' ? backlogOrder : null;
    await db.promises.run('UPDATE user_games SET status = ?, backlog_order = ? WHERE id = ?',
      [resolved, backlogOrder, row.id]);
    await recordStatusEvent(
      { userId, gameId, from: row.status, to: resolved, source: 'user' });
  }

  const updated = await get('SELECT * FROM user_games WHERE id = ?', [row.id]);
  // `coerced` tells the caller the server resolved their request to something else,
  // rather than silently storing a different value than they asked for.
  return { game: updated, coerced: resolved !== requested };
}

// v2's add, given a game the catalog has already resolved.
//
// The ONE rule it adds over upsertGame: `status` is OPTIONAL here, and omitting it on
// a game ALREADY IN THE LIBRARY leaves its status alone. Without that, "add Halo" from
// an agent that does not track what is already there silently demotes a game the user
// is playing back to wishlist — and reports 200, so nothing surfaces it. Only a game
// that is genuinely new takes the default.
//
// It lives here rather than in the adapter because it is a rule about what storing a
// game means, and the adapters are two skins over one implementation. It also returns
// the stored row, so the adapter does not have to know that upsertGame reports the
// outcome while the row has to be read back.
const DEFAULT_NEW_STATUS = 'wishlist';

// `deps` is a TEST SEAM (see services/catalog.js#search for the same pattern and the
// same reason): findGame and upsertGame are called directly from inside this module,
// so a test that stubs db.promises observes nothing — the documented false-pass trap.
// The rule below is one branch, and one branch nothing can reach is one that decays.
async function addResolvedGame(userId, game, requestedStatus, deps = {}) {
  const read = deps.findGame || findGame;
  const write = deps.upsertGame || upsertGame;
  let status = requestedStatus;
  if (status === undefined || status === null || status === '') {
    const prior = await read(userId, game.id);
    status = prior ? prior.status : DEFAULT_NEW_STATUS;
  }
  const result = await write(userId, {
    gameId: game.id,
    gameName: game.name,
    coverUrl: game.coverUrl,
    releaseDate: game.releaseDate,
    status,
    steamAppId: game.steamAppId,
  });
  // Read back rather than reconstruct: the stored row carries columns the caller never
  // sent (crack_status, last_price, added_at) and the status upsertGame may have
  // coerced. Building the response from the request is how a client learns a value the
  // database does not hold.
  return { ...result, game: await read(userId, game.id) };
}

// AT THE END OF THE FILE, deliberately. This block used to sit above the v2
// pagination helpers, which put every name it referenced in the temporal dead zone —
// `require('./library')` threw ReferenceError before any caller ran. Keeping exports
// last means adding a function below them cannot repeat that.
module.exports = {
  STATUSES, EVENTS, MAX_GAME_ID, MAX_GAME_NAME,
  isReleaseInFuture, validReleaseDate, decideEvents, upsertGame,
  isReleased, statusForDate, statusAfterDateChange, applyRefreshedMetadata,
  daysUntilRelease, promoteReleased,
  listGamesFor,
  listOwnGames,
  withAliases,
  listGamesWithAliases,
  findGame,
  removeGame,
  listBacklog,
  moveBacklogItem,
  reorderBacklog,
  listPage, SORTS, MAX_PAGE, DEFAULT_PAGE, encodeCursor, setStatus,
  addResolvedGame, DEFAULT_NEW_STATUS,
};
