package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStoreTest {
    private val now = 1_800_000_000L
    private fun store(kv: MapStore = MapStore()) = SessionStore(kv) { now }

    @Test fun signingOutRemovesTheTokenButKeepsTheUsernameAndFingerprintSetting() {
        // MOB-3: logout used to keep the token whenever fingerprint unlock was on.
        val kv = MapStore()
        kv.map["fingerprint_enabled"] = "true"
        val s = store(kv)
        s.save(jwtWithExp(now + 3600), "jane")
        s.endSession()
        assertNull(s.token)
        assertEquals("jane", s.username)
        assertEquals("true", kv.map["fingerprint_enabled"])
    }

    @Test fun aTokenIsLiveOnlyWhileItsOwnExpIsAheadWithSkew() {
        val s = store()
        s.save(jwtWithExp(now + 3600), "jane"); assertTrue(s.hasLiveToken())
        s.save(jwtWithExp(now + 30), "jane"); assertFalse("inside the 60s skew", s.hasLiveToken())
        s.save(jwtWithExp(now - 1), "jane"); assertFalse(s.hasLiveToken())
        s.save(jwtWithExp(null), "jane"); assertFalse("no exp is not live", s.hasLiveToken())
        s.save("not-a-jwt", "jane"); assertFalse(s.hasLiveToken())
        s.endSession(); assertFalse(s.hasLiveToken())
    }

    @Test fun decodesBase64UrlPayloadsWithoutPadding() {
        assertEquals(1_800_000_123L, SessionStore.jwtExpiry(jwtWithExp(1_800_000_123L)))
        assertNull(SessionStore.jwtExpiry("a.b"))
        assertNull(SessionStore.jwtExpiry("a.!!!.c"))
    }

    @Test fun onlyTheCurrentBearerClearsTheSessionAndOnlyOnce() {
        val s = store()
        s.save("tok-2", "jane")
        assertFalse("login sends no header", s.clearIfCurrent(null))
        assertFalse("a stale token's 401", s.clearIfCurrent("Bearer tok-1"))
        assertEquals("tok-2", s.token)
        assertTrue(s.clearIfCurrent("Bearer tok-2"))
        assertNull(s.token)
        assertFalse("a second 401 from the same session", s.clearIfCurrent("Bearer tok-2"))
    }
}
