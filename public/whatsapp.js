/**
 * The WhatsApp forwarding settings panel.
 *
 * Kept apart from app.js because it shares nothing with the inbox view — it talks to
 * /api/forwarding only, and the mail list neither reads nor writes any of this state.
 */

const $ = (id) => document.getElementById(id);

const el = {
  open: $('wa-open'),
  dialog: $('wa-dialog'),
  close: $('wa-close'),
  save: $('wa-save'),
  test: $('wa-test'),
  sync: $('wa-sync'),
  setupNote: $('wa-setup-note'),
  enabled: $('wa-enabled'),
  enabledLabel: $('wa-enabled-label'),
  watchState: $('wa-watch-state'),
  number: $('wa-number'),
  categories: $('wa-categories'),
  allow: $('wa-allow'),
  block: $('wa-block'),
  keywords: $('wa-keywords'),
  body: $('wa-body'),
  bodyLabel: $('wa-body-label'),
  quiet: $('wa-quiet'),
  quietStart: $('wa-quiet-start'),
  quietEnd: $('wa-quiet-end'),
  status: $('wa-status'),
};

let settings = null;

async function api(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function say(message, kind = 'muted') {
  el.status.textContent = message;
  el.status.className = `wa-status small ${kind}`;
}

function fill(data) {
  settings = data;

  el.enabled.checked = data.enabled;
  el.enabledLabel.textContent = data.enabled ? 'on' : 'off';
  el.number.value = data.toNumber || '';
  el.allow.value = (data.senderAllowlist || []).join(', ');
  el.block.value = (data.senderBlocklist || []).join(', ');
  el.keywords.value = data.keywords || '';
  el.body.value = data.bodyChars ?? 600;
  el.bodyLabel.textContent = el.body.value;

  el.quiet.checked = data.quietHours?.enabled || false;
  el.quietStart.value = data.quietHours?.start || '23:00';
  el.quietEnd.value = data.quietHours?.end || '07:00';

  if (data.categoriesAvailable) {
    el.categories.innerHTML = '';
    for (const name of data.categoriesAvailable) {
      const label = document.createElement('label');
      label.className = 'wa-chip';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = name;
      box.checked = data.categories.includes(name);
      label.append(box, document.createTextNode(name));
      el.categories.append(label);
    }
  }

  el.watchState.textContent = data.watching ? 'Gmail watch active' : 'Gmail watch inactive';
  el.watchState.className = `pill ${data.watching ? 'pill-ok' : 'muted'}`;

  // The two setup blockers worth naming up front, because every other control in this
  // panel is useless until they are cleared.
  const missing = [];
  if (data.whatsappConfigured === false) missing.push('WhatsApp credentials (WA_* in .env)');
  if (data.pubsubConfigured === false) missing.push('Pub/Sub push (PUBSUB_* in .env)');
  el.setupNote.textContent = missing.length
    ? `Still to configure: ${missing.join(' and ')}. See WHATSAPP-SETUP.md.`
    : 'Credentials look configured. New inbox mail matching the filters below lands on your phone.';

  const notes = [];
  if (data.queuedCount) notes.push(`${data.queuedCount} message(s) held by quiet hours`);
  if (data.forwardedCount) notes.push(`${data.forwardedCount} tracked as already handled`);
  notes.push(
    data.windowOpen
      ? 'Free-form window open — full email text will be sent.'
      : 'Free-form window closed — alerts go out as the approved template. Message the bot on WhatsApp to reopen it.',
  );
  say(notes.join(' · '));
}

function collect() {
  return {
    enabled: el.enabled.checked,
    toNumber: el.number.value,
    categories: [...el.categories.querySelectorAll('input:checked')].map((i) => i.value),
    senderAllowlist: el.allow.value,
    senderBlocklist: el.block.value,
    keywords: el.keywords.value,
    bodyChars: Number(el.body.value),
    quietHours: {
      enabled: el.quiet.checked,
      start: el.quietStart.value || '23:00',
      end: el.quietEnd.value || '07:00',
    },
  };
}

async function load() {
  try {
    fill(await api('/api/forwarding'));
  } catch (err) {
    say(err.message, 'error');
  }
}

el.open?.addEventListener('click', async () => {
  el.dialog.showModal();
  await load();
});

el.close?.addEventListener('click', () => el.dialog.close());

el.enabled?.addEventListener('change', () => {
  el.enabledLabel.textContent = el.enabled.checked ? 'on' : 'off';
});

el.body?.addEventListener('input', () => {
  el.bodyLabel.textContent = el.body.value;
});

el.save?.addEventListener('click', async () => {
  el.save.disabled = true;
  say('Saving…');
  try {
    const saved = await api('/api/forwarding', { method: 'PUT', body: JSON.stringify(collect()) });
    fill({ ...settings, ...saved });
    say(saved.warning || 'Saved.', saved.warning ? 'error' : 'ok');
  } catch (err) {
    say(err.message, 'error');
  } finally {
    el.save.disabled = false;
  }
});

el.test?.addEventListener('click', async () => {
  el.test.disabled = true;
  say('Sending a test message…');
  try {
    // Saved first, so the test uses the number currently in the box rather than
    // whatever was stored the last time the panel was open.
    await api('/api/forwarding', { method: 'PUT', body: JSON.stringify(collect()) });
    const { via } = await api('/api/forwarding/test', { method: 'POST' });
    say(
      via === 'text'
        ? 'Test sent as full text. Check your phone.'
        : 'Test sent using the approved template (the 24h free-form window is closed).',
      'ok',
    );
  } catch (err) {
    say(err.message, 'error');
  } finally {
    el.test.disabled = false;
  }
});

el.sync?.addEventListener('click', async () => {
  el.sync.disabled = true;
  say('Checking recent unread mail…');
  try {
    const { results } = await api('/api/forwarding/sync', { method: 'POST' });
    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'error');
    say(
      failed.length
        ? `Forwarded ${sent}. ${failed.length} failed: ${failed[0].reason}`
        : `Forwarded ${sent} of ${results.length} recent unread message(s); the rest were filtered or already handled.`,
      failed.length ? 'error' : 'ok',
    );
    await load();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    el.sync.disabled = false;
  }
});
