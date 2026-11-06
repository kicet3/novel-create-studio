/**
 * messaging — public API (design/05 §2.1, §5.3–5.4, §6.1, §6.4, §9; ADR-011; FR-MSG-*).
 * Owns: channels, messenger_bots, channel_binding_tokens, messenger_inbox, messenger_outbox.
 *
 * Fixed implementation decision: Telegram via the Bot API directly with `fetch` (long polling
 * `getUpdates`), NOT Chat SDK. Bot tokens live in system.secrets (`telegram.bot.<botId>`); only
 * `modules/messaging/adapters/**` may talk to Telegram.
 * Discord (DM only): REST v10 via `fetch` + an own minimal Gateway websocket client (outbound only — no
 * interactions HTTP endpoint); tokens in `discord.bot.<botId>`; adapters live in `adapters/discord/**`.
 *
 * Durability: every inbound event is INSERTed into messenger_inbox (dedupe_key unique) before ACK;
 * every outbound message is a messenger_outbox row (idempotency_key unique) sent by the outbox loop.
 * hitl/concept never format messages — they hand over a channel-neutral `QuestionView` / notice and
 * receive normalized `InboundAction`s through registered handlers.
 */
import type {
  ChannelKind,
  OutboxKind,
  QuestionGrade,
  QuestionTopic,
  QuestionType,
  TelegramReceiveMode,
} from "@ncs/shared";
import type { ChannelsRow, MessengerBotsRow, MessengerOutboxRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";

export type Channel = ChannelsRow;
export type MessengerBot = MessengerBotsRow;
export type OutboxItem = MessengerOutboxRow;

/** 05 §3.5 */
export interface PreviewExcerpt {
  label: string;
  text: string;
  ref?: { refType: string; refId: string };
}

/** 05 §3.2 — channel-neutral question rendering input (built by hitl, never stored). */
export interface QuestionView {
  questionId: string;
  novelId: string;
  /** "Q-12" */
  displayNo: string;
  grade: QuestionGrade;
  topic: QuestionTopic;
  questionType: QuestionType;
  targetLabel: string;
  title: string;
  /** Markdown subset: bold, lists, quotes */
  body: string;
  preview: PreviewExcerpt[];
  recommendation: { label: string; rationale: string } | null;
  blockingBasisLabel: string | null;
  gradeReason: string | null;
  options: Array<{ optionId: string; label: string; value: unknown; isRecommended: boolean }>;
  allowFreeText: boolean;
  /** deadline in the novel timezone + what happens after it */
  deadline: { at: Date; wallClock: string; afterLabel: string } | null;
  webUrl: string;
}

/** 05 §6.1 I5 — normalized inbound event. */
export type InboundAction =
  | { kind: "answer_option"; questionId: string; optionId: string }
  | { kind: "answer_text"; questionId: string | null; text: string; replyToMessageRef?: string }
  | { kind: "start_text_input"; questionId: string }
  | { kind: "session_step"; answerSessionId: string; value: unknown }
  | { kind: "concept_message"; conceptSessionId: string | null; text: string; optionValue?: string }
  | { kind: "command"; command: string; args: string[] }
  | { kind: "unrelated_text"; text: string };

export interface InboundContext {
  tx: Tx;
  scope: NovelScope;
  channel: Channel;
  inboxId: string;
  /** bound owner user as actor (03 §6.1: messenger answers are recorded as the bound user + channel) */
  actor: ActorRef;
  receivedAt: Date;
  /** provider sender id (Telegram from.id) — owner of AnswerSessions (05 §6.3) */
  senderExternalRef: string;
  /** provider message id of the pressed/sent message (stale-button checks, 05 §5.3) */
  providerMessageRef: string | null;
}

export type InboundResult = { status: "processed" } | { status: "ignored"; reason: "unknown_question" | "unsupported" | "duplicate" };

/** hitl registers answer_* / session_step; concept registers concept_message; messaging handles command/binding itself. */
export interface InboundActionHandler {
  kinds: InboundAction["kind"][];
  handle(action: InboundAction, ctx: InboundContext): Promise<InboundResult>;
}

export interface NoticeInput {
  kind: Exclude<OutboxKind, "question" | "question_update">;
  /** target channel; omitted → novel's preferred channel (05 §5.4) */
  channelId?: string;
  text: string;
  idempotencyKey: string;
  refs?: Array<{ refType: string; refId: string }>;
  buttons?: Array<{ label: string; value: string }>;
  /** Telegram ForceReply prompt (AnswerSession text input, 05 §6.3) */
  forceReply?: boolean;
  /** reply to the delivered message of this question on the same channel (reminders, prompts) */
  replyToQuestionId?: string;
}

/** outcome of an outbox row, reported to hitl so it can move QuestionDelivery (QD2 / QD5) */
export interface DeliveryResult {
  tx: Tx;
  scope: NovelScope;
  outboxId: string;
  kind: OutboxKind;
  channelId: string;
  questionId: string | null;
  digestBatchId: string | null;
  status: "sent" | "failed" | "cancelled" | "delivery_unknown";
  providerMessageRef: string | null;
  error?: string;
}

export interface DigestInput {
  digestBatchId: string;
  channelId: string;
  headerText: string;
  views: QuestionView[];
}

/** Raw Telegram Bot API transport (tests inject a stub; the real one uses fetch). */
export interface TelegramTransport {
  /** POST https://api.telegram.org/bot<token>/<method>; resolves `result`, rejects with TelegramApiError */
  call<T = unknown>(method: string, params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}
export type TelegramTransportFactory = (token: string) => TelegramTransport;

/** Raw Discord REST transport (`https://discord.com/api/v10` + `Authorization: Bot <token>`). */
export interface DiscordTransport {
  /** resolves the JSON body (null on 204), rejects with DiscordApiError */
  request<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}
/** Minimal websocket used by the Discord Gateway client (tests inject an in-memory one). */
export interface DiscordSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type DiscordSocketFactory = (url: string, handlers: { onOpen(): void; onMessage(data: string): void; onClose(code: number, reason: string): void }) => DiscordSocket;
export interface DiscordTransportFactory {
  rest: (token: string) => DiscordTransport;
  socket: DiscordSocketFactory;
  /** test seam: Gateway reconnect / invalid-session delays (default 1 s base, 60 s max, 1–5 s) */
  gatewayTiming?: { reconnectBaseMs?: number; reconnectMaxMs?: number; invalidSessionMs?: () => number; random?: () => number };
}

export { TelegramApiError, DiscordApiError } from "./application/ports.js";

export interface MessagingService {
  /** N1 participant body: active `web` channel "웹 인박스" (INV-CH-01) — already implemented */
  createWebChannel(tx: Tx, scope: NovelScope): Promise<Channel>;
  listChannels(scope: NovelScope): Promise<Channel[]>;
  getChannel(scope: NovelScope, channelId: string, tx?: Tx): Promise<Channel>;
  /** ordered by notification_policies.channel_priority, active first (05 §5.4) */
  preferredChannels(scope: NovelScope, tx?: Tx): Promise<Channel[]>;

  // bots (install level) and binding (05 §9.1)
  registerBot(input: { kind: Extract<ChannelKind, "telegram" | "discord">; label: string; token: string; receiveMode?: TelegramReceiveMode }, actor: ActorRef): Promise<MessengerBot>;
  listBots(): Promise<MessengerBot[]>;
  /** non-secret links of a bot: Discord OAuth2 invite URL (scopes bot + applications.commands), bot username */
  botLinks(bot: MessengerBot): Promise<{ username: string | null; inviteUrl: string | null }>;
  /** plaintext token returned once (stored hashed); user sends `/start <token>` to the bot (Telegram deep link / Discord DM) */
  issueBindingToken(scope: NovelScope, input: { kind: ChannelKind; botId: string }, actor: ActorRef): Promise<{ token: string; expiresAt: Date; deepLink: string | null }>;
  unbindChannel(scope: NovelScope, channelId: string, actor: ActorRef): Promise<Channel>;

  // outbound (all enqueue an outbox row in the caller's tx)
  deliverQuestion(tx: Tx, scope: NovelScope, view: QuestionView, channelId: string): Promise<{ outboxId: string; deliveryRef: string }>;
  /** edit/close a delivered question message (answered elsewhere, withdrawn …) */
  updateQuestionDelivery(tx: Tx, scope: NovelScope, input: { questionId: string; channelId: string; state: "answered_here" | "closed_elsewhere" | "withdrawn"; text: string }): Promise<void>;
  sendNotice(tx: Tx, scope: NovelScope, notice: NoticeInput): Promise<{ outboxId: string } | null>;
  /** concept chat line to the session's active messenger channel (outbox_kind=concept_message, 05 §3.7) */
  sendConceptMessage(
    tx: Tx,
    scope: NovelScope,
    input: {
      channelId: string;
      conceptMessageId: string;
      text: string;
      /** `value` = option idx (incl. reserved 900~907); buttons become `v1|c|<conceptSessionId>|<value>` */
      options?: Array<{ label: string; value: string }>;
      /** required for buttons (callback data carries the session id, 05 §5.3) */
      conceptSessionId?: string;
    },
  ): Promise<{ outboxId: string }>;
  /** reminder as a reply to the delivered question message, same buttons (05 §5.5) */
  deliverReminder(tx: Tx, scope: NovelScope, view: QuestionView, channelId: string, input: { reminderNo: number; text: string }): Promise<{ outboxId: string } | null>;
  /** non-blocking digest: one message, one button row per question (05 §5.2) */
  deliverDigest(tx: Tx, scope: NovelScope, input: DigestInput): Promise<{ outboxId: string } | null>;

  // inbound
  registerInboundHandler(handler: InboundActionHandler): void;
  /** hitl: move QuestionDelivery when an outbox row is sent / failed / cancelled (same tx as the outbox update) */
  onDeliveryResult(hook: (r: DeliveryResult) => Promise<void>): void;

  // workers (background loops call these; tests / admin call them directly)
  /** one getUpdates round for every polling bot; returns number of updates recorded */
  pollOnce(signal?: AbortSignal): Promise<number>;
  /** process due messenger_inbox rows; returns number processed */
  processInboxOnce(): Promise<number>;
  /** send due messenger_outbox rows; returns number attempted */
  processOutboxOnce(): Promise<number>;
  /** test / ops seam: replace the Telegram transport (default: fetch to api.telegram.org) */
  setTelegramTransportFactory(factory: TelegramTransportFactory): void;
  /** start/stop one Discord Gateway connection per active Discord bot; returns number of running gateways */
  syncDiscordGateways(): Promise<number>;
  /** test / ops seam: replace Discord REST + Gateway socket (default: fetch to discord.com + global WebSocket) */
  setDiscordTransportFactory(factory: DiscordTransportFactory): void;
}

export type { MessagingModuleDeps } from "./module.js";
export { createMessagingModule } from "./module.js";
