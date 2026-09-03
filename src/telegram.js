/**
 * Telegram Bot API client.
 *
 * Deliberately parallel to whatsapp.js so forward.js can treat them alike. The
 * differences that matter: Telegram has no 24-hour window and no template approval,
 * so every alert carries the full email text, and the destination chat id is learned
 * from the first inbound message rather than typed in by hand.
 */

import crypto from 'node:crypto';

const API = 'https://api.telegram.org';

export function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN. Create a bot with @BotFather and set it in Vercel.');
  }
  return value;
}

async function call(method, payload) {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(`Telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
    err.status = res.status;
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

/**
 * Sends a message. HTML is used rather than MarkdownV2 because Telegram's Markdown
 * requires escaping a long list of punctuation that appears constantly in real email
 * subjects; HTML needs only three characters escaped.
 */
export async function sendMessage(chatId, html) {
  return call('sendMessage', {
    chat_id: chatId,
    text: html.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/** Escapes the only three characters Telegram's HTML mode treats specially. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The shared secret Telegram echoes back on every update.
 *
 * Derived from the bot token rather than configured separately, so setting up the bot
 * means adding one environment variable instead of two. It is unguessable without the
 * token, and the token is already the thing that must stay secret. An explicit
 * TELEGRAM_WEBHOOK_SECRET still wins if you would rather set one.
 */
export function webhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return process.env.TELEGRAM_WEBHOOK_SECRET;
  return crypto.createHash('sha256').update(`mailflow:${token()}`).digest('hex').slice(0, 48);
}

/**
 * Points Telegram at our webhook.
 *
 * `secret_token` makes Telegram send that secret in a header on every update, which
 * is how the endpoint tells a real update from anyone who guessed the URL.
 */
export async function setWebhook(url) {
  return call('setWebhook', {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo() {
  return call('getWebhookInfo', {});
}

export async function getMe() {
  return call('getMe', {});
}

/** True when the update really came from Telegram. */
export function verifySecret(headerValue) {
  if (!isConfigured()) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN is not set' };
  if (!headerValue) return { ok: false, reason: 'missing secret header' };

  const a = Buffer.from(String(headerValue), 'utf8');
  const b = Buffer.from(webhookSecret(), 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'secret mismatch' };

  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'secret mismatch' };
}

/** A revoked or mistyped bot token — the UI should say so plainly. */
export function isAuthError(err) {
  return err?.status === 401 || err?.code === 401;
}
