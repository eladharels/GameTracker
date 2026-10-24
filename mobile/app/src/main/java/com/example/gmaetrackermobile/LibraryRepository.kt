package com.example.gmaetrackermobile

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
import okhttp3.Response

/**
 * The library, for every screen (MOB-19): one cached copy ([LibraryCache]) behind the session.
 * Screens call [load]; nothing else calls `getLibrary`.
 */
object LibraryRepository {
    private val cache = LibraryCache(fetch = { bearer, username -> fetch(bearer, username) })

    /**
     * The signed-in user's library, or null when there is no session or it could not be read.
     * [force]: ask the server even if a fresh copy is held (pull-to-refresh, the duplicate
     * check before an add, MOB-10).
     */
    suspend fun load(context: Context, force: Boolean = false): List<Game>? {
        val session = Session.get(context)
        val bearer = session.bearer() ?: return null
        val username = session.username ?: return null
        return cache.get(bearer, username, force)
    }

    /** The held copy, if fresh, so a screen can draw before it asks. */
    fun peek(context: Context): List<Game>? = Session.get(context).bearer()?.let { cache.peek(it) }

    fun invalidate() = cache.invalidate()

    /** At sign-out: the copy is keyed by the credential anyway, but nothing should linger. */
    fun clear() = cache.clear()

    private suspend fun fetch(bearer: String, username: String): List<Game>? = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.api.getLibrary(bearer, username)
            if (response.isSuccessful) response.body() ?: emptyList() else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Every write the app sends (anything but GET) drops the copy, before AND after it goes
     * out: one place, so a new write path cannot forget to. Before, so a read started during
     * the write is not stored; after, so a read finishing just before the server committed is
     * not served.
     */
    class WriteInterceptor(private val onWrite: () -> Unit = { invalidate() }) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val write = request.method != "GET" && request.method != "HEAD"
            if (write) onWrite()
            try {
                return chain.proceed(request)
            } finally {
                if (write) onWrite()
            }
        }
    }
}
