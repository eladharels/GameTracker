package ink.etech.gametracker

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.io.IOException

class LibraryWriteInterceptorTest {
    private lateinit var server: MockWebServer
    private var drops = 0
    private val client = OkHttpClient.Builder().addInterceptor(LibraryWriteInterceptor { drops++ }).build()

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { try { server.shutdown() } catch (_: IOException) {} }

    private fun call(method: String) {
        val body = if (method == "GET" || method == "HEAD") null else "{}".toRequestBody("application/json".toMediaType())
        client.newCall(Request.Builder().url(server.url("/api/user/jane/games")).method(method, body).build()).execute().close()
    }

    @Test fun aReadDropsNothing() {
        server.enqueue(MockResponse().setBody("[]"))
        call("GET")
        assertEquals(0, drops)
    }

    @Test fun everyWriteDropsTheCopyBeforeAndAfter() {
        for (m in listOf("POST", "PUT", "PATCH", "DELETE")) server.enqueue(MockResponse().setResponseCode(200))
        for (m in listOf("POST", "PUT", "PATCH", "DELETE")) call(m)
        assertEquals(8, drops)
    }

    @Test fun aFailedWriteStillDropsIt() {
        // What the server did is unknown: the next read must ask.
        server.enqueue(MockResponse().setResponseCode(500))
        call("POST")
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        try { call("PUT") } catch (_: IOException) {}
        assertEquals(4, drops)
    }
}
