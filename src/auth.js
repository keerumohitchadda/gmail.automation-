import { google } from 'googleapis';
import * as kv from './kv.js';

/**
 * Google sessions, one per connected mailbox.
 *
 * The app started out assuming a single account, with tokens under one key. Several
 * mailboxes now forward to the same phone, so everything is keyed by email address:
 * tokens, the Gmail history cursor, and the watch expiry all belong to an account
 * rather than to the app.
 */

const ACCOUNTS_KEY = 'mailflow:accounts';
const LEGACY_TOKEN_KEY = 'mailflow:tokens';

/**
 * Read, modify, label and send. This is a Google "restricted" scope, so the app must
 * stay in Testing mode with your address listed as a test user. See SETUP.md.
 */
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

/** { [email]: { tokens, historyId, watchExpiration, connectedAt } } */
let accounts = null;

/** Per-email OAuth2 clients, rebuilt each invocation. */
const clients = new Map();

function credentials() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy .env.example to .env and fill it in (see SETUP.md).',
    );
  }
  return {
    id: GOOGLE_CLIENT_ID,
    secret: GOOGLE_CLIENT_SECRET,
    redirect: OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
  };
}

function newClient() {
  const { id, secret, redirect } = credentials();
  return new google.auth.OAuth2(id, secret, redirect);
}

/**
 * Loads every connected account.
 *
 * Also migrates the single-account layout in place, so an existing deployment keeps
 * its Google session across this change instead of forcing a reconnect.
 */
export async function loadAccounts() {
  accounts = (await kv.getJSON(ACCOUNTS_KEY)) || {};

  if (!Object.keys(accounts).length) {
    const legacy = await kv.getJSON(LEGACY_TOKEN_KEY);
    if (legacy && (legacy.refresh_token || legacy.access_token)) {
      const email = await emailForTokens(legacy).catch(() => null);
      if (email) {
        accounts = { [email]: { tokens: legacy, historyId: null, watchExpiration: null } };
        await kv.setJSON(ACCOUNTS_KEY, accounts);
        await kv.del(LEGACY_TOKEN_KEY);
        console.log(`[auth] migrated the existing session to a per-account record (${email})`);
      }
    }
  }

  clients.clear();
  return accounts;
}

function ensureLoaded() {
  if (!accounts) throw new Error('auth.loadAccounts() must run before account access');
  return accounts;
}

export function listAccounts() {
  return Object.keys(ensureLoaded());
}

export function isAuthorized(email) {
  const all = ensureLoaded();
  if (email) return Boolean(all[email]?.tokens);
  return Object.keys(all).length > 0;
}

/** The OAuth2 client for one mailbox, with token refreshes persisted. */
export function getClient(email) {
  if (clients.has(email)) return clients.get(email);

  const record = ensureLoaded()[email];
  if (!record) throw new Error(`Not connected: ${email}`);

  const client = newClient();
  client.setCredentials(record.tokens);

  // A refresh only returns the access token, so merge rather than replace —
  // overwriting would drop the refresh token and end the session permanently.
  client.on('tokens', (fresh) => {
    const merged = { ...(ensureLoaded()[email]?.tokens || {}), ...fresh };
    patchAccount(email, { tokens: merged }).catch((err) =>
      console.error('[auth] could not persist refreshed tokens:', err.message),
    );
  });

  clients.set(email, client);
  return client;
}

export function authUrl() {
  return newClient().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    // Without consent, Google returns a refresh token only on the very first
    // authorisation. select_account is what makes adding a *second* mailbox possible
    // rather than silently re-authorising the one already signed in.
    prompt: 'consent select_account',
  });
}

/**
 * Asks Google which mailbox a token set belongs to.
 *
 * Uses Gmail's own profile endpoint rather than the userinfo one. userinfo needs a
 * separate scope, and tokens issued before this change were granted gmail.modify
 * alone — so asking there fails and an existing session looks unidentifiable.
 * getProfile returns the address using the scope every token here already has.
 */
async function emailForTokens(tokens) {
  const client = newClient();
  client.setCredentials(tokens);
  const { data } = await google.gmail({ version: 'v1', auth: client }).users.getProfile({
    userId: 'me',
  });
  return data.emailAddress?.toLowerCase() || null;
}

/**
 * Completes the OAuth dance and files the tokens under the mailbox they belong to.
 * Returns the email so the caller can report which account was added.
 */
export async function exchangeCode(code) {
  const client = newClient();
  const { tokens } = await client.getToken(code);

  const email = await emailForTokens(tokens);
  if (!email) throw new Error('Could not determine which Google account authorised.');

  const existing = ensureLoaded()[email];
  accounts[email] = {
    // Re-authorising an existing account keeps its cursor, so reconnecting does not
    // replay a week of mail.
    ...(existing || { historyId: null, watchExpiration: null }),
    // Google omits the refresh token when re-consenting; keep the stored one.
    tokens: { ...(existing?.tokens || {}), ...tokens },
    connectedAt: Date.now(),
  };

  clients.delete(email);
  await kv.setJSON(ACCOUNTS_KEY, accounts);
  return email;
}

/** Updates one account's record. */
export async function patchAccount(email, patch) {
  const all = ensureLoaded();
  if (!all[email]) return null;
  all[email] = { ...all[email], ...patch };
  await kv.setJSON(ACCOUNTS_KEY, all);
  return all[email];
}

export function getAccount(email) {
  return ensureLoaded()[email] || null;
}

export async function disconnect(email) {
  const all = ensureLoaded();
  if (!all[email]) return false;
  delete all[email];
  clients.delete(email);
  await kv.setJSON(ACCOUNTS_KEY, all);
  return true;
}

export async function disconnectAll() {
  accounts = {};
  clients.clear();
  await kv.setJSON(ACCOUNTS_KEY, accounts);
}
