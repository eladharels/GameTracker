package com.example.gmaetrackermobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SafeUrlTest {
    @Test fun onlyHttpsWithAHostReachesTheNetwork() {
        // MOB-8: an http:// cover went out in the clear on API 24-27, and nothing checked.
        assertEquals("https://images.igdb.com/a.jpg", SafeUrl.https("https://images.igdb.com/a.jpg"))
        assertEquals("HTTPS://cdn.example/x.png", SafeUrl.https("  HTTPS://cdn.example/x.png "))
        assertEquals("protocol-relative is read as https", "https://images.igdb.com/b.jpg", SafeUrl.https("//images.igdb.com/b.jpg"))
        for (bad in listOf(
            null, "", "   ", "http://images.igdb.com/a.jpg", "HTTP://x/y", "ftp://x/y",
            "file:///sdcard/x.jpg", "content://media/1", "javascript:alert(1)", "data:image/png;base64,AA",
            "/relative/path.jpg", "https://", "https:///nohost", "https://host/a b.jpg", "https://host/\u0000",
            "https:/one-slash.example/x",
        )) assertNull("$bad passed", SafeUrl.https(bad))
    }
}
