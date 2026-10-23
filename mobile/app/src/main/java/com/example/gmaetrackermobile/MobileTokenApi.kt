package com.example.gmaetrackermobile

import android.util.Log

/**
 * The two server calls behind [MobileToken] (MOB-9). Blocking-suspend; call off the main thread.
 * Neither ever logs or returns the server's body (CISO condition 6): the UI says fixed things.
 */
object MobileTokenApi {
    private const val TAG = "MobileToken"

    /** The minted token, or null for ANY failure (403, 409, 429, 503, network). Never retried. */
    suspend fun mint(bearer: String, request: CreateTokenRequest): CreatedToken? = try {
        val res = ApiClient.api.createToken(bearer, request)
        val body = res.body()
        if (res.code() == 201 && body != null && body.token.startsWith(SessionStore.PAT_PREFIX)) body
        else { Log.w(TAG, "mint refused: HTTP ${res.code()}"); null }
    } catch (e: Exception) {
        Log.w(TAG, "mint failed: ${e.javaClass.simpleName}")
        null
    }

    /**
     * Revokes token [id], presenting [bearer]. True when it is gone: revoked now, or already
     * (404, which is also what a token the server no longer knows answers).
     */
    suspend fun revoke(bearer: String, id: Long): Boolean = try {
        val code = ApiClient.api.revokeToken(bearer, id).code()
        code in 200..299 || code == 404
    } catch (e: Exception) {
        Log.w(TAG, "revoke failed: ${e.javaClass.simpleName}")
        false
    }
}
