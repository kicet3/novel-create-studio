/**
 * Telegram ChannelAdapter pieces (05 §9.2): Bot API calls over a TelegramTransport, update parsing,
 * inline keyboards (callback_data ≤ 64 bytes), ForceReply, HTML formatting of the Markdown subset.
 */
import type { TelegramTransport } from "../../index.js";
import type { NormalizedInbound, RenderedMessage, TelegramClient } from "../../application/ports.js";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Markdown subset (bold, lists, quotes) → Telegram HTML. */
export function toTelegramHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .split("\n")
    .map((line) => (line.startsWith("&gt; ") ? `<i>${line.slice(5)}</i>` : line))
    .join("\n");
}

function chatType(t: string | undefined): NormalizedInbound["chatType"] {
  if (!t) return null;
  if (t === "private") return "private";
  if (t === "group" || t === "supergroup" || t === "channel") return "group";
  return "other";
}

export function parseTelegramUpdate(raw: unknown): NormalizedInbound | null {
  const u = raw as TgUpdate;
  if (!u || typeof u.update_id !== "number") return null;
  const base = { providerEventId: String(u.update_id) };
  if (u.callback_query) {
    const cq = u.callback_query;
    return {
      ...base,
      eventKind: "callback",
      chatRef: cq.message ? String(cq.message.chat.id) : null,
      chatType: chatType(cq.message?.chat.type),
      senderRef: String(cq.from.id),
      senderLabel: cq.from.username ? `@${cq.from.username}` : (cq.from.first_name ?? null),
      text: null,
      callbackId: cq.id,
      callbackData: cq.data ?? null,
      messageRef: cq.message ? String(cq.message.message_id) : null,
      replyToRef: null,
      edited: false,
    };
  }
  const m = u.message ?? u.edited_message;
  if (!m) return { ...base, eventKind: "system", chatRef: null, chatType: null, senderRef: null, senderLabel: null, text: null, callbackId: null, callbackData: null, messageRef: null, replyToRef: null, edited: false };
  const text = m.text ?? null;
  return {
    ...base,
    eventKind: text?.startsWith("/") ? "command" : "message",
    chatRef: String(m.chat.id),
    chatType: chatType(m.chat.type),
    senderRef: m.from ? String(m.from.id) : null,
    senderLabel: m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? null),
    text,
    callbackId: null,
    callbackData: null,
    messageRef: String(m.message_id),
    replyToRef: m.reply_to_message ? String(m.reply_to_message.message_id) : null,
    edited: !u.message && !!u.edited_message,
  };
}

function replyMarkup(msg: RenderedMessage): Record<string, unknown> | undefined {
  if (msg.forceReply) return { force_reply: true, selective: true };
  if (!msg.buttons.length) return undefined;
  return { inline_keyboard: msg.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) };
}

export function createTelegramClient(transport: TelegramTransport): TelegramClient {
  return {
    async getUpdates({ offset, timeoutSec }, signal) {
      const params: Record<string, unknown> = { timeout: timeoutSec, allowed_updates: ["message", "callback_query", "edited_message"] };
      if (offset !== null) params.offset = offset;
      return transport.call<unknown[]>("getUpdates", params, { signal, timeoutMs: (timeoutSec + 10) * 1000 });
    },
    parseUpdate: parseTelegramUpdate,
    updateId: (raw) => {
      const id = (raw as TgUpdate | null)?.update_id;
      return typeof id === "number" ? id : null;
    },
    async send(chatRef, msg) {
      const params: Record<string, unknown> = { chat_id: chatRef, text: toTelegramHtml(msg.text), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
      const markup = replyMarkup(msg);
      if (markup) params.reply_markup = markup;
      if (msg.replyToRef) params.reply_parameters = { message_id: Number(msg.replyToRef), allow_sending_without_reply: true };
      const r = await transport.call<{ message_id: number }>("sendMessage", params);
      return { messageRef: String(r.message_id) };
    },
    async edit(chatRef, messageRef, msg) {
      const params: Record<string, unknown> = { chat_id: chatRef, message_id: Number(messageRef), text: toTelegramHtml(msg.text), parse_mode: "HTML" };
      params.reply_markup = msg.buttons.length ? replyMarkup(msg) : { inline_keyboard: [] };
      await transport.call("editMessageText", params);
    },
    async ack(callbackId, text) {
      await transport.call("answerCallbackQuery", text ? { callback_query_id: callbackId, text } : { callback_query_id: callbackId });
    },
    async getMe() {
      const r = await transport.call<{ id: number; username?: string }>("getMe", {});
      return { id: String(r.id), username: r.username ?? null };
    },
    async getChat(chatRef) {
      const r = await transport.call<{ id: number; type: string }>("getChat", { chat_id: chatRef });
      return { id: String(r.id), type: r.type };
    },
    async getWebhookUrl() {
      const r = await transport.call<{ url?: string }>("getWebhookInfo", {});
      return r.url ?? "";
    },
    async deleteWebhook() {
      await transport.call("deleteWebhook", { drop_pending_updates: false });
    },
  };
}
