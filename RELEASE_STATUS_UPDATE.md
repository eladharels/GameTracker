# Release Status Update Solution

## Problem
When games were added to the library as "unreleased", they would remain in that status even after their release date passed because the app wasn't automatically checking and updating their status.

## Solution
The system now automatically updates game status from "unreleased" to "wishlist" when the release date has passed.

### How It Works

1. **Daily Cron Job**: Runs every day at 8:00 AM (`0 8 * * *`)
2. **Release Date Check**: For each unreleased game, calculates days until/since release
3. **Status Update**: If `diffDays <= 0` (game has been released), automatically updates status to "wishlist"
4. **Notification**: Sends a release notification to the user
5. **Pre-release Notifications**: Still sends reminders for unreleased games. These are no
   longer hardcoded to 30/7/0 days — each user's schedule comes from `users.notification_days`
   (a JSON array, default `[0, 7, 30]`, editable on the My Account page). A reminder fires when
   `diffDays` matches one of the user's configured values.

### Code Changes

#### 1. The sweep itself — now `services/jobs.js#checkReleases()`
- Checks whether `diffDays <= 0` (the game has been released)
- Updates status from "unreleased" to "wishlist", recording the transition in
  `user_game_status_events` with `source = 'release_sweep'` — **not** `'user'`, so a nightly run
  never counts as an achievement on the statistics page
- Sends a release notification when the status is updated
- Loads each user's `notification_days` preference before evaluating reminders
- `index.js` schedules it at `0 8 * * *`; the admin route and `run_notifications.js` call the same
  function. It existed in **four** copies that had drifted before it was extracted here

#### 2. Manual Script (`run_notifications.js`)
- Can be run with: `node run_notifications.js`, inside the backend container
- **It no longer reimplements the sweep.** It calls `services/jobs.js#checkReleases()` — the same
  function the cron schedule and `POST /api/admin/check-releases` call, and the only
  implementation there is. It therefore reads each user's `users.notification_days` like
  everything else.
- An earlier revision of this file described the script as carrying its own hardcoded 30/7/0-day
  thresholds. It did, and the copy had drifted twice: besides ignoring `notification_days` it
  marked the release-day reminder with a different dedup key than the cron, so running it re-sent
  a day-0 reminder the cron had already delivered. "This must mirror the cron exactly" is not
  something a comment can enforce, which is why there is now nothing to mirror.

#### 3. API Endpoint (`POST /api/admin/check-releases`)
- Manual trigger for testing
- Guarded by `authRequired` + `requirePermission('can_manage_users')` — a valid JWT for a user
  with the admin flag is required
- Returns detailed results of what was updated

### Testing

#### Method 1: Manual Script
```bash
node run_notifications.js
```

#### Method 2: API Endpoint (Admin only)
```bash
curl -X POST http://your-server:3000/api/admin/check-releases \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Method 3: Wait for Daily Cron
The system will automatically check every day at 8:00 AM.

### Example Output
```
[CRON] User: john, Game: Cyberpunk 2077, Release: 2023-12-07, diffDays: -5, notifDays: [0,7,30]
[CRON] Game "Cyberpunk 2077" has been released! Updating status from unreleased to wishlist for user john
[CRON] Successfully updated status for game Cyberpunk 2077 (user: john) from unreleased to wishlist
```

### Benefits
1. **Automatic Updates**: Games automatically move from "unreleased" to "wishlist" when released
2. **User Notifications**: Users get notified when their unreleased games are released
3. **No Manual Intervention**: No need to manually check and update game statuses
4. **Backward Compatible**: Pre-release reminders still work; their schedule is now per-user
   (`users.notification_days`), defaulting to the original 0/7/30-day behaviour

### Configuration
The job runs daily at 8:00 AM. To change the schedule, edit the expression in `index.js`:
```javascript
scheduleWhenServer('0 8 * * *', () => { /* … */ });
```
**`scheduleWhenServer()`, never `cron.schedule()` directly.** `index.js` is `require`d by the
operator scripts for its exports, and a bare `cron.schedule()` at module scope registered all
three jobs on import: node-cron's timers keep the event loop alive, so `run_notifications.js`
printed "complete", closed the pool and then hung forever — and the 04:00 CrackWatch job, which
needs no database, really did run a full unrequested sweep from a stray process.

### Troubleshooting
- Check server logs for `[CRON]` entries to see if the job is running
- Use the manual script or API endpoint to test immediately
- Ensure the database has proper permissions for UPDATE operations
- Verify that release dates are stored in YYYY-MM-DD format 