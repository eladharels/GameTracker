package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A LocalStore over a map, standing in for SharedPreferences (values keep their old types). */
class MapLocalStore(vararg seed: Pair<String, Any?>) : LocalStore {
    val map = mutableMapOf<String, Any?>(*seed)
    override fun get(key: String): String? = map[key]?.toString()
    override fun put(key: String, value: String) { map[key] = value }
    override fun remove(keys: Collection<String>) { keys.forEach { map.remove(it) } }
    override fun all(): Map<String, Any?> = map.toMap()
    override fun clear() = map.clear()
}

class UserDataTest {
    private val calendar = MapLocalStore()
    private fun account(name: String, store: LocalStore = MapLocalStore()) =
        UserData(store, calendar, UserData.fileName(name))

    @Test fun anotherAccountOnTheSamePhoneSeesNoneOfItAndItsSyncCannotTouchTheFirstAccountsEvents() {
        // MOB-7: all of this was device-wide; the next account saw the notes and history, and
        // its calendar sync deleted the first account's events (one shared event map).
        val jane = account("jane")
        jane.setRating("igdb_1", 4)
        jane.setNote("igdb_1", "finish the DLC")
        jane.setSearchHistoryJson("""["zelda"]""")
        jane.setCalendarSyncEnabled(true)
        jane.setCalendarId(7)
        jane.setEventMapJson("""{"igdb_1":101}""")

        val bob = account("bob")
        assertEquals(0, bob.rating("igdb_1"))
        assertEquals("", bob.note("igdb_1"))
        assertNull(bob.searchHistoryJson())
        assertFalse(bob.calendarSyncEnabled())
        assertNull(bob.calendarId())
        assertNull("bob's sync would delete jane's events", bob.eventMapJson())

        bob.setEventMapJson("{}")   // what bob's deleteAllEvents writes
        assertEquals("""{"igdb_1":101}""", jane.eventMapJson())
    }

    @Test fun removingAnAccountsDataTakesAllOfItAndNothingOfAnotherAccounts() {
        val jane = account("jane")
        val bob = account("bob")
        jane.setNote("igdb_1", "mine"); jane.setCalendarId(7); jane.setEventMapJson("{}")
        bob.setNote("igdb_1", "bob's"); bob.setCalendarId(9)
        jane.clear()
        assertEquals("", jane.note("igdb_1"))
        assertNull(jane.calendarId())
        assertNull(jane.eventMapJson())
        assertEquals("bob's", bob.note("igdb_1"))
        assertEquals(9L, bob.calendarId())
    }

    @Test fun clearingARatingOrNoteRemovesItAndRatingsStayInRange() {
        val s = MapLocalStore()
        val jane = account("jane", s)
        jane.setRating("g", 9); assertEquals(5, jane.rating("g"))
        jane.setRating("g", 0); assertEquals(0, jane.rating("g")); assertTrue(s.map.isEmpty())
        jane.setNote("g", "x"); jane.setNote("g", "  "); assertTrue("a blank note is kept", s.map.isEmpty())
    }

    @Test fun theFileNameIsStableAndNeverTheUsernameItself() {
        assertEquals(UserData.fileName("Jane"), UserData.fileName("jane"))
        assertFalse(UserData.fileName("jane") == UserData.fileName("bob"))
        assertFalse(UserData.fileName("../../jane").contains("jane"))
        assertTrue(Regex("user_data_[0-9a-f]{32}").matches(UserData.fileName("../../jane")))
    }

    @Test fun gameKeysKeepTheOldNoteKeySoSavedNotesStillOpen() {
        assertEquals("igdb_12345", UserData.gameKey("igdb_12345"))
        assertEquals("rawg_9-x", UserData.gameKey("rawg_9-x"))
        assertEquals("a_b_c", UserData.gameKey("a b/c"))
        assertEquals("igdb_1", UserData.gameKey(Game(id = "77", game_id = "igdb_1")))
        assertEquals("77", UserData.gameKey(Game(id = "77")))
    }

    @Test fun theOldDeviceWideDataMovesToTheSignedInAccountOnceAndLeavesTheRestAlone() {
        val target = MapLocalStore()
        val owner = UserData.fileName("jane")
        val gameExtras = MapLocalStore("rating_igdb 1" to 3, "note_igdb_2" to "never read", "rating_igdb_3" to 5)
        val appPrefs = MapLocalStore(
            "note_igdb_2" to "the note the app showed",
            "search_history" to """["elden"]""",
            "theme_accent" to "blue",
            "library_sort" to "name",
        )
        val auth = MapLocalStore("username" to "jane", "calendar_id" to 7L, "calendar_sync_enabled" to true, "token_sealed_v1" to "c")
        val events = MapLocalStore("event_map" to """{"igdb_2":42}""")

        UserData.migrateLegacy(target, calendar, owner, gameExtras, appPrefs, auth, events)
        val jane = UserData(target, calendar, owner)
        assertEquals("the int rating keeps its value, under the safe key", 3, jane.rating("igdb_1"))
        assertEquals(5, jane.rating("igdb_3"))
        assertEquals("app_prefs held the note the app actually read", "the note the app showed", jane.note("igdb_2"))
        assertEquals("""["elden"]""", jane.searchHistoryJson())
        assertEquals(7L, jane.calendarId())
        assertTrue(jane.calendarSyncEnabled())
        assertEquals("""{"igdb_2":42}""", jane.eventMapJson())

        assertTrue("game_extras is emptied", gameExtras.map.isEmpty())
        assertTrue(events.map.isEmpty())
        assertEquals("only notes and history leave app_prefs", setOf("theme_accent", "library_sort"), appPrefs.map.keys)
        assertEquals("the credential file keeps everything but the calendar", setOf("username", "token_sealed_v1"), auth.map.keys)
        assertTrue("no calendar value is in the backed-up per-account file", target.map.keys.none { it.startsWith("calendar") || it == "event_map" })

        // A second run (the next process) changes nothing, and never overwrites newer data.
        jane.setNote("igdb_2", "edited after the update")
        UserData.migrateLegacy(target, calendar, owner, gameExtras, appPrefs, auth, events)
        assertEquals("edited after the update", jane.note("igdb_2"))
    }
}
