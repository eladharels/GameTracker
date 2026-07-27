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
const { all, run } = db.promises;
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
async function listOwnGames(userId) {
  return all(
    `SELECT game_id, game_name, cover_url, release_date, status
       FROM user_games
      WHERE user_id = ?
      ORDER BY game_name ASC`,
    [userId]
  );
}

// Full rows for a user id, plus the two camelCase aliases the current API emits
// alongside their snake_case originals.
//
// The duplication is intentional here and ONLY here: it is v1's published shape and
// the SPA reads both spellings. v2 emits camelCase once, from a single mapper.
async function listGamesWithAliases(userId) {
  const rows = await all('SELECT * FROM user_games WHERE user_id = ?', [userId]);
  return rows.map((row) => ({
    ...row,
    steamAppId: row.steam_app_id || null,
    crackStatus: row.crack_status || null,
  }));
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

// The backlog, in display order.
async function listBacklog(userId) {
  return all(
    'SELECT id, game_id, backlog_order FROM user_games WHERE user_id = ? AND status = ? ORDER BY backlog_order ASC NULLS FIRST, id ASC',
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
  const status = (!releaseDate || isReleaseInFuture(releaseDate)) ? 'unreleased' : requested;

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
      `INSERT INTO user_games (user_id, game_id, game_name, cover_url, release_date, status, steam_app_id, backlog_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game_id) DO UPDATE SET status=excluded.status,
         -- COALESCE, not a bare overwrite: the frontend's status-change call omits
         -- steamAppId, which bound as NULL and WIPED the stored Steam App ID every
         -- time a game moved between statuses. Prices then silently stopped
         -- resolving until backfill_steam_app_ids.js was run -- which is why that
         -- script kept finding work to do. Omitted now means unchanged.
         steam_app_id=COALESCE(excluded.steam_app_id, user_games.steam_app_id),
         backlog_order=excluded.backlog_order`,
      [userId, gameId, gameName, fields.coverUrl || null, releaseDate, status,
       fields.steamAppId || null, backlogOrder]
    );

    return { status, requested, coerced: status !== requested, events, created: !prior };
  });
}

module.exports = {
  STATUSES, EVENTS, MAX_GAME_ID, MAX_GAME_NAME,
  isReleaseInFuture, validReleaseDate, decideEvents, upsertGame,
  listGamesFor,
  listOwnGames,
  listGamesWithAliases,
  removeGame,
  listBacklog,
  moveBacklogItem,
  reorderBacklog,
};
