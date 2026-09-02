package com.kirti.mailflow.data.remote

import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Single Retrofit instance for the Gmail REST API.
 *
 * The OAuth access token is short lived (about an hour), so it lives in a volatile
 * field that [com.kirti.mailflow.auth.GoogleAuthManager] refreshes. The interceptor
 * reads whatever is current at request time rather than baking a token into the client.
 */
object GmailClient {

    private const val BASE_URL = "https://gmail.googleapis.com/"

    @Volatile
    var accessToken: String? = null

    val api: GmailApi by lazy {
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val builder = chain.request().newBuilder()
                    .header("Accept", "application/json")
                accessToken?.let { builder.header("Authorization", "Bearer $it") }
                chain.proceed(builder.build())
            }
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(GmailApi::class.java)
    }
}
