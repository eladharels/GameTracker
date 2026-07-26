// IGDB (APIcalypse) query construction.
//
// One function, one place, for the same reason ldap-helpers.js exists: this escaping
// was written out inline at four separate call sites in index.js, and when a fifth
// call site appeared in backfill_steam_app_ids.js it was written from memory as
// `.replace(/"/g, '')` -- which strips quotes but leaves BACKSLASH untouched, so a
// game named `Doom\` escaped the closing quote and injected into the query anyway.
// Game names are attacker-supplied: POST /api/user/:username/games takes game_name
// straight from the request body.
//
// Import this. Do not hand-roll the escape again.

// Escape a value for interpolation into an APIcalypse `search "..."` string literal.
// BOTH the quote and the backslash must be escaped -- escaping only the quote leaves
// a trailing backslash free to consume the closing quote we add ourselves.
function escapeIgdbSearch(value) {
  return String(value == null ? '' : value).replace(/["\\]/g, '\\$&');
}

module.exports = { escapeIgdbSearch };
