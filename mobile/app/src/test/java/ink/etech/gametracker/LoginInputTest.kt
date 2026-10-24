package ink.etech.gametracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LoginInputTest {
    @Test fun theUsernameIsTrimmedAndLowercased() {
        assertEquals("alice", LoginInput.username("  Alice \n"))
    }

    @Test fun aPasswordOfSpacesIsTheServersToJudge() {
        assertNull(LoginInput.problem("alice", "   "))
    }

    @Test fun emptyFieldsAreNamed() {
        assertEquals("Enter your username.", LoginInput.problem("   ", "pw"))
        assertEquals("Enter your password.", LoginInput.problem("alice", ""))
        assertEquals("Enter your username and password.", LoginInput.problem(" ", ""))
    }
}
