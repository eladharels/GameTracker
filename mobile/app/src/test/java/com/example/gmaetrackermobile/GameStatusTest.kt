package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class GameStatusTest {
    private val future = Game(id = "1", game_id = "igdb_1", game_name = "Hollow", release_date = "2099-01-01")
    private val undated = Game(id = "2", game_id = "igdb_2", game_name = "Mystery")

    @Test fun requestsCarryTheCanonicalStatusAndNullForAnUnknownDate() {
        // MOB-13: "Done" was sent, and "" for an unknown date.
        val r = GameStatus.request(undated, "Done")
        assertEquals("done", r.status)
        assertNull("an unknown date is null, never \"\"", r.releaseDate)
        assertEquals("2099-01-01", GameStatus.request(future, GameStatus.PLAYING).releaseDate)
        assertEquals("igdb_1", GameStatus.request(future, GameStatus.PLAYING).gameId)
    }

    @Test(expected = IllegalArgumentException::class)
    fun aNonStatusIsRefused() { GameStatus.request(future, "finished") }

    @Test fun unreleasedIsNeverOffered() {
        assertFalse(GameStatus.UNRELEASED in GameStatus.PICKABLE)
        assertEquals(listOf("wishlist", "backlog", "playing", "done"), GameStatus.PICKABLE)
    }

    @Test fun theStoredStatusIsTheServersAnswer() {
        assertEquals("unreleased", GameStatus.stored("playing", GameUpsertResult(true, "unreleased", true)))
        assertEquals("playing", GameStatus.stored("playing", null))
        assertEquals("playing", GameStatus.stored("playing", GameUpsertResult(true, "bogus", false)))
    }

    @Test fun aCoercedWriteSaysWhy() {
        assertEquals("Hollow isn't out until 2099-01-01, so it stays Unreleased.",
            GameStatus.outcome(future, "playing", GameUpsertResult(true, "unreleased", true)))
        assertEquals("Mystery has no release date yet, so it stays Unreleased.",
            GameStatus.outcome(undated, "done", GameUpsertResult(true, "unreleased", true)))
        assertEquals("Hollow → Done", GameStatus.outcome(future, "done", GameUpsertResult(true, "done", false)))
        assertEquals("Hollow was saved as Wishlist.", GameStatus.outcome(future, "unreleased", GameUpsertResult(true, "wishlist", true)))
    }
}
