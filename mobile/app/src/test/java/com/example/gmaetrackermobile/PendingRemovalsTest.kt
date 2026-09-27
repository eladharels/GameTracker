package com.example.gmaetrackermobile

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MOB-12: a removal is sent after the undo window whether or not the screen that asked for
 * it still exists, and Undo within the window means nothing is sent. The "window" here is
 * a gate the test opens, and the scope is Unconfined, so nothing waits and no Android is
 * needed.
 */
class PendingRemovalsTest {

    private val gate = CompletableDeferred<Unit>()
    private val removals = PendingRemovals(
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        wait = { gate.await() },
    )

    @Test
    fun `the removal is sent after the window, with no screen involved`() {
        val deleted = mutableListOf<String>()
        removals.schedule("igdb_1", 5000, delete = { deleted += "igdb_1"; true })
        assertEquals(setOf("igdb_1"), removals.pendingIds())
        assertTrue("sent before the window closed", deleted.isEmpty())

        // The library screen has gone by now (a tab switch). Nothing here refers to it.
        gate.complete(Unit)

        assertEquals(listOf("igdb_1"), deleted)
        assertTrue(removals.pendingIds().isEmpty())
    }

    @Test
    fun `undo inside the window means nothing is sent`() {
        var sent = false
        removals.schedule("igdb_1", 5000, delete = { sent = true; true })
        assertTrue(removals.undo("igdb_1"))
        gate.complete(Unit)
        assertFalse("undone, yet the DELETE was sent", sent)
        assertTrue(removals.pendingIds().isEmpty())
    }

    @Test
    fun `undo after the window is too late and says so`() {
        removals.schedule("igdb_1", 5000, delete = { true })
        gate.complete(Unit)
        assertFalse(removals.undo("igdb_1"))
    }

    @Test
    fun `a failed or throwing delete is reported, so the game can be put back`() {
        val failed = mutableListOf<String>()
        removals.schedule("igdb_1", 5000, delete = { false }, onFailed = { failed += it })
        removals.schedule("igdb_2", 5000, delete = { throw java.io.IOException("offline") }, onFailed = { failed += it })
        gate.complete(Unit)
        assertEquals(listOf("igdb_1", "igdb_2"), failed.sorted())
    }

    @Test
    fun `scheduling the same game twice sends one removal`() {
        var count = 0
        removals.schedule("igdb_1", 5000, delete = { count++; true })
        removals.schedule("igdb_1", 5000, delete = { count++; true })
        gate.complete(Unit)
        assertEquals(1, count)
    }
}
