const POLL_MS = 30_000;

const QUICK_REPLIES = [
  'Thanks, got it!',
  'Sounds good to me.',
  "Received — I'll get back to you shortly.",
  'Can we schedule a call to discuss this?',
  "Thanks for reaching out. I'm not interested at the moment.",
];

const state = {
  connected: false,
  email: '',
  messages: [],
  category: 'All',
  selectedId: null,
  search: '',
  alertsOn: false,
  /** Newest timestamp we have already alerted on, so a refresh doesn't re-notify. */
  lastSeen: Number(localStorage.getItem('lastSeen') || 0),
  /** null = compose new, otherwise the message being replied to. */
  replyTo: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  account: $('account'),
  banner: $('banner'),
  connectView: $('connect-view'),
  appView: $('app-view'),
  categories: $('categories'),
  list: $('message-list'),
  listStatus: $('list-status'),
  reader: $('reader'),
  search: $('search'),
  refresh: $('refresh'),
  notifyToggle: $('notify-toggle'),
  compose: $('compose'),
  logout: $('logout'),
  composer: $('composer'),
  composerTitle: $('composer-title'),
  composerTo: $('composer-to'),
  composerSubject: $('composer-subject'),
  composerBody: $('composer-body'),
  quickReplies: $('quick-replies'),
  fieldTo: $('field-to'),
  fieldSubject: $('field-subject'),
  confirm: $('confirm'),
  confirmSummary: $('confirm-summary'),
  confirmPreview: $('confirm-preview'),
};

