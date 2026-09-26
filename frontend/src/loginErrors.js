// What the login form says when sign-in fails (ROADMAP FE-4).
//
// Every failure used to read "Invalid username or password". For a 429 lockout that
// sends the user back to retyping a password that may be right, when the answer is to
// wait (the server checks the lockout BEFORE counting, so retries do not extend it —
// they just fail). An LDAP or server outage (5xx) and an unreachable server read the
// same way, so the user blamed their password for somebody else's outage.
//
// An unreachable DIRECTORY is a 503 since UP-21: the server answers it when only the
// directory could have decided (no local password to check), so it reads as the outage
// it is below, not as a wrong password. Before, it was a 401 nothing here could tell
// from a typo.
//
// "Sign in", everywhere: the button, these messages and the session notice.
//
// Pure, no DOM: pinned from test/helpers.test.js through import().
export function loginErrorMessage(err) {
  const status = err && err.response ? err.response.status : null
  const serverMsg = err && err.response && err.response.data && typeof err.response.data.error === 'string'
    ? err.response.data.error : ''
  if (status === null) return 'Can\'t reach the server. Check your connection and try again.'
  if (status === 401) return 'Invalid username or password.'
  // The server's lockout message carries the minutes remaining.
  if (status === 429) return serverMsg || 'Too many sign-in attempts. Please wait a few minutes and try again.'
  // 403 is "not a member of the required group": admin language the user cannot act on.
  // Mapped HERE rather than reworded on the server, whose text also serves token minting
  // on a frozen v1 route. Retrying never helps, so say who can.
  if (status === 403) return 'Your account isn\'t allowed to sign in to GameTracker. Ask an administrator for access.'
  if (status === 400 && serverMsg) return serverMsg
  // "A few minutes", not "a moment" (UP-21 review): the server's own Retry-After is 60s, and
  // quick retries during an outage end in a confusing 15-minute lockout.
  if (status >= 500) return 'Sign-in is temporarily unavailable. Please try again in a few minutes.'
  return 'Sign-in failed. Please try again.'
}
