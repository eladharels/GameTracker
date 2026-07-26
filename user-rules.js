// Rules that govern what a username may be.
//
// Shared because create-local-admin.js bypassed them. That script creates an account
// with can_manage_users=1 and, until this commit, was fenced off behind a legacy
// SQLite guard; porting it to Postgres pointed it at production while the reserved
// list still lived only inside the POST /api/users route handler. It would happily
// create an admin named `me` -- an account permanently shadowed by the
// /api/user/me/* routes, which are registered first, and therefore unusable and
// undeletable through the UI.

// `me` collides with the /api/user/me/* routes, which are registered first and would
// shadow such an account entirely; the others are reserved to avoid confusion with
// the seeded administrator.
const RESERVED_USERNAMES = ['me', 'root', 'admin'];

// Returns an error string, or null when the username is acceptable.
// Expects the already-lowercased form -- callers normalise first.
function validateUsername(normalizedUsername) {
  if (!normalizedUsername) return 'Username is required.';
  if (RESERVED_USERNAMES.includes(normalizedUsername)) {
    return `'${normalizedUsername}' is a reserved username.`;
  }
  return null;
}

module.exports = { RESERVED_USERNAMES, validateUsername };
