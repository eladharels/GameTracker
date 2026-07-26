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

// Email validation lives here too: it is a rule about a user field, it is needed by
// both index.js and services/users.js, and duplicating it is how the open-relay hole
// stayed open once already — it must hold at EVERY write site and again at the send
// sink, so there can only be one definition.
// Nodemailer treats a comma-separated `to` as a recipient LIST, so any value that
// smuggles a comma into users.email fans notifications out to arbitrary third
// parties from this deployment's SPF/DKIM-aligned domain. There are four writers
// (PUT /api/user/me/settings, POST /api/users, PUT /api/users/:id, and the LDAP
// sync + backfill), so this is enforced at the WRITE sites *and* again at the send
// sink in sendEmail — validating in only one place is how the hole stayed open.
function isValidEmailAddress(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '') return false;
  return /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]+$/.test(v);
}

module.exports = { RESERVED_USERNAMES, validateUsername, isValidEmailAddress };
