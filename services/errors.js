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
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  VALIDATION: 'validation',
  UNKNOWN_USERS: 'unknown_users',
  NOT_SHARED: 'not_shared',
  CONFLICT: 'conflict',
});

const serviceError = (code, message, details) => new ServiceError(code, message, details);

module.exports = { ServiceError, CODES, serviceError };
