package com.kirti.mailflow.auth

import android.content.Context
import android.content.Intent
import android.content.IntentSender
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.kirti.mailflow.data.remote.GmailClient
import kotlinx.coroutines.tasks.await

sealed interface AuthState {
    data object Idle : AuthState
    data object InProgress : AuthState

    /** Google needs the user to pick an account / approve the scope. Launch this sender. */
    data class NeedsConsent(val intentSender: IntentSender) : AuthState
    data class Authorized(val token: String) : AuthState
    data class Failed(val message: String) : AuthState
}

/**
 * Wraps Play Services' AuthorizationClient.
 *
 * [authorize] is safe to call repeatedly: once the user has granted the scope it returns
 * a fresh access token silently, which is exactly what the background sync worker needs.
 */
class GoogleAuthManager(context: Context) {

    private val client = Identity.getAuthorizationClient(context.applicationContext)

    private val request: AuthorizationRequest =
        AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(GMAIL_SCOPE)))
            .build()

    suspend fun authorize(): AuthState = try {
        val result = client.authorize(request).await()
        if (result.hasResolution()) {
            val pendingIntent = result.pendingIntent
            if (pendingIntent == null) {
                AuthState.Failed("Google asked for consent but returned no screen to show.")
            } else {
                AuthState.NeedsConsent(pendingIntent.intentSender)
            }
        } else {
            val token = result.accessToken
            if (token == null) {
                AuthState.Failed("Signed in, but Google returned no access token.")
            } else {
                GmailClient.accessToken = token
                AuthState.Authorized(token)
            }
        }
    } catch (e: Exception) {
        AuthState.Failed(e.message ?: "Authorization failed.")
    }

    /** Call from the activity result after launching a [AuthState.NeedsConsent] sender. */
    fun handleConsentResult(data: Intent?): AuthState = try {
        val token = client.getAuthorizationResultFromIntent(data).accessToken
        if (token == null) {
            AuthState.Failed("Consent finished without granting Gmail access.")
        } else {
            GmailClient.accessToken = token
            AuthState.Authorized(token)
        }
    } catch (e: Exception) {
        AuthState.Failed(e.message ?: "Could not read the consent result.")
    }

    companion object {
        /**
         * Read, modify, label and send. This is a Google "restricted" scope, so the app
         * must stay in Testing mode (with your address listed as a test user) unless you
         * put it through Google's verification review. See SETUP.md.
         */
        const val GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify"
    }
}
