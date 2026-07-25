// Script to manually trigger notification checks.
//
// This must mirror the daily cron in index.js (search "[CRON]") exactly. It
// previously diverged in two ways that made it actively harmful to run:
//   1. It hardcoded 30/7/0-day reminders and ignored users.notification_days, so a
//      user with a custom schedule got the wrong reminders.
//   2. It marked the release-day reminder as type 'release' while the cron uses
//      '0days'. Those are different dedup keys, so running this script re-sent a
//      day-0 reminder the cron had already delivered.
const {
  getAllUsers, getUserGames, wasNotificationSent, markNotificationSent,
  sendReleaseReminder, db, notifyEvent,
} = require('./index.js');

const DEFAULT_NOTIFICATION_DAYS = [0, 7, 30];

function getNotificationDays(username) {
  return new Promise((resolve) => {
    db.get('SELECT notification_days FROM users WHERE username = ?', [String(username).toLowerCase()], (err, row) => {
      if (err || !row || !row.notification_days) return resolve(DEFAULT_NOTIFICATION_DAYS);
      try {
        const parsed = JSON.parse(row.notification_days);
        resolve(Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_NOTIFICATION_DAYS);
      } catch {
        resolve(DEFAULT_NOTIFICATION_DAYS);
      }
    });
  });
}

function loadUserGames(username) {
  return new Promise((resolve) => {
    getUserGames(username, (err, games) => resolve(err ? [] : (games || [])));
  });
}

function daysUntil(releaseDate) {
  const release = new Date(releaseDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  release.setHours(0, 0, 0, 0);
  return Math.ceil((release - today) / (1000 * 60 * 60 * 24));
}

function markReleased(username, game) {
  return new Promise((resolve) => {
    db.run(
      'UPDATE user_games SET status = ? WHERE user_id = (SELECT id FROM users WHERE username = ?) AND game_id = ?',
      ['wishlist', String(username).toLowerCase(), game.game_id],
      (err) => {
        if (err) {
          console.error(`[MANUAL] Failed to update status for ${game.game_name} (user: ${username}):`, err.message);
          return resolve();
        }
        console.log(`[MANUAL] "${game.game_name}" released — status unreleased -> wishlist for ${username}`);
        notifyEvent('release', { gameName: game.game_name, coverUrl: game.cover_url }, username, 'wishlist')
          .catch(e => console.error(`[MANUAL] Release notification failed for ${game.game_name}:`, e.message))
          .finally(resolve);
      }
    );
  });
}

async function run() {
  console.log('[MANUAL] Running notification check...');

  const users = await new Promise((resolve, reject) => {
    getAllUsers((err, list) => (err ? reject(err) : resolve(list)));
  });

  for (const username of users) {
    const notifDays = await getNotificationDays(username);
    const games = await loadUserGames(username);
    let found = false;

    for (const game of games) {
      if (game.status !== 'unreleased' || !game.release_date) continue;

      const diffDays = daysUntil(game.release_date);
      console.log(`[MANUAL] User: ${username}, Game: ${game.game_name}, Release: ${game.release_date}, diffDays: ${diffDays}, notifDays: ${JSON.stringify(notifDays)}`);

      if (diffDays <= 0) {
        await markReleased(username, game);
        found = true;
        continue;
      }

      // Same key format as the cron: `${diffDays}days`.
      if (!notifDays.includes(diffDays)) continue;
      const type = `${diffDays}days`;

      if (wasNotificationSent(username, game.game_id, type)) {
        console.log(`[MANUAL] Already sent: ${username}, ${game.game_name}, ${type}`);
        continue;
      }

      console.log(`[MANUAL] Sending ${type} reminder to ${username} for ${game.game_name}`);
      try {
        await sendReleaseReminder(username, game, diffDays);
        markNotificationSent(username, game.game_id, type);
        console.log(`[MANUAL] Sent ${type} reminder to ${username} for ${game.game_name}`);
      } catch (err) {
        console.error(`[MANUAL] Failed to send ${type} reminder to ${username} for ${game.game_name}:`, err.message);
      }
      found = true;
    }

    if (!found) console.log(`[MANUAL] No matching unreleased games for user ${username}`);
  }

  console.log('[MANUAL] Notification check complete.');
}

run()
  .catch(err => {
    console.error('[MANUAL] Notification check failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
