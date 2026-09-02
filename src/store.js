import * as kv from './kv.js';

/**
 * Settings, the Gmail history cursor, and the two collections that keep forwarding
 * honest: what has already been sent, and what quiet hours is holding.
 *
 * The shape here is driven by serverless. A single invocation loads a snapshot once,
 * reads it synchronously all through the request, and writes changes through to the
 * store — which is why `get()` stayed synchronous and almost nothing else in the app
 * had to become async when this moved off the filesystem.
 *
 * The two collections are deliberately *not* in that snapshot. Concurrent invocations
 * are normal on Vercel, and a read-modify-write of an array would let two of them both
 * decide a message is unsent. They live in the store as a set and a list, mutated with
 * operations that are atomic on the server.
 */

const KEY_SETTINGS = 'mailflow:settings';
const KEY_SENT = 'mailflow:sent';
const KEY_QUEUE = 'mailflow:queue';

const SENT_ID_LIMIT = 500;

const DEFAULTS = {
  enabled: false,

  // Destination in full international form, digits only. "919876543210".
  toNumber: '',

  categories: ['Personal', 'Work', 'Finance', 'Shopping'],

  // A non-empty allowlist replaces the category filter rather than narrowing it.
  senderAllowlist: [],
  senderBlocklist: [],

  keywords: '',

  // How much mail body to include. 0 keeps it to sender + subject.
  bodyChars: 600,

  quietHours: { enabled: false, start: '23:00', end: '07:00' },

  // --- runtime state ---
  lastHistoryId: null,
  watchExpiration: null,

  // Unix ms of the last inbound WhatsApp message. Meta only allows free-form replies
  // for 24h after this; outside it we must fall back to an approved template.
  lastInboundAt: null,
};

let snapshot = null;
let counts = { sent: 0, queued: 0 };
let pending = Promise.resolve();

/**
 * Pulls the current state in. Call once per request on serverless; once at boot when
 * running as a long-lived process.
 */
export async function load() {
  const saved = (await kv.getJSON(KEY_SETTINGS)) || {};
  snapshot = {
    ...structuredClone(DEFAULTS),
    ...saved,
    quietHours: { ...DEFAULTS.quietHours, ...(saved.quietHours || {}) },
  };
  counts.queued = await kv.listLength(KEY_QUEUE).catch(() => 0);
  return snapshot;
}

export function get() {
  if (!snapshot) throw new Error('store.load() must run before store.get()');
  return snapshot;
}

/** Whether load() has run in this invocation. */
export function isLoaded() {
  return snapshot !== null;
}

/** Merges a patch into the snapshot and writes it through. Writes are serialised. */
export function update(patch) {
  const next = { ...get(), ...patch };
  if (patch.quietHours) next.quietHours = { ...get().quietHours, ...patch.quietHours };
  snapshot = next;

  pending = pending
    .then(() => kv.setJSON(KEY_SETTINGS, snapshot))
    .catch((err) => console.error('[store] could not persist:', err.message));

  return snapshot;
}

/** Awaits any in-flight write. Call before a serverless response returns. */
export async function flushed() {
  await pending;
  await kv.flushed();
}

/**
 * Claims a message id, returning true only for the caller that got there first.
 *
 * Replaces the old check-then-mark pair on purpose: those were two steps, and two
 * invocations could pass the check before either marked it. This is one atomic step,
 * so exactly one caller is ever told to go ahead.
 */
export async function claim(id) {
  const isNew = await kv.addIfNew(KEY_SENT, id);
  if (isNew) {
    counts.sent += 1;
    // Trimming every so often keeps the set bounded without a check on each claim.
    if (counts.sent % 100 === 0) await kv.trimSet(KEY_SENT, SENT_ID_LIMIT).catch(() => {});
  }
  return isNew;
}

export async function enqueue(entry) {
  await kv.push(KEY_QUEUE, entry);
  counts.queued += 1;
}

export async function drainQueue() {
  const queued = await kv.drain(KEY_QUEUE);
  counts.queued = 0;
  return queued;
}

/** The user-facing slice. Runtime cursors stay server-side. */
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
    queuedCount: counts.queued,
    windowOpen: isWindowOpen(),
    storage: kv.describe(),
  };
}

/** True while Meta still lets us send free-form text instead of a template. */
export function isWindowOpen() {
  const { lastInboundAt } = get();
  return Boolean(lastInboundAt && Date.now() - lastInboundAt < 24 * 60 * 60 * 1000);
}
