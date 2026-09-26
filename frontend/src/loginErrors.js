// What the login form says when sign-in fails (ROADMAP FE-4).
//
// Every failure used to read "Invalid username or password". For a 429 lockout that is
// actively harmful: the user retypes, and every retry extends the lockout. An LDAP or
// server outage (5xx) and an unreachable server read the same way, so the user blamed
// their password for somebody else's outage.
//
// Pure, no DOM: pinned from test/helpers.test.js through import().
export function loginErrorMessage(err) {
  const status = err && err.response ? err.response.status : null
  const serverMsg = err && err.response && err.response.data && typeof err.response.data.error === 'string'
    ? err.response.data.error : ''
  if (status === null) return 'Can\'t reach the server. Check your connection and try again.'
  if (status === 401) return 'Invalid username or password'
  // The server's lockout message carries the minutes remaining.
  if (status === 429) return serverMsg || 'Too many sign-in attempts. Please wait a few minutes and try again.'
  if (status === 400 && serverMsg) return serverMsg
  if (status >= 500) return 'Sign-in is temporarily unavailable. Please try again in a moment.'
  return 'Sign-in failed. Please try again.'
}
