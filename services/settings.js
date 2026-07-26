// Server settings (`settings.json`) — the ADMIN-EDITING surface: masking, section
// merging, and the role-dependent read. SMTP, LDAP, Telegram, ntfy, Gotify, API keys.
//
// THIS IS NOT THE READ PATH FOR CONSUMERS. Everything that actually USES a setting —
// the SMTP sender, the ntfy/Gotify/Telegram dispatchers, LDAP bind, API-key
// resolution — needs the UNMASKED value and calls settings-store directly. Routing
// them through readForRole() hands them the string '__unchanged__' where a password
// belongs, and the failure surfaces as an authentication error against the remote
// service, pointing nowhere near its cause. Notifications, when extracted, depends
// on settings-store, not on this module.
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

const { readSettings, loadSettings, saveSettings, apiKeyStatus } = require('../settings-store');
const { serviceError, CODES } = require('./errors');

// Every section this service will read out or write back. An ALLOWLIST in both
// directions, deliberately.
//
// The read used to be a denylist — `const { apikeys, ...rest }` — which stripped the
// one section it knew about and returned everything else. A section added by hand to
// settings.json (an `oidc` block, say) was therefore served to admins UNMASKED,
// while the next write, being an allowlist, silently deleted it. Leaking on read and
// destroying on write is the worst of both; pick one, and allowlist is the one.
const SECTIONS = ['smtp', 'ldap', 'telegram', 'ntfy', 'gotify'];

