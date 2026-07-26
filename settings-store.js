// settings.json — the single reader/writer, with its mtime-validated cache.
//
// Extracted from index.js so services/settings.js can reach it WITHOUT a second
// cache. Two caches over one file is a bug generator: a write through one leaves
// the other serving a stale LDAP bind DN or API key until an unrelated mtime change
// happens to invalidate it.
//
// This module owns the file for the SERVER: nothing in index.js or services/ may
// read or write settings.json any other way, and it is the only writer anywhere.
//
// Two operator scripts (test_ldap_sync.js, backfill_ldap_display_names.js) do read
// the file themselves, on purpose. loadSettings() returns EMPTY_SETTINGS for both a
// missing file and a corrupt one, which is right for a server that must keep
// serving but wrong for a diagnostic tool — those scripts have to tell the operator
// "not valid JSON" rather than "no LDAP configured". They never write.

const fs = require('fs');
const path = require('path');

// Absolute path. This was a bare relative 'settings.json', resolved against
// process.cwd() — so a utility script run from another directory silently read,
// or worse created, a DIFFERENT settings file.
//
// __dirname is the repo root, which is why this module lives here and not under
// services/: the path would then depend on the directory depth of its own file.
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

// The full result of a read: the settings, plus whether they are TRUSTWORTHY.
//
// A missing file is normal on a fresh install and yields EMPTY_SETTINGS, not
// degraded. Anything else — corrupt JSON, EACCES, EIO, a JSON document that is not
// an object — ALSO yields EMPTY_SETTINGS, and that is the dangerous case: it is
// indistinguishable from "nothing is configured" unless the caller is told.
//
// It is not hypothetical. saveSettings truncates in place (flag 'w'), so a container
// kill or a full disk mid-write leaves exactly a corrupt file. Any writer that then
// reconstructs the file from this value writes the emptiness back permanently:
//
//   truncate settings.json; POST /api/settings {} as ANY authenticated user
//   → 200, and the SMTP password, LDAP bind password, Telegram token and all five
//     API keys are gone from disk — from a request that changed nothing.
//
// Readers can carry on with the defaults. WRITERS MUST NOT: see services/settings.js.
function readSettings() {
  try {
    const { mtimeMs } = fs.statSync(SETTINGS_FILE);
    if (settingsCache && mtimeMs === settingsMtimeMs) return { settings: settingsCache, degraded: false };
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // `{...EMPTY, ...null}` and `{...EMPTY, ...[1,2]}` both "succeed" and produce
    // something that reads as an empty config, which is the trap above by another door.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json does not contain a JSON object');
    }
    settingsCache = { ...EMPTY_SETTINGS, ...parsed };
    settingsMtimeMs = mtimeMs;
    return { settings: settingsCache, degraded: false };
  } catch (err) {
    settingsCache = null;
    settingsMtimeMs = -1;
    if (err.code === 'ENOENT') return { settings: EMPTY_SETTINGS, degraded: false };
    // Used to degrade silently to "no SMTP, no LDAP, no API keys" with no log line
    // at all, which is a miserable thing to debug from the admin's side.
    console.error('[settings] Failed to read/parse settings.json:', err.message);
    return { settings: EMPTY_SETTINGS, degraded: true, reason: err.message };
  }
}

// The read every consumer wants: just the settings, defaults on failure. Callers
// that are about to WRITE must use readSettings() and honour `degraded`.
const loadSettings = () => readSettings().settings;

// Write the whole file. THROWS on failure — deliberately.
//
// This used to swallow the error after logging it, so a full disk or a read-only
// mount produced `{"success":true}` at the API while nothing had been written. The
// admin's next GET even confirmed the change, because it was served from the cache
// this function had already updated. Every 500 branch in the settings adapters was
// unreachable. Callers must let the throw propagate.
function saveSettings(settings) {
  try {
    // mode 0600: this file holds the SMTP password, the LDAP bind password and the
    // Telegram bot token. The default 0644 made it world-readable in the container.
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { flag: 'w', mode: 0o600 });
    // `mode` applies ONLY when writeFileSync creates the file. A settings.json that
    // already exists at 0644 — created by hand, restored from a backup, or written
    // by this code before the mode was added — kept those permissions through every
    // subsequent save, so the comment above was true of new installs only. Measured:
    // an existing 0644 file was still 0644 after a save.
  } catch (err) {
    console.error('Failed to write settings.json:', err.message);
    // Never keep serving a cache we cannot vouch for: the write may have been
    // partial, so what is on disk is now unknown.
    settingsCache = null;
    settingsMtimeMs = -1;
    throw err;
  }
  // Not fatal, and deliberately outside the throwing block: the content IS on disk,
  // so failing the admin's save would be wrong. A container that cannot chmod its
  // own bind-mounted file (not the owner) is a deployment issue to shout about, not
  // a reason to reject the write.
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (err) {
    console.warn('[settings] Could not set settings.json to 0600 — it may be readable by other'
      + ' users in this container. It holds the SMTP, LDAP and Telegram credentials:', err.message);
  }

  settingsCache = { ...EMPTY_SETTINGS, ...settings };
  try { settingsMtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs; } catch { settingsMtimeMs = -1; }
  console.log('settings.json created/updated.');
}

// The effective value of one API key, and where it came from.
//
// settings.json wins over the environment so an admin can rotate a key from the UI
// without a redeploy. That precedence is defined ONCE, here: it was implemented
// twice before (a resolver in index.js and a lister in the settings service), and
// the two promptly drifted — the IGDB client secret was readable from the
// environment by one and not the other, so the UI reported it unset while a search
// using it worked.
//
// `name` may be given in either case: 'RAWG_API_KEY' or 'rawg_api_key'.
function apiKeyStatus(name, env = process.env) {
  const fromSettings = String(loadSettings()?.apikeys?.[String(name).toLowerCase()] ?? '').trim();
  const fromEnv = String(env[String(name).toUpperCase()] ?? '').trim();
  return {
    value: fromSettings || fromEnv,
    source: fromSettings ? 'settings' : (fromEnv ? 'env' : 'none'),
  };
}

const resolveApiKey = (name, env = process.env) => apiKeyStatus(name, env).value;

module.exports = {
  SETTINGS_FILE, EMPTY_SETTINGS,
  readSettings, loadSettings, saveSettings, apiKeyStatus, resolveApiKey,
};
