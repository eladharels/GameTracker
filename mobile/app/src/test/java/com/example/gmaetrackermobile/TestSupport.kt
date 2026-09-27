package com.example.gmaetrackermobile

import java.util.Base64

/** A KeyValueStore over a map, standing in for SharedPreferences in JVM tests. */
class MapStore : KeyValueStore {
    val map = mutableMapOf<String, String>()
    override fun getString(key: String): String? = map[key]
    override fun putStrings(values: Map<String, String>) { map.putAll(values) }
    override fun remove(key: String) { map.remove(key) }
}

/** An unsigned JWT with the given `exp`; the app only ever DECODES, the server verifies. */
fun jwtWithExp(exp: Long?): String {
    val enc = Base64.getUrlEncoder().withoutPadding()
    val header = enc.encodeToString("""{"alg":"HS256","typ":"JWT"}""".toByteArray())
    val claims = if (exp == null) """{"id":5,"username":"jane"}""" else """{"id":5,"username":"jane","exp":$exp}"""
    return "$header.${enc.encodeToString(claims.toByteArray())}.sig"
}
