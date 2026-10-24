package ink.etech.gametracker

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest

/** The slice of SharedPreferences [UserData] needs, so the rules run in JVM tests. */
interface LocalStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(keys: Collection<String>)
    fun all(): Map<String, Any?>
    fun clear()
}

class PrefsStore(private val prefs: SharedPreferences) : LocalStore {
    // getString, not `all`: `all` copies the whole file on every call, once per card bound.
    // A legacy non-string value (only ever read through all() by the migration) falls back.
    override fun get(key: String): String? =
        try { prefs.getString(key, null) } catch (e: ClassCastException) { prefs.all[key]?.toString() }
    override fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(keys: Collection<String>) {
        if (keys.isEmpty()) return
        prefs.edit().apply { keys.forEach { remove(it) } }.apply()
    }
    override fun all(): Map<String, Any?> = prefs.all
    override fun clear() { prefs.edit().clear().apply() }
}

/**
 * ONE account's data on THIS phone (MOB-7): star ratings, notes, search history, and the
 * calendar sync settings with the map of events it added. None of it is on the server.
 *
 * Each account has its own preferences file, so the next person to sign in on a shared phone
 * sees none of the previous account's data, and the owner gets theirs back on signing in
 * again. Signing out does NOT delete it: notes exist nowhere else, so deleting them at
 * sign-out would lose them for good. [removeFromPhone] does that, when the user asks
 * (Profile -> "Remove my data from this phone").
 *
 * The calendar part is in ONE file for all accounts, [CALENDAR_FILE], under per-account keys,
 * because it must never be restored from a backup. Event ids belong to one phone's calendar
 * provider, and a restored map made the next sync delete whatever events the new phone has
 * under those ids. Notes and ratings ARE backed up, as they were before.
 *
 * Before this, all of it was device-wide: notes under two keys in two files (one never read),
 * and the calendar settings in the `auth` file next to the credential. A second account's sync
 * deleted the first account's calendar events, because the event map was shared.
 */
class UserData(private val store: LocalStore, private val calendar: LocalStore, private val owner: String) {

    fun rating(gameKey: String): Int = store.get(RATING + gameKey)?.toIntOrNull()?.coerceIn(0, 5) ?: 0
    fun setRating(gameKey: String, rating: Int) {
        if (rating <= 0) store.remove(listOf(RATING + gameKey)) else store.put(RATING + gameKey, rating.coerceAtMost(5).toString())
    }

    fun note(gameKey: String): String = store.get(NOTE + gameKey) ?: ""
    fun setNote(gameKey: String, note: String) {
        if (note.isBlank()) store.remove(listOf(NOTE + gameKey)) else store.put(NOTE + gameKey, note)
    }

    fun searchHistoryJson(): String? = store.get(SEARCH_HISTORY)
    fun setSearchHistoryJson(json: String) = store.put(SEARCH_HISTORY, json)

    private fun cal(key: String) = "$owner:$key"

    fun calendarId(): Long? = calendar.get(cal(CALENDAR_ID))?.toLongOrNull()?.takeIf { it != -1L }
    fun setCalendarId(id: Long?) {
        if (id == null) calendar.remove(listOf(cal(CALENDAR_ID))) else calendar.put(cal(CALENDAR_ID), id.toString())
    }

    fun calendarSyncEnabled(): Boolean = calendar.get(cal(CALENDAR_SYNC)) == "true"
    fun setCalendarSyncEnabled(on: Boolean) = calendar.put(cal(CALENDAR_SYNC), on.toString())

    fun eventMapJson(): String? = calendar.get(cal(EVENT_MAP))
    fun setEventMapJson(json: String) = calendar.put(cal(EVENT_MAP), json)

    /**
     * Everything this account keeps on the phone, and nothing another account keeps. With
     * [keepCalendar], the calendar id and event map stay: events that could not be deleted
     * must stay findable, or nothing could ever remove them.
     */
    fun clear(keepCalendar: Boolean = false) {
        store.clear()
        calendar.remove(if (keepCalendar) listOf(cal(CALENDAR_SYNC)) else listOf(CALENDAR_ID, CALENDAR_SYNC, EVENT_MAP).map(::cal))
    }

