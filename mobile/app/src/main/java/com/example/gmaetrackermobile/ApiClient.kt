package com.example.gmaetrackermobile

import android.content.Context
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

object ApiClient {
    private const val BASE_URL = "https://gametracker.etech.ink/api/"

    @Volatile private var appContext: Context? = null

    /** Called once by [GameTrackerApp]; the session interceptor needs the preferences. */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * The HTTP client, built in one testable place (MOB-1).
     *
     * It used to log at Level.BODY in EVERY build, release included: every request's
     * `Authorization: Bearer …` header and the login body -- the password in clear -- went to
     * logcat. Now a release build has no logging interceptor at all, and a debug build logs
     * only the request line and status (BASIC: no headers, no bodies). `redactHeader` is kept
     * for anyone who raises the level while debugging; BODY must never come back, because
     * the login body IS the password.
     */
    internal fun buildClient(
        debug: Boolean,
        interceptors: List<Interceptor> = emptyList(),
        logger: HttpLoggingInterceptor.Logger = HttpLoggingInterceptor.Logger.DEFAULT,
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
        interceptors.forEach { builder.addInterceptor(it) }
        if (debug) {
            builder.addInterceptor(HttpLoggingInterceptor(logger).apply {
                level = HttpLoggingInterceptor.Level.BASIC
                redactHeader("Authorization")
            })
        }
        return builder.build()
    }

    val api: GameTrackerApi by lazy {
        val context = appContext ?: error("ApiClient.init() was not called")
        val expiry = SessionExpiryInterceptor(
            clearIfCurrent = { Session.get(context).clearIfCurrent(it) },
            onEnded = {
                Session.redirecting = true
                Session.ended.tryEmit(Unit)
            },
        )
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(buildClient(BuildConfig.DEBUG, listOf(expiry)))
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(GameTrackerApi::class.java)
    }
}
