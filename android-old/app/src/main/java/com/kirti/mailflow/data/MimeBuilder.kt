package com.kirti.mailflow.data

import android.util.Base64
import java.nio.charset.StandardCharsets

/**
 * Builds RFC 2822 messages and encodes them the way Gmail's `messages.send` wants:
 * base64url, unpadded, no line wrapping.
 */
object MimeBuilder {

    fun build(
        to: String,
        subject: String,
        bodyText: String,
        inReplyTo: String? = null,
        references: String? = null,
    ): String {
        val encodedBody = Base64.encodeToString(
            bodyText.toByteArray(StandardCharsets.UTF_8),
            Base64.NO_WRAP,
        ).chunked(76).joinToString("\r\n")

        val headers = buildList {
            add("To: $to")
            add("Subject: ${encodeHeader(subject)}")
            inReplyTo?.let { add("In-Reply-To: $it") }
            references?.let { add("References: $it") }
            add("MIME-Version: 1.0")
            add("Content-Type: text/plain; charset=\"UTF-8\"")
            add("Content-Transfer-Encoding: base64")
        }

        val raw = headers.joinToString("\r\n") + "\r\n\r\n" + encodedBody
        return Base64.encodeToString(
            raw.toByteArray(StandardCharsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
    }

    /** RFC 2047 encoding, so non-ASCII subjects survive the trip. */
    private fun encodeHeader(value: String): String {
        if (value.all { it.code in 32..126 }) return value
        val b64 = Base64.encodeToString(
            value.toByteArray(StandardCharsets.UTF_8),
            Base64.NO_WRAP,
        )
        return "=?UTF-8?B?$b64?="
    }
}
