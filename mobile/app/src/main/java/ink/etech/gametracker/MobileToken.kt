package ink.etech.gametracker

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The phone's long-lived credential (MOB-9): a personal access token minted at a PASSWORD
 * sign-in, only while fingerprint unlock is on, and sealed by [TokenVault] at once. The CISO
 * design review fixed every value here:
 *  - scope `library` only, never `admin`: the app reaches no admin route;
 *  - a FIXED 30-day expiry, never null and never renewed; only a new password sign-in mints a
 *    new one;
 *  - a name an owner can recognise in My Account on the web, at most 60 characters with the
 *    model shortened and the timestamp kept whole (the server also shortens names, but from
 *    the end, which would cut the timestamp);
 *  - no retry: each attempt costs the user's sudo and directory budgets on the server.
 *
 * Pure: the network calls are in [MobileTokenApi].
 */
object MobileToken {
    const val LIFETIME_DAYS = 30L
    const val SCOPE = "library"
    private const val NAME_MAX = 60
    private const val PREFIX = "Android app · "
    private const val SEP = " · "

    fun name(model: String?, nowMillis: Long, zone: TimeZone = TimeZone.getDefault()): String {
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).apply { timeZone = zone }.format(Date(nowMillis))
        val room = NAME_MAX - PREFIX.length - SEP.length - stamp.length
        val clean = model.orEmpty().replace(Regex("[\\p{Cntrl}\\s]+"), " ").trim().ifEmpty { "phone" }
        return PREFIX + clean.take(room).trim() + SEP + stamp
    }

    /** When a token minted at [nowMillis] expires: epoch seconds, and the ISO string the server takes. */
    fun expiry(nowMillis: Long): Pair<Long, String> {
        val seconds = nowMillis / 1000 + LIFETIME_DAYS * 24 * 3600
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(seconds * 1000))
        return seconds to iso
    }

    fun request(password: String, model: String?, nowMillis: Long): CreateTokenRequest =
        CreateTokenRequest(
            password = password,
            name = name(model, nowMillis),
            scopes = listOf(SCOPE),
            expiresAt = expiry(nowMillis).second,
        )
}
