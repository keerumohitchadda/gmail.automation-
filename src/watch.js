import { google } from 'googleapis';
import { getClient, isAuthorized } from './auth.js';
import * as store from './store.js';

function api() {
  return google.gmail({ version: 'v1', auth: getClient() });
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
 * Tells Gmail to publish a Pub/Sub notification whenever the inbox changes.
 *
 * The registration lasts seven days, so `scheduleRenewal` re-arms it daily. Calling
 * this again on an already-watched mailbox is fine — Gmail just resets the clock.
 */
export async function startWatch() {
  const { data } = await api().users.watch({
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
  if (!store.get().lastHistoryId && historyId) patch.lastHistoryId = historyId;

  store.update(patch);
  console.log(`[watch] active until ${new Date(expiration).toLocaleString()}`);

  return { historyId, expiration };
}

export async function stopWatch() {
  try {
    await api().users.stop({ userId: 'me' });
  } finally {
    store.update({ watchExpiration: null });
  }
  console.log('[watch] stopped');
}

let renewalTimer = null;

/** Re-registers the watch once a day, well inside Gmail's seven-day expiry. */
export function scheduleRenewal() {
  if (renewalTimer) return;

  const DAY = 24 * 60 * 60 * 1000;
  renewalTimer = setInterval(async () => {
    if (!isAuthorized() || !store.get().enabled) return;
    try {
      await startWatch();
    } catch (err) {
      console.error('[watch] renewal failed:', err.message);
    }
  }, DAY);

  renewalTimer.unref?.();
}

export function cancelRenewal() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
}

/**
 * Returns the message ids added to the inbox since our stored cursor, then advances it.
 *
 * Gmail history is a change feed, not a mailbox listing: a single Pub/Sub ping can cover
 * several new messages, and the same message can reappear across pings. De-duplication
 * happens downstream in the store, so this stays a plain "what changed" query.
 */
export async function newMessageIds(notifiedHistoryId) {
  const startHistoryId = store.get().lastHistoryId;

  // No cursor yet means we have nothing to diff against. Adopt the notification's id
  // as the baseline and wait for the next event rather than dumping the whole inbox.
  if (!startHistoryId) {
    store.update({ lastHistoryId: String(notifiedHistoryId) });
    return [];
  }

  const gmail = api();
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
        console.warn('[watch] history cursor expired; resyncing from current position');
        store.update({ lastHistoryId: String(notifiedHistoryId) });
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

  store.update({ lastHistoryId: latestHistoryId });

  return [...new Set(ids)];
}
