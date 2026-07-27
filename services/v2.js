// The v2 wire format: one problem+json renderer and one camelCase mapper.
//
// Everything here is ONE implementation of a decision recorded in API_V2_DESIGN.md
// and specified in openapi/gametracker-v2.yaml. Nothing in this file talks to the
// database or to req/res — the adapters in index.js do that, so /api and /api/v2 stay
// two skins over the same services.
//
// WHY A SECOND RENDERER RATHER THAN CHANGING problem.js: v1's `{error: string}` is
// frozen and every SPA call site reads `data.error`. services/problem.js already holds
// the single code -> {status, title, expose} table, so this reuses that table and only
// changes how it is written out. The `expose` column keeps its meaning: a message the
// table says must not be shown is not shown here either.

const { PROBLEMS } = require('./problem');
const { serviceError, CODES } = require('./errors');

// The code used when nothing in the table matches — a bug or a database failure.
const CODE_INTERNAL = 'internal';

// Codes the spec publishes that no service emits yet. Each is a written decision, not
// a gap: they exist so a client can learn to branch on them before the server can
// produce them. test/openapi.test.js keeps this list and the spec's enum in step.
const PLANNED_CODES = Object.freeze({
  rate_limited: { status: 429, title: 'Too many requests', expose: false },
  settings_unreadable: { status: 409, title: 'Settings could not be read', expose: false },
  internal: { status: 500, title: 'Internal error', expose: false },
});

const SPEC = Object.freeze({ ...PLANNED_CODES, ...PROBLEMS });

// RFC 9457. `type` is a stable identifier a client can branch on, and `code` repeats it
// as a plain member because branching on a URI substring is worse than branching on a
// word — v1 had neither, so a client could only match on English prose.
//
// `detail` appears ONLY when the table says the message may be exposed. That is the
// same rule services/problem.js applies to v1, carried onto a format that invites
// putting an exception message in a field named `detail`.
function toProblem(err, { fallbackStatus = 500 } = {}) {
  const spec = SPEC[err?.code];
  if (!spec) {
    // Unrecognised: a bug or a database failure. Never pattern-matched into a 4xx, and
    // never echoing err.message — the same reasoning as problem.js's 500 branch.
    return {
      status: fallbackStatus,
      body: {
        type: '/problems/internal',
        title: 'Internal error',
        status: fallbackStatus,
        code: CODE_INTERNAL,
      },
    };
  }
  const body = {
    type: `/problems/${err.code}`,
    title: spec.title,
    status: spec.status,
    code: err.code,
  };
  if (spec.expose && err.message) body.detail = String(err.message).slice(0, 500);
  // Normalised and expose-gated. Copying the array verbatim bypassed the `expose`
  // column that the line below correctly honours — a pre-built leak for the first
  // service to attach field errors to a withheld code, and a shape the spec's
  // `errors` items (required field+message, no extras) would not permit.
  if (Array.isArray(err.details?.errors)) {
    body.errors = err.details.errors.map((e) => ({
      field: String(e?.field ?? ''),
      message: spec.expose ? String(e?.message ?? spec.title) : spec.title,
    }));
  } else if (err.details?.field) {
    body.errors = [{ field: err.details.field, message: spec.expose ? String(err.message) : spec.title }];
  }
  // The two problem EXTENSIONS the spec defines, each read explicitly and re-shaped —
  // never `{...err.details}`. A spread would publish whatever a service happened to
  // attach for its own use, on a body that is already going out to the caller, and the
  // spec's two extension schemas (AmbiguousGameProblem, UnknownUsersProblem) would
  // silently gain undocumented members. Adding a third extension has to be a code
  // change here, which is where it gets reviewed.
  if (Array.isArray(err.details?.candidates)) {
    body.candidates = err.details.candidates.map(catalogGame);
  }
  if (Array.isArray(err.details?.unknownUsers)) {
    // Names the CALLER sent back to the caller — no lookup, so this is not a
    // membership oracle; see the shares adapter, which is careful to keep it that way.
    body.unknownUsers = err.details.unknownUsers.map((u) => String(u));
  }
  return { status: spec.status, body };
}

