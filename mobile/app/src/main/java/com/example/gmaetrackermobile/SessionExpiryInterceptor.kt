package com.example.gmaetrackermobile

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Ends the session when the backend says the token it was sent is no longer valid (MOB-5).
 *
 * Before this, nothing handled a 401: after the 12-hour JWT expired every screen quietly
 * failed ("No games found", blank tabs) until the user thought to log out by hand.
 *
 *  - Only a 401 answering the CURRENT token ends it ([clearIfCurrent] compares the request's
 *    own Authorization header with the stored one). The login call sends no header, and a
 *    stale request's 401 must not sign out a session made after it was sent.
 *  - A network failure is an IOException: it propagates untouched and never ends a session.
 *    Being offline is not being signed out.
 *  - [onEnded] only SIGNALS; it must not start an activity from this thread.
 */
class SessionExpiryInterceptor(
    private val clearIfCurrent: (String?) -> Boolean,
    private val onEnded: () -> Unit,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if (response.code == 401 && clearIfCurrent(request.header("Authorization"))) onEnded()
        return response
    }
}
