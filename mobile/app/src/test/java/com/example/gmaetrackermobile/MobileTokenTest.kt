package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

class MobileTokenTest {
    private val now = 1_800_000_000_000L   // 2027-01-15T08:00:00Z
    private val utc = TimeZone.getTimeZone("UTC")

    @Test fun theNameFitsTheServersLimitAndKeepsTheWholeTimestamp() {
        // The server cuts names at 60 from the END: the timestamp is what makes it unique.
        assertEquals("Android app · Pixel 8 · 2027-01-15 08:00:00", MobileToken.name("Pixel 8", now, utc))
        val long = MobileToken.name("SM-S928B Galaxy S24 Ultra Enterprise Edition 5G", now, utc)
        assertTrue(long, long.length <= 60)
        assertTrue(long, long.endsWith(" · 2027-01-15 08:00:00"))
        assertEquals("Android app · phone · 2027-01-15 08:00:00", MobileToken.name("  \n\t ", now, utc))
        assertEquals("Android app · a b · 2027-01-15 08:00:00", MobileToken.name("a\u0000\nb", now, utc))
    }

    @Test fun theRequestIsLibraryOnlyWithAFixedThirtyDayExpiry() {
        val r = MobileToken.request("pw", "Pixel 8", now)
        assertEquals(listOf("library"), r.scopes)
        assertEquals("2027-02-14T08:00:00Z", r.expiresAt)
        val (seconds, iso) = MobileToken.expiry(now)
        assertEquals(now / 1000 + 30L * 86400, seconds)
        assertEquals(r.expiresAt, iso)
        assertEquals("pw", r.password)
    }
}