// Adapter helper. Mirrors problem.send for v1, including the headersSent guard: the
// library upsert does work AFTER the response is sent, so a throw can land here with
// the headers long gone, and writing again would crash the process rather than the
// request.
function send(res, err, { log, headers } = {}) {
  const mapped = toProblem(err);
  if (log) console.error(log, err?.message || err);
  if (res.headersSent) return;
  // RFC 9110 §15.5.2 requires WWW-Authenticate on a 401, and it is the only in-band
  // signal of which scheme this API accepts.
  if (headers) res.set(headers);
  res.status(mapped.status).type('application/problem+json').json(mapped.body);
}

// Sent with every 401 so a client learns the accepted scheme from the refusal itself.
const WWW_AUTHENTICATE = Object.freeze({
  'WWW-Authenticate': 'Bearer realm="gametracker", error="invalid_token"',
});

// --- shapes ------------------------------------------------------------------

// camelCase ONCE, from one mapper. v1 emits snake_case plus duplicated
// steamAppId/crackStatus aliases because clients read both spellings; this reads the
// raw row and never calls that aliasing function, so the duplication does not leak
// into v2.
//
// `?? null` on every optional, never `|| null`: `|| null` turns a legitimate 0 or ''
// into null. backlogOrder is the live case — position 0 does not occur today, but the
// habit is what matters, and undefined must not reach the response either way, since
// JSON.stringify drops the key entirely and a client sees "field removed" rather than
// "no value".
function libraryGame(row) {
  return {
    gameId: row.game_id,
    name: row.game_name,
    coverUrl: row.cover_url ?? null,
    releaseDate: row.release_date ?? null,
    status: row.status,
    steamAppId: row.steam_app_id ?? null,
    lastPrice: row.last_price ?? null,
    lastPriceUpdatedAt: row.last_price_updated ?? null,
    crackStatus: row.crack_status ?? null,
    backlogOrder: row.backlog_order ?? null,
    addedAt: row.added_at ?? null,
  };
}

// Identity and EFFECTIVE privilege — after scope narrowing, not the account's raw
// value. An administrator using a library-scoped token sees canManageUsers false,
// which is the correct answer for what that credential can do.
function me(user, auth) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    origin: user.origin || 'local',
    canManageUsers: !!user.can_manage_users,
    scopes: auth?.scopes ?? [],
    tokenExpiresAt: auth?.expiresAt ?? null,
  };
}

// A token, NEVER its secret. `hint` is the last four characters, which is what lets an
// operator match the token in a config file against the row they are about to revoke —
// the plaintext is gone after minting and the hash is one-way.
function token(row) {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint ?? null,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

// The ONLY response that ever carries the plaintext, and only at the moment of
// minting. Kept as a separate mapper so `token()` cannot grow the field by accident:
// the listing and the creation response are different shapes on purpose.
function tokenCreated(result) {
  return {
    id: result.id,
    name: result.name,
    hint: result.hint ?? null,
    scopes: result.scopes,
    createdAt: result.createdAt ?? new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: result.expiresAt ?? null,
    token: result.token,
  };
}

// The caller's OWN delivery targets. These are bearer secrets — a Gotify application
// token lets the holder post to that user's devices — and they are returned here ONLY
// because this is the caller's own row. They appear on no other response in the API.
function notificationSettings(row) {
  return {
    email: row.email ?? null,
    ntfyUrl: row.ntfy_url ?? null,
    ntfyTopic: row.ntfy_topic ?? null,
    gotifyUrl: row.gotify_url ?? null,
    gotifyToken: row.gotify_token ?? null,
    telegramChatId: row.telegram_chat_id ?? null,
    notificationDays: row.notification_days,
  };
}

// A backlog entry. `position` rather than `backlogOrder`: this resource IS the
// ordering, so the field names what it means here rather than echoing the column.
function backlogEntry(row, index) {
  return {
    gameId: row.game_id,
    name: row.game_name ?? null,
    // The stored backlog_order may be NULL on rows predating the column, and may have
    // gaps. The client asked for "the backlog in order", so the answer is 1..n by
    // position in the returned sequence — not the raw column, which would leak the
    // storage's holes as if they meant something.
    position: index + 1,
  };
}

// A search result. Same six fields v1 emits, already camelCase — services/catalog.js
// normalises every provider into this shape — so this mapper exists to PIN it rather
// than to translate: a provider row reaching the wire unmapped is how an undocumented
// field ships, and CatalogGame is `additionalProperties: false`.
function catalogGame(row) {
  return {
    id: row.id,
    name: row.name,
    releaseDate: row.releaseDate ?? null,
    coverUrl: row.coverUrl ?? null,
    source: row.source,
    steamAppId: row.steamAppId ?? null,
  };
}

// Provider status as an ARRAY of objects, not the service's keyed map. A map keyed by
// provider name makes every new provider a breaking change to the response's shape;
// a list of {name, status, count} does not. `skipped` and `failed` stay distinct —
// "not configured" and "did not answer" are different operational facts.
function searchMeta(result) {
  const providers = Object.keys(result.providers || {}).map((name) => ({
    name,
    status: result.providers[name],
    count: result.counts?.[name] ?? 0,
  }));
  return {
    degraded: !!result.degraded,
    providers,
    // AFTER merge and de-duplication, which is what `data` holds — the per-provider
    // counts above are before it, and the two genuinely differ.
    total: (result.results || []).length,
  };
}

// One side of a sharing relationship. `displayName` falls back to the username — the
// LEFT JOIN behind this leaves it null when the account has been removed while the
// grant survives, and a client rendering `null` as a name shows an empty row rather
// than telling the owner who they are still sharing with.
function share(row) {
  return {
    username: row.username,
    displayName: row.displayName || row.username,
    sharedAt: row.sharedAt ?? null,
  };
}

// An account, as an administrator sees it.
//
// NO notification targets, in either direction. ntfy topic, Gotify token, Telegram
// chat id and the two server URLs are bearer secrets addressing a user's devices; no
// administrative function needs them, and v1 returned two of them for every user to
// every admin. The projection behind this (services/users.js#ADMIN_LIST_COLUMNS) does
// not select them, and this mapper names its fields one by one so a column added to
// that projection cannot reach the wire by simply existing.
function user(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? null,
    email: row.email ?? null,
    canManageUsers: !!row.can_manage_users,
    origin: row.origin || 'local',
    sharesLibrary: !!row.shares_library,
    createdAt: row.created_at ?? null,
  };
}

