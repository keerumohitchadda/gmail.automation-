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
export async function processMessageIds(ids, { budgetMs = 0 } = {}) {
  const results = [];
  const startedAt = Date.now();

  for (const id of ids) {
    // Serverless runs these concurrently, so the claim has to happen before any work:
    // it is the single atomic point that decides which invocation owns this message.
    // Claiming up front means a failure cannot be retried by simply re-running, which
    // is why failures below go onto the retry queue instead.
    if (!(await store.claim(id))) {
      results.push({ id, status: 'skipped', reason: 'already handled' });
      continue;
    }

    // Stop early rather than be killed mid-send by the platform's time limit. Whatever
    // is left is unclaimed, so the next notification or cron run picks it up.
    if (budgetMs && Date.now() - startedAt > budgetMs) {
      results.push({ id, status: 'deferred', reason: 'time budget reached' });
      await store.enqueue({ id, queuedAt: Date.now(), reason: 'deferred' });
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
      results.push({ id, status: 'filtered', reason: verdict.reason, subject: msg.subject });
      continue;
    }

    if (inQuietHours()) {
      await store.enqueue({ id, queuedAt: Date.now(), subject: msg.subject, from: msg.fromEmail });
      results.push({ id, status: 'queued', reason: 'quiet hours', subject: msg.subject });
      continue;
    }

    try {
      const { via } = await deliver(msg);
      results.push({ id, status: 'sent', via, subject: msg.subject });
      console.log(`[forward] sent (${via}): ${msg.subject}`);
    } catch (err) {
      // The claim is already spent, so a plain retry would skip this message forever.
      // Queue it explicitly instead: the next cron run drains it.
      await store.enqueue({ id, queuedAt: Date.now(), subject: msg.subject, reason: 'retry' });
      results.push({ id, status: 'requeued', reason: err.message, subject: msg.subject });
      console.error(`[forward] failed, queued for retry: ${msg.subject} — ${err.message}`);
      if (wa.isAuthError(err)) break;
    }
  }

  return results;
}

/**
 * Drains everything waiting: mail quiet hours held back, deliveries that failed, and
 * anything deferred when an invocation ran out of time.
 *
 * Called by the cron endpoint, and after each webhook once the quiet window has closed.
 */
export async function flushQueue({ budgetMs = 0 } = {}) {
  if (inQuietHours()) return [];

  const queued = await store.drainQueue();
  if (!queued.length) return [];

  console.log(`[forward] draining ${queued.length} held message(s)`);
  const startedAt = Date.now();
  const results = [];

  for (const entry of queued) {
    if (budgetMs && Date.now() - startedAt > budgetMs) {
      // Put the rest back so the next run continues where this one stopped.
      await store.enqueue(entry);
      results.push({ id: entry.id, status: 'deferred' });
      continue;
    }
    try {
      const msg = await gmail.getMessage(entry.id);
      const { via } = await deliver(msg);
      results.push({ id: entry.id, status: 'sent', via, subject: msg.subject });
    } catch (err) {
      // Only re-queue a first failure. Something permanently undeliverable — a message
      // that no longer exists, say — would otherwise cycle forever.
      if (!entry.retried) {
        await store.enqueue({ ...entry, retried: true });
        results.push({ id: entry.id, status: 'requeued', reason: err.message });
      } else {
        results.push({ id: entry.id, status: 'dropped', reason: err.message });
        console.error(`[forward] giving up on ${entry.id}: ${err.message}`);
      }
    }
  }
  return results;
}

let sweeper = null;

/**
 * Five-minute quiet-hours sweep, for when the app runs as a long-lived process.
 *
 * A no-op on serverless, where nothing survives between requests — there the cron
 * endpoint does this job instead.
 */
export function startQuietHoursSweeper() {
  if (sweeper || process.env.VERCEL) return;
  sweeper = setInterval(() => {
    if (!store.isLoaded() || !store.get().enabled) return;
    flushQueue().catch((err) => console.error('[forward] flush failed:', err.message));
  }, 5 * 60 * 1000);
  sweeper.unref?.();
}
