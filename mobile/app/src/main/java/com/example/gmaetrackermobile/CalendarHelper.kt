package com.example.gmaetrackermobile

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject

data class CalendarInfo(val id: Long, val displayName: String, val accountName: String)

object CalendarHelper {

    private const val TAG = "CalendarHelper"
    private const val PREFS_AUTH = "auth"
    private const val KEY_CALENDAR_ID = "calendar_id"
    private const val KEY_SYNC_ENABLED = "calendar_sync_enabled"
    private const val PREFS_EVENTS = "calendar_events"
    private const val KEY_EVENT_MAP = "event_map"

    fun hasCalendarPermissions(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) ==
                PackageManager.PERMISSION_GRANTED &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) ==
                PackageManager.PERMISSION_GRANTED

    fun getAvailableCalendars(context: Context): List<CalendarInfo> {
        if (!hasCalendarPermissions(context)) return emptyList()
        val projection = arrayOf(
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME
        )
        val selection = "${CalendarContract.Calendars.VISIBLE} = 1 AND ${CalendarContract.Calendars.SYNC_EVENTS} = 1"
        return try {
            val cursor = context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                projection, selection, null, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME
            ) ?: return emptyList()
            val list = mutableListOf<CalendarInfo>()
            cursor.use {
                while (it.moveToNext()) {
                    list += CalendarInfo(
                        id = it.getLong(0),
                        displayName = it.getString(1) ?: "Unknown",
                        accountName = it.getString(2) ?: ""
                    )
                }
            }
            list
        } catch (e: Exception) {
            Log.e(TAG, "Failed to query calendars", e)
            emptyList()
        }
    }

    fun getStoredCalendarId(context: Context): Long? {
        val id = context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
            .getLong(KEY_CALENDAR_ID, -1L)
        return if (id == -1L) null else id
    }

    fun storeCalendarId(context: Context, calendarId: Long) {
        context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
            .edit().putLong(KEY_CALENDAR_ID, calendarId).apply()
    }

    fun isSyncEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
            .getBoolean(KEY_SYNC_ENABLED, false)

    fun setSyncEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_SYNC_ENABLED, enabled).apply()
    }

    /**
     * Deletes every calendar event we have stored and clears the event map.
     * Does NOT clear the stored calendar ID — use [disableSync] for a full tear-down.
     */
    fun deleteAllEvents(context: Context) {
        try {
            val map = loadEventMap(context)
            map.values.forEach { eventId ->
                try {
                    context.contentResolver.delete(
                        ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
                        null, null
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Could not delete event $eventId", e)
                }
            }
            saveEventMap(context, emptyMap())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete all calendar events", e)
        }
    }

    /** Full tear-down: deletes all events, clears the event map, calendar ID, and sync flag. */
    fun disableSync(context: Context) {
        deleteAllEvents(context)
        context.getSharedPreferences(PREFS_AUTH, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_CALENDAR_ID)
            .putBoolean(KEY_SYNC_ENABLED, false)
            .apply()
    }

    fun addGameEvent(context: Context, gameId: String, gameName: String, releaseDate: String): Long? {
        if (!hasCalendarPermissions(context)) return null
        val startMillis = parseDateToUtcMillis(releaseDate) ?: return null
        val calendarId = getStoredCalendarId(context) ?: return null
        return try {
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calendarId)
                put(CalendarContract.Events.TITLE, "$gameName releases today")
                put(CalendarContract.Events.DESCRIPTION, "Game release day — $gameName")
                put(CalendarContract.Events.DTSTART, startMillis)
                put(CalendarContract.Events.DTEND, startMillis + 86_400_000L)
                put(CalendarContract.Events.EVENT_TIMEZONE, "UTC")
                put(CalendarContract.Events.ALL_DAY, 1)
                put(CalendarContract.Events.HAS_ALARM, 1)
            }
            val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
                ?: return null
            val eventId = ContentUris.parseId(uri)
            insertReminder(context, eventId, 7 * 24 * 60)
            insertReminder(context, eventId, 1 * 24 * 60)
            val map = loadEventMap(context)
            map[gameId] = eventId
            saveEventMap(context, map)
            eventId
        } catch (e: Exception) {
            Log.e(TAG, "Failed to insert calendar event for $gameId", e)
            null
        }
    }

    fun deleteGameEvent(context: Context, gameId: String) {
        try {
            val map = loadEventMap(context)
            val eventId = map[gameId] ?: return
            context.contentResolver.delete(
                ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
                null, null
            )
            map.remove(gameId)
            saveEventMap(context, map)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete calendar event for $gameId", e)
        }
    }

    fun showCalendarPickerDialog(
        context: Context,
        calendars: List<CalendarInfo>,
        onSelected: (CalendarInfo) -> Unit
    ) {
        if (calendars.isEmpty()) {
            android.app.AlertDialog.Builder(context)
                .setTitle("No Calendars Found")
                .setMessage("No active calendars were found on this device. Please add a calendar account and try again.")
                .setPositiveButton("OK", null)
                .show()
            return
        }
        val names = calendars.map { "${it.displayName} (${it.accountName})" }.toTypedArray()
        android.app.AlertDialog.Builder(context)
            .setTitle("Choose a Calendar")
            .setItems(names) { _, index -> onSelected(calendars[index]) }
            .setNegativeButton("Skip", null)
            .show()
    }

    private fun parseDateToUtcMillis(dateStr: String): Long? {
        if (dateStr.isBlank()) return null
        return try {
            val parts = dateStr.trim().split("-")
            if (parts.size != 3) return null
            val cal = java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("UTC"))
            cal.set(parts[0].toInt(), parts[1].toInt() - 1, parts[2].toInt(), 0, 0, 0)
            cal.set(java.util.Calendar.MILLISECOND, 0)
            cal.timeInMillis
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse date: $dateStr")
            null
        }
    }

    private fun insertReminder(context: Context, eventId: Long, minutesBefore: Int) {
        val values = ContentValues().apply {
            put(CalendarContract.Reminders.EVENT_ID, eventId)
            put(CalendarContract.Reminders.MINUTES, minutesBefore)
            put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
        }
        context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, values)
    }

    private fun loadEventMap(context: Context): MutableMap<String, Long> {
        val json = context.getSharedPreferences(PREFS_EVENTS, Context.MODE_PRIVATE)
            .getString(KEY_EVENT_MAP, null) ?: return mutableMapOf()
        return try {
            val obj = JSONObject(json)
            val map = mutableMapOf<String, Long>()
            obj.keys().forEach { key -> map[key] = obj.getLong(key) }
            map
        } catch (e: Exception) {
            mutableMapOf()
        }
    }

    private fun saveEventMap(context: Context, map: Map<String, Long>) {
        val obj = JSONObject()
        map.forEach { (key, value) -> obj.put(key, value) }
        context.getSharedPreferences(PREFS_EVENTS, Context.MODE_PRIVATE)
            .edit().putString(KEY_EVENT_MAP, obj.toString()).apply()
    }
}
