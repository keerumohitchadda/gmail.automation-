package com.kirti.mailflow.data.model

/** Raw wire models for the Gmail REST API (v1). Populated by Gson. */

data class ListMessagesResponse(
    val messages: List<MessageRef>? = null,
    val nextPageToken: String? = null,
    val resultSizeEstimate: Int? = null,
)

data class MessageRef(
    val id: String = "",
    val threadId: String = "",
)

data class GmailMessage(
    val id: String = "",
    val threadId: String = "",
    val labelIds: List<String>? = null,
    val snippet: String? = null,
    val internalDate: String? = null,
    val payload: MessagePart? = null,
)

data class MessagePart(
    val partId: String? = null,
    val mimeType: String? = null,
    val filename: String? = null,
    val headers: List<Header>? = null,
    val body: MessageBody? = null,
    val parts: List<MessagePart>? = null,
)

data class Header(
    val name: String = "",
    val value: String = "",
)

data class MessageBody(
    val size: Int = 0,
    val data: String? = null,
    val attachmentId: String? = null,
)

data class SendMessageRequest(
    val raw: String,
    val threadId: String? = null,
)

data class ModifyRequest(
    val addLabelIds: List<String>? = null,
    val removeLabelIds: List<String>? = null,
)

data class ProfileResponse(
    val emailAddress: String = "",
    val messagesTotal: Int = 0,
)
