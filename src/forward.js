import * as gmail from './gmail.js';
import * as store from './store.js';
import * as wa from './whatsapp.js';

/**
 * Decides whether a message is worth a WhatsApp ping, and turns the ones that are
 * into a message Meta will actually accept.
 *
 * Order matters in `shouldForward`: the blocklist and allowlist are deliberate user
 * overrides, so they are checked before the category buckets that guess for you.
 */

const MAX_TEXT = 3500;

export function shouldForward(msg) {
  const s = store.get();

  if (!s.enabled) return { ok: false, reason: 'forwarding is off' };
  if (!s.toNumber) return { ok: false, reason: 'no destination number set' };

  const sender = (msg.fromEmail || '').toLowerCase();
  const subject = (msg.subject || '').toLowerCase();
  const snippet = (msg.snippet || '').toLowerCase();

  if (s.senderBlocklist.some((needle) => needle && sender.includes(needle.toLowerCase()))) {
    return { ok: false, reason: `sender is blocklisted (${sender})` };
  }

  // A non-empty allowlist is absolute: it replaces the category filter rather than
  // narrowing it, so "only ever ping me for these senders" behaves as written.
  if (s.senderAllowlist.length) {
    const allowed = s.senderAllowlist.some(
      (needle) => needle && sender.includes(needle.toLowerCase()),
    );
    return allowed
      ? { ok: true }
      : { ok: false, reason: `sender is not on the allowlist (${sender})` };
  }

  if (!s.categories.includes(msg.category)) {
    return { ok: false, reason: `category "${msg.category}" is not selected` };
  }

  const keywords = s.keywords
    .split(',')
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);

  if (keywords.length && !keywords.some((w) => subject.includes(w) || snippet.includes(w))) {
    return { ok: false, reason: 'no keyword match' };
  }

  return { ok: true };
}

/** True when "now" falls inside the configured quiet window, wrap-around included. */
export function inQuietHours(at = new Date()) {
  const { quietHours } = store.get();
  if (!quietHours.enabled) return false;

  const minutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const now = at.getHours() * 60 + at.getMinutes();
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);

  // A window like 23:00–07:00 crosses midnight, so the test flips from AND to OR.
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

export function formatText(msg) {
  const s = store.get();
  const when = new Date(msg.timestamp || Date.now()).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const lines = [
    '📬 *New email*',
    '',
    `*From:* ${msg.fromName || msg.fromEmail}`,
    `*Address:* ${msg.fromEmail}`,
    `*Subject:* ${msg.subject}`,
    `*Category:* ${msg.category}`,
    `*Received:* ${when}`,
  ];

  const body = (msg.body || msg.snippet || '').trim();
  if (s.bodyChars > 0 && body) {
    const clipped = body.length > s.bodyChars ? `${body.slice(0, s.bodyChars).trim()}…` : body;
    lines.push('', '—'.repeat(12), '', clipped);
  }

  return lines.join('\n').slice(0, MAX_TEXT);
}

/**
 * Sends one message, preferring the full-text form and dropping to the approved
 * template when Meta's 24-hour window has closed. The window state is tracked in the
 * store from inbound webhooks, but that can be stale — so a window-closed error from
 * the API is also treated as a signal and retried as a template.
 */
export async function deliver(msg) {
  const { toNumber } = store.get();

  if (store.isWindowOpen()) {
    try {
      await wa.sendText(toNumber, formatText(msg));
      return { via: 'text' };
    } catch (err) {
      if (!wa.isWindowClosedError(err)) throw err;
      store.update({ lastInboundAt: null });
      console.warn('[forward] 24h window had already closed; falling back to template');
    }
  }

  await wa.sendTemplate(toNumber, [
    msg.fromName || msg.fromEmail,
    msg.subject,
    (msg.snippet || '(no preview)').slice(0, 300),
  ]);

  return { via: 'template' };
}

/**
 * Fetches, filters and forwards a batch of Gmail message ids.
 *
 * Runs strictly one at a time: WhatsApp orders by arrival, and a parallel burst both
 * scrambles that order and makes the per-number rate limit much easier to trip.
 */
export async function processMessageIds(ids) {
  const results = [];

  for (const id of ids) {
    if (store.hasSent(id)) {
      results.push({ id, status: 'skipped', reason: 'already forwarded' });
      continue;
    }

    let msg;
    try {
      msg = await gmail.getMessage(id);
    } catch (err) {
      results.push({ id, status: 'error', reason: `could not read message: ${err.message}` });
      continue;
    }

    const verdict = shouldForward(msg);
    if (!verdict.ok) {
      // Remember filtered mail too, so a replayed history event does not re-evaluate it.
      store.markSent(id);
      results.push({ id, status: 'filtered', reason: verdict.reason, subject: msg.subject });
      continue;
    }

    if (inQuietHours()) {
      store.markSent(id);
      store.enqueue({ id, queuedAt: Date.now(), subject: msg.subject, from: msg.fromEmail });
      results.push({ id, status: 'queued', reason: 'quiet hours', subject: msg.subject });
      continue;
    }

    try {
      const { via } = await deliver(msg);
      store.markSent(id);
      results.push({ id, status: 'sent', via, subject: msg.subject });
      console.log(`[forward] sent (${via}): ${msg.subject}`);
    } catch (err) {
      // Deliberately not marked as sent — a transient Meta failure should be retried
      // by the next notification rather than silently swallowing the mail.
      results.push({ id, status: 'error', reason: err.message, subject: msg.subject });
      console.error(`[forward] failed: ${msg.subject} — ${err.message}`);
      if (wa.isAuthError(err)) break;
    }
  }

  return results;
}

/** Sends anything quiet hours held back. Called when the window closes. */
export async function flushQueue() {
  if (inQuietHours()) return [];

  const queued = store.drainQueue();
  if (!queued.length) return [];

  console.log(`[forward] quiet hours over — flushing ${queued.length} held message(s)`);

  const results = [];
  for (const entry of queued) {
    try {
      const msg = await gmail.getMessage(entry.id);
      const { via } = await deliver(msg);
      results.push({ id: entry.id, status: 'sent', via, subject: msg.subject });
    } catch (err) {
      results.push({ id: entry.id, status: 'error', reason: err.message });
    }
  }
  return results;
}

let sweeper = null;

/** Checks every five minutes whether the quiet window has closed. */
export function startQuietHoursSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    if (!store.get().enabled) return;
    flushQueue().catch((err) => console.error('[forward] flush failed:', err.message));
  }, 5 * 60 * 1000);
  sweeper.unref?.();
}
