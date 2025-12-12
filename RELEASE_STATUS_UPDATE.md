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
5. **Pre-release Notifications**: Still sends 30-day, 7-day, and release-day reminders for unreleased games

### Code Changes

#### 1. Modified Cron Job (`index.js` lines 1001-1050)
- Added logic to check if `diffDays <= 0` (game has been released)
- Automatically updates status from "unreleased" to "wishlist"
- Sends release notification when status is updated

#### 2. Updated Manual Script (`run_notifications.js`)
- Added same logic for manual testing
- Can be run with: `node run_notifications.js`

#### 3. New API Endpoint (`/api/admin/check-releases`)
- Manual trigger for testing (requires admin permissions)
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
[CRON] User: john, Game: Cyberpunk 2077, Release: 2023-12-07, diffDays: -5
[CRON] Game "Cyberpunk 2077" has been released! Updating status from unreleased to wishlist for user john
[CRON] Successfully updated status for game Cyberpunk 2077 (user: john) from unreleased to wishlist
```

### Benefits
1. **Automatic Updates**: Games automatically move from "unreleased" to "wishlist" when released
2. **User Notifications**: Users get notified when their unreleased games are released
3. **No Manual Intervention**: No need to manually check and update game statuses
4. **Backward Compatible**: Existing functionality for pre-release notifications remains unchanged

### Configuration
The cron job runs daily at 8:00 AM. To change the schedule, modify the cron expression in `index.js`:
```javascript
cron.schedule('0 8 * * *', () => {
  // Your code here
});
```

### Troubleshooting
- Check server logs for `[CRON]` entries to see if the job is running
- Use the manual script or API endpoint to test immediately
- Ensure the database has proper permissions for UPDATE operations
- Verify that release dates are stored in YYYY-MM-DD format 