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

  // The template is the reliable path and therefore the default.
  //
  // Free-form text is richer but only delivers inside Meta's 24-hour window, and Meta
  // does not say when it is shut: the API returns 200 with a message id and then drops
  // the message. So "try text and handle the rejection" cannot work — there is no
  // rejection to handle, only silence. That silence is what made a whole day of
  // alerts vanish while every call looked successful.
  //
  // Text is therefore attempted only when an inbound message proves the window is
  // open, and even then a genuine window-closed error falls through to the template.
  if (store.isWindowOpen()) {
    try {
      await wa.sendText(to, formatWhatsApp(msg));
      return { via: 'text' };
    } catch (err) {
      if (!wa.isWindowClosedError(err)) throw err;
      store.update({ lastInboundAt: null });
      console.warn('[notify] window had already closed; using the template');
    }
  }

  // Since the template now carries most alerts rather than being a fallback, give its
  // preview variable as much of the email as Meta allows — a template parameter tops
  // out around 1024 characters, and whitespace is flattened out of it anyway.
  const preview = (bodyPreview(msg) || msg.snippet || '(no preview)').slice(0, 850);

  await wa.sendTemplate(to, [msg.fromName || msg.fromEmail, msg.subject, preview]);
  return { via: 'template' };
}

/**
 * Tells you on your phone when a mailbox has lost its Google session.
 *
 * Without this the failure is invisible: forwarding simply stops, the app shows an
 * empty inbox, and you find out days later. Google ends these sessions on its own
 * schedule, so the app has to be the one that notices.
 *
 * Rate-limited to once a day per mailbox — the daily cron would otherwise report the
 * same dead account every morning until it is reconnected.
 */
export async function alertSessionExpired(emails, appUrl) {
  const to = destination();
  if (!to || !emails.length) return { sent: 0 };

  const DAY = 24 * 60 * 60 * 1000;
  const notified = { ...(store.get().deadNotifiedAt || {}) };
  const due = emails.filter((email) => !notified[email] || Date.now() - notified[email] > DAY);
  if (!due.length) return { sent: 0 };

  const text =
    `Gmail access for ${due.join(', ')} has expired, so forwarding has stopped. ` +
    `Open ${appUrl} and use Add Account to sign in again.`;

  await deliver({
    id: 'session-expired',
    fromName: 'MailFlow',
    fromEmail: 'mailflow',
    subject: 'Reconnect needed — forwarding has stopped',
    snippet: text,
    body: text,
    category: 'Personal',
    timestamp: Date.now(),
  });

  for (const email of due) notified[email] = Date.now();
  store.update({ deadNotifiedAt: notified });

  return { sent: due.length, emails: due };
}

/** Plain-text reply on the active channel, for the stop/start/status commands. */
export async function replyTo(to, text) {
  if (activeChannel() === 'telegram') return tg.sendMessage(to, tg.escapeHtml(text));
  return wa.sendText(to, text);
}

export function isAuthError(err) {
  return tg.isAuthError(err) || wa.isAuthError(err);
}
