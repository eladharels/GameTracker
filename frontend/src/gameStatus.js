// Game-status helpers shared by the library and search pages (moved out of App.jsx for
// FE-10, unchanged). Pure and DOM-free.

export const STATUSES = ['wishlist', 'playing', 'done', 'backlog']

// Date-only future check (YYYY-MM-DD parses as UTC midnight; compare date-only,
// matching the backend cron so "releases today" counts as released everywhere).
export function isGameReleaseInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d > today;
}

// Single source of truth: a game is "unreleased" if flagged, dateless, or its
// release date is still in the future. Accepts library games (release_date) or
// search results (releaseDate).
export function isGameUnreleased(game) {
  const date = game.release_date ?? game.releaseDate;
  return game.status === 'unreleased' || !date || isGameReleaseInFuture(date);
}

// Helper function to normalize status values
export function normalizeStatus(status) {
  if (!status) return 'wishlist';
  return status.toLowerCase();
}
