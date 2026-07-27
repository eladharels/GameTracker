-- `added_at` on user_games: when a game entered someone's library.
--
-- Required by /api/v2's library read, which sorts and paginates server-side. Recorded
-- as a service gap during the spec review, where it was the only entry needing a
-- MIGRATION rather than a service change — the spec had promised a field with no
-- column behind it.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. There is nothing in the table that says
-- when an existing row was added: `release_date` is the game's date, not the user's,
-- and `id` only gives relative order. Backfilling with the migration timestamp would
-- assert that every pre-existing game was added the moment this ran, which is false
-- for every one of them and indistinguishable afterwards from a true value. A NULL
-- says "unknown", which is the only honest thing available.
--
-- Ordered reads must therefore say NULLS LAST explicitly. Postgres sorts NULL LAST on
-- ASC and FIRST on DESC, SQLite did the opposite, and this data outlived a migration
-- between the two — so relying on the default puts every legacy row at whichever end
-- the engine happens to prefer. See the header of services/library.js.
--
-- No DEFAULT on the column either: a default would make the value appear for rows the
-- application forgot to set it on, hiding the omission. The upsert sets it explicitly
-- on insert and leaves it alone on conflict, so re-saving a game does not reset when
-- it was added.
ALTER TABLE user_games ADD COLUMN IF NOT EXISTS added_at TEXT;

-- Paging is `ORDER BY <key> NULLS LAST, id`, so the index carries the tiebreaker too.
-- Without `id` in the index a scan still has to sort within ties, which is the case
-- that matters here: a library where many rows share an added_at, or none have one.
CREATE INDEX IF NOT EXISTS idx_user_games_user_added
  ON user_games(user_id, added_at, id);
