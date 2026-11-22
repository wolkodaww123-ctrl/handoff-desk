// Visitor chat widget: the visitor talks to the AI support bot. When a team member takes over
// from the desk, the AI stops and a person answers in the same Nexconn channel.
import { BOT_ID, connect, sendText, sendTyping, loadHistory, readMeta, textOf, esc, time } from './common.js';

const $ = (s) => document.querySelector(s);
const log = $('#log');
const form = $('#form');
const input = $('#input');
const statusEl = $('#status');
const modeEl = $('#mode');
const typingEl = $('#typing');

let session = null;   // { appKey, token, userId, sig }
let humanMode = false; // true while a team member has taken over
let typingTimer = null;
const seen = new Set();

function setMode(on) {
  humanMode = on;
  modeEl.textContent = on ? 'A team member is answering' : 'AI assistant is answering';
  modeEl.className = 'mode ' + (on ? 'human' : 'ai');
}

function render(msg) {
  if (msg.messageId && seen.has(msg.messageId)) return;
  if (msg.messageId) seen.add(msg.messageId);
  const meta = readMeta(msg);
  if (meta.handoff === 'on') setMode(true);
  if (meta.handoff === 'off') setMode(false);
  const mine = msg.senderUserId === session.userId;
  const who = mine ? 'You' : meta.by === 'human' ? (meta.name || 'Team') : meta.by === 'system' ? '' : 'AI assistant';
  const el = document.createElement('div');
  el.className = 'msg ' + (mine ? 'me' : meta.by === 'system' ? 'sys' : meta.by === 'human' ? 'human' : 'ai');
  el.innerHTML = (who ? `<div class="who">${esc(who)} · ${time(msg.sentTime)}</div>` : '') + `<div class="bubble">${esc(textOf(msg))}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function recentContext(limit = 8) {
  // Last few lines for the AI, read from what is on screen.
  return [...log.querySelectorAll('.msg:not(.sys)')].slice(-limit).map((el) => ({
    role: el.classList.contains('me') ? 'user' : 'assistant',
    text: el.querySelector('.bubble').textContent,
  }));
}

async function askBot(text) {
  typingEl.textContent = 'AI assistant is typing…';
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: session.userId, sig: session.sig, text, context: recentContext() }),
    });
    if (!r.ok) throw new Error(await r.text());
    // The reply arrives through Nexconn (server -> Platform Chat API -> this client).
  } catch (e) {
    typingEl.textContent = 'The AI assistant could not answer right now. Press "Talk to a person".';
    return;
  }
  setTimeout(() => { if (typingEl.textContent.startsWith('AI assistant')) typingEl.textContent = ''; }, 8000);
}

async function start() {
  statusEl.textContent = 'connecting…';
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('handoff-desk-session') || 'null'); } catch (_) {}
  const r = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(stored ? { userId: stored.userId, sig: stored.sig } : {}),
  });
  if (!r.ok) { statusEl.textContent = 'server error'; return; }
  session = await r.json();
  localStorage.setItem('handoff-desk-session', JSON.stringify({ userId: session.userId, sig: session.sig }));

  await connect({
    appKey: session.appKey,
    token: session.token,
    onStatus: (s) => { statusEl.textContent = s; },
    onMessages: (msgs) => msgs
      .filter((m) => m.channelIdentifier && m.channelIdentifier.channelId === BOT_ID)
      .forEach((m) => { typingEl.textContent = ''; render(m); }),
    onTyping: (ch, list) => {
      if (ch.channelId !== BOT_ID) return;
      typingEl.textContent = list.length ? (humanMode ? 'Team member is typing…' : 'AI assistant is typing…') : '';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typingEl.textContent = ''; }, 6000);
    },
  });

  const history = await loadHistory(BOT_ID);
  history.forEach(render);
  if (!history.length) {
    // First visit: ask the server to send the bot's greeting through Nexconn.
    await fetch('/api/greet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: session.userId, sig: session.sig }) });
  }
  input.disabled = false;
  input.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !session) return;
  input.value = '';
  const sent = await sendText(BOT_ID, text, { by: 'visitor' });
  render(sent);
  if (!humanMode) askBot(text);
});

let lastTyping = 0;
input.addEventListener('input', () => {
  if (Date.now() - lastTyping > 3000 && session) { lastTyping = Date.now(); sendTyping(BOT_ID); }
});

$('#human').addEventListener('click', async () => {
  if (!session) return;
  const sent = await sendText(BOT_ID, 'I would like to talk to a person, please.', { by: 'visitor', handoff: 'request' });
  render(sent);
  typingEl.textContent = 'We let the team know. A person will join this chat.';
});

setMode(false);
start().catch((e) => { statusEl.textContent = 'error'; console.error(e); });