// ---- helpers ----

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let bannerTimer;
function banner(message, kind = 'error') {
  clearTimeout(bannerTimer);
  el.banner.textContent = message;
  el.banner.className = `banner ${kind}`;
  if (kind === 'ok') bannerTimer = setTimeout(hideBanner, 4000);
}
function hideBanner() {
  el.banner.className = 'banner hidden';
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const displayName = (m) => m.fromName || m.fromEmail || '(unknown)';

/**
 * A stable 0–359 hue for an avatar, hashed from the sender's address.
 *
 * Deriving it rather than storing it means the same person keeps the same colour
 * across refreshes and sessions without any state to keep in sync.
 */
function hueFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

function visibleMessages() {
  return state.category === 'All'
    ? state.messages
    : state.messages.filter((m) => m.category === state.category);
}

// ---- rendering ----

function renderCategories() {
  const counts = new Map();
  for (const m of state.messages) counts.set(m.category, (counts.get(m.category) || 0) + 1);

  const entries = [['All', state.messages.length], ...counts.entries()];
  el.categories.replaceChildren(
    ...entries.map(([name, count]) => {
      const button = document.createElement('button');
      button.className = `cat${name === state.category ? ' active' : ''}`;
      // Drives the colour dot; the palette itself lives in styles.css.
      button.dataset.cat = name;
      button.innerHTML = `<span></span><span class="count"></span>`;
      button.firstChild.textContent = name;
      button.lastChild.textContent = String(count);
      button.onclick = () => {
        state.category = name;
        render();
      };
      return button;
    }),
  );
}

function renderList() {
  const messages = visibleMessages();
  const unread = state.messages.filter((m) => m.unread).length;
  el.listStatus.textContent = `${messages.length} message(s)${unread ? ` · ${unread} unread` : ''}`;

  el.list.replaceChildren(
    ...messages.map((m) => {
      const li = document.createElement('li');
      li.className = `message${m.unread ? ' unread' : ''}${m.id === state.selectedId ? ' selected' : ''}`;

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (displayName(m)[0] || '?').toUpperCase();
      // Same sender, same colour, every session — the hue is derived, not assigned.
      avatar.style.setProperty('--hue', String(hueFor(m.fromEmail || displayName(m))));

      const main = document.createElement('div');
      main.className = 'message-main';

      const row = document.createElement('div');
      row.className = 'message-row';
      const from = document.createElement('div');
      from.className = 'message-from';
      from.textContent = displayName(m);
      const time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = formatTime(m.timestamp);
      row.append(from, time);

      const subject = document.createElement('div');
      subject.className = 'message-subject';
      subject.textContent = m.subject;

      const snippet = document.createElement('div');
      snippet.className = 'message-snippet';
      snippet.textContent = m.snippet;

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.dataset.cat = m.category;
      tag.textContent = m.category;

      main.append(row, subject, snippet, tag);
      li.append(avatar, main);
      li.onclick = () => openMessage(m.id);
      return li;
    }),
  );

  if (!messages.length) {
    const li = document.createElement('li');
    li.className = 'list-status muted';
    li.style.padding = '24px 16px';
    li.textContent =
      state.category === 'All' ? 'Nothing in your inbox.' : `Nothing in ${state.category}.`;
    el.list.append(li);
  }
}

function renderReader(message) {
  if (!message) {
    el.reader.innerHTML = '<div class="reader-empty muted">Select a message to read it.</div>';
    return;
  }

  el.reader.replaceChildren();

  const h2 = document.createElement('h2');
  h2.textContent = message.subject;

  const meta = document.createElement('div');
  meta.className = 'reader-meta';
  meta.textContent = `${displayName(message)} <${message.fromEmail}> · ${formatTime(
    message.timestamp,
  )} · ${message.category}`;

  const actions = document.createElement('div');
  actions.className = 'reader-actions';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'btn btn-primary';
  replyBtn.textContent = '↩ Reply';
  replyBtn.onclick = () => openComposer(message);

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'btn';
  archiveBtn.textContent = '🗄 Archive';
  archiveBtn.onclick = () => archiveMessage(message.id);

  actions.append(replyBtn, archiveBtn);

  const body = document.createElement('div');
  body.className = 'reader-body';
  body.textContent = message.body ?? message.snippet ?? '';

  el.reader.append(h2, meta, actions, body);
}

function render() {
  el.account.textContent = state.connected ? state.email : 'Not connected';
  el.connectView.classList.toggle('hidden', state.connected);
  el.appView.classList.toggle('hidden', !state.connected);
  el.logout.classList.toggle('hidden', !state.connected);
  el.notifyToggle.textContent = `🔔 Alerts: ${state.alertsOn ? 'on' : 'off'}`;
  el.notifyToggle.classList.toggle('is-on', state.alertsOn);
  renderCategories();
  renderList();
}

// ---- actions ----

async function refresh({ quiet = false } = {}) {
  if (!state.connected) return;
  if (!quiet) el.listStatus.textContent = 'Loading…';

  try {
    const params = new URLSearchParams({ max: '30' });
    if (state.search) params.set('q', state.search);
    const { messages } = await api(`/api/messages?${params}`);

    const fresh = messages.filter((m) => m.timestamp > state.lastSeen && m.unread);
    state.messages = messages;

    const newest = messages.reduce((max, m) => Math.max(max, m.timestamp), 0);
    if (newest > state.lastSeen) {
      state.lastSeen = newest;
      localStorage.setItem('lastSeen', String(newest));
    }

    if (fresh.length) notifyNewMail(fresh);
    hideBanner();
    render();
  } catch (err) {
    banner(err.message);
    if (/Not connected|Session expired/i.test(err.message)) {
      state.connected = false;
      render();
    }
  }
}

async function openMessage(id) {
  state.selectedId = id;
  renderList();

  const summary = state.messages.find((m) => m.id === id);
  renderReader(summary);

  try {
    const full = await api(`/api/messages/${id}`);
    if (state.selectedId === id) renderReader(full);

    if (summary?.unread) {
      await api(`/api/messages/${id}/read`, { method: 'POST' });
      summary.unread = false;
      renderList();
      renderCategories();
    }
  } catch (err) {
    banner(err.message);
  }
}

async function archiveMessage(id) {
  try {
    await api(`/api/messages/${id}/archive`, { method: 'POST' });
    state.messages = state.messages.filter((m) => m.id !== id);
    state.selectedId = null;
    renderReader(null);
    render();
    banner('Archived.', 'ok');
  } catch (err) {
    banner(err.message);
  }
}

// ---- composing ----

function openComposer(replyTo = null) {
  state.replyTo = replyTo;
  const isReply = Boolean(replyTo);

  el.composerTitle.textContent = isReply ? `Reply to ${displayName(replyTo)}` : 'New message';
  el.composerTo.value = isReply ? replyTo.fromEmail : '';
  el.composerSubject.value = isReply
    ? /^re:/i.test(replyTo.subject)
      ? replyTo.subject
      : `Re: ${replyTo.subject}`
    : '';
  el.composerBody.value = '';

  // On a reply the recipient and subject are derived server-side from the original,
  // so showing them as editable fields would be a lie.
  el.fieldTo.classList.toggle('hidden', isReply);
  el.fieldSubject.classList.toggle('hidden', isReply);
  el.quickReplies.classList.toggle('hidden', !isReply);

  el.composer.showModal();
  el.composerBody.focus();
}

function renderQuickReplies() {
  el.quickReplies.replaceChildren(
    ...QUICK_REPLIES.map((text) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = text;
      chip.onclick = () => {
        el.composerBody.value = text;
        el.composerBody.focus();
      };
      return chip;
    }),
  );
}

