package com.example.gmaetrackermobile

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MOB-1: the client used to log every bearer token and the login password, release included. */
class ApiClientLoggingTest {
    @Test fun aDebugClientNeverLogsTheTokenThePasswordOrTheResponseBody() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"token":"server-issued-secret"}"""))
        server.start()
        val lines = mutableListOf<String>()
        val client = ApiClient.buildClient(debug = true, logger = HttpLoggingInterceptor.Logger { lines.add(it) })
        val body = """{"username":"jane","password":"hunter2-password"}""".toRequestBody("application/json".toMediaType())
        client.newCall(
            Request.Builder().url(server.url("/api/auth/login"))
                .header("Authorization", "Bearer eyJhbGciOi.bearer-secret.sig")
                .post(body).build()
        ).execute().close()
        server.shutdown()
        val log = lines.joinToString("\n")
        assertTrue("the debug client logged nothing at all", lines.isNotEmpty())
        for (secret in listOf("hunter2-password", "bearer-secret", "server-issued-secret")) {
            assertFalse("the debug log contains $secret", log.contains(secret))
        }
    }

    @Test fun aReleaseClientHasNoLoggingInterceptor() {
        assertTrue(ApiClient.buildClient(debug = false).interceptors.none { it is HttpLoggingInterceptor })
    }

    @Test fun theBuildTypeUnderTestWiresLoggingOnlyInDebug() {
        // Runs twice in CI: testDebugUnitTest (DEBUG=true) and testReleaseUnitTest (DEBUG=false),
        // so the release variant's real BuildConfig is what decides here.
        val logging = ApiClient.buildClient(BuildConfig.DEBUG).interceptors.filterIsInstance<HttpLoggingInterceptor>()
        assertEquals(BuildConfig.DEBUG, logging.isNotEmpty())
    }

    @Test fun theDebugLevelIsNeverHeadersOrBody() {
        val logging = ApiClient.buildClient(debug = true).interceptors.filterIsInstance<HttpLoggingInterceptor>().single()
        assertEquals(HttpLoggingInterceptor.Level.BASIC, logging.level)
    }
}
