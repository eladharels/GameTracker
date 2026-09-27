package com.example.gmaetrackermobile

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException

class SessionExpiryInterceptorTest {
    private lateinit var server: MockWebServer
    private val store = SessionStore(MapStore()) { 0L }
    private var ended = 0
    private val client = OkHttpClient.Builder()
        .addInterceptor(SessionExpiryInterceptor({ store.clearIfCurrent(it) }, { ended++ }))
        .build()

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { try { server.shutdown() } catch (_: IOException) {} }

    private fun call(code: Int, authorization: String?) {
        server.enqueue(MockResponse().setResponseCode(code))
        val builder = Request.Builder().url(server.url("/api/user/jane/games"))
        if (authorization != null) builder.header("Authorization", authorization)
        client.newCall(builder.build()).execute().close()
    }

    @Test fun a401ForTheCurrentTokenEndsTheSessionOnce() {
        store.save("tok-1", "jane")
        call(401, "Bearer tok-1")
        call(401, "Bearer tok-1")
        assertNull(store.token)
        assertEquals("jane", store.username)
        assertEquals(1, ended)
    }

    @Test fun a401ForAStaleTokenOrTheLoginCallEndsNothing() {
        store.save("tok-2", "jane")
        call(401, "Bearer tok-1")
        call(401, null)
        assertEquals("tok-2", store.token)
        assertEquals(0, ended)
    }

    @Test fun successAndOtherErrorsEndNothing() {
        store.save("tok-1", "jane")
        call(200, "Bearer tok-1")
        call(403, "Bearer tok-1")
        call(500, "Bearer tok-1")
        assertEquals("tok-1", store.token)
        assertEquals(0, ended)
    }

    @Test fun beingOfflineIsNotBeingSignedOut() {
        store.save("tok-1", "jane")
        val url = server.url("/api/user/me")   // taken while the server is up; nothing listens after
        server.shutdown()
        try {
            client.newCall(Request.Builder().url(url).header("Authorization", "Bearer tok-1").build()).execute()
            fail("expected a network failure")
        } catch (_: IOException) {}
        assertEquals("tok-1", store.token)
        assertEquals(0, ended)
    }
}
