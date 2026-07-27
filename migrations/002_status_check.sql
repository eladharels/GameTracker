-- Make the status allowlist an invariant of the DATA, not a policy of one function.
--
-- `status` has always been a bare TEXT column with nothing checking it, and the API
-- wrote whatever the client sent. Production therefore carries at least one row
-- reading 'Done' where every read, filter and status tab expects 'done' — invisible
-- to the SPA's own controls, and fixable only by hand in SQL. services/library.js
-- now rejects anything outside the five, but that only stops NEW bad rows, and it is
-- one write path: the release cron and the manual sweep issue raw UPDATEs. A CHECK
-- constraint covers all of them and survives the next service that forgets.

-- 1. Fold the rows that are merely mis-spelled. This is the 'Done' row's fix.
UPDATE user_games
   SET status = lower(btrim(status))
 WHERE status IS NOT NULL
   AND status <> lower(btrim(status));

-- 2. Anything still outside the set is not a casing problem — it is a value nothing
--    in the app can render. 'wishlist' is the safe landing spot: it is the default
--    the two release paths already assign, and it keeps the row visible to its owner
--    rather than hiding it in a status the UI has no tab for.
UPDATE user_games
   SET status = 'wishlist'
 WHERE status IS NOT NULL
   AND status NOT IN ('wishlist', 'playing', 'done', 'backlog', 'unreleased');

-- 3. The constraint itself.
--
-- The `status IS NULL` disjunct is MANDATORY, not defensive: the column is nullable
-- (migrations/001_initial_schema.sql), rows predating the API's status handling can
-- hold NULL, and a CHECK that omitted it would fail on them. Per CLAUDE.md a failed
-- migration is fatal and the backend then refuses to serve traffic — so a forgotten
-- disjunct here is a production outage, not a warning.
ALTER TABLE user_games
  ADD CONSTRAINT user_games_status_chk
  CHECK (status IS NULL OR status IN ('wishlist', 'playing', 'done', 'backlog', 'unreleased'));
