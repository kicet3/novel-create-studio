/**
 * Discord ChannelAdapter pieces (DM only): REST calls over a DiscordTransport, Gateway event parsing,
 * message components (buttons, custom_id = the channel-neutral callback payload `v1|…`), 2000-char splitting.
 * Discord renders the Markdown subset (`**bold**`, `> quote`, lists) natively, so text is sent as-is with
 * mentions disabled (`allowed_mentions.parse = []`).
 */
import type { DiscordTransport } from "../../index.js";
import { DiscordApiError, type DiscordClient, type NormalizedInbound, type RenderedMessage } from "../../application/ports.js";

export const DISCORD_MAX_CHARS = 2000;
const MAX_ROWS = 5;
const MAX_PER_ROW = 5;
const LABEL_MAX = 80;
const CUSTOM_ID_MAX = 100;
/** internal wait for a 429 in the middle of a split message (keeps the chunk sequence intact) */
const MID_MESSAGE_RETRY_MAX_SEC = 5;

interface DcUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}
interface DcMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DcUser;
  content?: string;
  message_reference?: { message_id?: string };
  type?: number;
}
interface DcInteraction {
  id: string;
  type: number;
  channel_id?: string;
  channel?: { id: string; type?: number };
  guild_id?: string;
  user?: DcUser;
  member?: { user?: DcUser };
  message?: { id: string };
  data?: { custom_id?: string; component_type?: number };
}
/** stored inbox payload: the Gateway dispatch `{ t, d }` (interaction token stripped) */
export interface DiscordEventPayload {
  t: string;
  d: unknown;
}

const labelOf = (u: DcUser | undefined): string | null => (u ? (u.global_name ?? u.username ?? null) : null);

const empty = { text: null, callbackId: null, callbackData: null, messageRef: null, replyToRef: null, edited: false } as const;

/**
 * `!help` → `/help`; bare `start <code>` / `연결 <code>` → `/start <code>` (Discord has no deep-link start parameter).
 * Only `!` + an ASCII command word becomes a command, so ordinary text such as `!중요한 메모` stays a message.
 */
export function normalizeDiscordText(text: string): string {
  const t = text.trim();
  if (/^![A-Za-z][\w-]*(?:\s|$)/.test(t)) return `/${t.slice(1)}`;
  const m = /^(?:start|연결)\s+(\S{16,})$/i.exec(t);
  if (m) return `/start ${m[1]}`;
  return t;
}

export function parseDiscordEvent(raw: unknown): NormalizedInbound | null {
  const ev = raw as DiscordEventPayload | null;
  if (!ev || typeof ev.t !== "string" || !ev.d || typeof ev.d !== "object") return null;
  if (ev.t === "MESSAGE_CREATE") {
    const m = ev.d as DcMessage;
    if (!m.id) return null;
    const text = typeof m.content === "string" && m.content.length ? normalizeDiscordText(m.content) : null;
    return {
      providerEventId: m.id,
      eventKind: text?.startsWith("/") ? "command" : "message",
      chatRef: m.channel_id ?? null,
      chatType: m.guild_id ? "group" : "private",
      senderRef: m.author?.id ?? null,
      senderLabel: labelOf(m.author),
      text,
      callbackId: null,
      callbackData: null,
      messageRef: m.id,
      // type 19 = REPLY
      replyToRef: m.message_reference?.message_id && (m.type === undefined || m.type === 19) ? m.message_reference.message_id : null,
      edited: false,
    };
  }
  if (ev.t === "INTERACTION_CREATE") {
    const i = ev.d as DcInteraction;
    if (!i.id) return null;
    const user = i.user ?? i.member?.user;
    const chatRef = i.channel_id ?? i.channel?.id ?? null;
    if (i.type !== 3) {
      return { ...empty, providerEventId: i.id, eventKind: "system", chatRef, chatType: null, senderRef: user?.id ?? null, senderLabel: labelOf(user) };
    }
    return {
      ...empty,
      providerEventId: i.id,
      eventKind: "callback",
      chatRef,
      chatType: i.guild_id ? "group" : "private",
      senderRef: user?.id ?? null,
      senderLabel: labelOf(user),
      callbackId: i.id,
      callbackData: i.data?.custom_id ?? null,
      messageRef: i.message?.id ?? null,
    };
  }
  return null;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
/** never cut between the two halves of a UTF-16 surrogate pair (emoji, CJK ext. B) */
const safeCut = (s: string, cut: number) => (cut > 0 && cut < s.length && isHighSurrogate(s.charCodeAt(cut - 1)) ? cut - 1 : cut);
const FENCE = "```";
const FENCE_CLOSE = `\n${FENCE}`;

/**
 * Split at paragraph / line / space boundaries into chunks of ≤ max chars. Only the boundary itself is dropped
 * (indentation of the next line is kept), surrogate pairs are never split, and a ``` code block that spans a cut
 * is closed at the end of the chunk and reopened (same language tag) at the start of the next one.
 */
export function splitDiscordText(text: string, max = DISCORD_MAX_CHARS): string[] {
  /** boundary inside the first `budget` chars → [cut, length of the dropped separator] */
  const pick = (rest: string, budget: number): [number, number] => {
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf("\n\n");
    if (cut >= budget / 2) return [cut, 2];
    cut = window.lastIndexOf("\n");
    if (cut >= budget / 2) return [cut, 1];
    cut = window.lastIndexOf(" ");
    if (cut >= budget / 2) return [cut, 1];
    return [safeCut(rest, budget), 0];
  };
  const openFence = (chunk: string) => (chunk.split(FENCE).length - 1) % 2 === 1;
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let [cut, skip] = pick(rest, max);
    // a code block left open by this cut needs room for the closing fence
    if (openFence(rest.slice(0, cut))) [cut, skip] = pick(rest, max - FENCE_CLOSE.length);
    let chunk = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut + skip);
    if (openFence(chunk)) {
      const lang = /```([^\s`]*)[^`]*$/.exec(chunk)?.[1] ?? "";
      chunk += FENCE_CLOSE;
      rest = `${FENCE}${lang}\n${rest}`;
    }
    out.push(chunk);
  }
  if (rest.length || !out.length) out.push(rest);
  return out.filter((c, i) => c.length > 0 || i === 0);
}

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, safeCut(s, max - 1))}…`);

