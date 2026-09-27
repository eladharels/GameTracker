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
        removals.schedule("jane", "igdb_1", 5000, delete = { deleted += "igdb_1"; true })
        assertEquals(setOf("igdb_1"), removals.pendingIds("jane"))
        assertTrue("sent before the window closed", deleted.isEmpty())

        // The library screen has gone by now (a tab switch). Nothing here refers to it.
        gate.complete(Unit)

        assertEquals(listOf("igdb_1"), deleted)
        assertTrue(removals.pendingIds("jane").isEmpty())
    }

    @Test
    fun `undo inside the window means nothing is sent`() {
        var sent = false
        removals.schedule("jane", "igdb_1", 5000, delete = { sent = true; true })
        assertTrue(removals.undo("jane", "igdb_1"))
        gate.complete(Unit)
        assertFalse("undone, yet the DELETE was sent", sent)
        assertTrue(removals.pendingIds("jane").isEmpty())
    }

    @Test
    fun `undo after the window is too late and says so`() {
        removals.schedule("jane", "igdb_1", 5000, delete = { true })
        gate.complete(Unit)
        assertFalse(removals.undo("jane", "igdb_1"))
    }

    @Test
    fun `a failed or throwing delete is reported, so the game can be put back`() {
        val failed = mutableListOf<String>()
        removals.schedule("jane", "igdb_1", 5000, delete = { false }, onFailed = { failed += it })
        removals.schedule("jane", "igdb_2", 5000, delete = { throw java.io.IOException("offline") }, onFailed = { failed += it })
        gate.complete(Unit)
        assertEquals(listOf("igdb_1", "igdb_2"), failed.sorted())
    }

    @Test
    fun `one account's pending removal never touches another's copy of the game`() {
        val deleted = mutableListOf<String>()
        removals.schedule("jane", "igdb_1", 5000, delete = { deleted += "jane"; true })
        // Bob, signed in on the same device inside Jane's window, owns the same game.
        assertTrue("Bob's library hides his game because of Jane's removal", removals.pendingIds("bob").isEmpty())
        removals.schedule("bob", "igdb_1", 5000, delete = { deleted += "bob"; true })
        gate.complete(Unit)
        assertEquals(listOf("bob", "jane"), deleted.sorted())
    }

    @Test
    fun `the caller is told when Undo stops being possible, and never after an undo`() {
        var committed = 0
        removals.schedule("jane", "igdb_1", 5000, delete = { true }, onCommitted = { committed++ })
        removals.schedule("jane", "igdb_2", 5000, delete = { true }, onCommitted = { committed += 100 })
        assertTrue(removals.undo("jane", "igdb_2"))
        gate.complete(Unit)
        assertEquals("the snackbar's Undo must be taken down exactly once, and only for igdb_1", 1, committed)
    }

    @Test
    fun `scheduling the same game twice sends one removal`() {
        var count = 0
        removals.schedule("jane", "igdb_1", 5000, delete = { count++; true })
        removals.schedule("jane", "igdb_1", 5000, delete = { count++; true })
        gate.complete(Unit)
        assertEquals(1, count)
    }
}
