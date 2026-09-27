package com.example.gmaetrackermobile

import android.content.Context

/**
 * Per-game values the backend does NOT hold: the user's star rating and personal note.
 *
 * Both are stored on THIS DEVICE only (SharedPreferences), never synced, and the screens
 * that show them say so.
 *
 * MOB-11: this object used to invent hours played, completion progress, a genre and a
 * default rating from a hash of the game id "so the UI looks real". A finished game showed
 * "4.5★ · 87h" the user never entered, and Insights drew a "Top genres" chart from random
 * labels. Nothing here may be derived from the id again. Where the server has no value,
 * the screen shows nothing or "—": "nothing recorded" is not a number (the web app's
 * statistics page makes the same choice).
 */
object GameExtras {

    private const val PREFS = "game_extras"

    private fun keyOf(game: Game): String = game.game_id ?: game.id ?: game.displayName

    /** Release year parsed from the release date, or null. */
    fun year(game: Game): String? {
        val r = game.release
        if (r.length >= 4 && r.substring(0, 4).all { it.isDigit() }) return r.substring(0, 4)
        return null
    }

    /** Card subtitle: the release year, the one descriptive fact the library row carries. */
    fun subtitle(game: Game): String = year(game) ?: "Release date unknown"

    // ── User-editable rating + note (this device only) ───────────────────────

    /** The rating the user set on this device (1..5), or 0 when they never set one. */
    fun rating(ctx: Context, game: Game): Int =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt("rating_${keyOf(game)}", 0)
            .coerceIn(0, 5)

    fun setRating(ctx: Context, game: Game, rating: Int) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt("rating_${keyOf(game)}", rating).apply()
    }

    fun note(ctx: Context, game: Game): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("note_${keyOf(game)}", "") ?: ""

    fun setNote(ctx: Context, game: Game, note: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString("note_${keyOf(game)}", note).apply()
    }
}