/** RenderedMessage buttons → ≤ 5 action rows × ≤ 5 buttons; overflow is listed as text (numbered fallback). */
export function toDiscordComponents(buttons: RenderedMessage["buttons"]): { components: unknown[]; overflow: string[] } {
  const seen = new Set<string>();
  /** custom_id > 100 chars cannot be a button: listed as text instead of being dropped silently */
  const tooLong: string[] = [];
  const clean = buttons
    .map((row) =>
      row.filter((b) => {
        if (seen.has(b.data)) return false;
        seen.add(b.data);
        if (b.data.length > CUSTOM_ID_MAX) {
          tooLong.push(b.label);
          return false;
        }
        return true;
      }),
    )
    .filter((row) => row.length);
  let rows = clean;
  if (rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_PER_ROW)) {
    const flat = clean.flat();
    rows = [];
    for (let i = 0; i < flat.length; i += MAX_PER_ROW) rows.push(flat.slice(i, i + MAX_PER_ROW));
  }
  const shown = rows.slice(0, MAX_ROWS);
  const overflow = [...rows.slice(MAX_ROWS).flat().map((b) => b.label), ...tooLong];
  const components = shown.map((row) => ({
    type: 1,
    components: row.map((b) => ({ type: 2, style: b.label.startsWith("★") ? 1 : 2, label: truncate(b.label, LABEL_MAX), custom_id: b.data })),
  }));
  return { components, overflow };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** shown in the DM when the tail of a split message (with its buttons) could not be delivered */
export const DISCORD_PARTIAL_NOTICE = "(메시지 뒷부분을 보내지 못했습니다. 웹 인박스에서 확인하고 답하세요.)";

/**
 * Part of a split message is already visible. `undelivered` = the failed part was certainly not delivered
 * (429 / request never sent), so the outbox may resume at `sentParts` without duplicating anything.
 */
export class DiscordPartialDeliveryError extends DiscordApiError {
  constructor(
    readonly sentParts: number,
    readonly totalParts: number,
    readonly undelivered: boolean,
    readonly retryAfterSec: number | null,
    cause: string,
  ) {
    super(-1, `partial delivery (${sentParts}/${totalParts} parts sent): ${cause}`);
  }
}

