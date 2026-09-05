import * as store from './store.js';
import * as tg from './telegram.js';
import * as wa from './whatsapp.js';
import { listAccounts } from './auth.js';

/**
 * Which mailbox an alert is about, shown only when more than one is connected.
 * With a single account it is noise; with two it is the first thing you want to know.
 */
function inboxLine(msg) {
  if (!msg.account || listAccounts().length < 2) return null;
  return msg.account;
}

/**
 * Picks a delivery channel and formats for it.
 *
 * Telegram wins when configured, because it has no 24-hour window and no template
 * approval — it can always carry the whole email. WhatsApp stays fully supported and
 * takes over the moment its credentials are present and Telegram's are not, so
 * finishing the Meta setup later needs no code change.
 */

export function activeChannel() {
  if (tg.isConfigured()) return 'telegram';
  if (wa.isConfigured()) return 'whatsapp';
  return null;
}

export function describeChannel() {
  const channel = activeChannel();
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'whatsapp') return 'WhatsApp';
  return 'not configured';
}

/** Where alerts go on the active channel, or null if nothing is set up yet. */
export function destination() {
  return activeChannel() === 'telegram' ? store.get().telegramChatId : store.get().toNumber;
}

function when(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function bodyPreview(msg) {
  const { bodyChars } = store.get();
  const body = (msg.body || msg.snippet || '').trim();
  if (!bodyChars || !body) return '';
  return body.length > bodyChars ? `${body.slice(0, bodyChars).trim()}…` : body;
}

export function formatTelegram(msg) {
  const e = tg.escapeHtml;
  const lines = [
    '📬 <b>New email</b>',
    '',
    `<b>From:</b> ${e(msg.fromName || msg.fromEmail)}`,
    `<b>Address:</b> <code>${e(msg.fromEmail)}</code>`,
    `<b>Subject:</b> ${e(msg.subject)}`,
    `<b>Category:</b> ${e(msg.category)}`,
    `<b>Received:</b> ${e(when(msg.timestamp))}`,
  ];

  const inbox = inboxLine(msg);
  if (inbox) lines.splice(2, 0, `<b>Inbox:</b> ${e(inbox)}`);

  const preview = bodyPreview(msg);
  if (preview) lines.push('', '<pre>' + e(preview) + '</pre>');

  return lines.join('\n');
}

export function formatWhatsApp(msg) {
  const lines = [
    '📬 *New email*',
    '',
    `*From:* ${msg.fromName || msg.fromEmail}`,
    `*Address:* ${msg.fromEmail}`,
    `*Subject:* ${msg.subject}`,
    `*Category:* ${msg.category}`,
    `*Received:* ${when(msg.timestamp)}`,
  ];

  const inbox = inboxLine(msg);
  if (inbox) lines.splice(2, 0, `*Inbox:* ${inbox}`);

  const preview = bodyPreview(msg);
  if (preview) lines.push('', '—'.repeat(12), '', preview);

  return lines.join('\n').slice(0, 3500);
}

/**
 * Sends one alert on whichever channel is active.
 *
 * The WhatsApp branch keeps its full-text-then-template fallback; Telegram needs no
 * equivalent because nothing there expires.
 */
export async function deliver(msg) {
  const channel = activeChannel();
  if (!channel) throw new Error('No delivery channel configured.');

  const to = destination();
  if (!to) {
    throw new Error(
      channel === 'telegram'
        ? 'No Telegram chat yet — send your bot any message to link it.'
        : 'Set the destination WhatsApp number first.',
    );
  }

  if (channel === 'telegram') {
    await tg.sendMessage(to, formatTelegram(msg));
    return { via: 'telegram' };
  }

  // Always attempt full text first, and let Meta be the judge of whether the
  // 24-hour window is open.
  //
  // The window used to be inferred from inbound webhooks, but Meta does not deliver
  // those to an unpublished app — so that signal reads "closed" forever and every
  // alert degrades to the template even when free-form would have been accepted.
  // Asking and handling the rejection costs one wasted call when the window really is
  // shut, and gets the whole email through whenever it is not.
  try {
    await wa.sendText(to, formatWhatsApp(msg));
    if (!store.isWindowOpen()) store.update({ lastInboundAt: Date.now() });
    return { via: 'text' };
  } catch (err) {
    if (!wa.isWindowClosedError(err)) throw err;
    store.update({ lastInboundAt: null });
    console.warn('[notify] free-form rejected; falling back to the approved template');
  }

  await wa.sendTemplate(to, [
    msg.fromName || msg.fromEmail,
    msg.subject,
    (msg.snippet || '(no preview)').slice(0, 300),
  ]);
  return { via: 'template' };
}

/** Plain-text reply on the active channel, for the stop/start/status commands. */
export async function replyTo(to, text) {
  if (activeChannel() === 'telegram') return tg.sendMessage(to, tg.escapeHtml(text));
  return wa.sendText(to, text);
}

export function isAuthError(err) {
  return tg.isAuthError(err) || wa.isAuthError(err);
}
