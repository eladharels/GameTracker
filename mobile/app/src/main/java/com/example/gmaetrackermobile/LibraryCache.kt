package com.example.gmaetrackermobile

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The ONE in-memory copy of the signed-in user's library (MOB-19). Every screen used to fetch
 * the whole library in onViewCreated AND onResume, so each tab switch downloaded it twice.
 *
 * Pure Kotlin, so the rules are JVM-tested; [LibraryRepository] wires it to the API.
 * - A copy belongs to ONE credential ([owner] is the bearer): a different sign-in never sees
 *   the previous account's games, even before [clear] runs.
 * - A copy younger than [maxAgeMs] is served without a request; `force` (pull-to-refresh,
 *   the add-time duplicate check) always asks the server.
 * - Concurrent callers share one request (the mutex), instead of racing two.
 * - [invalidate] is called on every write the app sends; a fetch that STARTED before a write
 *   is not stored afterwards (the generation check), because its answer predates the write.
 * - A failed fetch returns null and keeps nothing: a screen never shows a failure as an
 *   empty library.
 */
class LibraryCache(
    private val fetch: suspend (owner: String, username: String) -> List<Game>?,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val maxAgeMs: Long = 30_000,
) {
    private class Copy(val owner: String, val games: List<Game>, val atMs: Long)

    private val mutex = Mutex()
    @Volatile private var copy: Copy? = null
    @Volatile private var generation = 0L

    private fun fresh(owner: String): List<Game>? =
        copy?.takeIf { it.owner == owner && nowMs() - it.atMs < maxAgeMs }?.games

    /** Completed, stored fetches: lets a waiting caller see that one finished after it asked. */
    @Volatile private var stored = 0L

    suspend fun get(owner: String, username: String, force: Boolean = false): List<Game>? {
        if (!force) fresh(owner)?.let { return it }
        val seen = stored
        return mutex.withLock {
            // Another caller fetched while this one waited: that answer is newer than the ask.
            if (stored != seen) copy?.takeIf { it.owner == owner }?.let { return@withLock it.games }
            if (!force) fresh(owner)?.let { return@withLock it }
            val gen = generation
            val games = fetch(owner, username) ?: return@withLock null
            if (generation == gen) {
                copy = Copy(owner, games, nowMs())
                stored++
            }
            games
        }
    }

    /** The copy, if it is still fresh: for a screen that can draw before it asks. */
    fun peek(owner: String): List<Game>? = fresh(owner)

    /** A write happened: the next read asks the server. */
    fun invalidate() {
        generation++
        copy = null
    }

    /** Sign-out: nothing of this account stays in memory. */
    fun clear() = invalidate()
}
