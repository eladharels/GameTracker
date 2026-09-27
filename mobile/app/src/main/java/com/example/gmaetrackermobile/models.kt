package com.example.gmaetrackermobile

import android.os.Parcelable
import kotlinx.parcelize.Parcelize

// Data class for login request
data class LoginRequest(val username: String, val password: String)

// Data class for login response
data class LoginResponse(val token: String)

// Data class for a game
@Parcelize
data class Game(
    val id: String?,
    val user_id: Int? = null,
    val game_id: String? = null,
    val game_name: String? = null,
    val cover_url: String? = null,
    val release_date: String? = null,
    val status: String? = null,
    val steam_app_id: String? = null,
    val last_price: String? = null,
    val last_price_updated: String? = null,
    val steamAppId: String? = null, // for compatibility
    val backlog_order: Int? = null,
    // Fields from search API
    val name: String? = null,
    val releaseDate: String? = null,
    val coverUrl: String? = null,
    val source: String? = null
) : Parcelable {
    val displayName: String get() = game_name ?: name ?: "Unknown Title"
    val cover: String? get() = cover_url ?: coverUrl
    val release: String get() = release_date ?: releaseDate ?: ""
}

data class GameUpdateRequest(
    val gameId: String,
    val gameName: String,
    val coverUrl: String?,
    val releaseDate: String?,
    val status: String,
    val steamAppId: String?
)

data class BacklogOrderRequest(val direction: String)

/**
 * Converts a raw "yyyy-MM-dd" release string into a human-readable countdown label.
 *  - Blank / null  → "Unreleased"
 *  - Today         → "Releasing today!"
 *  - Future date   → "In X day(s)"
 *  - Past date     → the raw string (e.g. "2023-05-12")
 *  - Parse failure → the raw string (graceful degradation)
 */
fun formatReleaseLabel(releaseStr: String): String {
    if (releaseStr.isBlank()) return "Unreleased"
    return try {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        sdf.isLenient = false
        val releaseDate = sdf.parse(releaseStr) ?: return releaseStr

        // Midnight today in the device's local timezone
        val today = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, 0)
            set(java.util.Calendar.MINUTE, 0)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }.time

        val diffMs = releaseDate.time - today.time
        val diffDays = diffMs / (1_000L * 60 * 60 * 24)

        when {
            diffDays == 0L -> "Releasing today!"
            diffDays == 1L -> "In 1 day"
            diffDays > 1L  -> "In $diffDays days"
            else           -> releaseStr   // past date → show raw
        }
    } catch (e: Exception) {
        releaseStr  // unparseable → show as-is
    }
}