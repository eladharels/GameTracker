# Notification System Fixes

## Issues Addressed

### 1. Duplicate Notifications
**Problem**: Users received the same notification twice for games about to be released.

**Solution**: 
- Improved notification tracking by storing timestamps instead of boolean flags
- Added better logging to track when notifications are sent vs. already sent
- Enhanced error handling to prevent duplicate sends

**Files Modified**: `index.js`
- Updated `markNotificationSent()` to store timestamps
- Added logging in cron job to show when notifications are already sent
- Added error handling for notification sending

### 2. Uninformative ntfy Messages
**Problem**: ntfy messages only said "you" instead of showing which user performed the action.

**Solution**: 
- Updated `notifyEvent()` function to include username in ntfy messages
- Changed message format from "You added..." to "User {username} added..."

**Files Modified**: `index.js`
- Updated notification message templates in `notifyEvent()` function

### 3. Per-User Email Notifications
**Problem**: All users received notifications to a single email address instead of their own emails.

**Solution**: 
- Implemented LDAP email lookup functionality
- Updated notification system to send emails to individual users
- Added automatic email fetching during LDAP authentication
- Created fallback system to get emails from LDAP if not in database

**Files Modified**: `index.js`
- Added `getLdapEmail()` function to fetch emails from Active Directory
- Added `getUserEmail()` function to get email from database or LDAP
- Updated `sendReleaseReminder()` to send emails to individual users
- Enhanced LDAP authentication to fetch and store user emails
- Updated LDAP search to include email attributes (`mail`, `email`)

## Technical Details

### LDAP Email Integration
- **Search Attributes**: Added `mail` and `email` to LDAP search attributes
- **Automatic Storage**: User emails are automatically fetched and stored during LDAP login
- **Fallback System**: If email not in database, system queries LDAP and updates database
- **Error Handling**: Graceful fallback if LDAP is not configured or unavailable

### Notification Tracking
- **Timestamp Storage**: Notifications now store ISO timestamps instead of boolean flags
- **Better Logging**: Added detailed logging to track notification status
- **Duplicate Prevention**: Enhanced checks to prevent duplicate notifications

### Email Delivery
- **Per-User Delivery**: Each user receives notifications at their own email address
- **LDAP Integration**: Emails are automatically pulled from Active Directory
- **Database Caching**: Emails are cached in database after first LDAP lookup

## Configuration Requirements

### LDAP Settings
Ensure your `settings.json` has proper LDAP configuration:
```json
{
  "ldap": {
    "url": "ldap://your-domain-controller.com",
    "base": "DC=your,DC=domain,DC=com",
    "bindDn": "CN=ServiceAccount,OU=Service Users,DC=your,DC=domain,DC=com",
    "bindPass": "service-account-password",
    "requiredGroup": "CN=GameTrackerUsers,OU=Security Groups,DC=your,DC=domain,DC=com"
  }
}
```

### SMTP Settings
Configure SMTP for email delivery:
```json
{
  "smtp": {
    "host": "your-smtp-server.com",
    "port": "587",
    "from": "GameTracker@your-domain.com",
    "user": "smtp-username",
    "pass": "smtp-password"
  }
}
```

## Testing

The notification system can be tested by:
1. Adding games with release dates 30, 7, or 0 days from today
2. Checking that notifications are sent only once per user per game per type
3. Verifying that emails are sent to individual user addresses
4. Confirming ntfy messages include username information

## Benefits

1. **No More Duplicates**: Each notification is sent only once per user per game per type
2. **Informative Messages**: ntfy messages now show which user performed actions
3. **Individual Notifications**: Each user receives notifications at their own email address
4. **Automatic Email Management**: Emails are automatically pulled from Active Directory
5. **Better Tracking**: Improved logging and error handling for notification system 