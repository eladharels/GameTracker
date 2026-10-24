package ink.etech.gametracker

/**
 * The five library statuses, as the server stores them (MOB-13). The ONE place the app spells
 * them: requests carry these lowercase values, never a label ("Done" worked only because the
 * server lowercases for this app's sake).
 *
 * `unreleased` is not a choice. The server decides it from the stored release date
 * (`statusForDate`, the backend's D7): asking for `playing` on a game that is not out yet stores
 * `unreleased`, and asking for `unreleased` on a released game stores `wishlist`. So the pickers
 * offer [PICKABLE] only, and every write shows what the server SAYS it stored ([outcome]).
 */
object GameStatus {
    const val WISHLIST = "wishlist"
    const val PLAYING = "playing"
    const val DONE = "done"
    const val BACKLOG = "backlog"
    const val UNRELEASED = "unreleased"

    val ALL = listOf(WISHLIST, PLAYING, DONE, BACKLOG, UNRELEASED)

    /** What a user may pick, in picker order. */
    val PICKABLE = listOf(WISHLIST, BACKLOG, PLAYING, DONE)

    fun canonical(status: String?): String? = status?.trim()?.lowercase()?.takeIf { it in ALL }

    fun label(status: String?): String = canonical(status)?.replaceFirstChar { it.uppercase() } ?: "Unknown"

    /** The add/update body for [game] at [status]. An unknown date is `null`, never `""`. */
    fun request(game: Game, status: String): GameUpdateRequest = GameUpdateRequest(
        gameId = game.game_id ?: game.id ?: "",
        gameName = game.displayName,
        coverUrl = game.cover,
        releaseDate = game.release.ifBlank { null },
        status = requireNotNull(canonical(status)) { "not a status: $status" },
        steamAppId = game.steam_app_id ?: game.steamAppId,
    )

    /** The status the server stored, from its answer; [requested] when it did not say. */
    fun stored(requested: String, answer: GameUpsertResult?): String =
        canonical(answer?.status) ?: canonical(requested) ?: requested

    /**
     * What to tell the user after a write of [requested] for [game]. When the server stored
     * something else (`coerced`), say why, in its terms: the date, not "an error".
     */
    fun outcome(game: Game, requested: String, answer: GameUpsertResult?): String {
        val name = game.displayName
        val saved = stored(requested, answer)
        if (answer?.coerced != true || saved == canonical(requested)) return "$name → ${label(saved)}"
        return when (saved) {
            UNRELEASED ->
                if (game.release.isBlank()) "$name has no release date yet, so it stays Unreleased."
                else "$name isn't out until ${game.release}, so it stays Unreleased."
            else -> "$name was saved as ${label(saved)}."
        }
    }
}
