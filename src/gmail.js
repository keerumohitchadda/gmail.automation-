import { google } from 'googleapis';
import { getClient } from './auth.js';
import { categorize } from './categorize.js';
import { buildRaw, replySubject } from './mime.js';

/**
 * Gmail access, always for a named mailbox.
 *
 * Every entry point takes the account's email address first. There is no implicit
 * "current account" — several mailboxes forward to the same phone, and an implied
 * default is exactly how mail from one would end up attributed to another.
 */

const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'References'];

function api(email) {
  return google.gmail({ version: 'v1', auth: getClient(email) });
}

export async function profile(email) {
  const { data } = await api(email).users.getProfile({ userId: 'me' });
  return { email: data.emailAddress, total: data.messagesTotal };
}

/**
 * Lists the inbox. Gmail's list endpoint returns only ids, so each message is fetched
 * with `format=metadata` — enough for a list row, and far cheaper than pulling full
 * bodies for messages that may never be opened.
 */
export async function listInbox(email, { maxResults = 30, query = 'in:inbox' } = {}) {
  const gmail = api(email);
  const { data } = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  const refs = data.messages || [];

  const results = await Promise.all(
    refs.map(async (ref) => {
      try {
        const { data: msg } = await gmail.users.messages.get({
          userId: 'me',
          id: ref.id,
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        });
        return toMessage(msg, email);
      } catch {
        return null;
      }
    }),
  );

  return results.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
}

export async function getMessage(email, id) {
  const { data } = await api(email).users.messages.get({ userId: 'me', id, format: 'full' });
  return { ...toMessage(data, email), body: extractBody(data.payload) };
}

export async function markRead(email, id) {
  await api(email).users.messages.modify({
    userId: 'me',
    id,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

export async function archive(email, id) {
  await api(email).users.messages.modify({
    userId: 'me',
    id,
    requestBody: { removeLabelIds: ['INBOX'] },
  });
}

export async function sendNew(email, { to, subject, body }) {
  const raw = buildRaw({ to, subject, body });
  const { data } = await api(email).users.messages.send({ userId: 'me', requestBody: { raw } });
  return data;
}

/** Replies in-thread, carrying the headers Gmail needs to keep the conversation together. */
export async function sendReply(email, { original, body }) {
  const references = [original.referencesHeader, original.messageIdHeader]
    .filter(Boolean)
    .join(' ');

  const raw = buildRaw({
    to: original.fromEmail,
    subject: replySubject(original.subject),
    body,
    inReplyTo: original.messageIdHeader || undefined,
    references: references || undefined,
  });

  const { data } = await api(email).users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: original.threadId },
  });
  return data;
}

// ---- mapping helpers ----

function toMessage(msg, account) {
  const headers = {};
  for (const h of msg.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;

  const from = headers.from || '';
  const labelIds = msg.labelIds || [];
  const subject = (headers.subject || '').trim() || '(no subject)';
  const fromEmail = parseEmail(from);

  return {
    id: msg.id,
    threadId: msg.threadId,
    // Which mailbox this arrived in. Carried through so a merged inbox and a
    // forwarded alert can both say where a message came from.
    account,
    fromName: parseName(from),
    fromEmail,
    to: headers.to || '',
    subject,
    snippet: unescapeHtml(msg.snippet || ''),
    timestamp: Number(msg.internalDate) || 0,
    unread: labelIds.includes('UNREAD'),
    category: categorize({ fromEmail, subject, labelIds }),
    messageIdHeader: headers['message-id'] || null,
    referencesHeader: headers.references || null,
  };
}

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address yields the part before the @. */
function parseName(from) {
  const angle = from.indexOf('<');
  if (angle > 0) return from.slice(0, angle).trim().replace(/^"|"$/g, '');
  return from.split('@')[0].trim();
}

function parseEmail(from) {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

/** Walks the MIME tree, preferring text/plain over a tag-stripped text/html fallback. */
function extractBody(payload) {
  if (!payload) return '';

  const plain = findPart(payload, 'text/plain');
  if (plain) return decode(plain.body.data);

  const html = findPart(payload, 'text/html');
  if (html) return stripHtml(decode(html.body.data));

  return payload.body?.data ? decode(payload.body.data) : '';
}

function findPart(part, mimeType) {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts || []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decode(data) {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html) {
  return unescapeHtml(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unescapeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
