package ink.etech.gametracker

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStoreTest {
    private val now = 1_800_000_000L
    private fun store(kv: MapStore = MapStore()) = SessionStore(kv) { now }
    private val sealedBlob = SealedToken(ciphertext = "Y2lwaGVy", iv = "aXY=")

    @Test fun theTokenIsNeverWrittenToDiskInTheClear() {
        // MOB-6: it used to live in SharedPreferences under "token".
        val kv = MapStore()
        val s = store(kv)
        val token = jwtWithExp(now + 3600)
        s.save(token, "jane")
        assertEquals(token, s.token)
        assertTrue("the token reached the preferences: ${kv.map}", kv.map.values.none { it.contains(token) })
        assertNull(kv.map[SessionStore.KEY_LEGACY_TOKEN])
    }

    @Test fun signingOutRemovesTheTokenAndItsSealedCopyButKeepsTheUsernameAndFingerprintSetting() {
        // MOB-3: logout used to keep the token whenever fingerprint unlock was on.
        val kv = MapStore()
        kv.map["fingerprint_enabled"] = "true"
        val s = store(kv)
        val token = jwtWithExp(now + 3600)
        s.save(token, "jane")
        assertTrue(s.storeSealed(sealedBlob, forToken = token))
        s.endSession()
        assertNull(s.token)
        assertNull(s.sealed())
        assertFalse(s.hasSealedLiveSession())
        assertEquals("jane", s.username)
        assertEquals("true", kv.map["fingerprint_enabled"])
    }

    @Test fun aSealedCopyIsStoredOnlyForTheTokenHeldNow() {
        val s = store()
        val first = jwtWithExp(now + 3600)
        val second = jwtWithExp(now + 7200)
        s.save(first, "jane")
        s.save(second, "jane")   // a sign-in while the prompt for `first` was up
        assertFalse("sealed a token that is no longer the session", s.storeSealed(sealedBlob, forToken = first))
        assertNull(s.sealed())
        assertTrue(s.storeSealed(sealedBlob, forToken = second))
        assertEquals(sealedBlob, s.sealed())
    }

    @Test fun aNewSignInDropsTheOldSealedCopy() {
        val s = store()
        val first = jwtWithExp(now + 3600)
        s.save(first, "jane")
        s.storeSealed(sealedBlob, forToken = first)
        s.save(jwtWithExp(now + 7200), "jane")
        assertNull("the old session's sealed copy survived a new sign-in", s.sealed())
    }

    @Test fun theFingerprintIsOfferedOnlyForALiveSealedSession() {
        val s = store()
        assertFalse("nothing sealed", s.hasSealedLiveSession())
        val token = jwtWithExp(now + 3600)
        s.save(token, "jane"); s.storeSealed(sealedBlob, token)
        assertTrue(s.hasSealedLiveSession())

        val soon = jwtWithExp(now + 30)
        s.save(soon, "jane"); s.storeSealed(sealedBlob, soon)
        assertFalse("inside the 60s skew", s.hasSealedLiveSession())

        val noExp = jwtWithExp(null)
        s.save(noExp, "jane")
        assertFalse("a token without exp cannot be sealed", s.storeSealed(sealedBlob, noExp))
    }

    @Test fun unsealAcceptsOnlyTheSealedSessionAndOnlyWhileItIsLive() {
        val kv = MapStore()
        val token = jwtWithExp(now + 3600)
        store(kv).apply { save(token, "jane"); storeSealed(sealedBlob, token) }

        // A cold start: a NEW process, nothing in memory.
        val cold = store(kv)
        assertNull(cold.token)
        assertFalse("a different session", cold.unseal(jwtWithExp(now + 9999)))
        assertNull(cold.token)
        assertTrue(cold.unseal(token))
        assertEquals(token, cold.token)

        val expiredKv = MapStore()
        val old = jwtWithExp(now - 1)
        expiredKv.map[SessionStore.KEY_SEALED] = "c"
        expiredKv.map[SessionStore.KEY_SEALED_IV] = "i"
        expiredKv.map[SessionStore.KEY_SEALED_EXP] = (now - 1).toString()
        assertFalse("expired", store(expiredKv).unseal(old))
    }

    @Test fun theOldPlaintextTokenIsDeletedFromDiskAndKeptForThisProcessOnly() {
        val kv = MapStore()
        val legacy = jwtWithExp(now + 3600)
        kv.map[SessionStore.KEY_LEGACY_TOKEN] = legacy
        kv.map[SessionStore.KEY_USERNAME] = "jane"
        val s = store(kv)
        assertTrue(s.migrateLegacyToken())
        assertNull("the plaintext token is still on disk", kv.map[SessionStore.KEY_LEGACY_TOKEN])
        assertEquals(legacy, s.token)
        assertFalse("migrated twice", s.migrateLegacyToken())
        assertNull("the next process does not get it back", store(kv).token)
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
        val token = jwtWithExp(now + 3600)
        s.save(token, "jane")
        s.storeSealed(sealedBlob, token)
        assertFalse("login sends no header", s.clearIfCurrent(null))
        assertFalse("a stale token's 401", s.clearIfCurrent("Bearer tok-1"))
        assertEquals(token, s.token)
        assertTrue(s.clearIfCurrent("Bearer $token"))
        assertNull(s.token)
        assertNull("a 401 must also end the sealed copy", s.sealed())
        assertFalse("a second 401 from the same session", s.clearIfCurrent("Bearer $token"))
    }

    // ── MOB-9: this phone's 30-day token ─────────────────────────────────────────

    private val pat = "gt_pat_abcdefghijklmnopqrstuvwxyz0123456789"

    @Test fun aPatIsLiveOnTheExpiryItWasMintedWithAndItsIdIsKeptForRevocation() {
        val kv = MapStore()
        val s = store(kv)
        s.save(jwtWithExp(now + 3600), "jane")
        s.adoptPat(pat, 42, now + 30 * 86400)
        assertEquals(pat, s.token)
        assertTrue(s.isPat)
        assertEquals(42L, s.patId)
        assertTrue("a PAT has no exp of its own: its minted expiry decides", s.hasLiveToken())
        assertTrue("the PAT reached the preferences: ${kv.map}", kv.map.values.none { it.contains(pat) })
        assertEquals(42L, s.pendingRevokeId())
        s.endSession()
        assertNull(s.token)
        assertFalse(s.isPat)
        assertEquals("the id outlives the session until its revocation is confirmed", 42L, s.pendingRevokeId())
        s.forgetPatId(7)
        assertEquals("only that id is forgotten", 42L, s.pendingRevokeId())
        s.forgetPatId(42)
        assertNull(s.pendingRevokeId())
    }

    @Test fun anExpiredPatIsNotLive() {
        val s = store()
        s.adoptPat(pat, 1, now + 30)
        assertFalse("inside the skew", s.hasLiveToken())
        s.adoptPat(pat, 1, now - 1)
        assertFalse(s.hasLiveToken(skewSeconds = 0))
    }

    @Test fun aSealedPatComesBackWithItsIdAndExpiryAndOnlyAsAPat() {
        val kv = MapStore()
        val exp = now + 30 * 86400
        store(kv).apply { save(jwtWithExp(now + 3600), "jane"); adoptPat(pat, 42, exp); assertTrue(storeSealed(sealedBlob, pat)) }
        assertTrue(store(kv).hasSealedLiveSession())

        val cold = store(kv)
        assertFalse("a JWT never unseals a PAT copy", cold.unseal(jwtWithExp(exp)))
        assertFalse("nor anything that is not a PAT", cold.unseal("not-a-pat"))
        assertTrue(cold.unseal(pat))
        assertEquals(pat, cold.token)
        assertEquals(42L, cold.patId)
        assertTrue(cold.hasLiveToken())
    }

    @Test fun aPatNeverUnsealsAsAJwtSession() {
        val kv = MapStore()
        val jwt = jwtWithExp(now + 3600)
        store(kv).apply { save(jwt, "jane"); storeSealed(sealedBlob, jwt) }
        assertFalse(store(kv).unseal(pat))
        assertTrue(store(kv).unseal(jwt))
    }

    @Test fun theSealContextBindsKindIdAndExpirySoNoneCanBeSwapped() {
        val kv = MapStore()
        val s = store(kv)
        val exp = now + 30 * 86400
        s.save(jwtWithExp(now + 3600), "jane"); s.adoptPat(pat, 42, exp)
        val sealedWith = s.sealContext()!!
        s.storeSealed(sealedBlob, pat)
        assertArrayEquals("what was sealed is what the stored copy is opened with", sealedWith, s.sealedContext())
        kv.map[SessionStore.KEY_SEALED_EXP] = (exp + 86400).toString()
        assertFalse("a later expiry written beside the blob changes the additional data", sealedWith.contentEquals(s.sealedContext()!!))
        kv.map[SessionStore.KEY_SEALED_EXP] = exp.toString()
        kv.map[SessionStore.KEY_SEALED_PAT_ID] = "43"
        assertFalse("so does another id", sealedWith.contentEquals(s.sealedContext()!!))

        val jwtKv = MapStore()
        val j = store(jwtKv)
        val jwt = jwtWithExp(now + 3600)
        j.save(jwt, "jane")
        j.storeSealed(sealedBlob, jwt)
        assertFalse("a JWT copy is bound as a JWT", j.sealedContext()!!.contentEquals(sealedWith))

        val legacy = MapStore()
        legacy.map[SessionStore.KEY_SEALED] = "c"; legacy.map[SessionStore.KEY_SEALED_IV] = "i"; legacy.map[SessionStore.KEY_SEALED_EXP] = "9"
        assertNull("a copy sealed before MOB-9 was sealed with no additional data", store(legacy).sealedContext())
    }

    @Test fun aNewPasswordSignInDropsThePatButKeepsItsIdForRevocation() {
        val kv = MapStore()
        val s = store(kv)
        s.adoptPat(pat, 42, now + 86400)
        s.storeSealed(sealedBlob, pat)
        s.save(jwtWithExp(now + 3600), "jane")
        assertFalse(s.isPat)
        assertNull(s.sealed())
        assertNull(kv.map[SessionStore.KEY_SEALED_PAT_ID])
        assertEquals(42L, s.pendingRevokeId())
    }
}
