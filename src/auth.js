import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const TOKEN_PATH = path.resolve('.tokens.json');

/**
 * Read, modify, label and send. This is a Google "restricted" scope, so the app must
 * stay in Testing mode with your address listed as a test user. See SETUP.md.
 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

let oauthClient = null;

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
  // so a restart doesn't send you through the consent screen again.
  oauthClient.on('tokens', (tokens) => {
    saveTokens({ ...readCachedTokens(), ...tokens }).catch((err) =>
      console.error('Could not persist refreshed tokens:', err.message),
    );
  });

  return oauthClient;
}

let cachedTokens = null;
function readCachedTokens() {
  return cachedTokens || {};
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
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/** Restores a previous session at startup. Returns true if we have usable credentials. */
export async function restoreSession() {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8');
    const tokens = JSON.parse(raw);
    if (!tokens.refresh_token && !tokens.access_token) return false;
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
  await fs.rm(TOKEN_PATH, { force: true });
}

export function isAuthorized() {
  const creds = oauthClient?.credentials;
  return Boolean(creds && (creds.refresh_token || creds.access_token));
}
