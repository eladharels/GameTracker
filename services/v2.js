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

// The code used when nothing in the table matches — a bug or a database failure.
const CODE_INTERNAL = 'internal';

// Codes the spec publishes that no service emits yet. Each is a written decision, not
// a gap: they exist so a client can learn to branch on them before the server can
// produce them. test/openapi.test.js keeps this list and the spec's enum in step.
const PLANNED_CODES = Object.freeze({
  rate_limited: { status: 429, title: 'Too many requests', expose: false },
  provider_unavailable: { status: 502, title: 'Upstream provider unavailable', expose: false },
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

module.exports = {
  toProblem, send, libraryGame, me, token, tokenCreated, notificationSettings,
  PLANNED_CODES, WWW_AUTHENTICATE,
};
