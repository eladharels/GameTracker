package ink.etech.gametracker

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Every write the app sends (anything but GET or HEAD) drops the library copy (MOB-19), before
 * AND after it goes out: one place, so a new write path cannot forget to. Before, so a read
 * started during the write is not stored; after, so a read finishing just before the server
 * committed is not served. Even a failed write: what the server did is then unknown.
 */
class LibraryWriteInterceptor(private val onWrite: () -> Unit) : Interceptor {
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
