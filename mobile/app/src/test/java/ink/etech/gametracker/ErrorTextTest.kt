package ink.etech.gametracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.UnknownHostException

class ErrorTextTest {
    @Test fun aLockoutOrAnOutageIsNeverAWrongPassword() {
        val wrong = ErrorText.signIn(401)
        for (code in listOf(429, 503, 500, 403, null)) assertFalse("$code", ErrorText.signIn(code) == wrong)
        assertEquals("Wrong username or password.", wrong)
    }

    @Test fun aLockoutSaysHowLongFromRetryAfter() {
        assertEquals("Too many sign-in attempts. Try again in 15 minutes.", ErrorText.signIn(429, "900"))
        assertEquals("Too many sign-in attempts. Try again in 1 minute.", ErrorText.signIn(429, "30"))
        assertEquals("Too many sign-in attempts. Wait a few minutes and try again.", ErrorText.signIn(429, null))
        assertNull(ErrorText.minutes("Wed, 21 Oct 2026 07:28:00 GMT"))   // a date: not guessed at
        assertNull(ErrorText.minutes("-5"))
    }

    @Test fun noAnswerIsUnreachable() {
        assertEquals(ErrorText.UNREACHABLE, ErrorText.signIn(null))
        assertEquals(ErrorText.UNREACHABLE, ErrorText.action(UnknownHostException("gametracker.etech.ink"), "Couldn't save."))
    }

    @Test fun anExceptionMessageNeverReachesTheUser() {
        val text = ErrorText.action(IllegalStateException("secret host db:5432"), "Couldn't save the status.")
        assertEquals("Couldn't save the status. Try again.", text)
        assertEquals(ErrorText.UNREACHABLE, ErrorText.action(IOException("x"), "Couldn't save the status."))
    }
}
