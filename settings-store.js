// settings.json — the single reader/writer, with its mtime-validated cache.
//
// Extracted from index.js so services/settings.js can reach it WITHOUT a second
// cache. Two caches over one file is a bug generator: a write through one leaves
// the other serving a stale LDAP bind DN or API key until an unrelated mtime change
// happens to invalidate it.
//
// This module owns the file. Nothing else may read or write settings.json directly.

const fs = require('fs');
const path = require('path');

// Absolute path. This was a bare relative 'settings.json', resolved against
// process.cwd() — so a utility script run from another directory silently read,
// or worse created, a DIFFERENT settings file. Matches STATUS_CACHE_FILE below.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const EMPTY_SETTINGS = { smtp: {}, ntfy: {}, gotify: {}, telegram: {}, ldap: {}, apikeys: {} };

// loadSettings() sits on the hot path — resolveApiKey() calls it ~10x per search,
// and every login, notification and settings read goes through it. Doing a
// synchronous readFileSync each time blocks the single-threaded event loop against
// a single-file Docker bind mount: if that host path ever stalls, the whole server
// stalls. Cache the parsed object and validate it with a much cheaper statSync.
//
// mtime validation (rather than only invalidating inside saveSettings) keeps
// EXTERNAL writers working — the utility scripts and any `docker exec` edit — so an
// admin's change still takes effect immediately, as CLAUDE.md advertises.
let settingsCache = null;
let settingsMtimeMs = -1;

function loadSettings() {
  try {
    const { mtimeMs } = fs.statSync(SETTINGS_FILE);
    if (settingsCache && mtimeMs === settingsMtimeMs) return settingsCache;
    settingsCache = { ...EMPTY_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    settingsMtimeMs = mtimeMs;
    return settingsCache;
  } catch (err) {
    // A missing file is normal on a fresh install. A corrupt one is NOT — it used
    // to degrade silently to "no SMTP, no LDAP, no API keys" with no log line at
    // all, which is a miserable thing to debug from the admin's side.
    if (err.code !== 'ENOENT') {
      console.error('[settings] Failed to read/parse settings.json:', err.message);
    }
    settingsCache = null;
    settingsMtimeMs = -1;
    return EMPTY_SETTINGS;
  }
}

function saveSettings(settings) {
  try {
    // mode 0600: this file holds the SMTP password, the LDAP bind password and the
    // Telegram bot token. The default 0644 made it world-readable in the container.
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { flag: 'w', mode: 0o600 });
    settingsCache = { ...EMPTY_SETTINGS, ...settings };
    try { settingsMtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs; } catch { settingsMtimeMs = -1; }
    console.log('settings.json created/updated.');
  } catch (err) {
    console.error('Failed to write settings.json:', err);
    // Never keep serving a cache we cannot vouch for.
    settingsCache = null;
    settingsMtimeMs = -1;
  }
}


module.exports = { SETTINGS_FILE, EMPTY_SETTINGS, loadSettings, saveSettings };
