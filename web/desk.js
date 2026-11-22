// Staff desk: a team member signs in with the desk PIN and joins as the "support_bot" account
// on another device (Nexconn multi-device sync). They see every visitor conversation live,
// including the AI answers, and can take over or hand back to the AI at any moment.
import { connect, sendText, sendTyping, loadHistory, loadDirectChannels, archiveChat, readMeta, textOf, esc, time } from './common.js';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const logEl = $('#log');
const form = $('#form');
const input = $('#input');
const statusEl = $('#status');
const titleEl = $('#title');
const takeBtn = $('#take');
const typingEl = $('#typing');
const archiveBtn = $('#archive');

const convs = new Map(); // visitorId -> { msgs: [], unread, human, wantsHuman, last }
let current = null;
let staffName = 'Support team';
let typingTimer = null;
// Inbox shows chats active in the last 3 hours (or since ?since=<ms timestamp>); archived chats stay
// hidden in this browser until the visitor writes again.
const SINCE = Number(new URLSearchParams(location.search).get('since')) || Date.now() - 3 * 3600 * 1000;
const archived = JSON.parse(localStorage.getItem('handoff-desk-archived') || '{}');

function conv(id) {
  if (!convs.has(id)) convs.set(id, { msgs: [], ids: new Set(), unread: 0, human: false, wantsHuman: false, last: 0 });
  return convs.get(id);
}

function add(id, msg, live) {
  const c = conv(id);
  if (msg.messageId && c.ids.has(msg.messageId)) return;
  if (msg.messageId) c.ids.add(msg.messageId);
  c.msgs.push(msg);
  c.msgs.sort((a, b) => a.sentTime - b.sentTime);
  c.last = Math.max(c.last, msg.sentTime || Date.now());
  const meta = readMeta(msg);
  if (meta.handoff === 'request') c.wantsHuman = true;
  if (meta.handoff === 'on') { c.human = true; c.wantsHuman = false; }
  if (meta.handoff === 'off') c.human = false;
  if (live && id !== current) c.unread++;
}

function renderList() {
  const items = [...convs.entries()].sort((a, b) => b[1].last - a[1].last);
  listEl.innerHTML = items.map(([id, c]) => {
    const lastMsg = c.msgs[c.msgs.length - 1];
    const badge = c.wantsHuman ? '<span class="tag want">wants a person</span>' : c.human ? '<span class="tag human">you</span>' : '<span class="tag ai">AI</span>';
    return `<button class="conv ${id === current ? 'active' : ''}" data-id="${esc(id)}">
      <div class="row"><b>${esc(id.replace('visitor_', 'Visitor '))}</b>${badge}${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
      <div class="preview">${esc(lastMsg ? textOf(lastMsg).slice(0, 60) : '')}</div></button>`;
  }).join('') || '<p class="empty">No conversations yet. Open the visitor page in another tab and say hi.</p>';
  listEl.querySelectorAll('.conv').forEach((b) => b.addEventListener('click', () => open(b.dataset.id)));
}

function renderLog() {
  if (!current) { logEl.innerHTML = ''; return; }
  const c = conv(current);
  logEl.innerHTML = c.msgs.map((m) => {
    const meta = readMeta(m);
    const fromVisitor = m.senderUserId === current;
    const cls = fromVisitor ? 'visitor' : meta.by === 'human' ? 'human' : meta.by === 'system' ? 'sys' : 'ai';
    const who = fromVisitor ? 'Visitor' : meta.by === 'human' ? (meta.name || 'Team') : meta.by === 'system' ? 'System' : 'AI assistant';
    return `<div class="msg ${cls}"><div class="who">${esc(who)} · ${time(m.sentTime)}</div><div class="bubble">${esc(textOf(m))}</div></div>`;
  }).join('');
  logEl.scrollTop = logEl.scrollHeight;
  titleEl.textContent = current.replace('visitor_', 'Visitor ');
  takeBtn.disabled = false;
  archiveBtn.disabled = false;
  takeBtn.textContent = c.human ? 'Hand back to AI' : 'Take over from AI';
  input.disabled = !c.human;
  input.placeholder = c.human ? 'Reply as ' + staffName : 'Take over to reply yourself';
}

async function open(id) {
  current = id;
  const c = conv(id);
  c.unread = 0;
  if (!c.loaded) {
    c.loaded = true;
    (await loadHistory(id)).forEach((m) => add(id, m, false));
  }
  renderList();
  renderLog();
}

async function signIn(pin, name) {
  const r = await fetch('/api/desk/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!r.ok) throw new Error('Wrong PIN');
  const s = await r.json();
  staffName = name || 'Support team';
  await connect({
    appKey: s.appKey,
    token: s.token,
    onStatus: (st) => { statusEl.textContent = st; },
    onMessages: (msgs) => {
      msgs.forEach((m) => {
        const id = m.channelIdentifier && m.channelIdentifier.channelId;
        if (!id || !id.startsWith('visitor_')) return;
        // Offline sync on connect replays older messages; keep the inbox to recent, non-archived chats.
        if (!convs.has(id) && ((m.sentTime || 0) < SINCE || (m.sentTime || 0) <= (archived[id] || 0))) return;
        add(id, m, true);
        if (id === current) typingEl.textContent = '';
      });
      renderList();
      renderLog();
    },
    onTyping: (ch, list) => {
      if (ch.channelId !== current) return;
      typingEl.textContent = list.length ? 'Visitor is typing…' : '';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typingEl.textContent = ''; }, 6000);
    },
  });
  const channels = await loadDirectChannels();
  for (const ch of channels) {
    if (!ch.channelId.startsWith('visitor_')) continue;
    const lastTs = ch.latestMessage ? ch.latestMessage.sentTime : 0;
    if (lastTs < SINCE || lastTs <= (archived[ch.channelId] || 0)) continue;
    const c = conv(ch.channelId);
    if (ch.latestMessage) add(ch.channelId, ch.latestMessage, false);
    c.unread = ch.unreadCount || 0;
  }
  renderList();
}

archiveBtn.addEventListener('click', async () => {
  if (!current) return;
  const id = current;
  archived[id] = Date.now();
  localStorage.setItem('handoff-desk-archived', JSON.stringify(archived));
  await archiveChat(id);
  {
    convs.delete(id);
    current = null;
    titleEl.textContent = 'Pick a conversation';
    takeBtn.disabled = true; archiveBtn.disabled = true; input.disabled = true;
    renderList(); renderLog();
  }
});

takeBtn.addEventListener('click', async () => {
  if (!current) return;
  const c = conv(current);
  const on = !c.human;
  const text = on
    ? `${staffName} from the team joined the chat. The AI assistant is paused.`
    : `${staffName} handed the chat back to the AI assistant.`;
  const sent = await sendText(current, text, { by: 'system', handoff: on ? 'on' : 'off' });
  add(current, sent, false);
  renderList();
  renderLog();
  if (on) input.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = '';
  const sent = await sendText(current, text, { by: 'human', name: staffName });
  add(current, sent, false);
  renderList();
  renderLog();
});

let lastTyping = 0;
input.addEventListener('input', () => {
  if (current && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); sendTyping(current); }
});

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#err');
  err.textContent = '';
  try {
    await signIn($('#pin').value.trim(), $('#name').value.trim());
    $('#gate').hidden = true;
    $('#app').hidden = false;
  } catch (x) {
    err.textContent = x.message || 'Sign-in failed';
  }
});
