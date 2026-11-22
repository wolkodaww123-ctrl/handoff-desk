// HandoffDesk – Cloudflare Worker (app server).
// - Issues Nexconn access tokens (Platform Chat API, signed with the App Secret, server-side only).
// - Generates the AI support bot's reply (Workers AI) and delivers it into the visitor's Nexconn direct
//   channel with the Platform Chat API, echoed to the "support_bot" account so the staff desk sees it.
// - Serves the static visitor widget and staff desk (bundled by scripts/build.mjs into ./assets.js).
import { ASSETS } from './assets.js';

const BOT_ID = 'support_bot';
const BOT_NAME = 'AI assistant';
// Tried in order; Workers AI retires models over time, so keep a short fallback chain.
const AI_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'];

const BUSINESS = `Brightsmile Dental is a FICTIONAL demo dental clinic used to show this app.
Services: check-ups and cleaning, fillings, whitening, braces consultations, emergency appointments.
Opening hours: Monday to Friday 9:00-19:00, Saturday 10:00-15:00, closed Sunday.
Example prices (demo): check-up with cleaning $80, whitening from $250. Exact treatment prices are confirmed by the clinic team after an exam.
Before a visit: bring a photo ID and your insurance card if you have one, and arrive 10 minutes early. Free parking behind the building (demo).
Appointments are booked by the clinic team; the assistant collects the preferred day and time and offers to bring in a person.`;

const SYSTEM_PROMPT = `You are the AI support assistant in the website chat of the business described below. You are an AI, never claim to be human.
${BUSINESS}
Rules: use only the facts above; if you do not know something, say so and suggest pressing "Talk to a person" so a team member joins this same chat. Never give medical diagnoses. Never ask for passwords, card numbers or one-time codes. If asked, say this is a demo and the clinic is fictional.
Style: reply in the visitor's language, 1-3 short sentences, plain text, no markdown. End with one simple question when it helps.`;

const GREETING = "Hi! I'm the AI assistant of Brightsmile Dental (a demo clinic). I can help with services, prices and opening hours, and a person from the team can join this chat whenever you like. How can I help?";

const enc = new TextEncoder();

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha1Hex(s) {
  const d = await crypto.subtle.digest('SHA-1', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

// Signed call to the Nexconn Platform Chat API with primary/backup domain failover.
async function nexconn(env, path, body) {
  const domains = [env.NEXCONN_API_DOMAIN || 'api.sg-light-api.com', env.NEXCONN_API_DOMAIN_BACKUP || 'api-b.sg-light-api.com'];
  let lastErr;
  for (const host of domains) {
    const nonce = String(Math.floor(Math.random() * 1e12));
    const ts = String(Date.now());
    try {
      const r = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: {
          'App-Key': env.NEXCONN_APP_KEY,
          Nonce: nonce,
          Timestamp: ts,
          Signature: await sha1Hex(env.NEXCONN_APP_SECRET + nonce + ts),
          'X-Request-ID': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.code === 0) return data;
      lastErr = new Error(`Nexconn ${path} -> HTTP ${r.status} code ${data.code}`);
      if (r.status < 500) break; // business error: do not retry on the backup domain
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function issueToken(env, userId, name) {
  const data = await nexconn(env, '/v4/auth/access-token/issue', { userId, name });
  return data.result.accessToken;
}

async function sendAsBot(env, toUserId, text, meta) {
  return nexconn(env, '/v4/direct-channel/message/send', {
    fromUserId: BOT_ID,
    toUserIds: [toUserId],
    messageType: 'RC:TxtMsg',
    content: JSON.stringify({ content: text, extra: JSON.stringify(meta) }),
    isEchoToSender: 1, // the staff desk (signed in as "support_bot") sees the AI answers too
  });
}

async function checkVisitor(env, body) {
  const userId = String(body.userId || '');
  if (!/^visitor_[a-z0-9]{6,20}$/.test(userId)) return null;
  const sig = await hmacHex(env.NEXCONN_APP_SECRET, 'visitor:' + userId);
  return sig === body.sig ? userId : null;
}

async function aiReply(env, text, context) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of (Array.isArray(context) ? context : []).slice(-8)) {
    if (m && typeof m.text === 'string') messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text.slice(0, 1000) });
  }
  if (!messages.length || messages[messages.length - 1].content !== text) messages.push({ role: 'user', content: text });
  let reply = '';
  let lastErr;
  for (const model of AI_MODELS) {
    try {
      const out = await env.AI.run(model, { messages, max_tokens: 220 });
      const r = out && (typeof out.response === 'string' ? out.response : out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content);
      reply = String(r || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (reply) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!reply && lastErr) throw lastErr;
  return reply || "Sorry, I didn't catch that. Could you say it another way, or press \"Talk to a person\"?";
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error(String(e && e.message || e));
      return json({ error: 'upstream error', detail: String((e && e.message) || e).slice(0, 200) }, 502);
    }
  },
};

async function handle(request, env) {
  {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/api/session') {
      const body = await request.json().catch(() => ({}));
      let userId = await checkVisitor(env, body);
      if (!userId) userId = 'visitor_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      const [token, sig] = await Promise.all([
        issueToken(env, userId, 'Visitor ' + userId.slice(8, 12)),
        hmacHex(env.NEXCONN_APP_SECRET, 'visitor:' + userId),
        issueToken(env, BOT_ID, BOT_NAME), // keeps the bot account registered
      ]);
      return json({ appKey: env.NEXCONN_APP_KEY, token, userId, sig });
    }

    if (request.method === 'POST' && path === '/api/greet') {
      const body = await request.json().catch(() => ({}));
      const userId = await checkVisitor(env, body);
      if (!userId) return json({ error: 'bad session' }, 403);
      await sendAsBot(env, userId, GREETING, { by: 'ai' });
      return json({ ok: true });
    }

    if (request.method === 'POST' && path === '/api/ask') {
      const body = await request.json().catch(() => ({}));
      const userId = await checkVisitor(env, body);
      if (!userId) return json({ error: 'bad session' }, 403);
      const text = String(body.text || '').slice(0, 1500);
      if (!text) return json({ error: 'empty' }, 400);
      const reply = await aiReply(env, text, body.context);
      await sendAsBot(env, userId, reply, { by: 'ai' });
      return json({ ok: true });
    }

    if (request.method === 'POST' && path === '/api/desk/session') {
      const body = await request.json().catch(() => ({}));
      if (!env.DESK_PIN || String(body.pin || '') !== env.DESK_PIN) return json({ error: 'wrong pin' }, 403);
      const token = await issueToken(env, BOT_ID, BOT_NAME);
      return json({ appKey: env.NEXCONN_APP_KEY, token, userId: BOT_ID });
    }

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/healthz') return json({ ok: true, appKeySet: !!env.NEXCONN_APP_KEY, secretSet: !!env.NEXCONN_APP_SECRET, ai: !!env.AI });

    const key = path === '/' ? '/index.html' : path === '/desk' ? '/desk.html' : path;
    const asset = ASSETS[key];
    if (asset && request.method === 'GET') {
      return new Response(asset.body, { headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=300' } });
    }
    return new Response('Not found', { status: 404 });
  }
}
