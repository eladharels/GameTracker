package ink.etech.gametracker

import org.junit.Assert.assertEquals
import org.junit.Test

class ScreenStatesTest {

    @Test fun aFailedLoadIsNeverAnEmptyLibrary() {
        // The Library used to read "0 games" and "Your library is empty" when the load failed.
        val s = ScreenStates.library(libraryCount = 0, filterLabel = null, query = "", failed = true)
        assertEquals("Couldn't load your library", s.title)
        assertEquals(ScreenStates.Action.RETRY, s.action)
    }

    @Test fun anEmptyLibraryPointsToDiscover() {
        val s = ScreenStates.library(0, null, "", failed = false)
        assertEquals("Your library is empty", s.title)
        assertEquals(ScreenStates.Action.DISCOVER, s.action)
    }

    @Test fun aSearchWithNoMatchesSaysSoAndOffersToClearIt() {
        val s = ScreenStates.library(12, null, " zelda ", failed = false)
        assertEquals("No games match “zelda”", s.title)
        assertEquals(ScreenStates.Action.CLEAR_SEARCH, s.action)
    }

    @Test fun aSearchInsideAFilterNamesTheFilter() {
        val s = ScreenStates.library(12, "Playing", "zelda", failed = false)
        assertEquals("Nothing in Playing matches. Try another word or clear the search.", s.body)
    }

    @Test fun anEmptyFilterIsNotAnEmptyLibrary() {
        val s = ScreenStates.library(12, "Done", "", failed = false)
        assertEquals("Nothing in Done", s.title)
        assertEquals(ScreenStates.Action.SHOW_ALL, s.action)
    }

    @Test fun aFailedRefreshWithGamesHeldIsNotAnError() {
        // The held list stays on screen; a snackbar reports the failure instead.
        val s = ScreenStates.library(12, "Done", "", failed = true)
        assertEquals("Nothing in Done", s.title)
    }

    @Test fun unreleasedIsNotAStatusAUserMarks() {
        // The server decides Unreleased from the date (MOB-18).
        val s = ScreenStates.library(12, "Unreleased", "", failed = false)
        assertEquals("Games with a release date still ahead show up here.", s.body)
    }
}
