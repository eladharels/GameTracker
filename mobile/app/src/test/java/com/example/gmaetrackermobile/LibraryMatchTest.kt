package com.example.gmaetrackermobile

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MOB-10: the app's copy of the "already in the library?" rule gives the SAME answer as the
 * server and the web app on every shared vector. The vectors are a JSON copy of the root
 * test/library-match-vectors.js, and test/runtime.test.js fails if the copy drifts.
 */
class LibraryMatchTest {

    // Plain classes for Gson: fromJson has existed in every Gson version, unlike
    // JsonParser.parseString (2.8.6+), and the app may resolve Retrofit's 2.8.5.
    private class JRow(val game_id: String? = null, val game_name: String? = null, val release_date: String? = null)
    private class JGame(val id: String? = null, val name: String? = null, val releaseDate: String? = null)
    private class JVector(val name: String = "", val rows: List<JRow> = emptyList(), val game: JGame = JGame(), val want: String? = null)

    private data class Vector(val name: String, val rows: List<LibraryMatch.Row>, val game: LibraryMatch.Candidate, val want: String?)

    private fun vectors(): List<Vector> {
        val text = javaClass.classLoader!!.getResourceAsStream("library-match-vectors.json")!!
            .bufferedReader().use { it.readText() }
        return Gson().fromJson(text, Array<JVector>::class.java).map { v ->
            Vector(
                name = v.name,
                rows = v.rows.map { LibraryMatch.Row(it.game_id, it.game_name, it.release_date) },
                game = LibraryMatch.Candidate(v.game.id, v.game.name, v.game.releaseDate),
                want = v.want,
            )
        }
    }

    private fun LibraryMatch.Kind?.wire(): String? = when (this) {
        LibraryMatch.Kind.SAME -> "same"
        LibraryMatch.Kind.POSSIBLE -> "possible"
        null -> null
    }

    @Test
    fun `every shared vector gives the server's answer`() {
        val all = vectors()
        assertTrue("the shared vectors went missing", all.size >= 10)
        for (v in all) assertEquals(v.name, v.want, LibraryMatch.match(v.rows, v.game).wire())
    }

    @Test
    fun `a non-breaking space normalises like JavaScript's whitespace`() {
        val rows = listOf(LibraryMatch.Row("igdb_1", "Hades II", "2024-05-06"))
        val nbsp = LibraryMatch.Candidate("rawg_9", "Hades II", "2024-01-01")
        assertEquals(LibraryMatch.Kind.SAME, LibraryMatch.match(rows, nbsp))
    }

    @Test
    fun `owned finds a library row by the search result's own id`() {
        val library = listOf(Game(id = null, game_id = "igdb_7", game_name = "Celeste", status = "done", release_date = "2018-01-25"))
        val result = Game(id = "igdb_7", name = "Celeste", releaseDate = "2018-01-25")
        assertEquals("done", LibraryMatch.owned(library, result)?.status)
    }

    @Test
    fun `a remake is not owned because its original is`() {
        val library = listOf(Game(id = null, game_id = "igdb_1", game_name = "Resident Evil 4", status = "done", release_date = "2005-01-11"))
        val remake = Game(id = "igdb_2", name = "Resident Evil 4", releaseDate = "2023-03-24")
        assertNull(LibraryMatch.owned(library, remake))
    }

    @Test
    fun `an unnamed result never matches an Unknown Title row`() {
        val library = listOf(Game(id = null, game_id = "igdb_1", game_name = "Unknown Title", status = "done"))
        assertNull(LibraryMatch.owned(library, Game(id = "rawg_5")))
    }
}
