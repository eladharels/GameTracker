package com.example.gmaetrackermobile

/**
 * Is a search result already in the library? (MOB-10)
 *
 * The app's copy of the rule in services/library.js#libraryMatch and
 * frontend/src/libraryMatch.js. The THREE copies are held equal by one set of vectors:
 * test/library-match-vectors.js on the server side, and its JSON copy at
 * app/src/test/resources/library-match-vectors.json, which LibraryMatchTest runs and the
 * root test/runtime.test.js keeps identical to the original. Change a vector there, never
 * one copy alone.
 *
 *  - SAME: the same id, or the same name AND the same known release year. The add must not
 *    be sent: v1's upsert overwrites the stored status, so "Add" on a game marked done
 *    demoted it to wishlist, wrote a permanent source='user' history row and pushed a
 *    status notification.
 *  - POSSIBLE: the same name with a year unknown on either side. The add goes ahead (a
 *    remake must not be refused) and the user is told a same-named game is already there.
 *  - null: not in the library.
 *
 * Pure Kotlin, no Android types, so the JVM unit tests run it directly.
 */
object LibraryMatch {

    enum class Kind { SAME, POSSIBLE }

    /** The three columns the rule reads, from a library row. */
    data class Row(val gameId: String?, val gameName: String?, val releaseDate: String?)

    /** What a search result offers the rule. */
    data class Candidate(val id: String?, val name: String?, val releaseDate: String?)

    // Normalised as a STORED name already is: control characters to spaces, whitespace
    // collapsed. The same character ranges as the JS copies ([\u0000-\u001f\u007f-\u009f]).
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f]")
    // (?U): Java's plain \\s is ASCII-only, while JavaScript's also matches Unicode spaces
    // (NBSP, U+2028...) and U+FEFF. Without it a name with a non-breaking space would
    // normalise differently here than on the server.
    private val SPACES = Regex("(?U)[\\s\\uFEFF]+")

    internal fun norm(s: String?): String =
        (s ?: "").replace(CONTROL, " ").replace(SPACES, " ").trim().lowercase()

    internal fun yearOf(d: String?): String? {
        val s = d ?: return null
        return if (s.length >= 4 && s.substring(0, 4).all { it in '0'..'9' }) s.substring(0, 4) else null
    }

    fun match(rows: List<Row>, game: Candidate): Kind? {
        val id = game.id ?: ""
        val name = norm(game.name)
        val year = yearOf(game.releaseDate)
        var possible = false
        for (r in rows) {
            if (id.isNotEmpty() && r.gameId == id) return Kind.SAME
            if (name.isEmpty() || norm(r.gameName) != name) continue
            val rYear = yearOf(r.releaseDate)
            if (year != null && rYear != null) {
                if (year == rYear) return Kind.SAME
                continue              // both known and different: a remake, not a duplicate
            }
            possible = true           // same name, a year unknown: cannot tell
        }
        return if (possible) Kind.POSSIBLE else null
    }

    /** The library row a SAME match refers to, so the UI can show its status. */
    fun owned(library: List<Game>, result: Game): Game? {
        val c = candidateOf(result)
        return library.firstOrNull { row ->
            match(listOf(rowOf(row)), c) == Kind.SAME
        }
    }

    fun rowOf(g: Game) = Row(g.game_id ?: g.id, g.game_name ?: g.name, g.release_date ?: g.releaseDate)

    // The raw name, never displayName: its "Unknown Title" fallback would match a library
    // row that really is called that.
    fun candidateOf(g: Game) = Candidate(g.game_id ?: g.id, g.game_name ?: g.name, g.release.ifBlank { null })
}
