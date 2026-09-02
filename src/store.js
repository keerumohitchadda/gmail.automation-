import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_PATH = path.resolve('.forwarding.json');

/**
 * Everything the forwarder needs to survive a restart: user settings, the Gmail
 * history cursor, the watch expiry, and a short memory of what we already sent.
 *
 * It is a single small JSON file written whole. Volume here is a handful of writes
 * per minute at worst, so the simplicity is worth more than incremental updates.
 */
const DEFAULTS = {
  enabled: false,

  // Destination in full international form, digits only. "919876543210", not "+91 98765 43210".
  toNumber: '',

  // Which categorize.js buckets get forwarded. Empty array means "none".
  categories: ['Personal', 'Work', 'Finance', 'Shopping'],

  // Substring matches against the sender address. Allowlist, when non-empty, wins
  // outright: nothing outside it is ever forwarded, whatever the categories say.
  senderAllowlist: [],
  senderBlocklist: [],

  // Comma-separated words; if set, the subject or snippet must contain one of them.
  keywords: '',

  // How much of the mail body to put in the message. 0 keeps it to sender + subject.
  bodyChars: 600,

  // Nothing is sent between these times, local to the server. Held, not dropped —
  // queued mail goes out when the window closes.
  quietHours: { enabled: false, start: '23:00', end: '07:00' },

  // --- runtime state, not user-editable ---
  lastHistoryId: null,
  watchExpiration: null,
  watchedEmail: null,

  // Unix ms of the last inbound WhatsApp message from `toNumber`. Meta only allows
  // free-form replies for 24h after this; outside it we must fall back to a template.
  lastInboundAt: null,

  // Ids we have already forwarded, newest last. Gmail's history feed can replay the
  // same message across notifications, so this is what stops duplicate pings.
  sentIds: [],

  // Mail held back by quiet hours, flushed when the window closes.
  queued: [],
};

const SENT_ID_LIMIT = 500;
const QUEUE_LIMIT = 100;

let state = null;
let writeChain = Promise.resolve();

export async function load() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const saved = JSON.parse(raw);
    state = { ...structuredClone(DEFAULTS), ...saved, quietHours: { ...DEFAULTS.quietHours, ...(saved.quietHours || {}) } };
  } catch {
    state = structuredClone(DEFAULTS);
  }
  return state;
}

export function get() {
  if (!state) throw new Error('store.load() must run before store.get()');
  return state;
}

/** Merges a patch into the store and persists it. Writes are serialised. */
export function update(patch) {
  const next = { ...get(), ...patch };
  if (patch.quietHours) next.quietHours = { ...get().quietHours, ...patch.quietHours };
  state = next;
  writeChain = writeChain.then(() =>
    fs.writeFile(STORE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 }).catch((err) =>
      console.error('[store] could not persist:', err.message),
    ),
  );
  return state;
}

export function flushed() {
  return writeChain;
}

export function hasSent(id) {
  return get().sentIds.includes(id);
}

export function markSent(id) {
  const ids = get().sentIds.filter((existing) => existing !== id);
  ids.push(id);
  update({ sentIds: ids.slice(-SENT_ID_LIMIT) });
}

export function enqueue(entry) {
  const queued = [...get().queued, entry].slice(-QUEUE_LIMIT);
  update({ queued });
}

export function drainQueue() {
  const { queued } = get();
  if (queued.length) update({ queued: [] });
  return queued;
}

/** The user-facing slice of the store — runtime cursors stay server-side. */
export function publicSettings() {
  const s = get();
  return {
    enabled: s.enabled,
    toNumber: s.toNumber,
    categories: s.categories,
    senderAllowlist: s.senderAllowlist,
    senderBlocklist: s.senderBlocklist,
    keywords: s.keywords,
    bodyChars: s.bodyChars,
    quietHours: s.quietHours,
    watching: Boolean(s.watchExpiration && s.watchExpiration > Date.now()),
    watchExpiration: s.watchExpiration,
    queuedCount: s.queued.length,
    forwardedCount: s.sentIds.length,
    windowOpen: isWindowOpen(),
  };
}

/** True while Meta still lets us send free-form text instead of a template. */
export function isWindowOpen() {
  const { lastInboundAt } = get();
  return Boolean(lastInboundAt && Date.now() - lastInboundAt < 24 * 60 * 60 * 1000);
}
