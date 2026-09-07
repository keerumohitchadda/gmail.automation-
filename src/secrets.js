import * as kv from './kv.js';

/**
 * Credentials that can be updated without a redeploy.
 *
 * Environment variables are the source of truth, but changing one on Vercel means a
 * dashboard visit and a new deployment. Some of these expire on their own — Meta's
 * access token most obviously — and the app being dead until someone is at a computer
 * is a poor failure mode.
 *
 * So a value stored here wins over the environment. Nothing is stored by default, and
 * clearing an override falls straight back to the deployed configuration.
 */

const KEY = 'mailflow:secrets';

/** Only credentials that legitimately rotate. Anything else stays deploy-time. */
const OVERRIDABLE = new Set([
  'WA_ACCESS_TOKEN',
  'WA_PHONE_NUMBER_ID',
  'WA_APP_SECRET',
  'WA_TEMPLATE_NAME',
  'WA_TEMPLATE_LANG',
  'TELEGRAM_BOT_TOKEN',
  // The scheduler's own credentials. Included so a deployment whose CRON_TOKEN was
  // never set can still be driven — the maintenance endpoint is what drains a stuck
  // queue, and needing a redeploy to reach it defeats the point.
  'CRON_TOKEN',
  'CRON_SECRET',
]);

let overrides = null;

export async function load() {
  overrides = (await kv.getJSON(KEY)) || {};
  return overrides;
}

/** The override if one is stored, otherwise the environment. */
export function get(name) {
  const stored = overrides?.[name];
  return stored != null && stored !== '' ? stored : process.env[name];
}

export function isOverridden(name) {
  const stored = overrides?.[name];
  return stored != null && stored !== '';
}

export async function set(name, value) {
  if (!OVERRIDABLE.has(name)) throw new Error(`${name} cannot be overridden at runtime.`);
  overrides = { ...(overrides || {}) };
  if (value == null || value === '') delete overrides[name];
  else overrides[name] = String(value);
  await kv.setJSON(KEY, overrides);
  return Object.keys(overrides);
}

/** Names only — the values are secrets and must never reach a response body. */
export function listOverridden() {
  return Object.keys(overrides || {});
}

export function overridable() {
  return [...OVERRIDABLE];
}
