package ink.etech.gametracker

/**
 * What a list screen says when it has nothing to show, and what it offers to do about it.
 *
 * "Nothing to show" has four different causes, and they used to share one message: the
 * library failed to load (the screen read "0 games" and "Your library is empty", which is
 * false and offers no way back), the library really is empty, a status filter has no games,
 * or a search matched nothing. Each now says which it is and offers the one action that
 * helps. Pure, so it is JVM-tested.
 */
object ScreenStates {

    enum class Action { RETRY, DISCOVER, CLEAR_SEARCH, SHOW_ALL }

    data class State(val title: String, val body: String, val action: Action, val actionLabel: String)

    /**
     * The Library tab's empty state.
     *
     * [libraryCount] is the whole library, before filter and search. [filterLabel] is the
     * selected chip's label, or null for All. [failed] means the last load did not reach the
     * server and nothing is held.
     */
    fun library(libraryCount: Int, filterLabel: String?, query: String, failed: Boolean): State = when {
        failed && libraryCount == 0 -> loadFailed("your library")
        libraryCount == 0 -> State(
            "Your library is empty",
            "Discover games and add them to start tracking.",
            Action.DISCOVER,
            "Discover games",
        )
        query.isNotBlank() -> State(
            "No games match “${query.trim()}”",
            if (filterLabel != null) "Nothing in $filterLabel matches. Try another word or clear the search." else "Try another word or clear the search.",
            Action.CLEAR_SEARCH,
            "Clear search",
        )
        filterLabel != null -> State(
            "Nothing in $filterLabel",
            // Unreleased is the server's conclusion from the release date, never a status a
            // user picks (MOB-18), so "games you mark as" would be wrong for it.
            if (filterLabel == "Unreleased") "Games with a release date still ahead show up here."
            else "Games you mark as $filterLabel show up here.",
            Action.SHOW_ALL,
            "Show all games",
        )
        // Unreachable with a non-empty library and no narrowing, but never a blank screen.
        else -> State("Nothing to show", "Pull down to refresh.", Action.RETRY, "Refresh")
    }

    /** A screen whose data could not be read at all: say so, and offer to try again. */
    fun loadFailed(what: String): State = State(
        "Couldn't load $what",
        "Check your connection and try again.",
        Action.RETRY,
        "Try again",
    )
}