export function createDiscordClient(transport: DiscordTransport): DiscordClient {
  async function post(chatRef: string, body: Record<string, unknown>, retryRateLimit: boolean): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await transport.request<{ id: string }>("POST", `/channels/${chatRef}/messages`, { ...body, allowed_mentions: { parse: [] } });
        return r.id;
      } catch (err) {
        const wait = err instanceof DiscordApiError && err.status === 429 ? (err.retryAfter ?? 1) : null;
        if (!retryRateLimit || wait === null || wait > MID_MESSAGE_RETRY_MAX_SEC || attempt >= 2) throw err;
        await sleep(wait * 1000);
      }
    }
  }

  return {
    async send(chatRef, msg) {
      const { components, overflow } = toDiscordComponents(msg.forceReply ? [] : msg.buttons);
      const text = overflow.length ? `${msg.text}\n\n(버튼이 많아 일부는 표시하지 못했습니다: ${overflow.join(", ")} — 웹 인박스에서 답하세요.)` : msg.text;
      const chunks = splitDiscordText(text || "​");
      // resume after a partial delivery: parts before `resumeFromPart` are already in the DM
      const from = Math.min(Math.max(0, msg.resumeFromPart ?? 0), chunks.length - 1);
      let last = "";
      for (let i = from; i < chunks.length; i++) {
        const body: Record<string, unknown> = { content: chunks[i] };
        if (i === 0 && msg.replyToRef) body.message_reference = { message_id: msg.replyToRef, fail_if_not_exists: false };
        if (i === chunks.length - 1 && components.length) body.components = components;
        try {
          last = await post(chatRef, body, i > from);
        } catch (err) {
          if (i === 0) throw err;
          // part of the message is already visible: never resend the whole thing (INV-OUT-01)
          const status = err instanceof DiscordApiError ? err.status : -1;
          const undelivered = status === 429 || status === 0;
          const retryAfter = err instanceof DiscordApiError && status === 429 ? (err.retryAfter ?? 1) : null;
          const cause = err instanceof Error ? err.message : String(err);
          if (!undelivered) {
            // unknown outcome: no automatic resume, but tell the user where to answer (best effort, one try)
            await post(chatRef, { content: DISCORD_PARTIAL_NOTICE }, false).catch(() => undefined);
          }
          throw new DiscordPartialDeliveryError(i, chunks.length, undelivered, retryAfter, cause);
        }
      }
      return { messageRef: last };
    },
    async edit(chatRef, messageRef, msg) {
      const { components } = toDiscordComponents(msg.buttons);
      // messageRef is the LAST part of a split message: replace it with the last part of the new text, so the
      // earlier parts (still visible above) are not repeated and the end of the text is not cut off
      const chunks = splitDiscordText(msg.text || "​");
      await transport.request("PATCH", `/channels/${chatRef}/messages/${messageRef}`, {
        content: truncate(chunks.at(-1) ?? "​", DISCORD_MAX_CHARS),
        components,
        allowed_mentions: { parse: [] },
      });
    },
    async getMe() {
      const r = await transport.request<{ id: string; username?: string }>("GET", "/users/@me");
      return { id: String(r.id), username: r.username ?? null };
    },
    async getChat(chatRef) {
      const r = await transport.request<{ id: string; type: number }>("GET", `/channels/${chatRef}`);
      return { id: String(r.id), type: r.type === 1 ? "private" : r.type === 3 ? "group" : "other" };
    },
    async getApplicationId() {
      const r = await transport.request<{ id: string }>("GET", "/oauth2/applications/@me");
      return String(r.id);
    },
    async ackInteraction(id, token) {
      await transport.request("POST", `/interactions/${id}/${token}/callback`, { type: 6 });
    },
    async messagesAfter(chatRef, afterId, limit) {
      const r = await transport.request<DcMessage[]>("GET", `/channels/${chatRef}/messages?after=${encodeURIComponent(afterId)}&limit=${limit}`);
      return [...(r ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },
    async gatewayUrl() {
      const r = await transport.request<{ url: string; session_start_limit?: { remaining?: number; reset_after?: number } }>("GET", "/gateway/bot");
      const l = r.session_start_limit;
      return { url: r.url, remaining: typeof l?.remaining === "number" ? l.remaining : null, resetAfterMs: typeof l?.reset_after === "number" ? l.reset_after : null };
    },
  };
}

/** OAuth2 invite URL: scopes bot + applications.commands, no guild permissions (the bot only talks in DMs). */
export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot+applications.commands&permissions=0`;
}

/** The first token segment is the base64 bot user id (= application id for every current app). Not a secret. */
export function discordIdFromToken(token: string): string | null {
  const seg = token.split(".")[0];
  if (!seg) return null;
  try {
    const id = Buffer.from(seg, "base64url").toString("utf8");
    return /^\d{15,22}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const DISCORD_TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
