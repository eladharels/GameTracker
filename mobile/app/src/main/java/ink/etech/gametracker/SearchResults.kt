package ink.etech.gametracker

import java.io.IOException

/**
 * What one search ended as (MOB-15). Every failure used to become an empty list, so an outage,
 * an expired session or a 429 all read "No games found for 'x'", and users concluded the game
 * did not exist. Pure, so the rules run in JVM tests.
 */
sealed class SearchResult {
    /** [degraded]: the server answered, but a game source was down (`X-Catalog-Degraded`). */
    data class Found(val games: List<Game>, val degraded: Boolean) : SearchResult()
    data class Empty(val degraded: Boolean) : SearchResult()
    data class Failed(val reason: Reason) : SearchResult()

    enum class Reason { OFFLINE, SIGNED_OUT, RATE_LIMITED, SERVER }
}

object SearchResults {
    const val DEGRADED_HEADER = "X-Catalog-Degraded"

    /** From an HTTP answer: its status, body and the degraded header. */
    fun of(code: Int, body: List<Game>?, degradedHeader: String?): SearchResult {
        val degraded = degradedHeader == "1"
        return when {
            code in 200..299 -> if (body.isNullOrEmpty()) SearchResult.Empty(degraded) else SearchResult.Found(body, degraded)
            code == 401 -> SearchResult.Failed(SearchResult.Reason.SIGNED_OUT)
            code == 429 -> SearchResult.Failed(SearchResult.Reason.RATE_LIMITED)
            else -> SearchResult.Failed(SearchResult.Reason.SERVER)
        }
    }

    /** From a call that never got an answer. */
    fun of(error: Throwable): SearchResult = SearchResult.Failed(
        if (error is IOException) SearchResult.Reason.OFFLINE else SearchResult.Reason.SERVER
    )

    /** The heading shown above the results, or for an empty or failed search. */
    fun header(result: SearchResult, query: String): String = when (result) {
        is SearchResult.Found -> "Found ${result.games.size} game(s) for '$query'"
        is SearchResult.Empty -> "No games found for '$query'"
        is SearchResult.Failed -> "Couldn't search for '$query'"
    }

    /** The title and explanation for the empty/failed state. Never server text. */
    fun state(result: SearchResult): Pair<String, String>? = when (result) {
        is SearchResult.Found -> null
        is SearchResult.Empty ->
            if (result.degraded) "No matches so far" to "Some game sources are unavailable right now, so this may not be everything. Try again in a few minutes."
            else "No matches" to "Try a different title, series, or genre keyword."
        is SearchResult.Failed -> when (result.reason) {
            SearchResult.Reason.OFFLINE -> "You're offline" to "Check your connection, then try again."
            SearchResult.Reason.SIGNED_OUT -> "Signed out" to "Your session ended. Sign in again to search."
            SearchResult.Reason.RATE_LIMITED -> "Too many searches" to "Wait a minute, then try again."
            SearchResult.Reason.SERVER -> "Search isn't working right now" to "The server couldn't run this search. Try again in a few minutes."
        }
    }

    /** A note under the header when results came back with a source down. */
    fun degradedNote(result: SearchResult): String? =
        if (result is SearchResult.Found && result.degraded) "Some game sources are unavailable, so results may be incomplete." else null

    /** Whether the failed state offers Retry: not for a signed-out session (it goes to sign-in). */
    fun canRetry(result: SearchResult): Boolean = result is SearchResult.Failed && result.reason != SearchResult.Reason.SIGNED_OUT
}
