// Server settings (`settings.json`) — SMTP, LDAP, Telegram, ntfy, Gotify, API keys.
//
// Promise-free: this is synchronous file I/O behind an mtime-validated cache, and
// pretending otherwise would add ceremony without adding concurrency. Everything
// else about the service contract holds — no req/res, no HTTP status codes.
//
// AUTHORIZATION IS DIFFERENT HERE, and deliberately so. Every other route decides
// access with middleware, which test/api-surface.test.js can see. These two cannot:
// GET /api/settings returns a DIFFERENT BODY per role, and POST /api/settings
// rejects based on WHICH SECTIONS the body contains. That is content-dependent
// authorization, and no middleware can express it.
//
// So the rule takes a boolean `isAdmin` and lives in this module, where it is one
// function rather than a condition scattered through a handler. The adapter passes
// req.user.can_manage_users and does nothing else. api-surface.test.js records both
// routes as tier 'auth' with a comment saying the real check is in-handler — the
// table is honest about the gap rather than silently overstating coverage.

const { loadSettings, saveSettings } = require('../settings-store');
const { serviceError, CODES } = require('./errors');

// Sections only an administrator may write. `ntfy` and `gotify` are here because
// they are the INSTANCE-WIDE fallback servers, not a user's personal ones.
const ADMIN_ONLY_SETTINGS = ['smtp', 'ldap', 'telegram', 'ntfy', 'gotify'];

const SECRET_PLACEHOLDER = '__unchanged__';
const SECRET_FIELDS = [
  ['smtp', 'pass'],
  ['ldap', 'bindPass'],
  ['telegram', 'bot_token'],
];

const API_KEY_NAMES = [
  'igdb_client_id', 'igdb_client_secret', 'igdb_bearer_token',
  'rawg_api_key', 'thegamesdb_api_key',
];

// Replace stored secrets with a placeholder for transport. A set secret becomes
// '__unchanged__'; an unset one stays empty, so the admin UI can tell the two apart.
function maskSecrets(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  for (const [section, key] of SECRET_FIELDS) {
    const val = out?.[section]?.[key];
    if (typeof val === 'string' && val !== '') out[section][key] = SECRET_PLACEHOLDER;
  }
  return out;
}

// Merge one incoming section over the stored one.
//
// TWO ways a caller says "leave this alone", and both must work: the key is present
// and equals the placeholder (what the browser form posts back, because GET handed
// it the mask), or the key is ABSENT (what any partial-update API client sends, and
// the default idiom of a generated OpenAPI client).
//
// Only the first was handled, and the section was REPLACED rather than merged — so
// `{"ldap":{"url":"ldaps://..."}}` silently deleted bindPass, bindDn, base and
// requiredGroup, returned 200, and killed LDAP login for every user. The browser
// never tripped it because the form always posts every field.
//
// An empty string still CLEARS a value. That is the deliberate way to unset one.
function mergeSection(incomingSection, sectionName, existing) {
  const prior = existing?.[sectionName] || {};
  const section = { ...prior, ...(incomingSection || {}) };
  for (const [sec, key] of SECRET_FIELDS) {
    if (sec !== sectionName) continue;
    if (section[key] === SECRET_PLACEHOLDER) {
      if (typeof prior[key] === 'string') section[key] = prior[key];
      else delete section[key];
    }
  }
  return section;
}

// What GET /api/settings returns for this caller.
//
// Non-admins get {} — NOT a 403. Preserving v1: the SPA calls this unconditionally
// to render the Diagnostics tab and treats {} as "no server config to show".
// v2 should return 403 and let the client ask for what it may actually see.
function readForRole(isAdmin) {
  const all = loadSettings();
  // apikeys never appear here regardless of role — they hold the IGDB client secret
  // and are served, masked, only by the dedicated admin-only endpoint.
  const { apikeys, ...rest } = all;
  return isAdmin ? maskSecrets(rest) : {};
}

// Write whole sections. Only the sections present in `body` are touched.
//
// Throws FORBIDDEN when a non-admin includes ANY admin-only section. A non-admin
// posting an empty or irrelevant body succeeds having changed nothing, which is v1's
// behaviour and the reason this route is 'auth' rather than admin-gated.
function write(body, isAdmin) {
  if (!isAdmin && ADMIN_ONLY_SETTINGS.some((k) => body[k] !== undefined)) {
    throw serviceError(CODES.FORBIDDEN,
      'Only administrators can change SMTP, LDAP, or Telegram settings.');
  }
  const existing = loadSettings();
  const canWrite = (k) => body[k] !== undefined && (isAdmin || !ADMIN_ONLY_SETTINGS.includes(k));
  const section = (k) => mergeSection(body[k], k, existing);
  saveSettings({
    smtp: canWrite('smtp') ? section('smtp') : (existing.smtp || {}),
    ldap: canWrite('ldap') ? section('ldap') : (existing.ldap || {}),
    telegram: canWrite('telegram') ? section('telegram') : (existing.telegram || {}),
    ntfy: canWrite('ntfy') ? section('ntfy') : (existing.ntfy || {}),
    gotify: canWrite('gotify') ? section('gotify') : (existing.gotify || {}),
    // Never writable here — managed by the dedicated API-keys endpoint.
    apikeys: existing.apikeys || {},
  });
}

// Show the last 6 characters only, so an admin can tell which key is loaded without
// the value being readable from a screenshot or a shared log.
function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 6 ? '••••••' : `••••••••${s.slice(-6)}`;
}

// Per-key status: is it set, and did it come from settings.json or the environment?
function listApiKeys(env = process.env) {
  const keys = loadSettings().apikeys || {};
  const out = {};
  for (const name of API_KEY_NAMES) {
    const fromSettings = (keys[name] || '').trim();
    const fromEnv = (env[name.toUpperCase()] || '').trim();
    const effective = fromSettings || fromEnv;
    out[name] = {
      masked: maskKey(effective),
      set: !!effective,
      source: fromSettings ? 'settings' : (fromEnv ? 'env' : 'none'),
    };
  }
  return out;
}

// Write API keys. Unknown keys are dropped rather than stored.
function writeApiKeys(body) {
  const existing = loadSettings();
  const apikeys = { ...(existing.apikeys || {}) };
  for (const name of API_KEY_NAMES) {
    if (body[name] !== undefined) apikeys[name] = String(body[name]).trim();
  }
  saveSettings({ ...existing, apikeys });
  return apikeys;
}

// Persist a freshly-minted IGDB bearer token.
function storeIgdbToken(token) {
  const existing = loadSettings();
  const apikeys = { ...(existing.apikeys || {}), igdb_bearer_token: String(token).trim() };
  saveSettings({ ...existing, apikeys });
  return maskKey(apikeys.igdb_bearer_token);
}

module.exports = {
  ADMIN_ONLY_SETTINGS, SECRET_PLACEHOLDER, SECRET_FIELDS, API_KEY_NAMES,
  maskSecrets, mergeSection, readForRole, write,
  maskKey, listApiKeys, writeApiKeys, storeIgdbToken,
};
