const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

const api = {
  async req(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (res.status === 401) { state.me = null; render(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  me() { return this.req('/api/me'); },
  login(password) { return this.req('/api/login', { method: 'POST', body: JSON.stringify({ password }) }); },
  logout() { return this.req('/api/logout', { method: 'POST' }); },
  chats() { return this.req('/api/chats'); },
  messages(chatId, beforeId) {
    const q = new URLSearchParams();
    if (beforeId) q.set('beforeId', beforeId);
    return this.req(`/api/chats/${chatId}/messages${q.toString() ? '?' + q : ''}`);
  },
  send(chatId, text) { return this.req(`/api/chats/${chatId}/send`, { method: 'POST', body: JSON.stringify({ text }) }); },
  markRead(chatId) { return this.req(`/api/chats/${chatId}/read`, { method: 'POST' }); },
  callback(chatId, msgId, data) {
    return this.req(`/api/chats/${chatId}/callback`, { method: 'POST', body: JSON.stringify({ msgId, data }) });
  },
};

const state = {
  me: null,
  chats: [],
  activeChatId: null,
  messagesByChat: {},
  loading: false,
  loginError: null,
  stream: null,
};

const AVATAR_COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#65aadd', '#ee7aae', '#6ec9cb'];
const avatarColor = (id) => AVATAR_COLORS[Math.abs(Number(id)) % AVATAR_COLORS.length];
const chatName = (c) => c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : '') || `#${c.id}`;
const chatInitials = (c) => {
  const name = chatName(c);
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
};

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
};
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();

async function init() {
  try {
    const r = await api.me();
    state.me = r.bot;
    await loadChats();
    openStream();
  } catch {}
  render();
}

async function loadChats() {
  const r = await api.chats();
  state.chats = r.chats;
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  if (!state.messagesByChat[chatId]) {
    state.messagesByChat[chatId] = { messages: [], hasMore: true, loading: false };
    await loadMessages(chatId);
  }
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat && chat.unread_count) {
    chat.unread_count = 0;
    api.markRead(chatId).catch(() => {});
  }
  render();
  scrollToBottom();
}

async function loadMessages(chatId, beforeId) {
  const entry = state.messagesByChat[chatId];
  if (!entry || entry.loading) return;
  entry.loading = true;
  try {
    const r = await api.messages(chatId, beforeId);
    if (r.messages.length < 50) entry.hasMore = false;
    entry.messages = beforeId ? [...r.messages, ...entry.messages] : r.messages;
  } finally {
    entry.loading = false;
  }
}

async function sendMessage(text) {
  if (!state.activeChatId) return;
  const chatId = state.activeChatId;
  try {
    await api.send(chatId, text);
  } catch (e) { alert('Send failed: ' + e.message); }
}

function openStream() {
  if (state.stream) state.stream.close();
  const es = new EventSource('/api/stream');
  state.stream = es;
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'message') handleStreamMessage(data);
      else if (data.type === 'chatRead') handleStreamRead(data);
    } catch {}
  };
  es.onerror = () => {};
}

function handleStreamMessage({ chatId, message }) {
  const entry = state.messagesByChat[chatId];
  if (entry && !entry.messages.find((m) => m.id === message.id)) {
    entry.messages.push(message);
  }
  let chat = state.chats.find((c) => c.id === chatId);
  if (!chat) { loadChats().then(render); return; }
  chat.last_message_id = message.id;
  chat.last_message_date = message.date;
  chat.last_message_text = message.text || `[${message.media_type || 'message'}]`;
  if (!message.is_outgoing && state.activeChatId !== chatId) {
    chat.unread_count = (chat.unread_count || 0) + 1;
  }
  state.chats = [chat, ...state.chats.filter((c) => c.id !== chatId)];
  render();
  if (state.activeChatId === chatId) scrollToBottom();
}

function handleStreamRead({ chatId }) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat) { chat.unread_count = 0; render(); }
}

function scrollToBottom() {
  const list = $('.message-list');
  if (list) list.scrollTop = list.scrollHeight;
}

