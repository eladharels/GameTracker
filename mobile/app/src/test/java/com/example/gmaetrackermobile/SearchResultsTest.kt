package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SearchResultsTest {
    private val halo = listOf(Game(id = "1", game_id = "igdb_1", game_name = "Halo"))

    @Test fun aFailureIsNeverNoGamesFound() {
        // MOB-15: every non-2xx and every exception became an empty list.
        for ((result, title) in listOf(
            SearchResults.of(IOException("no route")) to "You're offline",
            SearchResults.of(401, null, null) to "Signed out",
            SearchResults.of(429, null, null) to "Too many searches",
            SearchResults.of(500, null, null) to "Search isn't working right now",
            SearchResults.of(IllegalStateException("x")) to "Search isn't working right now",
        )) {
            assertTrue(result is SearchResult.Failed)
            assertEquals(title, SearchResults.state(result)!!.first)
            assertEquals("Couldn't search for 'halo'", SearchResults.header(result, "halo"))
        }
    }

    @Test fun emptyAndFoundAreTheServersAnswer() {
        assertEquals(SearchResult.Empty(false), SearchResults.of(200, emptyList(), null))
        assertEquals("No matches", SearchResults.state(SearchResults.of(200, null, null))!!.first)
        val found = SearchResults.of(200, halo, null)
        assertEquals(SearchResult.Found(halo, false), found)
        assertNull(SearchResults.state(found))
        assertEquals("Found 1 game(s) for 'halo'", SearchResults.header(found, "halo"))
    }

    @Test fun aSourceDownIsSaidNotHidden() {
        assertEquals("No matches so far", SearchResults.state(SearchResults.of(200, emptyList(), "1"))!!.first)
        assertTrue(SearchResults.degradedNote(SearchResults.of(200, halo, "1"))!!.contains("incomplete"))
        assertNull(SearchResults.degradedNote(SearchResults.of(200, halo, null)))
    }

    @Test fun retryIsOfferedForFailuresTheUserCanRetry() {
        assertTrue(SearchResults.canRetry(SearchResults.of(IOException())))
        assertFalse(SearchResults.canRetry(SearchResults.of(401, null, null)))
        assertFalse(SearchResults.canRetry(SearchResults.of(200, emptyList(), null)))
    }
}
