package com.example.gmaetrackermobile

import retrofit2.Response
import retrofit2.http.*

interface GameTrackerApi {
    @POST("auth/login")
    suspend fun login(@Body loginRequest: LoginRequest): Response<LoginResponse>

    // A cheap authenticated read: does the stored session still work? (MOB-5)
    @GET("user/me")
    suspend fun getMe(@Header("Authorization") token: String): Response<Unit>

    // MOB-9: this phone's long-lived credential (MobileToken). Minted with the fresh JWT and
    // the password (the server's sudo mode); revoked by its own id. The app never lists tokens.
    @POST("user/me/tokens")
    suspend fun createToken(@Header("Authorization") token: String, @Body body: CreateTokenRequest): Response<CreatedToken>

    @DELETE("user/me/tokens/{tokenId}")
    suspend fun revokeToken(@Header("Authorization") token: String, @Path("tokenId") tokenId: Long): Response<Unit>

    @GET("games/search")
    suspend fun searchGames(
        @Query("q") query: String,
        @Header("Authorization") token: String = ""
    ): Response<List<Game>>

    @GET("user/{username}/games")
    suspend fun getLibrary(
        @Header("Authorization") token: String,
        @Path("username") username: String
    ): Response<List<Game>>

    @POST("user/{username}/games")
    suspend fun addOrUpdateGame(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Body game: GameUpdateRequest
    ): Response<GameUpsertResult>

    @DELETE("user/{username}/games/{gameId}")
    suspend fun deleteGame(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Path("gameId") gameId: String
    ): Response<Unit>

    // The whole backlog order in one call, one transaction on the server (MOB-14).
    @PUT("user/{username}/backlog-reorder")
    suspend fun reorderBacklog(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Body body: BacklogReorderRequest
    ): Response<Unit>

    @POST("user/{username}/games/{gameId}/refresh-metadata")
    suspend fun refreshGameMetadata(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Path("gameId") gameId: String
    ): Response<Unit>
}