function renderLogin() {
  const form = el('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault();
    const pwd = form.querySelector('input').value;
    try {
      await api.login(pwd);
      await init();
    } catch (err) {
      state.loginError = err.message === 'unauthorized' ? 'Wrong password' : err.message;
      render();
    }
  }},
    el('h1', {}, 'Bot Panel'),
    el('input', { type: 'password', placeholder: 'Password', autofocus: 'true' }),
    el('button', { type: 'submit' }, 'Sign in'),
    el('div', { class: 'err' }, state.loginError || ''),
  );
  return el('div', { class: 'login-wrap' }, form);
}

function renderChatList() {
  return el('div', { class: 'chat-list' },
    state.chats.length === 0
      ? el('div', { style: 'padding:16px;color:var(--text-muted);font-size:13px' }, 'No chats yet — waiting for bot messages…')
      : state.chats.map((c) => el('div', {
          class: 'chat-item' + (c.id === state.activeChatId ? ' active' : ''),
          onclick: () => openChat(c.id),
        },
          el('div', { class: 'avatar', style: `background:${avatarColor(c.id)}` }, chatInitials(c)),
          el('div', { class: 'chat-info' },
            el('div', { class: 'chat-top' },
              el('div', { class: 'chat-name' }, chatName(c)),
              el('div', { class: 'chat-time' }, fmtTime(c.last_message_date)),
            ),
            el('div', { class: 'chat-bottom' },
              el('div', { class: 'chat-preview' }, c.last_message_text || ''),
              c.unread_count ? el('div', { class: 'chat-badge' }, String(c.unread_count)) : null,
            ),
          ),
        )),
  );
}

async function onCallbackButton(btnEl, m, btn) {
  if (btnEl.dataset.busy) return;
  btnEl.dataset.busy = '1';
  const orig = btnEl.textContent;
  btnEl.textContent = '…';
  try {
    const r = await api.callback(m.chat_id, m.id, btn.data);
    const a = r.answer || {};
    if (a.url) window.open(a.url, '_blank', 'noopener');
    if (a.message) {
      if (a.alert) alert(a.message);
      else showToast(a.message);
    }
  } catch (e) {
    showToast('Callback failed: ' + e.message);
  } finally {
    btnEl.textContent = orig;
    delete btnEl.dataset.busy;
  }
}

function showToast(text) {
  let host = $('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host' });
    document.body.appendChild(host);
  }
  const t = el('div', { class: 'toast' }, text);
  host.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function renderMarkupButton(m, btn) {
  const label = btn.text || '';
  switch (btn.type) {
    case 'url':
    case 'webview':
      return el('a', { class: 'kbd-btn', href: btn.url, target: '_blank', rel: 'noopener' }, label, el('span', { class: 'kbd-ico' }, '↗'));
    case 'callback':
      return el('button', { class: 'kbd-btn', onclick: (e) => onCallbackButton(e.currentTarget, m, btn) }, label);
    case 'switch_inline':
      return el('button', { class: 'kbd-btn', onclick: () => showToast('Switch-inline not supported') }, label);
    default:
      return el('button', { class: 'kbd-btn kbd-btn-disabled', disabled: 'true', title: btn.className || btn.type }, label);
  }
}

function renderInlineKeyboard(m) {
  if (!m.reply_markup) return null;
  let markup;
  try { markup = JSON.parse(m.reply_markup); } catch { return null; }
  if (!markup || markup.kind !== 'inline' || !markup.rows?.length) return null;
  return el('div', { class: 'kbd' },
    ...markup.rows.map((row) =>
      el('div', { class: 'kbd-row' }, ...row.buttons.map((b) => renderMarkupButton(m, b))),
    ),
  );
}

