package com.example.gmaetrackermobile

import retrofit2.Response
import retrofit2.http.*

interface GameTrackerApi {
    @POST("auth/login")
    suspend fun login(@Body loginRequest: LoginRequest): Response<LoginResponse>

    // A cheap authenticated read: does the stored session still work? (MOB-5)
    @GET("user/me")
    suspend fun getMe(@Header("Authorization") token: String): Response<Unit>

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
    ): Response<Unit>

    @DELETE("user/{username}/games/{gameId}")
    suspend fun deleteGame(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Path("gameId") gameId: String
    ): Response<Unit>

    @PUT("user/{username}/games/{gameId}/backlog-order")
    suspend fun updateBacklogOrder(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Path("gameId") gameId: String,
        @Body body: BacklogOrderRequest
    ): Response<Unit>

    @POST("user/{username}/games/{gameId}/refresh-metadata")
    suspend fun refreshGameMetadata(
        @Header("Authorization") token: String,
        @Path("username") username: String,
        @Path("gameId") gameId: String
    ): Response<Unit>
}