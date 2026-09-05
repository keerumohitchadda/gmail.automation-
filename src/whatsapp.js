import crypto from 'node:crypto';

const GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v21.0';

function config() {
  const {
    WA_PHONE_NUMBER_ID,
    WA_ACCESS_TOKEN,
    WA_TEMPLATE_NAME,
    WA_TEMPLATE_LANG,
  } = process.env;

  if (!WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    throw new Error(
      'Missing WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN. Fill them into .env — see WHATSAPP-SETUP.md.',
    );
  }

  return {
    phoneNumberId: WA_PHONE_NUMBER_ID,
    token: WA_ACCESS_TOKEN,
    templateName: WA_TEMPLATE_NAME || 'new_email_alert',
    // Meta treats "en" and "en_US" as different languages, and a mismatch fails the
    // send outright rather than falling back. Accounts created through the current
    // console get en_US, so that is the default.
    templateLang: WA_TEMPLATE_LANG || 'en_US',
  };
}

export function isConfigured() {
  return Boolean(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);
}

async function post(payload) {
  const { phoneNumberId, token } = config();
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = data?.error || {};
    // Meta's own message is far more useful than the status code, so lead with it.
    const detail = err.error_user_msg || err.message || `HTTP ${res.status}`;
    const error = new Error(`WhatsApp API: ${detail}`);
    error.status = res.status;
    error.code = err.code;
    error.subcode = err.error_subcode;
    throw error;
  }

  return data;
}

/**
 * Free-form text. Meta only accepts this inside the 24-hour customer service window,
 * i.e. within a day of the recipient last messaging the business number. Outside it
 * this fails with code 131047 and the caller should fall back to a template.
 */
export async function sendText(to, body) {
  return post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeNumber(to),
    type: 'text',
    text: { preview_url: false, body: body.slice(0, 4096) },
  });
}

/**
 * Pre-approved template with positional {{1}}..{{n}} body variables. This is the only
 * thing that gets through outside the 24-hour window, which is why the notification
 * template is three short variables rather than one big blob of email text.
 */
export async function sendTemplate(to, params) {
  const { templateName, templateLang } = config();

  return post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeNumber(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text: templateParam(text) })),
        },
      ],
    },
  });
}

/**
 * Template variables reject newlines, tabs and runs of 4+ spaces outright — Meta
 * returns a 132000-family error rather than silently trimming. Flatten first.
 */
export function templateParam(value) {
  const flat = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (flat || '-').slice(0, 900);
}

/** Digits only, no plus, country code included. "+91 98765-43210" -> "919876543210". */
export function normalizeNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Verifies the X-Hub-Signature-256 header Meta sends with every webhook POST.
 * Without this the webhook is an open endpoint anyone can post fake events to.
 */
export function verifySignature(rawBody, header) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return { ok: false, reason: 'WA_APP_SECRET is not set' };
  if (!header?.startsWith('sha256=')) return { ok: false, reason: 'missing signature header' };

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };

  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

/** Meta says the token is expired/invalid — the UI should tell the user to re-issue it. */
export function isAuthError(err) {
  return err?.status === 401 || err?.code === 190;
}

/** The 24-hour window has closed; retry the same content as a template. */
export function isWindowClosedError(err) {
  return err?.code === 131047 || err?.code === 131026 || err?.subcode === 2494010;
}
