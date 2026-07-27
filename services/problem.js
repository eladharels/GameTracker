// One table mapping a service error code to an HTTP response.
//
// Every adapter used to spell this out itself — eight sites, each a short ladder of
// `if (err.code === SVC.X) return res.status(N)...`. That was survivable while the
// codes were few and the messages came from our own service layer. It stops being
// survivable at the catalog slice, because the question those ladders answer
// implicitly is not "which status?" but "MAY THIS MESSAGE BE SHOWN TO THE CALLER?",
// and catalog wraps IGDB, RAWG, TheGamesDB and Twitch, whose error text carries
// upstream detail — endpoint paths, quota state, sometimes the key that failed.
//
// So `expose` is the load-bearing column here, not `status`. A code marked
// expose:false NEVER returns err.message; the caller gets the fixed title and the
// detail goes to the server log. A new service cannot leak an upstream message by
// forgetting to write the ladder carefully — it has to declare a code, and the
// declaration is in this file where it is reviewed.
//
// The two policies the ladders had already drifted between, preserved here as the
// deliberate default: our own validation messages ARE shown (they tell the caller
// what to fix), and "not found"-shaped answers are NOT (they would otherwise let a
// caller probe for the existence of records they cannot read).
//
// Not RFC 9457 `application/problem+json` yet. v1's body shape is `{error: string}`
// and every SPA call site reads `data.error`; the envelope changes at /api/v2, and
// this table is what makes that a one-file change.

const { CODES } = require('./errors');

const PROBLEMS = Object.freeze({
  [CODES.VALIDATION]:     Object.freeze({ status: 400, title: 'Invalid request',      expose: true }),
  [CODES.UNKNOWN_USERS]:  Object.freeze({ status: 400, title: 'Unknown user',         expose: true }),
  [CODES.FORBIDDEN]:      Object.freeze({ status: 403, title: 'Forbidden',            expose: true }),
  [CODES.NOT_SHARED]:     Object.freeze({ status: 403, title: 'Not shared with you.', expose: false }),
  [CODES.UNAUTHENTICATED]: Object.freeze({ status: 401, title: 'Unauthorized',         expose: true }),
  [CODES.NOT_FOUND]:      Object.freeze({ status: 404, title: 'Not found',            expose: false }),
  [CODES.NOT_IN_BACKLOG]: Object.freeze({ status: 404, title: 'Game not in backlog',  expose: false }),
  [CODES.CONFLICT]:       Object.freeze({ status: 409, title: 'Conflict',             expose: true }),
});

// What the response WOULD be. Returns null when the error is not a ServiceError we
// recognise — the caller then owns it, which is deliberate: an unrecognised error is
// a bug or a database failure, and neither should be pattern-matched into a 4xx.
//
// `messages` lets one route override the text for one code (e.g. 'User not found'
// rather than the generic 'Not found'). It can only replace the text, never the
// status, and never turns an expose:false code into an exposed one.
function toProblem(err, messages = {}) {
  const spec = PROBLEMS[err?.code];
  if (!spec) return null;
  const override = messages[err.code];
  return {
    status: spec.status,
    body: { error: override ?? (spec.expose ? err.message : spec.title) },
  };
}

// Adapter helper: send the mapped response, or a 500 with a fixed message.
//
// The 500 branch NEVER echoes err.message — that is the same disclosure rule as
// `expose`, applied to the case where we do not even know what the error is.
function send(res, err, { fallback = 'DB error', log, messages } = {}) {
  // The response may ALREADY be sent. The library upsert is the first adapter that
  // does work after res.json() — it dispatches notifications off the response path —
  // so anything thrown there lands in this function's .catch() with the headers long
  // gone, and a second write is an ERR_HTTP_HEADERS_SENT crash rather than an error
  // response. The guard lives here so it covers all eight adapters at once, and so
  // the next one that moves work after the response inherits it.
  if (res.headersSent) {
    console.error(log || '[problem] error after the response was sent:', err?.message || err);
    return undefined;
  }
  const problem = toProblem(err, messages);
  if (problem) return res.status(problem.status).json(problem.body);
  if (log) console.error(log, err?.message || err);
  return res.status(500).json({ error: fallback });
}

module.exports = { PROBLEMS, toProblem, send };
