// Typed errors for the service layer.
//
// Services must not know about HTTP. They throw a ServiceError carrying a stable
// `code`; the route adapter maps that code to a status and a body. That is what lets
// the same service back both the current /api routes and the future /api/v2 routes
// without the two disagreeing about what an operation means — the failure taxonomy
// lives in one place instead of being re-decided in every handler.
//
// `details` carries structured, caller-actionable data (e.g. which usernames were
// unknown). Keep it free of anything sensitive: it is destined for a response body.
//
// TWO RULES FOR ADAPTERS, both learned the hard way:
//
//   1. AWAIT EVERY SERVICE CALL AND HANDLE ITS REJECTION — including calls to a
//      service documented as non-throwing. That documentation describes the intended
//      shape, not the database underneath it: a pool error rejects regardless. An
//      unhandled rejection in an Express handler means the response is never sent
//      and the request hangs until the client gives up.
//
//   2. THE ONE DELIBERATE EXCEPTION TO THE TAXONOMY is
//      services/notifications.js#dispatch, which never throws. It returns
//      {channel: {sent, error}} because the operation has four INDEPENDENT outcomes
//      and no single status code describes "email sent, Gotify refused" — forcing
//      that through an exception is what made three call sites re-derive per-channel
//      state and drift apart, which is the bug that service exists to prevent.
//
//      Its result is ADVISORY. No adapter may turn a channel error into a request
//      failure: adding a game must not 500 because the user's self-hosted ntfy box
//      is down. If you find yourself wanting to, you are recreating the defect.
class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// The codes in use. Exported as a frozen object so a typo is a TypeError at the
// throw site rather than an error that silently maps to a 500.
const CODES = Object.freeze({
  // 401. Added for v2: the taxonomy had NO code mapping to 401, so patRequired was
  // forced to answer 403 for a missing or expired credential — and 403 is what an
  // insufficient SCOPE returns, so "re-authenticate" and "stop retrying" became
  // distinguishable only by English prose in `detail`, which Problem tells clients
  // never to branch on. For an agent holding a long-lived token, expiry is the one
  // failure it is guaranteed to hit, and misreading it as a permission problem is a
  // retry loop. v1 never needed this: it hand-writes 401 in authRequired.
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  VALIDATION: 'validation',
  UNKNOWN_USERS: 'unknown_users',
  NOT_SHARED: 'not_shared',
  NOT_IN_BACKLOG: 'not_in_backlog',
  CONFLICT: 'conflict',
});

const serviceError = (code, message, details) => new ServiceError(code, message, details);

module.exports = { ServiceError, CODES, serviceError };
