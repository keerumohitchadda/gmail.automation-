import { google } from 'googleapis';
import { getClient, listAccounts, getAccount, patchAccount, isAuthorized } from './auth.js';
import * as store from './store.js';

/**
 * Gmail push registration, per mailbox.
 *
 * A watch belongs to one account, and so does the history cursor it produces. Both
 * live on the account record rather than in settings, because two mailboxes advance
 * through their histories independently.
 */

function api(email) {
  return google.gmail({ version: 'v1', auth: getClient(email) });
}

function topicName() {
  const topic = process.env.PUBSUB_TOPIC;
  if (!topic) {
    throw new Error(
      'Missing PUBSUB_TOPIC. It looks like "projects/your-project/topics/gmail-push" — see WHATSAPP-SETUP.md.',
    );
  }
  return topic;
}

/**
 * Tells Gmail to publish a Pub/Sub notification whenever this mailbox changes.
 *
 * Several accounts can publish to the same topic — the notification carries the
 * address, which is how the webhook knows whose mail it is. The registration lasts
 * seven days, so it is re-armed daily by cron.
 */
export async function startWatch(email) {
  const { data } = await api(email).users.watch({
    userId: 'me',
    requestBody: {
      topicName: topicName(),
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    },
  });

  const expiration = Number(data.expiration) || null;
  const historyId = data.historyId ? String(data.historyId) : null;

  // Only seed the cursor the first time. Overwriting it on a renewal would skip any
  // mail that arrived between the last sync and now.
  const patch = { watchExpiration: expiration };
  if (!getAccount(email)?.historyId && historyId) patch.historyId = historyId;

  await patchAccount(email, patch);
  console.log(`[watch] ${email} active until ${new Date(expiration).toLocaleString()}`);

  return { email, historyId, expiration };
}

/** Arms a watch for every connected mailbox, reporting per-account outcomes. */
export async function startAllWatches() {
  const results = [];
  for (const email of listAccounts()) {
    try {
      results.push({ ...(await startWatch(email)), ok: true });
    } catch (err) {
      console.error(`[watch] ${email} failed: ${err.message}`);
      results.push({ email, ok: false, error: err.message });
    }
  }
  return results;
}

export async function stopWatch(email) {
  try {
    await api(email).users.stop({ userId: 'me' });
  } finally {
    await patchAccount(email, { watchExpiration: null });
  }
  console.log(`[watch] ${email} stopped`);
}

let renewalTimer = null;

/**
 * Re-registers watches daily, well inside Gmail's seven-day expiry.
 *
 * A no-op on serverless: there is no process to hold a timer, and a setInterval
 * registered during a request dies with that invocation. /cron/renew covers it there.
 */
export function scheduleRenewal() {
  if (renewalTimer || process.env.VERCEL) return;

  const DAY = 24 * 60 * 60 * 1000;
  renewalTimer = setInterval(async () => {
    if (!isAuthorized() || !store.isLoaded() || !store.get().enabled) return;
    await startAllWatches();
  }, DAY);

  renewalTimer.unref?.();
}

export function cancelRenewal() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
}

/**
 * Returns the message ids added to one mailbox since its stored cursor, then advances
 * that cursor.
 *
 * Gmail history is a change feed, not a mailbox listing: a single Pub/Sub ping can
 * cover several new messages, and the same message can reappear across pings.
 * De-duplication happens downstream, so this stays a plain "what changed" query.
 */
export async function newMessageIds(email, notifiedHistoryId) {
  const startHistoryId = getAccount(email)?.historyId;

  // No cursor yet means nothing to diff against. Adopt the notification's id as the
  // baseline and wait for the next event rather than dumping the whole inbox.
  if (!startHistoryId) {
    await patchAccount(email, { historyId: String(notifiedHistoryId) });
    return [];
  }

  const gmail = api(email);
  const ids = [];
  let pageToken;
  let latestHistoryId = String(startHistoryId);

  do {
    let data;
    try {
      ({ data } = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        maxResults: 500,
        pageToken,
      }));
    } catch (err) {
      // 404 means the cursor aged out (Gmail keeps roughly a week of history).
      // Skip forward instead of failing forever.
      if (err?.response?.status === 404 || err?.code === 404) {
        console.warn(`[watch] ${email} history cursor expired; resyncing from current position`);
        await patchAccount(email, { historyId: String(notifiedHistoryId) });
        return [];
      }
      throw err;
    }

    for (const record of data.history || []) {
      for (const added of record.messagesAdded || []) {
        const msg = added.message;
        if (!msg?.id) continue;

        const labels = msg.labelIds || [];
        // Skip our own sent mail, drafts, spam and trash — none of that is "new mail".
        if (!labels.includes('INBOX')) continue;
        if (labels.includes('SENT') || labels.includes('DRAFT')) continue;
        if (labels.includes('SPAM') || labels.includes('TRASH')) continue;

        ids.push(msg.id);
      }
    }

    if (data.historyId) latestHistoryId = String(data.historyId);
    pageToken = data.nextPageToken;
  } while (pageToken);

  await patchAccount(email, { historyId: latestHistoryId });

  return [...new Set(ids)];
}
