# HandoffDesk

**AI support chat for small-business websites, with human takeover in the same conversation. Built on the Nexconn Chat SDK.**

Live demo: **https://desk.titanhold.app/** (visitor) · **https://desk.titanhold.app/desk** (staff desk; the PIN for judges is in the write-up)

The demo runs for a fictional clinic, "Brightsmile Dental". The business profile is one text block in `src/worker.js`, so any shop, clinic or service business can swap in its own.

## The problem

Small businesses add an AI chat so visitors get answers at any hour. When a visitor needs a person (an exact quote, a complaint, an unusual request), most AI chats loop or send them to email, and the context is lost.

## What HandoffDesk does

Everything stays in **one Nexconn conversation**:

1. The visitor chats with the **AI assistant** in a web widget.
2. Every message, from the visitor or the AI, travels through Nexconn. The visitor uses the Web Chat SDK; the AI's answers are posted with the Platform Chat API.
3. A team member opens the **staff desk** and sees all live conversations, including the AI's answers, unread counts, typing indicators and who asked for a person.
4. **Take over from AI** puts the person in the same chat and pauses the AI. **Hand back to AI** resumes it. The visitor never changes app, page or channel.

## Where the Nexconn SDK is used

| Feature | Nexconn API | Where |
| --- | --- | --- |
| Init + connect with an App Key and per-user access token, connection status | `NCEngine.initialize`, `NCEngine.connect`, `ConnectionStatusHandler` | `web/common.js` → `connect()` |
| 1:1 messaging visitor ↔ support bot | `DirectChannel.sendMessage(SendTextMessageParams)` | `web/common.js` → `sendText()` |
| Real-time receive | `NCEngine.addMessageHandler(MessageHandler)` | `web/common.js`, used by both clients |
| Typing indicators, both directions | `DirectChannel.sendTypingStatus`, `ChannelHandler.onTypingStatusChanged` | `web/common.js` |
| Conversation history after reload | `BaseChannel.createMessagesQuery(...).loadNextPage()` | `web/common.js` → `loadHistory()` |
| Staff inbox of all visitor chats | `BaseChannel.createChannelsQuery({channelTypes:[DIRECT]})`, `latestMessage`, `unreadCount` | `web/desk.js` |
| Staff on a second device as the same account | Nexconn multi-device message sync | `web/desk.js` |
| Handoff state carried inside the chat | `extra` field of `RC:TxtMsg` (`{"by":"ai"/"human"/"visitor","handoff":"request"/"on"/"off"}`) | both clients |
| Server-issued access tokens | Platform Chat API `POST /v4/auth/access-token/issue` (SHA1-signed, App Secret only on the server) | `src/worker.js` |
| AI answers delivered into the chat | Platform Chat API `POST /v4/direct-channel/message/send` with `isEchoToSender=1`, so the desk sees them | `src/worker.js` |

The handoff needs no database: **the handoff state lives in the Nexconn messages themselves**, and both the widget and the desk rebuild it from channel history.

## Architecture

```
Visitor browser ──Chat SDK──►  Nexconn  ◄──Chat SDK── Staff desk (signed in as "support_bot", 2nd device)
       │                          ▲
       │ /api/ask                 │ Platform Chat API (signed)
       ▼                          │
Cloudflare Worker (src/worker.js) ─┘  – issues tokens, runs the AI model, posts the bot's replies
```

- App server: a single Cloudflare Worker that serves the static files, issues Nexconn tokens and calls the AI.
- AI model: Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` (with fallbacks)). The prompt keeps the bot to the business facts, makes it say it is an AI, and has it offer a person when it doesn't know.
- Security: the App Secret never reaches the browser. Visitor sessions are HMAC-signed, so one visitor can't trigger answers in another visitor's chat. The desk is behind a PIN.

## Run it yourself

1. Create a free Nexconn account and an app (Singapore data center) in the [Nexconn Console](https://console.nexconn.ai), and copy the App Key and App Secret.
2. `npm install && npm run build`
3. Local smoke test (stub AI): `NEXCONN_APP_KEY=... NEXCONN_APP_SECRET=... DESK_PIN=1234 node scripts/local-server.mjs`, then open http://localhost:8788 and http://localhost:8788/desk.
4. Deploy to Cloudflare: `npx wrangler secret put NEXCONN_APP_KEY`, then the same for `NEXCONN_APP_SECRET` and `DESK_PIN`, then `npm run deploy`.

## Files

- `web/index.html`, `web/visitor.js`: visitor widget
- `web/desk.html`, `web/desk.js`: staff desk
- `web/common.js`: all Nexconn Chat SDK calls
- `src/worker.js`: app server (tokens, AI, Platform Chat API, business profile)
- `scripts/build.mjs`: bundles the clients and embeds them into the Worker

## About

Built by TITANHOLD LLC (Wyoming, USA) for the Nexconn Build Challenge 2026. All code in this repository was written for the challenge. License: MIT.
