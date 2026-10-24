package ink.etech.gametracker

import com.google.gson.GsonBuilder
import com.google.gson.annotations.JsonAdapter
import com.google.gson.annotations.SerializedName
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Url
import java.io.File
import java.lang.reflect.Modifier

/**
 * MOB-25: the app's API contract, read by REFLECTION from the compiled interface and models,
 * and committed as `mobile/api-contract.json`. The backend's gates (test/mobile-api.js) read
 * that file instead of regex-parsing Kotlin. This test fails when the file no longer matches
 * the code; regenerate with GT_WRITE_CONTRACT=1 and review the diff like code.
 */
class ApiContractTest {
    /** Every Gson model in models.kt (test/runtime.test.js holds this list equal to the file). */
    private val models = mapOf(
        "game" to Game::class.java,
        "loginRequest" to LoginRequest::class.java,
        "loginResponse" to LoginResponse::class.java,
        "createTokenRequest" to CreateTokenRequest::class.java,
        "createdToken" to CreatedToken::class.java,
        "gameUpdateRequest" to GameUpdateRequest::class.java,
        "backlogReorderRequest" to BacklogReorderRequest::class.java,
        "gameUpsertResult" to GameUpsertResult::class.java,
    )

    /** Every method must carry a plain verb: @HTTP or @Url would hide its route from the gate. */
    private fun routes(): List<String> = GameTrackerApi::class.java.declaredMethods.filter { !it.isSynthetic }.map { m ->
        assertTrue("${m.name} uses @HTTP or @Url", m.getAnnotation(HTTP::class.java) == null &&
            m.parameterAnnotations.flatten().none { it is Url })
        m.getAnnotation(GET::class.java)?.let { "GET ${it.value}" }
            ?: m.getAnnotation(POST::class.java)?.let { "POST ${it.value}" }
            ?: m.getAnnotation(PUT::class.java)?.let { "PUT ${it.value}" }
            ?: m.getAnnotation(DELETE::class.java)?.let { "DELETE ${it.value}" }
            ?: m.getAnnotation(PATCH::class.java)?.let { "PATCH ${it.value}" }
            ?: throw AssertionError("${m.name} has no @GET/@POST/@PUT/@DELETE/@PATCH")
    }.sorted()

    /** The names on the WIRE: Gson's field names. A @SerializedName is refused, as the gate did. */
    private fun fields(c: Class<*>): List<String> = c.declaredFields
        .filter { !Modifier.isStatic(it.modifiers) && !Modifier.isTransient(it.modifiers) && !it.isSynthetic }
        .onEach {
            assertTrue("${c.simpleName}.${it.name} uses @SerializedName", it.getAnnotation(SerializedName::class.java) == null)
            assertTrue("${c.simpleName}.${it.name} uses @JsonAdapter", it.getAnnotation(JsonAdapter::class.java) == null)
        }
        .map { it.name }
        .sorted()

    private fun contract(): String {
        val tree = sortedMapOf<String, Any>("routes" to routes())
        models.forEach { (key, c) -> tree[key] = fields(c) }
        return GsonBuilder().setPrettyPrinting().create().toJson(tree) + "\n"
    }

    @Test fun theCommittedContractIsTheCode() {
        // Unit tests run in the module directory (app/); the file is mobile/api-contract.json.
        val file = File("../api-contract.json")
        val now = contract()
        if (System.getenv("GT_WRITE_CONTRACT") == "1") file.writeText(now)
        assertTrue("mobile/api-contract.json is missing: run with GT_WRITE_CONTRACT=1", file.exists())
        assertEquals("mobile/api-contract.json no longer matches the code: regenerate it (GT_WRITE_CONTRACT=1) and review the diff",
            now, file.readText())
    }

    @Test fun everyRouteAndModelIsSeen() {
        // Fails closed, like the old parser: an empty reflection is a broken test, not a pass.
        assertTrue(routes().size >= 7)
        assertTrue("GET games/search" in routes())
        assertTrue(fields(Game::class.java).containsAll(listOf("game_id", "backlog_order")))
    }
}
