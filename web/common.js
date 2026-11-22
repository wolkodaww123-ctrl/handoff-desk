// Shared helpers for the visitor widget and the staff desk.
// Everything that travels between people goes through Nexconn (Chat SDK on the client,
// Platform Chat API on the server). This file only wraps the SDK calls we use.
import {
  NCEngine,
  AreaCode,
  ConnectionStatusHandler,
  ConnectionStatus,
  MessageHandler,
  ChannelHandler,
  DirectChannel,
  BaseChannel,
  ChannelType,
  SendTextMessageParams,
} from '@nexconn/chat';

export const BOT_ID = 'support_bot';

// Meta we attach to every text message in the `extra` field of RC:TxtMsg.
// by: "visitor" | "ai" | "human" | "system"; handoff: "request" | "on" | "off"
export function readMeta(msg) {
  try {
    const raw = msg && msg.content && msg.content.extra;
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

export function textOf(msg) {
  const c = (msg && msg.content) || {};
  return c.text || c.content || '';
}

export async function connect({ appKey, token, onStatus, onMessages, onTyping }) {
  NCEngine.initialize({ appKey, areaCode: AreaCode.SG });
  NCEngine.addConnectionStatusHandler('handoff-desk-status', new ConnectionStatusHandler({
    onConnectionStatusChanged({ status }) {
      const label =
        status === ConnectionStatus.CONNECTED ? 'connected' :
        status === ConnectionStatus.CONNECTING ? 'connecting' :
        status === ConnectionStatus.SUSPENDED ? 'reconnecting' : 'offline';
      onStatus && onStatus(label);
    },
  }));
  NCEngine.addMessageHandler('handoff-desk-messages', new MessageHandler({
    onMessageReceived({ messages }) { onMessages && onMessages(messages); },
  }));
  NCEngine.addChannelHandler('handoff-desk-typing', new ChannelHandler({
    onTypingStatusChanged({ channelIdentifier, userTypingStatus }) {
      onTyping && onTyping(channelIdentifier, userTypingStatus || []);
    },
  }));
  const res = await NCEngine.connect({ token });
  if (!res.isOk && res.code !== 0) throw new Error('Nexconn connect failed, code ' + res.code);
  return res.data && res.data.userId;
}

export async function sendText(targetUserId, text, meta) {
  const channel = new DirectChannel(targetUserId);
  const content = { text };
  if (meta) content.extra = JSON.stringify(meta);
  const res = await channel.sendMessage(new SendTextMessageParams(content));
  if (res.code !== 0) throw new Error('Nexconn send failed, code ' + res.code);
  return res.data;
}

export async function sendTyping(targetUserId) {
  try { await new DirectChannel(targetUserId).sendTypingStatus('RC:TxtMsg'); } catch (_) {}
}

export async function loadHistory(targetUserId, pageSize = 50) {
  const channel = new DirectChannel(targetUserId);
  const query = BaseChannel.createMessagesQuery({
    channelIdentifier: channel.identifier,
    startTime: Date.now(),
    pageSize,
    isAscending: false,
  });
  const res = await query.loadNextPage();
  if (res.code !== 0 || !res.data) return [];
  return res.data.data.slice().sort((a, b) => a.sentTime - b.sentTime);
}

export async function loadDirectChannels(pageSize = 50) {
  const query = BaseChannel.createChannelsQuery({ pageSize, channelTypes: [ChannelType.DIRECT] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await query.loadNextPage();
    if (res.code === 0 && res.data) return res.data.data;
    await new Promise((r) => setTimeout(r, 1500)); // first call right after connect can return "not synced"
  }
  return [];
}

export async function archiveChat(targetUserId) {
  // Removes the conversation from this account's channel list (messages stay in history).
  const res = await BaseChannel.deleteChannels([new DirectChannel(targetUserId).identifier]);
  return res.code === 0;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function time(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
