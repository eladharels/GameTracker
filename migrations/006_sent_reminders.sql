-- The release-reminder dedupe log, moved out of sent_notifications.json (ROADMAP
-- CC-3, CC-4).
--
-- The file was a whole-object rewrite from an in-memory copy, and there were TWO
-- copies: the server's and run_notifications.js's. A manual run followed by the 08:00
-- cron on the same day each consulted their own copy, both sent, and the second
-- write erased the first's records. Nothing serialised the three entry points either
-- (the cron, POST /api/admin/check-releases, the script): two overlapping sweeps both
-- read "not sent", both delivered to every channel.
--
-- The primary key IS the dedupe. services/jobs.js#REMINDER_LOG claims a reminder with
-- INSERT ... ON CONFLICT DO NOTHING RETURNING before sending, so exactly one sweep --
-- in any process -- wins each (user, game, threshold), and the claim is released
-- again when no channel delivered.
--
-- Keyed on user_id, not username like the file: CASCADE removes an account's log with
-- the account, and a username can be deleted and re-created by someone else.
--
-- NOT SEEDED from sent_notifications.json. A reminder is keyed by its threshold
-- (`7days`), and yesterday's thresholds can never match again, so the only thing the
-- old log still guards is a reminder ALREADY sent today being re-sent by a second
-- sweep on the day this migration lands. That is at most one duplicate per game, once.
CREATE TABLE IF NOT EXISTS sent_reminders (
  user_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- TEXT, 'igdb_12345' -- the same rule as user_games.game_id. No FK to user_games:
  -- a reminder that was sent stays sent if the game is removed and re-added.
  game_id  TEXT        NOT NULL,
  -- '30days', '7days', '0days' -- the threshold, as the file stored it.
  type     TEXT        NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id, type)
);
