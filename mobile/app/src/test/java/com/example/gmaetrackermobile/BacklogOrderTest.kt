package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BacklogOrderTest {
    private fun g(id: String, status: String, order: Int?) = Game(id = id, game_id = id, game_name = id, status = status, backlog_order = order)
    // Stored numbers with gaps, an unknown position, and games that are not in the backlog.
    private val library = listOf(
        g("c", "backlog", 7), g("x", "done", 1), g("a", "backlog", 2), g("d", "backlog", null),
        g("b", "Backlog", 5), g("y", "wishlist", 3),
    )

    @Test fun theBacklogIsOrderedByStoredPositionWithUnknownLast() {
        assertEquals(listOf("a", "b", "c", "d"), BacklogOrder.backlog(library).map { it.game_id })
    }

    @Test fun positionsAreTheListPositionNotTheStoredNumber() {
        // MOB-14: cards showed #7 for "c" while Home showed #3.
        assertEquals(mapOf("a" to 1, "b" to 2, "c" to 3, "d" to 4), BacklogOrder.positions(library))
    }

    @Test fun oneRequestCarriesTheWholeOrder() {
        val dragged = BacklogOrder.backlog(library).toMutableList().apply { add(0, removeAt(2)) }
        assertEquals(listOf("c", "a", "b", "d"), BacklogOrder.request(dragged).order)
    }

    @Test fun noDragWhileASearchNarrowsTheList() {
        assertTrue(BacklogOrder.canDrag("backlog", ""))
        assertFalse(BacklogOrder.canDrag("backlog", "zel"))
        assertFalse(BacklogOrder.canDrag("all", ""))
    }
}