/** Second gate: shows exactly what will go out before anything leaves the machine. */
function askConfirmation() {
  const body = el.composerBody.value.trim();
  if (!body) return banner('Write a message first.');

  const to = state.replyTo ? state.replyTo.fromEmail : el.composerTo.value.trim();
  if (!to) return banner('Add a recipient first.');

  const subject = el.composerSubject.value.trim() || '(no subject)';

  el.confirmSummary.replaceChildren();
  for (const [label, value] of [['To', to], ['Subject', subject]]) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    el.confirmSummary.append(dt, dd);
  }
  el.confirmPreview.textContent = body;
  el.confirm.showModal();
}

async function send() {
  const body = el.composerBody.value.trim();
  const sendBtn = $('confirm-send');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  try {
    if (state.replyTo) {
      await api('/api/reply', {
        method: 'POST',
        body: JSON.stringify({ messageId: state.replyTo.id, body }),
      });
    } else {
      await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({
          to: el.composerTo.value.trim(),
          subject: el.composerSubject.value.trim(),
          body,
        }),
      });
    }
    el.confirm.close();
    el.composer.close();
    banner('Message sent.', 'ok');
  } catch (err) {
    el.confirm.close();
    banner(err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Yes, send it';
  }
}

// ---- desktop alerts ----

function notifyNewMail(messages) {
  if (!state.alertsOn || Notification.permission !== 'granted') return;

  for (const m of messages.slice(0, 5)) {
    const note = new Notification(displayName(m), {
      body: `${m.subject}\n${m.snippet}`,
      tag: m.id,
    });
    note.onclick = () => {
      window.focus();
      openMessage(m.id);
    };
  }
}

async function toggleAlerts() {
  if (state.alertsOn) {
    state.alertsOn = false;
    localStorage.setItem('alertsOn', 'false');
    return render();
  }

  if (!('Notification' in window)) return banner('This browser has no notification support.');

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();

  if (permission !== 'granted') {
    return banner('Notifications are blocked. Allow them in your browser settings to get alerts.');
  }

  state.alertsOn = true;
  localStorage.setItem('alertsOn', 'true');
  render();
}

// ---- wiring ----

el.refresh.onclick = () => refresh();
el.compose.onclick = () => openComposer(null);
el.notifyToggle.onclick = toggleAlerts;
$('composer-cancel').onclick = () => el.composer.close();
$('composer-send').onclick = askConfirmation;
$('confirm-cancel').onclick = () => el.confirm.close();
$('confirm-send').onclick = send;

el.logout.onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  state.connected = false;
  state.messages = [];
  renderReader(null);
  render();
};

let searchTimer;
el.search.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = el.search.value.trim();
    refresh();
  }, 400);
};

async function init() {
  renderQuickReplies();
  state.alertsOn =
    localStorage.getItem('alertsOn') === 'true' &&
    'Notification' in window &&
    Notification.permission === 'granted';

  if (location.search) {
    const params = new URLSearchParams(location.search);
    if (params.get('error')) banner(`Google sign-in failed: ${params.get('error')}`);
    if (params.get('connected')) banner('Connected.', 'ok');
    history.replaceState({}, '', location.pathname);
  }

  try {
    const status = await api('/api/status');
    state.connected = status.connected;
    state.email = status.email || '';
  } catch (err) {
    banner(err.message);
  }

  render();
  await refresh();

  // Background auto-refresh. Skipped while the tab is hidden — no point burning
  // Gmail quota on a window nobody is looking at.
  setInterval(() => {
    if (!document.hidden) refresh({ quiet: true });
  }, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh({ quiet: true });
  });
}

init();
