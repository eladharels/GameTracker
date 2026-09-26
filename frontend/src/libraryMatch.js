// Is a search result already in the library? (ROADMAP FE-3)
//
// It compared NAMES alone, so Resident Evil 4 (2023) was refused because Resident Evil 4
// (2005) was in the library, with "You already have this game". The id is the real
// answer. Name still counts, but only together with the release YEAR: search merges the
// three providers, yet the same game can still arrive as igdb_1 in the library and
// rawg_9 in a result, and that pair is worth catching. A remake shares the name, never
// the year.
//
// DELIBERATELY STRICTER than the server's two matching rules, and must stay so:
//   services/catalog.js#sameGame     (merging search results) treats an undated side as
//                                    the same game when the name carries one year;
//   services/catalog.js#matchForRow  (metadata refresh) accepts one same-named result
//                                    when either year is unknown.
// Those decide which record to KEEP or UPDATE, where merging too little costs a
// duplicate row. This one decides whether to REFUSE an add, where a false positive
// blocks a legitimate game — exactly the FE-3 bug. "Unifying" it with catalog.js would
// bring that bug back. The server's copy is services/library.js (UP-19); the two are held
// equal by test/library-match-vectors.js. Change a vector there, never one side alone.
//
// Pure, no DOM: pinned from test/helpers.test.js through import().

// Normalised as a STORED name already is: controls to spaces, whitespace collapsed. Held
// EQUAL to services/library.js#normTitle by test/library-match-vectors.js (UP-19).
const norm = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase()
const yearOf = (d) => {
  const m = /^(\d{4})/.exec(String(d || ''))
  return m ? m[1] : null
}

// Three answers, not two (review of FE-3). A REFUSAL needs certainty: same id, or same
// name AND the same known year. But catalog.js#mergeResults keeps the UNDATED copy when a
// name carries one year, so the result a user adds is often undated and from another
// provider — a strict yes/no let that true duplicate through silently. Same name with a
// year unknown on either side is therefore 'possible': the add goes ahead (a remake must
// not be refused) and the page says a same-named game is already there.
//
// `rows`: library rows (game_id, game_name, release_date). `game`: a search result
// (id, name, releaseDate). Returns 'same' | 'possible' | null.
export function libraryMatch(rows, game) {
  if (!Array.isArray(rows) || !game) return null
  const id = String(game.id ?? '')
  const name = norm(game.name)
  const year = yearOf(game.releaseDate)
  let possible = false
  for (const r of rows) {
    if (id && String(r.game_id) === id) return 'same'
    if (!name || norm(r.game_name) !== name) continue
    const rYear = yearOf(r.release_date)
    if (year && rYear) {
      if (year === rYear) return 'same'
      continue                    // both known and different: a remake, not a duplicate
    }
    possible = true               // same name, a year unknown: cannot tell
  }
  return possible ? 'possible' : null
}

export const isAlreadyInLibrary = (rows, game) => libraryMatch(rows, game) === 'same'