// Sections only an administrator may write. `ntfy` and `gotify` are here because
// they are the INSTANCE-WIDE fallback servers, not a user's personal ones.
//
// Currently identical to SECTIONS, and kept separate on purpose: one is "what this
// file contains", the other is "who may change it". Merging them would make a future
// user-writable section silently admin-only, or worse, the reverse.
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
    if (!out?.[section] || !Object.prototype.hasOwnProperty.call(out[section], key)) continue;
    const val = out[section][key];
    // Any non-empty value, WHATEVER ITS TYPE. `typeof val === 'string'` let a
    // hand-edited numeric SMTP password — `"pass": 987654321`, not exotic — straight
    // through to the admin's browser, devtools and any proxy log on the way, which
    // is precisely what this function exists to prevent.
    if (val !== null && val !== undefined && val !== '') out[section][key] = SECRET_PLACEHOLDER;
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
  // A section must be an object. Spreading anything else quietly wrote its indices
  // in: `{"ldap":"pwn"}` stored `{"0":"p","1":"w","2":"n"}` alongside the real keys,
  // and a long string stored one key per character. Nothing was destroyed, but the
  // file ends up full of junk that only a hand edit can remove.
  //
  // `null` still means "no change", which is how it already behaved.
  if (incomingSection !== undefined && incomingSection !== null
      && (typeof incomingSection !== 'object' || Array.isArray(incomingSection))) {
    throw serviceError(CODES.VALIDATION, `${sectionName} must be an object`, { field: sectionName });
  }
  const prior = existing?.[sectionName] || {};
  const section = { ...prior, ...(incomingSection || {}) };
  for (const [sec, key] of SECRET_FIELDS) {
    if (sec !== sectionName) continue;
    if (section[key] === SECRET_PLACEHOLDER) {
      // `!== undefined`, not `typeof === 'string'`: a stored secret of any other
      // type failed that test, so "leave it alone" DELETED it — the exact partial-
      // write class of bug this comment block is about, surviving inside the fix.
      if (prior[key] !== undefined) section[key] = prior[key];
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
// As readForRole, but also says whether the file could be read at all.
//
// A degraded read serves five empty sections, which is indistinguishable from an
// unconfigured server: the admin sees a blank but plausible Settings page, edits it,
// and only then discovers the write is refused. The flag lets the UI say so up front.
// Admin-only, like the rest of the body — it is a fact about the server's internals.
function readForRoleWithStatus(isAdmin) {
  const { degraded } = readSettings();
  return { sections: readForRole(isAdmin), degraded: isAdmin ? !!degraded : false };
}

function readForRole(isAdmin) {
  if (!isAdmin) return {};
  const all = loadSettings();
  // Allowlist, so a section this service does not know about can never be served —
  // `apikeys` above all, since it holds the IGDB client secret and has its own
  // admin-only endpoint, but equally anything a future version or a hand edit adds.
  const picked = {};
  for (const name of SECTIONS) picked[name] = all[name] || {};
  return maskSecrets(picked);
}

// Refuse to write when the current contents could not be read.
//
// Every writer here reconstructs the whole file from what it just loaded, and a
// failed load looks exactly like an empty config. Persisting that turns one unreadable
// file into permanently erased credentials — see readSettings() in settings-store.js
// for the measured sequence. The only safe move is to stop and say why.
function loadForWrite() {
  const { settings, degraded, reason } = readSettings();
  if (degraded) {
    throw serviceError(CODES.CONFLICT,
      'settings.json could not be read, so it cannot be safely updated — saving now would '
      + 'erase the stored credentials. Fix or restore the file first.', { reason });
  }
  return settings;
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
  const canWrite = (k) => body[k] !== undefined && (isAdmin || !ADMIN_ONLY_SETTINGS.includes(k));

  // A body with nothing writable in it does NOT touch the file.
  //
  // "Succeeds having changed nothing" used to mean a full truncate-in-place rewrite:
  // every authenticated non-admin could POST {} on a loop and rewrite the credential
  // file as fast as they liked. Two things came of that. Any section this service
  // does not know about — a hand-added `oidc` block and its client secret — was
  // deleted by a request from someone not allowed to change anything. And since
  // there is deliberately no atomic rename here (settings.json is a single-file bind
  // mount; a rename would detach it), every rewrite is a crash window that leaves the
  // corrupt file loadForWrite() now refuses to write over. An unprivileged caller
  // should not get to open that window at all, let alone on demand.
  if (!SECTIONS.some(canWrite)) return;

  const existing = loadForWrite();
  const next = {
    // Never writable here — managed by the dedicated API-keys endpoint.
    apikeys: existing.apikeys || {},
  };
  for (const name of SECTIONS) {
    next[name] = canWrite(name) ? mergeSection(body[name], name, existing) : (existing[name] || {});
  }
  saveSettings(next);
}

// Show the last 6 characters only, so an admin can tell which key is loaded without
// the value being readable from a screenshot or a shared log.
function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 6 ? '••••••' : `••••••••${s.slice(-6)}`;
}

// Per-key status: is it set, and did it come from settings.json or the environment?
//
// Presentation only. The settings-over-env precedence is settings-store's, not a
// second copy — see apiKeyStatus() there for what that duplication already cost.
function listApiKeys(env = process.env) {
  const out = {};
  for (const name of API_KEY_NAMES) {
    const { value, source } = apiKeyStatus(name, env);
    out[name] = { masked: maskKey(value), set: !!value, source };
  }
  return out;
}

// What an incoming API-key value means. Named and exported so the regression below
// is testable without touching disk.
//
// A blanket `String(value)` stores the four characters "null" for `{"rawg_api_key":
// null}` — and "null" reads as SET everywhere: the UI shows a key, and every search
// authenticates with the literal word until someone works out why RAWG answers 401.
// `false`, `0` and `{}` fail the same way ("false", "0", "[object Object]"). The
// browser form only ever sends strings; a generated client — the whole reason
// /api/v2 exists — sends the others routinely.
//
// Falsy CLEARS, which is v1's behaviour (`String(v || '').trim()`) and the only way
// an admin can remove a stored key. A non-string that isn't one of those is a client
// bug, so say so rather than storing its stringification.
function normalizeApiKeyValue(value, name = 'api key') {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return '';
  if (typeof value !== 'string') {
    throw serviceError(CODES.VALIDATION, `${name} must be a string`, { field: name });
  }
  return value.trim();
}

// Write API keys. Unknown keys are dropped rather than stored.
function writeApiKeys(body) {
  // Same no-op rule as write(): a body naming no key rewrites nothing. This route is
  // admin-only, so it is not the privilege-escalation half of that problem, but it is
  // the same needless crash window over the same file.
  if (!API_KEY_NAMES.some((name) => body[name] !== undefined)) return loadSettings().apikeys || {};
  const existing = loadForWrite();
  const apikeys = { ...(existing.apikeys || {}) };
  for (const name of API_KEY_NAMES) {
    if (body[name] !== undefined) apikeys[name] = normalizeApiKeyValue(body[name], name);
  }
  saveSettings({ ...existing, apikeys });
  return apikeys;
}

// Persist a freshly-minted IGDB bearer token.
function storeIgdbToken(token) {
  const existing = loadForWrite();
  const apikeys = { ...(existing.apikeys || {}), igdb_bearer_token: String(token).trim() };
  saveSettings({ ...existing, apikeys });
  return maskKey(apikeys.igdb_bearer_token);
}

module.exports = {
  SECTIONS, ADMIN_ONLY_SETTINGS, SECRET_PLACEHOLDER, SECRET_FIELDS, API_KEY_NAMES,
  maskSecrets, mergeSection, readForRole, readForRoleWithStatus, write,
  maskKey, normalizeApiKeyValue, listApiKeys, writeApiKeys, storeIgdbToken,
};
