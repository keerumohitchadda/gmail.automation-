package com.kirti.mailflow.data.remote

import com.kirti.mailflow.data.model.GmailMessage
import com.kirti.mailflow.data.model.ListMessagesResponse
import com.kirti.mailflow.data.model.ModifyRequest
import com.kirti.mailflow.data.model.ProfileResponse
import com.kirti.mailflow.data.model.SendMessageRequest
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface GmailApi {

    @GET("gmail/v1/users/me/profile")
    suspend fun getProfile(): ProfileResponse

    @GET("gmail/v1/users/me/messages")
    suspend fun listMessages(
        @Query("q") query: String,
        @Query("maxResults") maxResults: Int,
        @Query("pageToken") pageToken: String?,
    ): ListMessagesResponse

    @GET("gmail/v1/users/me/messages/{id}")
    suspend fun getMessage(
        @Path("id") id: String,
        @Query("format") format: String,
        @Query("metadataHeaders") metadataHeaders: List<String>?,
    ): GmailMessage

    @POST("gmail/v1/users/me/messages/send")
    suspend fun sendMessage(@Body body: SendMessageRequest): GmailMessage

    @POST("gmail/v1/users/me/messages/{id}/modify")
    suspend fun modifyMessage(
        @Path("id") id: String,
        @Body body: ModifyRequest,
    ): GmailMessage
}
