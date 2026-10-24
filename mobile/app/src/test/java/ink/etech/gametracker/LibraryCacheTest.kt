package ink.etech.gametracker

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LibraryCacheTest {
    private fun g(id: String) = Game(id = id, game_id = id, game_name = id)
    private var now = 1_000L
    private var calls = 0

    private fun cache(answer: () -> List<Game>?) = LibraryCache(
        fetch = { _, _ -> calls++; answer() },
        nowMs = { now },
        maxAgeMs = 30_000,
    )

    @Test fun aFreshCopyIsServedWithoutARequest() = runBlocking {
        val c = cache { listOf(g("a")) }
        c.get("Bearer A", "alice")
        now += 29_000
        assertEquals(listOf("a"), c.get("Bearer A", "alice")?.map { it.game_id })
        assertEquals(1, calls)   // MOB-19: two GETs per tab switch before
    }

    @Test fun anOldCopyOrAForcedReadAsksTheServer() = runBlocking {
        val c = cache { listOf(g("a")) }
        c.get("Bearer A", "alice")
        c.get("Bearer A", "alice", force = true)
        now += 30_000
        c.get("Bearer A", "alice")
        assertEquals(3, calls)
    }

    @Test fun anotherCredentialNeverSeesTheCopy() = runBlocking {
        var who = "alice"
        val c = cache { listOf(g(who)) }
        c.get("Bearer A", "alice")
        who = "bob"
        assertEquals(listOf("bob"), c.get("Bearer B", "bob")?.map { it.game_id })
        assertNull(c.peek("Bearer A"))   // replaced, not kept beside it
    }

    @Test fun aFailureIsNullAndKeepsNothing() = runBlocking {
        var fail = true
        val c = cache { if (fail) null else listOf(g("a")) }
        assertNull(c.get("Bearer A", "alice"))
        assertNull(c.peek("Bearer A"))
        fail = false
        assertEquals(1, c.get("Bearer A", "alice")?.size)
    }

    @Test fun aWriteDropsTheCopy() = runBlocking {
        val c = cache { listOf(g("a")) }
        c.get("Bearer A", "alice")
        c.invalidate()
        assertNull(c.peek("Bearer A"))
        c.get("Bearer A", "alice")
        assertEquals(2, calls)
    }

    @Test fun aReadThatStartedBeforeAWriteIsNotStored() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val c = LibraryCache(fetch = { _, _ -> gate.await(); listOf(g("old")) }, nowMs = { now })
        val read = async { c.get("Bearer A", "alice") }
        yield()
        c.invalidate()        // the write lands while the read is in flight
        gate.complete(Unit)
        assertEquals(listOf("old"), read.await()?.map { it.game_id })   // the caller still gets it
        assertNull(c.peek("Bearer A"))                                    // but it is not served again
    }

    @Test fun concurrentReadersShareOneRequest() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val c = LibraryCache(fetch = { _, _ -> calls++; gate.await(); listOf(g("a")) }, nowMs = { now })
        val one = async { c.get("Bearer A", "alice") }
        val two = async { c.get("Bearer A", "alice", force = true) }
        yield()
        gate.complete(Unit)
        one.await(); two.await()
        assertEquals(1, calls)
    }
}