// An account, as WRITTEN. camelCase in, column names out.
//
// A STRICT ALLOWLIST, and an unknown field is a 400. Two reasons, and the second is
// the one that matters: `UserCreate` and `UserUpdate` are both
// `additionalProperties: false`, and — because this maps names — a body carrying
// `ntfy_topic` or `gotifyToken` would otherwise arrive at the service under a name its
// USER_OWNED_NOTIFICATION_COLUMNS guard does not recognise, turning a refusal into a
// silent drop. The guard still runs (it is the service's first statement); this makes
// sure the two agree on what a field is called.
const USER_WRITE_FIELDS = Object.freeze({
  password: 'password',
  email: 'email',
  canManageUsers: 'can_manage_users',
  sharesLibrary: 'shares_library',
});

function userWrite(body, { create = false } = {}) {
  const input = Object(body);
  const out = {};
  for (const key of Object.keys(input)) {
    if (create && key === 'username') { out.username = input.username; continue; }
    const column = USER_WRITE_FIELDS[key];
    if (!column) {
      throw serviceError(CODES.VALIDATION, `unknown field: ${key}`, { field: key });
    }
    out[column] = input[key];
  }
  if (create) {
    // Defaults are applied HERE rather than left to the column: the service reads
    // `fields.can_manage_users ? 1 : 0`, so an absent key already means false — this
    // only makes the spec's documented default explicit and the two impossible to
    // disagree about.
    if (out.can_manage_users === undefined) out.can_manage_users = false;
    if (out.shares_library === undefined) out.shares_library = false;
  } else if (Object.keys(out).length === 0) {
    // `minProperties: 1` in the spec. The service also refuses an empty update, but
    // with a message about SQL rather than about the request.
    throw serviceError(CODES.VALIDATION, 'send at least one field to update');
  }
  return out;
}

