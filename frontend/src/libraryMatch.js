// Is a search result already in the library? (ROADMAP FE-3)
//
// It compared NAMES alone, so Resident Evil 4 (2023) was refused because Resident Evil 4
// (2005) was in the library, with "You already have this game". The id is the real
// answer. Name still counts, but only together with the release YEAR: search merges the
// three providers, yet the same game can still arrive as igdb_1 in the library and
// rawg_9 in a result, and that pair is worth catching. A remake shares the name, never
// the year.
//
// Pure, no DOM: pinned from test/helpers.test.js through import().

const norm = (s) => String(s || '').trim().toLowerCase()
const yearOf = (d) => {
  const m = /^(\d{4})/.exec(String(d || ''))
  return m ? m[1] : null
}

// `rows`: library rows (game_id, game_name, release_date). `game`: a search result
// (id, name, releaseDate).
export function isAlreadyInLibrary(rows, game) {
  if (!Array.isArray(rows) || !game) return false
  const id = String(game.id ?? '')
  const name = norm(game.name)
  const year = yearOf(game.releaseDate)
  return rows.some((r) => {
    if (id && String(r.game_id) === id) return true
    // Same name counts only when BOTH years are known and equal: an unknown year is not
    // evidence that two same-named games are one.
    return !!name && norm(r.game_name) === name && !!year && yearOf(r.release_date) === year
  })
}