    companion object {
        private const val RATING = "rating_"
        private const val NOTE = "note_"
        private const val SEARCH_HISTORY = "search_history"
        private const val CALENDAR_ID = "calendar_id"
        private const val CALENDAR_SYNC = "calendar_sync_enabled"
        private const val EVENT_MAP = "event_map"
        /** Excluded from backup and device transfer (res/xml), unlike the per-account files. */
        const val CALENDAR_FILE = "calendar"

        /**
         * The key for a game: its id, made safe the way the old note key was. Ids look like
         * `igdb_12345`, which this leaves alone, so notes saved before MOB-7 keep their key.
         */
        fun gameKey(game: Game): String = gameKey(game.game_id ?: game.id ?: game.displayName)
        fun gameKey(id: String): String = id.replace(Regex("[^a-zA-Z0-9_\\-]"), "_")

        /** A file name from the username: never the name itself, which could hold anything. */
        fun fileName(username: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(username.lowercase().toByteArray(Charsets.UTF_8))
            return "user_data_" + digest.take(16).joinToString("") { "%02x".format(it) }
        }

        /**
         * Moves the device-wide data from before MOB-7 into [target], once: it is deleted from
         * the old files as it moves, so a second call finds nothing. [target] is the account
         * whose username is stored when the update first runs: the last one to sign in, which
         * on a single-user phone is the one that wrote it. On a shared phone it may not be;
         * that data was visible to every account already, so this reveals nothing new.
         * Where both old note stores hold a note, app_prefs wins: it is the one the app read.
         */
        fun migrateLegacy(
            target: LocalStore, calendar: LocalStore, owner: String,
            gameExtras: LocalStore, appPrefs: LocalStore, auth: LocalStore, calendarEvents: LocalStore,
        ) {
            fun moveTo(store: LocalStore, key: String, value: Any?) {
                if (value != null && store.get(key) == null) store.put(key, value.toString())
            }
            fun move(key: String, value: Any?) = moveTo(target, key, value)
            fun moveCal(key: String, value: Any?) = moveTo(calendar, "$owner:$key", value)
            val app = appPrefs.all()
            val appKeys = app.keys.filter { it.startsWith(NOTE) || it == SEARCH_HISTORY }
            appKeys.forEach { move(it, app[it]) }
            appPrefs.remove(appKeys)

            for ((key, value) in gameExtras.all()) {
                when {
                    key.startsWith(RATING) -> move(RATING + gameKey(key.removePrefix(RATING)), value)
                    key.startsWith(NOTE) -> move(NOTE + gameKey(key.removePrefix(NOTE)), value)
                }
            }
            gameExtras.clear()

            val a = auth.all()
            val calendarKeys = listOf(CALENDAR_ID, CALENDAR_SYNC).filter { a.containsKey(it) }
            calendarKeys.forEach { moveCal(it, a[it]) }
            auth.remove(calendarKeys)

            calendarEvents.all()[EVENT_MAP]?.let { moveCal(EVENT_MAP, it) }
            calendarEvents.clear()
        }

        @Volatile private var legacyChecked = false

        /** The signed-in account's data, or null when nobody has signed in on this phone. */
        fun current(context: Context): UserData? {
            val username = Session.get(context).username ?: return null
            val app = context.applicationContext
            fun prefs(name: String) = PrefsStore(app.getSharedPreferences(name, Context.MODE_PRIVATE))
            val owner = fileName(username)
            val store = prefs(owner)
            val calendar = prefs(CALENDAR_FILE)
            if (!legacyChecked) {
                synchronized(this) {
                    if (!legacyChecked) {
                        migrateLegacy(store, calendar, owner, prefs("game_extras"), prefs("app_prefs"), prefs(SessionStore.PREFS), prefs("calendar_events"))
                        legacyChecked = true
                    }
                }
            }
            return UserData(store, calendar, owner)
        }

        /**
         * Deletes the signed-in account's data from this phone, and the calendar events it
         * added. Returns how many of those events are STILL in the calendar (no calendar
         * access, a provider error): their ids are kept, so the user can allow access and try
         * again, and the caller must say so. Blocking: call it off the main thread.
         */
        fun removeFromPhone(context: Context): Int {
            val username = Session.get(context).username ?: return 0
            val left = CalendarHelper.deleteAllEvents(context)
            current(context)?.clear(keepCalendar = left > 0)
            context.applicationContext.deleteSharedPreferences(fileName(username))
            return left
        }
    }
}
