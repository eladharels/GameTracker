package com.example.gmaetrackermobile

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * "Add to library", from Search and from Game Details (MOB-16). ONE implementation, so the MOB-10
 * rule cannot be followed by one screen and forgotten by the other:
 *
 * v1's add OVERWRITES the stored status, so "Add" on a game marked done demoted it to wishlist,
 * wrote a permanent history row and pushed a notification. So a FRESH library is read first
 * (a screen's copy can be stale), a SAME match is refused, and nothing is posted when the check
 * itself failed: a blind add is the bug.
 */
object LibraryAdd {
    sealed class Outcome {
        /** [saved]: what the server stored (Unreleased for a game not out yet, MOB-13). */
        data class Added(val saved: String, val possibleDuplicate: Boolean, val library: List<Game>?) : Outcome()
        data class AlreadyOwned(val owned: Game?, val library: List<Game>) : Outcome()
        object CheckFailed : Outcome()
        object Failed : Outcome()
    }

    suspend fun add(context: Context, game: Game): Outcome = withContext(Dispatchers.IO) {
        val session = Session.get(context)
        val bearer = session.bearer() ?: return@withContext Outcome.CheckFailed
        val username = session.username ?: return@withContext Outcome.CheckFailed
        // FORCED: never the shared copy, which can be up to 30 s old (MOB-10, MOB-19).
        val fresh = LibraryRepository.load(context, force = true) ?: return@withContext Outcome.CheckFailed
        val match = LibraryMatch.match(fresh.map { LibraryMatch.rowOf(it) }, LibraryMatch.candidateOf(game))
        if (match == LibraryMatch.Kind.SAME) return@withContext Outcome.AlreadyOwned(LibraryMatch.owned(fresh, game), fresh)
        val response = try {
            ApiClient.api.addOrUpdateGame(bearer, username, GameStatus.request(game, GameStatus.WISHLIST))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return@withContext Outcome.Failed
        }
        if (!response.isSuccessful) return@withContext Outcome.Failed
        Outcome.Added(
            saved = GameStatus.stored(GameStatus.WISHLIST, response.body()),
            possibleDuplicate = match == LibraryMatch.Kind.POSSIBLE,
            library = LibraryRepository.load(context, force = true),
        )
    }

    /** What to tell the user. Fixed text: never a server body or an exception (MOB-27). */
    fun message(game: Game, outcome: Outcome): String = when (outcome) {
        is Outcome.Added -> {
            val where = if (outcome.saved == GameStatus.WISHLIST) "" else " as ${GameStatus.label(outcome.saved)}"
            // A same-named game with an unknown year: added (a remake must not be refused),
            // but say so, as the web app does.
            val note = if (outcome.possibleDuplicate) ". A game with the same name is already in your library." else "!"
            "${game.displayName} added to library$where$note"
        }
        is Outcome.AlreadyOwned ->
            "${game.displayName} is already in your library" +
                (outcome.owned?.status?.let { " (${GameStatus.label(it)})" } ?: "")
        Outcome.CheckFailed -> "Couldn't check your library. Try again."
        Outcome.Failed -> "Couldn't add ${game.displayName}. Try again."
    }
}