function renderMessage(m, prev) {
  const isOut = !!m.is_outgoing;
  const sameSender = prev && prev.is_outgoing === m.is_outgoing && (m.date - prev.date) < 300;
  const cls = `msg-wrap ${isOut ? 'out' : 'in'}${sameSender ? ' same' : ''}`;
  const bubbleChildren = [];
  if (m.media_type === 'photo' && m.media_file_id) {
    bubbleChildren.push(el('div', { class: 'media' },
      el('img', { src: `/api/file/${m.media_file_id}`, loading: 'lazy' }),
    ));
  } else if (m.media_type) {
    const meta = m.media_meta ? JSON.parse(m.media_meta) : {};
    const label = m.media_type === 'document' ? (meta.name || 'document')
      : m.media_type === 'location' ? `${meta.lat}, ${meta.lon}`
      : m.media_type === 'contact' ? `${meta.firstName || ''} ${meta.phone || ''}`.trim()
      : `[${m.media_type}]`;
    bubbleChildren.push(el('div', { class: 'media-chip' }, `📎 ${label}`));
  }
  if (m.text) bubbleChildren.push(el('div', {}, m.text));
  bubbleChildren.push(el('div', { class: 'meta' }, new Date(m.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));

  const bubble = el('div', { class: `msg ${isOut ? 'out' : 'in'}` }, ...bubbleChildren);
  const kbd = renderInlineKeyboard(m);
  return el('div', { class: cls }, bubble, kbd);
}

function renderMessages(chatId) {
  const entry = state.messagesByChat[chatId];
  if (!entry) return el('div', { class: 'empty-state' }, 'Loading…');
  const items = [];
  if (entry.hasMore && entry.messages.length) {
    items.push(el('div', { class: 'load-more', onclick: async () => {
      await loadMessages(chatId, entry.messages[0].id);
      render();
    }}, entry.loading ? 'Loading…' : 'Load older'));
  }
  let prev = null;
  for (const m of entry.messages) {
    if (!prev || !sameDay(prev.date, m.date)) items.push(el('div', { class: 'day-sep' }, fmtDay(m.date)));
    items.push(renderMessage(m, prev));
    prev = m;
  }
  if (entry.messages.length === 0) items.push(el('div', { class: 'empty-state' }, 'No messages yet'));
  return el('div', { class: 'message-list', dataset: { chatId: String(chatId) } }, ...items);
}

function renderMain() {
  if (!state.activeChatId) return el('div', { class: 'main' }, el('div', { class: 'empty-state' }, 'Select a chat to view the conversation'));
  const chat = state.chats.find((c) => c.id === state.activeChatId);
  if (!chat) return el('div', { class: 'main' }, el('div', { class: 'empty-state' }, 'Chat not found'));

  const textarea = el('textarea', { placeholder: 'Write a message…', rows: '1',
    oninput: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = e.target.value.trim();
        if (text) { e.target.value = ''; e.target.style.height = 'auto'; sendMessage(text); }
      }
    },
  });
  const sendBtn = el('button', { title: 'Send', onclick: () => {
    const text = textarea.value.trim();
    if (text) { textarea.value = ''; textarea.style.height = 'auto'; sendMessage(text); }
  }}, '➤');

  return el('div', { class: 'main' },
    el('div', { class: 'main-header' },
      el('div', { class: 'avatar', style: `background:${avatarColor(chat.id)}` }, chatInitials(chat)),
      el('div', {},
        el('div', { class: 'name' }, chatName(chat)),
        el('div', { class: 'sub' }, chat.type === 'private' ? (chat.username ? '@' + chat.username : 'user') : chat.type),
      ),
    ),
    renderMessages(state.activeChatId),
    el('div', { class: 'composer' }, textarea, sendBtn),
  );
}

function renderApp() {
  return el('div', { class: 'app' },
    el('div', { class: 'sidebar' },
      el('div', { class: 'sidebar-header' },
        el('div', {},
          el('div', { class: 'bot-name' }, state.me ? '@' + state.me.username : 'Bot Panel'),
          el('div', { class: 'bot-sub' }, 'inbox'),
        ),
        el('button', { onclick: async () => { await api.logout(); location.reload(); } }, 'Log out'),
      ),
      renderChatList(),
    ),
    renderMain(),
  );
}

function render() {
  const root = $('#root');
  const list = $('.message-list');
  let snapshot = null;
  if (list) {
    snapshot = {
      top: list.scrollTop,
      height: list.scrollHeight,
      atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 80,
      chatId: list.dataset.chatId ? Number(list.dataset.chatId) : null,
    };
  }
  root.innerHTML = '';
  root.appendChild(state.me ? renderApp() : renderLogin());
  const newList = $('.message-list');
  if (newList) {
    const sameChat = snapshot && snapshot.chatId === state.activeChatId;
    if (!sameChat) {
      newList.scrollTop = newList.scrollHeight;
    } else if (snapshot.atBottom) {
      newList.scrollTop = newList.scrollHeight;
    } else {
      const delta = newList.scrollHeight - snapshot.height;
      newList.scrollTop = snapshot.top + delta;
    }
  }
}

init();
