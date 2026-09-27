package com.example.gmaetrackermobile

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Removals the user can still undo (MOB-12).
 *
 * The library screen used to send the DELETE from its undo snackbar's onDismissed callback,
 * through viewLifecycleOwner and requireContext(). Leaving the screen within the 5 seconds
 * destroyed the view first, so the timeout crashed the app (getViewLifecycleOwner() throws
 * once the view is gone) and the removal was never sent: the "removed" game came back.
 *
 * Here the countdown and the DELETE run in a scope that outlives any view. Undo cancels the
 * countdown. A screen that goes away takes nothing with it. The scope, the delay and the
 * delete are injected, so the JVM unit tests drive this without Android.
 *
 * Rules (CISO review, PR #8):
 *  - Entries are keyed by OWNER and game id. Two accounts on one device can own the same
 *    game; one account's pending removal must never hide, replace or cancel the other's.
 *  - A scheduled removal is STILL SENT after the user signs out inside the window, under the
 *    token that was live when they asked for it, against their own library. That is
 *    intended: the user asked for it, and the alternative is a removal that silently never
 *    happens. It must never be "fixed" into reading the token at send time, which after a
 *    sign-in would send user A's removal with user B's token.
 */
class PendingRemovals(
    private val scope: CoroutineScope,
    private val wait: suspend (Long) -> Unit = { delay(it) },
) {
    private data class Key(val owner: String, val gameId: String)

    private val pending = mutableMapOf<Key, Job>()

    /**
     * Removes [gameId] after [delayMs] unless [undo] is called first. [delete] runs once, off
     * any view; it returns true when the server removed the game. [onFailed] is told when it
     * did not, so the caller can put the game back. [onCommitted] runs when the window closes,
     * before the delete. A second schedule for the same owner and id replaces the first.
     */
    @Synchronized
    fun schedule(
        owner: String,
        gameId: String,
        delayMs: Long,
        delete: suspend () -> Boolean,
        onFailed: (gameId: String) -> Unit = {},
        onCommitted: () -> Unit = {},
    ) {
        val key = Key(owner, gameId)
        pending.remove(key)?.cancel()
        // LAZY, registered, THEN started: with an immediate dispatcher the body can run
        // inside launch(), before a plain `val job = launch {}` has been stored.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            wait(delayMs)
            // Past this point Undo is too late: the removal is committed.
            val mine = coroutineContext[Job]
            synchronized(this@PendingRemovals) {
                if (pending[key] !== mine) return@launch
                pending.remove(key)
            }
            // Undo is no longer possible: let the caller take its Undo off screen. With
            // TalkBack on, Snackbar stretches its own timeout past the window (UI/UX review).
            onCommitted()
            val ok = try { delete() } catch (e: CancellationException) { throw e } catch (e: Exception) { false }
            if (!ok) onFailed(gameId)
        }
        pending[key] = job
        job.start()
    }

    /** Cancels a pending removal. True when it was still pending, so the game was kept. */
    @Synchronized
    fun undo(owner: String, gameId: String): Boolean {
        val job = pending.remove(Key(owner, gameId)) ?: return false
        job.cancel()
        return true
    }

    /** Ids whose removal is scheduled but not yet sent: a reload must keep them hidden. */
    @Synchronized
    fun pendingIds(owner: String): Set<String> =
        pending.keys.filter { it.owner == owner }.map { it.gameId }.toSet()

    companion object {
        /** The app's instance, alive as long as the process is. */
        val app: PendingRemovals by lazy {
            PendingRemovals(CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate))
        }
    }
}
