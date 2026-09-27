// The published v1 key sets, shared by test/api-contract.test.js (which pins them), the
// Android gate in the same file (which checks mobile/'s models against them) and
// test/integration/library-shape.test.js (which checks a REAL row from Postgres). One copy,
// so the three cannot drift apart. Changing a list here is changing the frozen v1 contract.

// withAliases(row) over a row carrying exactly these columns (the unit pin's fixture).
const LIBRARY_ROW_KEYS = Object.freeze([
  'id', 'user_id', 'game_id', 'game_name', 'cover_url', 'release_date', 'status',
  'steam_app_id', 'last_price', 'last_price_updated', 'crack_status', 'backlog_order',
  'steamAppId', 'crackStatus',
]);
// What GET /api/user/:username/games actually sends. Its SELECT * put `added_at`
// (migration 004) on the wire without a decision being made (CLAUDE.md), and the fixture
// above cannot see it: only a real row can. Every new user_games column lands here too.
const LIBRARY_ROW_WIRE_KEYS = Object.freeze([...LIBRARY_ROW_KEYS, 'added_at']);
const SEARCH_ITEM_KEYS = Object.freeze(['id', 'name', 'releaseDate', 'coverUrl', 'source', 'steamAppId']);
const LOGIN_TOKEN_KEYS = Object.freeze(['token']);

module.exports = { LIBRARY_ROW_KEYS, LIBRARY_ROW_WIRE_KEYS, SEARCH_ITEM_KEYS, LOGIN_TOKEN_KEYS };