// --- settings ----------------------------------------------------------------
//
// The ONE place the storage names and the wire names are related. settings.json keeps
// `telegram.bot_token` and `apikeys.igdb_client_id`; the wire says `botToken` and
// `igdbClientId`. Both directions are ALLOWLISTS built from the same table, so a
// section or field that is not listed cannot be read out and cannot be written in.
const SETTINGS_FIELDS = Object.freeze({
  smtp: Object.freeze({ host: 'host', port: 'port', user: 'user', pass: 'pass', from: 'from', to: 'to' }),
  ntfy: Object.freeze({ url: 'url' }),
  gotify: Object.freeze({ url: 'url' }),
  telegram: Object.freeze({ botToken: 'bot_token' }),
  ldap: Object.freeze({ url: 'url', base: 'base', bindDn: 'bindDn', bindPass: 'bindPass', requiredGroup: 'requiredGroup' }),
});

const API_KEY_FIELDS = Object.freeze({
  igdbClientId: 'igdb_client_id',
  igdbClientSecret: 'igdb_client_secret',
  igdbBearerToken: 'igdb_bearer_token',
  rawgApiKey: 'rawg_api_key',
  thegamesdbApiKey: 'thegamesdb_api_key',
});

// Server configuration as READ. Secrets arrive already masked by
// services/settings.js#readForRole — this only renames.
//
// API keys are reported as STATE, never as a masked value. v1 emits the last six
// characters of each key, which is a disclosure and, worse, round-trips: a client that
// reads and writes back stores the mask AS the key. `configured` and `source` answer
// the question an operator actually has ("is it set, and do I edit it here or restart
// the container?") without either failure.
function maskedSettings(sections, apiKeyStates, degraded) {
  const out = { degraded: !!degraded, apikeys: {} };
  for (const [section, fields] of Object.entries(SETTINGS_FIELDS)) {
    const stored = sections?.[section] || {};
    const mapped = {};
    for (const [wire, key] of Object.entries(fields)) {
      if (stored[key] !== undefined) mapped[wire] = stored[key];
    }
    out[section] = mapped;
  }
  for (const [wire, key] of Object.entries(API_KEY_FIELDS)) {
    const state = apiKeyStates?.[key];
    out.apikeys[wire] = {
      configured: !!state?.set,
      // `?? null`, and `source` is only ever 'settings' | 'env' | null. Nothing here
      // carries any character of the key — see ApiKeyState in the spec for why that
      // is a rule rather than a preference.
      source: state?.set ? (state.source ?? null) : null,
    };
  }
  return out;
}

// Server configuration as WRITTEN: the inverse of the table above, split into the two
// stores that own the two halves.
//
// An unknown section or field is a 400, not a silent drop. The spec marks every object
// here `additionalProperties: false`, and dropping quietly is the failure mode the
// admin surface already documents for notification targets: a tool told the write
// succeeded when it did not has been told something false. It also stops junk keys
// reaching settings.json, which only a hand edit can remove.
function settingsUpdate(body) {
  const input = Object(body);
  const sections = {};
  let apikeys = null;
  for (const name of Object.keys(input)) {
    if (name === 'apikeys') {
      const incoming = Object(input.apikeys);
      apikeys = {};
      for (const wire of Object.keys(incoming)) {
        const key = API_KEY_FIELDS[wire];
        if (!key) {
          throw serviceError(CODES.VALIDATION, `unknown api key: ${wire}`, { field: `apikeys.${wire}` });
        }
        apikeys[key] = incoming[wire];
      }
      continue;
    }
    const fields = SETTINGS_FIELDS[name];
    if (!fields) {
      throw serviceError(CODES.VALIDATION, `unknown settings section: ${name}`, { field: name });
    }
    // Left as-is when it is not an object: services/settings.js#mergeSection has the
    // one type check, and duplicating it here is how the two end up disagreeing about
    // what `null` means.
    const incoming = input[name];
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      sections[name] = incoming;
      continue;
    }
    const mapped = {};
    for (const wire of Object.keys(incoming)) {
      const key = fields[wire];
      if (!key) {
        throw serviceError(CODES.VALIDATION, `unknown field: ${name}.${wire}`, { field: `${name}.${wire}` });
      }
      mapped[key] = incoming[wire];
    }
    sections[name] = mapped;
  }
  return { sections, apikeys };
}

module.exports = {
  toProblem, send, libraryGame, me, token, tokenCreated, notificationSettings, backlogEntry,
  catalogGame, searchMeta, share, user, userWrite, maskedSettings, settingsUpdate,
  SETTINGS_FIELDS, API_KEY_FIELDS, USER_WRITE_FIELDS,
  PLANNED_CODES, WWW_AUTHENTICATE,
};
