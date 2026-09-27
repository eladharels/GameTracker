package com.example.gmaetrackermobile

import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

object ApiClient {
    val api: GameTrackerApi by lazy {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(logging)
            .build()
        Retrofit.Builder()
            .baseUrl("https://gametracker.etech.ink/api/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(GameTrackerApi::class.java)
    }
} 