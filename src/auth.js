import { google } from 'googleapis';
import * as kv from './kv.js';

const TOKEN_KEY = 'mailflow:tokens';

/**
 * Read, modify, label and send. This is a Google "restricted" scope, so the app must
 * stay in Testing mode with your address listed as a test user. See SETUP.md.
 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

let oauthClient = null;
let cachedTokens = null;

export function getClient() {
  if (oauthClient) return oauthClient;

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy .env.example to .env and fill it in (see SETUP.md).',
    );
  }

  oauthClient = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
  );

  // googleapis refreshes the access token on its own; persist whatever it hands back
  // so the next invocation does not have to send you through the consent screen.
  oauthClient.on('tokens', (tokens) => {
    // A refresh only returns the access token, so merge rather than replace —
    // overwriting would drop the refresh token and end the session permanently.
    saveTokens({ ...(cachedTokens || {}), ...tokens }).catch((err) =>
      console.error('Could not persist refreshed tokens:', err.message),
    );
  });

  return oauthClient;
}

export function authUrl() {
  return getClient().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    // Without this, Google only returns a refresh token the very first time you ever
    // authorize — reconnecting later would leave you unable to refresh.
    prompt: 'consent',
  });
}

export async function exchangeCode(code) {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveTokens(tokens);
}

async function saveTokens(tokens) {
  cachedTokens = tokens;
  await kv.setJSON(TOKEN_KEY, tokens);
}

/**
 * Restores the Google session from the store.
 *
 * On a long-lived server this runs once at boot. On serverless there is no boot, so it
 * runs per request — cheap, because the credentials are one small object and the
 * client is reused within an invocation.
 */
export async function restoreSession() {
  try {
    const tokens = await kv.getJSON(TOKEN_KEY);
    if (!tokens || (!tokens.refresh_token && !tokens.access_token)) return false;
    cachedTokens = tokens;
    getClient().setCredentials(tokens);
    return true;
  } catch {
    return false;
  }
}

export async function logout() {
  cachedTokens = null;
  if (oauthClient) oauthClient.setCredentials({});
  await kv.del(TOKEN_KEY);
}

export function isAuthorized() {
  const creds = oauthClient?.credentials;
  return Boolean(creds && (creds.refresh_token || creds.access_token));
}
