import * as gmail from './gmail.js';
import * as store from './store.js';
import * as notify from './notify.js';
import { listAccounts } from './auth.js';

/**
 * Decides whether a message is worth an alert, and hands the ones that are to
 * notify.js, which owns the channel choice and its formatting.
 *
 * Order matters in `shouldForward`: the blocklist and allowlist are deliberate user
 * overrides, so they are checked before the category buckets that guess for you.
 */

export function shouldForward(msg) {
  const s = store.get();

  if (!s.enabled) return { ok: false, reason: 'forwarding is off' };
  if (!notify.destination()) return { ok: false, reason: 'no destination configured' };

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

  // A window like 23:00-07:00 crosses midnight, so the test flips from AND to OR.
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** Sends one alert on whichever channel is configured. */
export async function deliver(msg) {
  return notify.deliver(msg);
}

/**
 * Fetches, filters and forwards a batch of Gmail message ids.
 *
 * Runs strictly one at a time: chat apps order by arrival, and a parallel burst both
 * scrambles that order and makes a rate limit much easier to trip.
 */
export async function processMessageIds(email, ids, { budgetMs = 0 } = {}) {
  const results = [];
  const startedAt = Date.now();

  for (const id of ids) {
    // Gmail message ids are only unique within a mailbox, so the claim is namespaced
    // by account. Without that, the same id in two mailboxes would look like a
    // duplicate and the second mailbox's mail would be silently dropped.
    const claimKey = `${email}:${id}`;

    // Serverless runs these concurrently, so the claim happens before any work: it is
    // the single atomic point deciding which invocation owns this message. Claiming up
    // front means a failure cannot be retried by re-running, which is why failures
    // below go onto the retry queue instead.
    if (!(await store.claim(claimKey))) {
      results.push({ id, account: email, status: 'skipped', reason: 'already handled' });
      continue;
    }

    // Stop early rather than be killed mid-send by the platform's time limit.
    if (budgetMs && Date.now() - startedAt > budgetMs) {
      results.push({ id, account: email, status: 'deferred', reason: 'time budget reached' });
      await store.enqueue({ id, email, queuedAt: Date.now(), reason: 'deferred' });
      continue;
    }

    let msg;
    try {
      msg = await gmail.getMessage(email, id);
    } catch (err) {
      results.push({ id, account: email, status: 'error', reason: `could not read message: ${err.message}` });
      continue;
    }

    const verdict = shouldForward(msg);
    if (!verdict.ok) {
      results.push({ id, account: email, status: 'filtered', reason: verdict.reason, subject: msg.subject });
      continue;
    }

    if (inQuietHours()) {
      await store.enqueue({ id, email, queuedAt: Date.now(), subject: msg.subject, from: msg.fromEmail });
      results.push({ id, account: email, status: 'queued', reason: 'quiet hours', subject: msg.subject });
      continue;
    }

    try {
      const { via } = await deliver(msg);
      results.push({ id, account: email, status: 'sent', via, subject: msg.subject });
      console.log(`[forward] sent (${via}) for ${email}: ${msg.subject}`);
    } catch (err) {
      // The claim is already spent, so a plain retry would skip this message forever.
      // Queue it explicitly instead: the next cron run drains it.
      await store.enqueue({ id, email, queuedAt: Date.now(), subject: msg.subject, reason: 'retry' });
      results.push({ id, account: email, status: 'requeued', reason: err.message, subject: msg.subject });
      console.error(`[forward] failed, queued for retry: ${msg.subject} - ${err.message}`);
      if (notify.isAuthError(err)) break;
    }
  }

  return results;
}

/**
 * Drains everything waiting: mail quiet hours held back, deliveries that failed, and
 * anything deferred when an invocation ran out of time.
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
      // Entries queued before multi-account support carry no address; fall back to
      // the only mailbox there was, rather than dropping them.
      const account = entry.email || listAccounts()[0];
      if (!account) throw new Error('no connected account for this queued message');

      const msg = await gmail.getMessage(account, entry.id);
      const { via } = await deliver(msg);
      results.push({ id: entry.id, account, status: 'sent', via, subject: msg.subject });
    } catch (err) {
      // Only re-queue a first failure. Something permanently undeliverable would
      // otherwise cycle forever.
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
 * A no-op on serverless, where the cron endpoint does this job instead.
 */
export function startQuietHoursSweeper() {
  if (sweeper || process.env.VERCEL) return;
  sweeper = setInterval(() => {
    if (!store.isLoaded() || !store.get().enabled) return;
    flushQueue().catch((err) => console.error('[forward] flush failed:', err.message));
  }, 5 * 60 * 1000);
  sweeper.unref?.();
}
