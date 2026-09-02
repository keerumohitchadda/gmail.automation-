import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The storage primitives the app needs, over either Upstash Redis or a local file.
 *
 * Serverless has no persistent disk and no shared memory between invocations, so on
 * Vercel every piece of state has to live in an external store. Locally there is no
 * reason to require a database, so the same interface is implemented over a JSON file.
 *
 * Only the handful of Redis operations this app actually uses are implemented, and
 * they are chosen deliberately: `sadd`/`sismember` are atomic, which is what keeps two
 * concurrent invocations from both deciding a message has not been forwarded yet.
 */

const LOCAL_PATH = path.resolve('.kv.json');

export function isRemote() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export function describe() {
  return isRemote() ? 'Upstash Redis' : `local file (${LOCAL_PATH})`;
}

// ---- Upstash REST transport ----

async function command(args) {
  const url = process.env.KV_REST_API_URL.replace(/\/$/, '');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`KV ${args[0]} failed: ${data.error || `HTTP ${res.status}`}`);
  }
  return data.result;
}

// ---- local file transport ----

let localCache = null;

async function readLocal() {
  if (localCache) return localCache;
  try {
    localCache = JSON.parse(await fs.readFile(LOCAL_PATH, 'utf8'));
  } catch {
    localCache = {};
  }
  return localCache;
}

let localWrites = Promise.resolve();
async function writeLocal(db) {
  localCache = db;
  localWrites = localWrites.then(() =>
    fs.writeFile(LOCAL_PATH, JSON.stringify(db, null, 2), { mode: 0o600 }).catch((err) =>
      console.error('[kv] local write failed:', err.message),
    ),
  );
  return localWrites;
}

/** Awaits any in-flight local write. Remote writes are already awaited inline. */
export async function flushed() {
  await localWrites;
}

// ---- operations ----

export async function getJSON(key) {
  if (isRemote()) {
    const raw = await command(['GET', key]);
    if (raw === null || raw === undefined) return null;
    // Upstash returns whatever was stored; we always store strings.
    return typeof raw === 'string' ? safeParse(raw) : raw;
  }
  const db = await readLocal();
  return db[key] ?? null;
}

export async function setJSON(key, value) {
  if (isRemote()) {
    await command(['SET', key, JSON.stringify(value)]);
    return;
  }
  const db = await readLocal();
  db[key] = value;
  await writeLocal(db);
}

export async function del(key) {
  if (isRemote()) {
    await command(['DEL', key]);
    return;
  }
  const db = await readLocal();
  delete db[key];
  await writeLocal(db);
}

/**
 * Adds to a set and reports whether it was new, in one atomic step.
 *
 * This is the whole reason the de-dup list is a set rather than an array inside the
 * settings blob: two Pub/Sub pushes can run at the same time, and a read-modify-write
 * would let both conclude the message is unseen and send it twice.
 */
export async function addIfNew(key, member) {
  if (isRemote()) {
    const added = await command(['SADD', key, member]);
    return added === 1;
  }
  const db = await readLocal();
  const list = db[key] || [];
  if (list.includes(member)) return false;
  list.push(member);
  db[key] = list;
  await writeLocal(db);
  return true;
}

/** Keeps a set from growing without bound. Cheap and only run occasionally. */
export async function trimSet(key, keep) {
  if (isRemote()) {
    const size = await command(['SCARD', key]);
    if (size > keep) await command(['SPOP', key, String(size - keep)]);
    return;
  }
  const db = await readLocal();
  const list = db[key] || [];
  if (list.length > keep) {
    db[key] = list.slice(-keep);
    await writeLocal(db);
  }
}

export async function push(key, value) {
  if (isRemote()) {
    await command(['RPUSH', key, JSON.stringify(value)]);
    return;
  }
  const db = await readLocal();
  db[key] = [...(db[key] || []), value];
  await writeLocal(db);
}

export async function listLength(key) {
  if (isRemote()) return (await command(['LLEN', key])) || 0;
  const db = await readLocal();
  return (db[key] || []).length;
}

/** Reads a list and empties it. Used to drain the quiet-hours queue. */
export async function drain(key) {
  if (isRemote()) {
    const raw = (await command(['LRANGE', key, '0', '-1'])) || [];
    await command(['DEL', key]);
    return raw.map((entry) => (typeof entry === 'string' ? safeParse(entry) : entry)).filter(Boolean);
  }
  const db = await readLocal();
  const list = db[key] || [];
  if (list.length) {
    db[key] = [];
    await writeLocal(db);
  }
  return list;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
