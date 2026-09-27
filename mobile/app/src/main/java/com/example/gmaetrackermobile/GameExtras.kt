package com.example.gmaetrackermobile

import android.content.Context

/**
 * Supplies the "rich" per-game fields shown in the new design that the production
 * backend does NOT persist (hours played, star rating, genre, personal notes).
 *
 * - Hours / rating / genre are derived **deterministically** from the game id so the
 *   UI looks real and stays stable across reloads (no flicker between random values).
 * - User-set ratings and notes ARE persisted locally (per-device) in SharedPreferences
 *   so editing them in Game Details feels real. They are not synced to the web app.
 *
 * This keeps the redesigned screens visually faithful to the prototype without
 * inventing backend support. See CLAUDE.md "Known Technical Debt".
 */
object GameExtras {

    private const val PREFS = "game_extras"

    private val GENRES = listOf(
        "Action RPG", "RPG", "Roguelike", "Metroidvania", "Adventure",
        "Platformer", "Simulation", "Action", "Strategy", "Shooter"
    )

    private fun keyOf(game: Game): String = game.game_id ?: game.id ?: game.displayName

    /** Stable non-negative hash for deterministic mock values. */
    private fun stableHash(s: String): Int {
        var h = 0
        for (c in s) h = (h * 31 + c.code) and 0x7fffffff
        return h
    }

    /** Derived genre label (deterministic). */
    fun genre(game: Game): String = GENRES[stableHash(keyOf(game)) % GENRES.size]

    /** Release year parsed from the release date, or null. */
    fun year(game: Game): String? {
        val r = game.release
        if (r.length >= 4 && r.substring(0, 4).all { it.isDigit() }) return r.substring(0, 4)
        return null
    }

    /** "year · genre" subtitle used across cards. */
    fun subtitle(game: Game): String {
        val y = year(game)
        val g = genre(game)
        return if (y != null) "$y · $g" else g
    }

    /**
     * Hours played — deterministic mock. Only "playing"/"done" games show real hours;
     * everything else is 0 (not started).
     */
    fun hours(game: Game): Int = when (game.status?.lowercase()) {
        "playing" -> 12 + stableHash(keyOf(game)) % 70
        "done"    -> 8 + stableHash(keyOf(game)) % 100
        else      -> 0
    }

    /** Completion progress 0..100 for a "playing" game (deterministic mock). */
    fun progress(game: Game): Int {
        if (game.status?.lowercase() != "playing") return 0
        return 18 + stableHash(keyOf(game) + "p") % 70
    }

    // ── User-editable rating + note (persisted locally) ───────────────────────

    /** Stored rating (1..5), or a deterministic mock for "done" games, else 0. */
    fun rating(ctx: Context, game: Game): Int {
        val stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt("rating_${keyOf(game)}", -1)
        if (stored >= 0) return stored
        return if (game.status?.lowercase() == "done") 4 + stableHash(keyOf(game)) % 2 else 0
    }

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
