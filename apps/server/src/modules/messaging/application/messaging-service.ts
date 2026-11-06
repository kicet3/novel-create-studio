/**
 * messaging application service (05 §2.1, §5.3–5.4, §6.1, §6.4, §9). Implements MessagingService:
 * bots/binding, outbound enqueue (outbox), Telegram long polling → inbox (dedupe) → normalized
 * InboundActions → registered handlers, outbox worker with 429/backoff/breaker, health checks.
 */
import { createHash, randomBytes } from "node:crypto";
import { DEFAULTS, labelKo, type ChannelStatus, type OutboxKind } from "@ncs/shared";
import {
  actors,
  DomainValidationError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { NovelService } from "../../novel/index.js";
import type { SystemService } from "../../system/index.js";
import type {
  Channel,
  DeliveryResult,
  InboundAction,
  InboundActionHandler,
  InboundContext,
  InboundResult,
  MessagingService,
  MessengerBot,
  OutboxItem,
  QuestionView,
  TelegramTransportFactory,
} from "../index.js";
import { insertWebChannel } from "../adapters/db/bootstrap.js";
import { messagingRepo as repo, type InboxRow } from "../adapters/db/messaging-repository.js";
import {
  CHANNEL_TRANSITIONS,
  backoffMs,
  canTransition,
  findRule,
  fromStatuses,
} from "../domain/transitions.js";
import {
  CONCEPT_CHANGE_GUIDANCE,
  HELP_TEXT,
  decodeCallback,
  encodeCallback,
  looksLikeConceptChangeRequest,
  questionButtons,
  renderDigest,
  renderNotice,
  renderQuestion,
  truncate,
} from "../domain/render.js";
import { classifyTelegramError, type NormalizedInbound, type OutboxPayload, type RenderedMessage, type TelegramClient, type TelegramClientFactory } from "./ports.js";

export interface MessagingServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  system: SystemService;
  /** bot token → client (module.ts wires the fetch transport; tests swap it) */
  clientFactory: () => TelegramClientFactory;
  parseUpdate: (raw: unknown) => NormalizedInbound | null;
  setTransportFactory: (f: TelegramTransportFactory) => void;
}

interface BotState {
  backoffUntil: number;
  failures: number;
  webhookChecked: boolean;
  lastConflictAt: number;
  pausedUntil: number;
  offlineChecked: boolean;
}

const PROCESSING_STALE_MS = 5 * 60_000;
const SENDING_STALE_MS = 2 * 60_000;
const PER_CHAT_INTERVAL_MS = 1000; // Telegram: ~1 msg/s per chat

export const BOT_SECRET_PREFIX = "telegram.bot.";

export function hashBindingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const chatRefOf = (c: Channel): string | null => {
  const r = c.externalChatRef as { chatId?: string } | null;
  return r?.chatId != null ? String(r.chatId) : null;
};

export interface MessagingInternals {
  service: MessagingService;
  checkBotTokens(signal?: AbortSignal): Promise<{ status: "pass" | "warn" | "fail"; message: string; details: Record<string, unknown> }>;
  checkChannelReach(novelId: string): Promise<{ status: "pass" | "warn" | "fail"; message: string; details: Record<string, unknown> }>;
  recoverOnBoot(): Promise<void>;
}

export function createMessagingService(deps: MessagingServiceDeps): MessagingInternals {
  const { platform, audit, novel, system } = deps;
  const { uow, ids, clock, log } = platform;
  const handlers: InboundActionHandler[] = [];
  const deliveryHooks: Array<(r: DeliveryResult) => Promise<void>> = [];
  const clients = new Map<string, { token: string; client: TelegramClient }>();
  const botStates = new Map<string, BotState>();
  const chatLastSent = new Map<string, number>();
  const channelFailures = new Map<string, number>();
  const usernames = new Map<string, string | null>();

  const now = () => clock.date();
  const stateOf = (botId: string): BotState => {
    let s = botStates.get(botId);
    if (!s) botStates.set(botId, (s = { backoffUntil: 0, failures: 0, webhookChecked: false, lastConflictAt: 0, pausedUntil: 0, offlineChecked: false }));
    return s;
  };

  async function clientFor(bot: MessengerBot): Promise<TelegramClient> {
    const token = await system.secrets.get(bot.tokenSecretId);
    if (!token) throw new DomainValidationError("bot_token_missing", "봇 토큰이 저장되어 있지 않습니다. 설정에서 다시 입력하세요.");
    const cached = clients.get(bot.id);
    if (cached && cached.token === token) return cached.client;
    const client = deps.clientFactory()(token);
    clients.set(bot.id, { token, client });
    return client;
  }

  async function mustChannel(db: Tx["db"], scope: NovelScope, channelId: string, forUpdate = false): Promise<Channel> {
    const c = await repo.getChannel(db, scope, channelId, forUpdate);
    if (!c) throw new NotFoundError("채널", channelId);
    return c;
  }

  async function fireDelivery(tx: Tx, row: OutboxItem, status: DeliveryResult["status"], error?: string): Promise<void> {
    if (row.kind !== "question" && row.kind !== "digest") return;
    for (const hook of deliveryHooks) {
      await hook({
        tx,
        scope: { novelId: row.novelId },
        outboxId: row.id,
        kind: row.kind,
        channelId: row.channelId,
        questionId: row.questionId,
        digestBatchId: row.digestBatchId,
        status,
        providerMessageRef: row.providerMessageRef,
        error,
      });
    }
  }

  /** CH transition + audit (only when the status really changes) */
  async function transitionChannel(tx: Tx, channel: Channel, to: ChannelStatus, actor: ActorRef, reason: string | null, extra: Partial<Channel> = {}): Promise<Channel | null> {
    if (channel.status === to || !canTransition(CHANNEL_TRANSITIONS, channel.status, to)) return null;
    const rule = findRule(CHANNEL_TRANSITIONS, "channel", channel.status, to);
    const updated = await repo.updateChannel(
      tx.db,
      { novelId: channel.novelId },
      channel.id,
      { status: to, updatedAt: now(), disconnectedReason: to === "active" ? null : reason, ...extra },
      fromStatuses(CHANNEL_TRANSITIONS, to),
    );
    if (!updated) return null;
    await audit.record(tx, {
      novelId: channel.novelId,
      actor,
      action: to === "revoked" ? "channel.unbound" : "channel.health_changed",
      target: { type: "channel", id: channel.id },
      before: { status: channel.status },
      after: { status: to },
      reason,
      details: { rule: rule.id },
    });
    if (to !== "active") {
      const cancelled = await repo.cancelUnsent(tx.db, { novelId: channel.novelId }, channel.id, now());
      for (const r of cancelled) await fireDelivery(tx, r, "cancelled", reason ?? undefined);
    }
    return updated;
  }

  async function enqueue(
    tx: Tx,
    scope: NovelScope,
    row: { channelId: string; kind: OutboxKind; idempotencyKey: string; payload: OutboxPayload & Record<string, unknown>; questionId?: string | null; digestBatchId?: string | null },
  ): Promise<OutboxItem> {
    const at = now();
    const { row: r } = await repo.insertOutbox(tx.db, {
      id: ids.next("obx"),
      novelId: scope.novelId,
      channelId: row.channelId,
      kind: row.kind,
      status: "pending",
      idempotencyKey: row.idempotencyKey,
      payload: row.payload,
      questionId: row.questionId ?? null,
      digestBatchId: row.digestBatchId ?? null,
      createdAt: at,
      updatedAt: at,
    });
    tx.afterCommit(() => platform.workSignal.notify("outbox", scope.novelId));
    return r;
  }

  async function messengerChannel(tx: Tx, scope: NovelScope, channelId: string): Promise<Channel> {
    const c = await mustChannel(tx.db, scope, channelId);
    if (c.kind === "web") throw new DomainValidationError("web_channel_no_outbox", "웹 채널은 발신함을 거치지 않습니다.");
    return c;
  }

  const topicLabel = (v: QuestionView) => labelKo("question_topic", v.topic);

  // ───────────────────────────── inbound ─────────────────────────────
  async function dispatch(actions: InboundAction[], ctx: InboundContext): Promise<{ result: InboundResult; action: InboundAction | null }> {
    let last: InboundResult = { status: "ignored", reason: "unsupported" };
    for (const action of actions) {
      for (const h of handlers.filter((x) => x.kinds.includes(action.kind))) {
        const r = await h.handle(action, ctx);
        if (r.status === "processed") return { result: r, action };
        last = r;
      }
    }
    return { result: last, action: null };
  }

  async function reply(tx: Tx, channel: Channel, inboxId: string, text: string, n = 1): Promise<void> {
    await enqueue(tx, { novelId: channel.novelId }, {
      channelId: channel.id,
      kind: "command_reply",
      idempotencyKey: `command_reply:${inboxId}:${channel.id}:${n}`,
      payload: { op: "send", message: renderNotice(text) },
    });
  }

  type InboxOutcome = { status: "processed" } | { status: "ignored"; reason: NonNullable<InboxRow["ignoreReason"]> };
  type DirectReply = { bot: MessengerBot; chatRef: string; text: string };

  async function bindChat(tx: Tx, bot: MessengerBot, ev: NormalizedInbound, row: InboxRow, token: string, direct: DirectReply[]): Promise<InboxOutcome> {
    const at = now();
    const t = await repo.findTokenByHash(tx.db, hashBindingToken(token));
    const fail = (text: string): InboxOutcome => {
      direct.push({ bot, chatRef: ev.chatRef!, text });
      return { status: "ignored", reason: "unbound_chat" };
    };
    if (!t || t.botId !== bot.id || t.status !== "issued") return fail("연결 코드가 올바르지 않거나 이미 사용됐습니다. PC 웹 설정에서 새로 발급하세요.");
    if (t.expiresAt.getTime() <= at.getTime()) {
      await repo.updateToken(tx.db, t.id, { status: "expired", updatedAt: at }); // BT3
      return fail("연결 코드가 만료됐습니다. PC 웹 설정에서 새로 발급하세요.");
    }
    const scope = { novelId: t.novelId };
    const n = await novel.getNovel(scope, tx);
    const existing = (await repo.findChannelsForChat(tx.db, bot.id, ev.chatRef!)).find((c) => c.novelId === t.novelId);
    let channel: Channel;
    if (existing) {
      channel = (await repo.updateChannel(tx.db, scope, existing.id, {
        status: "active",
        allowedUserRefs: [ev.senderRef!],
        boundAt: at,
        disconnectedReason: null,
        updatedAt: at,
      }))!;
    } else {
      channel = await repo.insertChannel(tx.db, {
        id: ids.next("chn"),
        novelId: t.novelId,
        kind: "telegram",
        status: "active", // CH1+CH2: created on consumption (assumption: no pending_binding row before /start)
        botId: bot.id,
        label: ev.senderLabel ?? "Telegram",
        externalChatRef: { chatId: ev.chatRef },
        allowedUserRefs: [ev.senderRef!],
        boundAt: at,
        createdAt: at,
        updatedAt: at,
      });
    }
    await repo.updateToken(tx.db, t.id, { status: "consumed", consumedAt: at, consumedExternalRef: ev.senderRef!, channelId: channel.id, updatedAt: at }); // BT2
    await audit.record(tx, {
      novelId: t.novelId,
      actor: actors.system("messenger"),
      action: "channel.bound",
      target: { type: "channel", id: channel.id },
      after: { status: "active", kind: "telegram", botId: bot.id },
      details: { inboxId: row.id },
    });
    await enqueue(tx, scope, {
      channelId: channel.id,
      kind: "binding_confirmation",
      idempotencyKey: `binding_confirmation:${t.id}:${channel.id}:1`,
      payload: { op: "send", message: renderNotice(`「${n.title}」와 연결됐습니다. 이제 이 대화로 질문과 알림을 받습니다.\n/help 로 사용법을 볼 수 있습니다.`) },
    });
    await repo.updateInbox(tx.db, row.id, { novelId: t.novelId, channelId: channel.id });
    return { status: "processed" };
  }

  async function handleInbound(tx: Tx, row: InboxRow, direct: DirectReply[], ownerId: string | null): Promise<InboxOutcome> {
    const bot = await repo.getBot(tx.db, row.botId);
    if (!bot) return { status: "ignored", reason: "unsupported" };
    const ev = deps.parseUpdate(row.payload);
    if (!ev || ev.eventKind === "system" || !ev.chatRef) return { status: "ignored", reason: "unsupported" };
    if (ev.chatType !== "private") return { status: "ignored", reason: "unsupported" }; // FR-MSG-02: 1:1 only
    if (ev.edited) return { status: "ignored", reason: "unsupported" }; // 05 §6.4 edited_message

    const text = ev.text?.trim() ?? "";
    const startMatch = ev.eventKind === "command" ? /^\/start(?:@\S+)?(?:\s+(\S+))?/.exec(text) : null;
    if (startMatch?.[1] && ev.senderRef) return bindChat(tx, bot, ev, row, startMatch[1], direct);

    // I3 binding
    const candidates = await repo.findChannelsForChat(tx.db, bot.id, ev.chatRef);
    if (!candidates.length) {
      if (ev.eventKind !== "callback") direct.push({ bot, chatRef: ev.chatRef, text: "이 대화는 아직 작품과 연결되지 않았습니다. PC 웹 설정 › 채널에서 연결 링크를 발급해 시작하세요." });
      return { status: "ignored", reason: "unbound_chat" };
    }
    let channel = candidates[0]!;
    const refToMatch = ev.eventKind === "callback" ? ev.messageRef : ev.replyToRef;
    if (candidates.length > 1 && refToMatch) {
      for (const c of candidates) if (await repo.findByProviderRef(tx.db, c.id, refToMatch)) channel = c;
    }
    const scope = { novelId: channel.novelId };
    await repo.updateInbox(tx.db, row.id, { novelId: channel.novelId, channelId: channel.id });

    // I4 allowlist (INV-CH-02)
    if (!ev.senderRef || !(channel.allowedUserRefs ?? []).includes(ev.senderRef)) {
      await audit.record(tx, {
        novelId: channel.novelId,
        actor: actors.system("messenger"),
        action: "channel.unauthorized_input",
        target: { type: "channel", id: channel.id },
        details: { inboxId: row.id, senderRef: ev.senderRef, eventKind: ev.eventKind },
      });
      return { status: "ignored", reason: "unauthorized" };
    }

    if (!ownerId) throw new Error("owner user missing");
    const ctx: InboundContext = {
      tx,
      scope,
      channel,
      inboxId: row.id,
      actor: actors.user(ownerId),
      receivedAt: row.receivedAt,
      senderExternalRef: ev.senderRef,
      providerMessageRef: ev.messageRef,
    };

    // commands (05 §6.4)
    if (ev.eventKind === "command" && !startMatch) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      const command = (cmd ?? "").replace(/@.*$/, "");
      await audit.record(tx, {
        novelId: channel.novelId,
        actor: ctx.actor,
        action: "channel.command_received",
        target: { type: "channel", id: channel.id },
        details: { command, inboxId: row.id },
      });
      const { result } = await dispatch([{ kind: "command", command, args }], ctx);
      if (result.status === "processed") return result;
      await reply(tx, channel, row.id, command === "help" ? HELP_TEXT : "지원하지 않는 명령입니다. /help 로 사용법을 확인하세요.");
      return { status: "processed" };
    }
    if (startMatch) {
      await reply(tx, channel, row.id, `이미 연결된 대화입니다.\n\n${HELP_TEXT}`);
      return { status: "processed" };
    }

    // callbacks (05 §5.3)
    if (ev.eventKind === "callback") {
      const d = decodeCallback(ev.callbackData);
      if (!d.ok) {
        if (d.reason === "expired_version") await reply(tx, channel, row.id, "만료된 버튼입니다. 웹 인박스에서 답하세요.");
        return { status: "ignored", reason: "unsupported" };
      }
      const p = d.payload;
      const action: InboundAction =
        p.action === "a"
          ? { kind: "answer_option", questionId: p.id, optionId: String(p.idx) }
          : p.action === "t"
            ? { kind: "start_text_input", questionId: p.id }
            : p.action === "c"
              ? { kind: "concept_message", conceptSessionId: p.id, text: "", optionValue: String(p.idx) }
              : { kind: "session_step", answerSessionId: "", value: { questionId: p.id, action: p.action, idx: p.idx } };
      const { result } = await dispatch([action], ctx);
      if (result.status === "ignored" && result.reason === "unknown_question") {
        await reply(tx, channel, row.id, "이 질문은 더 이상 없습니다(복원 등으로 취소됐습니다). 웹 인박스를 확인하세요.");
        return { status: "ignored", reason: "unknown_question" };
      }
      return result.status === "processed" ? result : { status: "ignored", reason: result.reason };
    }

    // plain text / replies (05 §6.4 routing order)
    if (!text) return { status: "ignored", reason: "unsupported" };
    let chain: InboundAction[];
    const repliedTo = ev.replyToRef ? await repo.findByProviderRef(tx.db, channel.id, ev.replyToRef) : null;
    if (repliedTo?.kind === "concept_message") {
      const sid = (repliedTo.payload as OutboxPayload).conceptSessionId ?? null;
      chain = [{ kind: "answer_text", questionId: null, text, replyToMessageRef: ev.replyToRef! }, { kind: "concept_message", conceptSessionId: sid, text }];
    } else if (repliedTo?.questionId) {
      chain = [{ kind: "answer_text", questionId: repliedTo.questionId, text, replyToMessageRef: ev.replyToRef! }];
    } else {
      chain = [
        { kind: "answer_text", questionId: null, text, ...(ev.replyToRef ? { replyToMessageRef: ev.replyToRef } : {}) },
        { kind: "concept_message", conceptSessionId: null, text },
        { kind: "unrelated_text", text },
      ];
    }
    const { result } = await dispatch(chain, ctx);
    if (result.status === "processed") return result;
    if (result.reason === "unknown_question") {
      await reply(tx, channel, row.id, "이 질문은 더 이상 없습니다(복원 등으로 취소됐습니다). 웹 인박스를 확인하세요.");
      return { status: "ignored", reason: "unknown_question" };
    }
    const guidance = looksLikeConceptChangeRequest(text) ? `\n\n${CONCEPT_CHANGE_GUIDANCE}` : "";
    await reply(tx, channel, row.id, `어느 질문의 답인지 알 수 없습니다. 답할 질문 메시지에 답장하거나 버튼을 누르세요.${guidance}`);
    return { status: "processed" };
  }

  async function processInboxRow(row: InboxRow): Promise<void> {
    const direct: DirectReply[] = [];
    try {
      const ownerId = (await novel.getOwnerUser())?.id ?? null; // read outside the tx (PGlite single connection)
      await uow.run(async (tx) => {
        direct.length = 0;
        const out = await handleInbound(tx, row, direct, ownerId);
        const at = now();
        await repo.updateInbox(tx.db, row.id, {
          status: out.status, // IN3 / IN4
          ignoreReason: out.status === "ignored" ? out.reason : null,
          processedAt: at,
          updatedAt: at,
          lastError: null,
        });
      });
    } catch (err) {
      const attempt = row.attemptCount + 1;
      const max = DEFAULTS["inbox.max_attempts"];
      const at = now();
      log.warn({ err, inboxId: row.id, attempt }, "inbox processing failed");
      await uow.run((tx) =>
        repo.updateInbox(tx.db, row.id, {
          status: attempt >= max ? "failed" : "retry", // IN6 / IN5
          attemptCount: attempt,
          nextAttemptAt: attempt >= max ? null : new Date(at.getTime() + backoffMs(attempt)),
          lastError: truncate(err instanceof Error ? err.message : String(err), 500),
          updatedAt: at,
        }),
      );
      return;
    }
    for (const d of direct) {
      try {
        await (await clientFor(d.bot)).send(d.chatRef, renderNotice(d.text));
      } catch (err) {
        log.warn({ err: classifyTelegramError(err).message, botId: d.bot.id }, "direct reply failed");
      }
    }
  }

  // ───────────────────────────── poller (05 §9.2 TelegramPoller) ─────────────────────────────
  async function degradeBot(bot: MessengerBot, to: "degraded" | "disconnected", reason: string): Promise<void> {
    await uow.run(async (tx) => {
      if (bot.status !== to && !(bot.status === "disconnected" && to === "degraded")) await repo.updateBot(tx.db, bot.id, { status: to, updatedAt: now() });
      for (const c of await repo.listChannelsOfBot(tx.db, bot.id)) {
        if (c.kind === "web") continue;
        await transitionChannel(tx, c, to, actors.system("messenger"), reason);
      }
    });
  }

  async function restoreBot(bot: MessengerBot, onlyDegraded: boolean): Promise<void> {
    await uow.run(async (tx) => {
      if (bot.status !== "active") await repo.updateBot(tx.db, bot.id, { status: "active", updatedAt: now() });
      for (const c of await repo.listChannelsOfBot(tx.db, bot.id)) {
        if (c.status === "degraded" || (!onlyDegraded && c.status === "disconnected")) await transitionChannel(tx, c, "active", actors.system("health_check"), null);
      }
    });
  }

  async function pollBot(bot: MessengerBot, signal?: AbortSignal): Promise<number> {
    const st = stateOf(bot.id);
    const t0 = clock.now();
    if (t0 < st.backoffUntil) return 0;
    let client: TelegramClient;
    try {
      client = await clientFor(bot);
    } catch (err) {
      log.warn({ botId: bot.id, err: (err as Error).message }, "telegram poller: no token");
      st.backoffUntil = t0 + 60_000;
      return 0;
    }
    let updates: unknown[];
    try {
      updates = await client.getUpdates({ offset: bot.telegramUpdateOffset ?? null, timeoutSec: DEFAULTS["telegram.poll_timeout_seconds"] }, signal);
    } catch (err) {
      if (signal?.aborted) return 0;
      const e = classifyTelegramError(err);
      const maxSec = DEFAULTS["telegram.poll_backoff_max_seconds"];
      st.failures++;
      if (e.kind === "unauthorized") {
        // TP5: token revoked — stop polling until a health check passes again
        await degradeBot(bot, "disconnected", "봇 토큰이 폐기됐거나 올바르지 않습니다. 토큰을 재발급해 다시 입력하세요.");
        st.backoffUntil = clock.now() + maxSec * 1000;
        return 0;
      }
      if (e.kind === "rate_limited") {
        st.backoffUntil = clock.now() + (e.retryAfterSec ?? 1) * 1000; // TP6
        return 0;
      }
      if (e.kind === "conflict") {
        st.lastConflictAt = clock.now(); // TP4
        if (!st.webhookChecked) {
          st.webhookChecked = true;
          try {
            if (await client.getWebhookUrl()) await client.deleteWebhook();
          } catch {
            /* best effort */
          }
        }
      }
      st.backoffUntil = clock.now() + backoffMs(st.failures, maxSec);
      if (e.kind === "conflict" || st.failures >= DEFAULTS["channel.degraded_after_consecutive_failures"]) {
        await degradeBot(
          bot,
          "degraded",
          e.kind === "conflict" ? "다른 곳에서 같은 봇을 수신 중이거나 webhook이 설정됨" : `Telegram 수신 실패가 계속됩니다: ${truncate(e.message, 120)}`,
        );
      }
      return 0;
    }
    if (st.failures > 0 && bot.status === "degraded") await restoreBot(bot, true);
    st.failures = 0;

    // offline gap notice (05 §9.2, NFR-REL-06)
    if (!st.offlineChecked) {
      st.offlineChecked = true;
      if (bot.lastConnectedAt && clock.now() - bot.lastConnectedAt.getTime() > 24 * 3600_000) {
        await uow.run(async (tx) => {
          for (const c of await repo.listChannelsOfBot(tx.db, bot.id)) {
            if (c.status !== "active") continue;
            await enqueue(tx, { novelId: c.novelId }, {
              channelId: c.id,
              kind: "alert",
              idempotencyKey: `alert:offline_gap:${c.id}:${clock.now()}`,
              payload: { op: "send", message: renderNotice("앱이 꺼져 있는 동안 보낸 답이 사라졌을 수 있습니다. 웹 인박스를 확인하세요.") },
            });
          }
        });
      }
    }

    // TP2: record in update_id order, advance offset only over the contiguous recorded prefix
    const sorted = [...updates].sort((a, b) => (client.updateId(a) ?? 0) - (client.updateId(b) ?? 0));
    let lastOk: number | null = null;
    let recorded = 0;
    const acks: string[] = [];
    for (const raw of sorted) {
      const updateId = client.updateId(raw);
      if (updateId === null) break;
      const ev = client.parseUpdate(raw);
      try {
        const at = now();
        const inserted = await uow.run((tx) =>
          repo.insertInbox(tx.db, {
            id: ids.next("inb"),
            botId: bot.id,
            eventKind: ev?.eventKind ?? "system",
            providerEventId: String(updateId),
            dedupeKey: `telegram:${bot.id}:${updateId}`,
            status: "received",
            senderExternalRef: ev?.senderRef ?? null,
            payload: raw as object,
            receivedAt: at,
            createdAt: at,
            updatedAt: at,
          }),
        );
        if (inserted) recorded++;
        if (ev?.callbackId) acks.push(ev.callbackId);
        lastOk = updateId;
      } catch (err) {
        log.error({ err, botId: bot.id, updateId }, "inbox insert failed; offset not advanced");
        break;
      }
    }
    await uow.run((tx) =>
      repo.updateBot(tx.db, bot.id, {
        ...(lastOk !== null ? { telegramUpdateOffset: lastOk + 1 } : {}),
        lastConnectedAt: now(),
        updatedAt: now(),
      }),
    );
    // I2: immediate ACK for button presses; processing is asynchronous
    await Promise.allSettled(acks.map((id) => client.ack(id)));
    if (recorded) platform.workSignal.notify("inbox");
    return recorded;
  }

  // ───────────────────────────── outbox worker (05 §9.4) ─────────────────────────────
  async function finishOutbox(row: OutboxItem, status: "sent" | "retry" | "failed" | "delivery_unknown" | "cancelled", patch: Partial<OutboxItem> = {}, error?: string) {
    await uow.run(async (tx) => {
      const at = now();
      const updated = await repo.updateOutbox(tx.db, row.id, ["sending"], {
        status,
        updatedAt: at,
        ...(status === "sent" ? { sentAt: at, lastError: null } : {}),
        ...(error ? { lastError: truncate(error, 500) } : {}),
        ...patch,
      });
      if (updated && status !== "retry") await fireDelivery(tx, updated, status === "sent" ? "sent" : status, error);
    });
  }

  async function resolveTarget(row: OutboxItem, channel: Channel, questionId: string): Promise<{ ref: string } | "wait" | "gone"> {
    const target = await repo.findQuestionMessage(uow.db, { novelId: row.novelId }, channel.id, questionId);
    if (!target) return "gone";
    if (target.status === "sent" && target.providerMessageRef) return { ref: target.providerMessageRef };
    if (["pending", "retry", "sending"].includes(target.status)) return "wait";
    return "gone";
  }

  async function sendRow(row: OutboxItem): Promise<void> {
    const t0 = clock.now();
    const channel = await repo.getChannelById(uow.db, row.channelId);
    if (!channel || channel.status !== "active") return finishOutbox(row, "cancelled", {}, `channel ${channel?.status ?? "missing"}`); // OB7
    const bot = channel.botId ? await repo.getBot(uow.db, channel.botId) : null;
    const chatRef = chatRefOf(channel);
    if (!bot || !chatRef || bot.status === "revoked" || bot.status === "disconnected") return finishOutbox(row, "cancelled", {}, "bot unavailable");
    const st = stateOf(bot.id);
    if (st.pausedUntil > t0) return finishOutbox(row, "retry", { nextAttemptAt: new Date(st.pausedUntil) });
    const last = chatLastSent.get(chatRef) ?? 0;
    if (t0 - last < PER_CHAT_INTERVAL_MS) return finishOutbox(row, "retry", { nextAttemptAt: new Date(last + PER_CHAT_INTERVAL_MS) });

    const payload = row.payload as OutboxPayload;
    const message: RenderedMessage = { ...payload.message };
    let editRef = payload.editRef ?? null;
    for (const [qid, kind] of [
      [payload.replyToQuestionId, "reply"],
      [payload.editQuestionId, "edit"],
    ] as const) {
      if (!qid) continue;
      const r = await resolveTarget(row, channel, qid);
      if (r === "wait") return finishOutbox(row, "retry", { nextAttemptAt: new Date(t0 + 2000) });
      if (r === "gone") {
        if (kind === "edit") return finishOutbox(row, "cancelled", {}, "edit target not delivered");
        continue;
      }
      if (kind === "reply") message.replyToRef = r.ref;
      else editRef = r.ref;
    }

    let client: TelegramClient;
    try {
      client = await clientFor(bot);
    } catch (err) {
      return finishOutbox(row, "failed", {}, (err as Error).message);
    }
    try {
      chatLastSent.set(chatRef, t0);
      if (payload.op === "edit" && editRef) {
        await client.edit(chatRef, editRef, message);
        await finishOutbox(row, "sent", { providerMessageRef: editRef });
      } else {
        const { messageRef } = await client.send(chatRef, message);
        await finishOutbox(row, "sent", { providerMessageRef: messageRef });
      }
      channelFailures.delete(channel.id);
    } catch (err) {
      const e = classifyTelegramError(err);
      const sys = actors.system("messenger");
      switch (e.kind) {
        case "not_modified":
          return finishOutbox(row, "sent", { providerMessageRef: editRef });
        case "rate_limited": {
          // OB4 without counting the attempt; pause the whole bot until retry_after
          st.pausedUntil = clock.now() + (e.retryAfterSec ?? 1) * 1000;
          return finishOutbox(row, "retry", { nextAttemptAt: new Date(st.pausedUntil) }, `429 retry_after=${e.retryAfterSec}`);
        }
        case "unauthorized":
          await finishOutbox(row, "failed", {}, e.message);
          return degradeBot(bot, "disconnected", "봇 토큰이 폐기됐거나 올바르지 않습니다. 토큰을 재발급해 다시 입력하세요.");
        case "forbidden":
          await finishOutbox(row, "failed", {}, e.message);
          return uow.run(async (tx) => {
            await transitionChannel(tx, channel, "disconnected", sys, "사용자가 봇을 차단했거나 대화가 없어졌습니다.");
          });
        case "bad_request":
          return finishOutbox(row, "failed", {}, e.message); // OB6
        case "unknown_delivery":
          return finishOutbox(row, "delivery_unknown", {}, e.message); // OB5, INV-OUT-01
        default: {
          const attempt = row.attemptCount + 1;
          const failures = (channelFailures.get(channel.id) ?? 0) + 1;
          channelFailures.set(channel.id, failures);
          if (attempt >= DEFAULTS["outbox.max_attempts"]) await finishOutbox(row, "failed", { attemptCount: attempt }, e.message);
          else await finishOutbox(row, "retry", { attemptCount: attempt, nextAttemptAt: new Date(clock.now() + backoffMs(attempt)) }, e.message);
          if (failures >= DEFAULTS["channel.degraded_after_consecutive_failures"]) {
            // error-burst circuit breaker → CH3 (cancels unsent rows; health check restores CH4)
            channelFailures.delete(channel.id);
            await uow.run(async (tx) => {
              const fresh = await repo.getChannel(tx.db, { novelId: channel.novelId }, channel.id, true);
              if (fresh) await transitionChannel(tx, fresh, "degraded", sys, `연속 발송 실패 ${failures}회: ${truncate(e.message, 120)}`);
            });
          }
        }
      }
    }
  }

  // ───────────────────────────── health checks (05 §9.6) ─────────────────────────────
  async function checkBotTokens() {
    const bots = (await repo.listBots(uow.db)).filter((b) => b.kind === "telegram" && b.status !== "revoked");
    if (!bots.length) return { status: "pass" as const, message: "등록된 메신저 봇이 없습니다.", details: { bots: 0 } };
    const results: Record<string, string> = {};
    let worst: "pass" | "warn" | "fail" = "pass";
    for (const bot of bots) {
      try {
        const me = await (await clientFor(bot)).getMe();
        usernames.set(bot.id, me.username);
        results[bot.id] = "pass";
        if (bot.status !== "active") await restoreBot(bot, false); // CH4 / CH6
      } catch (err) {
        const e = classifyTelegramError(err);
        if (e.kind === "unauthorized") {
          results[bot.id] = "fail";
          worst = "fail";
          await degradeBot(bot, "disconnected", "봇 토큰이 폐기됐거나 올바르지 않습니다. 토큰을 재발급해 다시 입력하세요.");
        } else {
          results[bot.id] = "warn";
          if (worst === "pass") worst = "warn";
        }
      }
    }
    const message =
      worst === "pass" ? "봇 토큰이 정상입니다." : worst === "fail" ? "봇 토큰이 올바르지 않습니다. 토큰 재발급 후 다시 입력하세요." : "Telegram에 연결할 수 없습니다. 네트워크를 확인하세요.";
    return { status: worst, message, details: { bots: results } };
  }

  async function checkChannelReach(novelId: string) {
    const scope = { novelId };
    const chans = (await repo.listChannels(uow.db, scope)).filter((c) => c.kind === "telegram" && c.status !== "revoked");
    if (!chans.length) return { status: "pass" as const, message: "연결된 메신저 채널이 없습니다(웹 인박스만 사용).", details: { channels: 0 } };
    let worst: "pass" | "warn" | "fail" = "pass";
    const results: Record<string, string> = {};
    for (const c of chans) {
      const bot = c.botId ? await repo.getBot(uow.db, c.botId) : null;
      let status: "pass" | "warn" | "fail" = "pass";
      let reason: string | null = null;
      try {
        if (!bot) throw new Error("bot missing");
        const client = await clientFor(bot);
        await client.getChat(chatRefOf(c)!);
        const url = await client.getWebhookUrl();
        const conflictRecent = clock.now() - stateOf(bot.id).lastConflictAt < 10 * 60_000;
        if (url || conflictRecent) {
          status = "fail";
          reason = "다른 곳에서 같은 봇을 수신 중이거나 webhook이 설정됨 — 다른 기기의 앱을 끄거나 봇 토큰을 새로 발급하세요.";
        }
      } catch (err) {
        const e = classifyTelegramError(err);
        status = e.kind === "network" || e.kind === "server" ? "warn" : "fail";
        reason = `채널에 닿을 수 없습니다: ${truncate(e.message, 120)}`;
      }
      results[c.id] = status;
      if (status === "fail") worst = "fail";
      else if (status === "warn" && worst === "pass") worst = "warn";
      await uow.run(async (tx) => {
        const fresh = (await repo.getChannel(tx.db, scope, c.id, true))!;
        await repo.updateChannel(tx.db, scope, c.id, { lastHealthAt: now(), lastHealthStatus: status, updatedAt: now() });
        if (status === "pass" && (fresh.status === "degraded" || fresh.status === "disconnected")) await transitionChannel(tx, fresh, "active", actors.system("health_check"), null);
        if (status === "fail" && fresh.status === "active") await transitionChannel(tx, fresh, "degraded", actors.system("health_check"), reason);
      });
    }
    const message = worst === "pass" ? "메신저 채널에 정상적으로 닿습니다." : "일부 메신저 채널에 문제가 있습니다. 설정 › 채널에서 확인하세요.";
    return { status: worst, message, details: { channels: results } };
  }

  // ───────────────────────────── service ─────────────────────────────
  const service: MessagingService = {
    createWebChannel: (tx, scope) => insertWebChannel(platform, tx, scope),
    listChannels: (scope) => repo.listChannels(uow.db, scope),
    getChannel: (scope, channelId, tx) => mustChannel(tx?.db ?? uow.db, scope, channelId),
    async preferredChannels(scope, tx) {
      const db = tx?.db ?? uow.db;
      const all = (await repo.listChannels(db, scope)).filter((c) => c.status !== "revoked");
      const policy = await novel.getNotificationPolicy(scope, tx);
      const prio = policy.channelPriority ?? [];
      const rank = (c: Channel) => {
        const i = prio.findIndex((p) => p === c.id || p === c.kind);
        return i < 0 ? prio.length : i;
      };
      const statusRank = (c: Channel) => (c.status === "active" ? 0 : 1);
      return all.sort((a, b) => statusRank(a) - statusRank(b) || rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
    },

    async registerBot(input, actor) {
      if (input.kind !== "telegram") throw new DomainValidationError("unsupported_channel_kind", "MVP-α는 Telegram 봇만 등록할 수 있습니다.");
      if (input.receiveMode === "webhook") throw new DomainValidationError("webhook_unsupported", "local_trusted 모드에서는 long polling만 쓸 수 있습니다.");
      const token = input.token.trim();
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new DomainValidationError("invalid_bot_token", "봇 토큰 형식이 올바르지 않습니다. BotFather에서 받은 토큰을 그대로 붙여 넣으세요.");
      const client = deps.clientFactory()(token);
      let username: string | null = null;
      let status: "active" | "degraded" = "active";
      try {
        username = (await client.getMe()).username;
      } catch (err) {
        const e = classifyTelegramError(err);
        if (e.kind === "unauthorized") throw new DomainValidationError("invalid_bot_token", "봇 토큰이 올바르지 않습니다. BotFather에서 받은 토큰을 다시 확인하세요.");
        status = "degraded"; // network: keep the bot, health check will restore it
      }
      const botId = ids.next("bot");
      const secretId = `${BOT_SECRET_PREFIX}${botId}`;
      await system.secrets.set(secretId, token, `Telegram 봇 토큰 (${input.label})`);
      usernames.set(botId, username);
      clients.set(botId, { token, client });
      return uow.run(async (tx) => {
        const at = now();
        const bot = await repo.insertBot(tx.db, {
          id: botId,
          kind: "telegram",
          label: input.label,
          tokenSecretId: secretId,
          receiveMode: "polling",
          status,
          createdAt: at,
          updatedAt: at,
        });
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "settings.changed",
          target: { type: "settings", id: botId },
          after: { messengerBot: { kind: bot.kind, label: bot.label, receiveMode: bot.receiveMode, username } },
        });
        return bot;
      });
    },
    listBots: () => repo.listBots(uow.db),

    async issueBindingToken(scope, input, actor) {
      if (input.kind !== "telegram") throw new DomainValidationError("unsupported_channel_kind", "MVP-α는 Telegram 채널만 연결할 수 있습니다.");
      const bot = await repo.getBot(uow.db, input.botId);
      if (!bot || bot.kind !== "telegram" || bot.status === "revoked") throw new NotFoundError("메신저 봇", input.botId);
      let username = usernames.get(bot.id) ?? null;
      if (!username) {
        try {
          username = (await (await clientFor(bot)).getMe()).username;
          usernames.set(bot.id, username);
        } catch {
          username = null;
        }
      }
      const token = randomBytes(24).toString("base64url"); // URL-safe 32 chars (05 §9.2 assumption)
      return uow.run(async (tx) => {
        await novel.getNovel(scope, tx);
        const at = now();
        const expiresAt = new Date(at.getTime() + DEFAULTS["channel.binding_token_ttl_minutes"] * 60_000);
        const revoked = await repo.revokeIssuedTokens(tx.db, scope, bot.id, at); // BT4
        const row = await repo.insertToken(tx.db, {
          id: ids.next("bnd"),
          novelId: scope.novelId,
          channelKind: "telegram",
          botId: bot.id,
          tokenHash: hashBindingToken(token),
          status: "issued", // BT1
          expiresAt,
          createdAt: at,
          updatedAt: at,
        });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "channel.binding_issued",
          target: { type: "novel", id: scope.novelId },
          details: { bindingTokenId: row.id, botId: bot.id, expiresAt: expiresAt.toISOString(), revokedTokenIds: revoked.map((r) => r.id) },
        });
        return { token, expiresAt, deepLink: username ? `https://t.me/${username}?start=${token}` : null };
      });
    },

    unbindChannel(scope, channelId, actor) {
      return uow.run(async (tx) => {
        const c = await mustChannel(tx.db, scope, channelId, true);
        if (c.kind === "web") throw new DomainValidationError("web_channel_required", "웹 인박스 채널은 해제할 수 없습니다."); // INV-CH-01
        findRule(CHANNEL_TRANSITIONS, "channel", c.status, "revoked");
        return (await transitionChannel(tx, c, "revoked", actor, "사용자가 연결을 해제했습니다."))!; // CH7
      });
    },

    async deliverQuestion(tx, scope, view, channelId) {
      const c = await messengerChannel(tx, scope, channelId);
      const prefix = `question:${view.questionId}:${c.id}:`;
      const n = (await repo.countOutbox(tx.db, scope, prefix)) + 1;
      const r = await enqueue(tx, scope, {
        channelId: c.id,
        kind: "question",
        idempotencyKey: `${prefix}${n}`,
        questionId: view.questionId,
        payload: { op: "send", message: renderQuestion(view, topicLabel(view)), questionIds: [view.questionId] },
      });
      return { outboxId: r.id, deliveryRef: r.id };
    },

    async updateQuestionDelivery(tx, scope, input) {
      const c = await mustChannel(tx.db, scope, input.channelId);
      if (c.kind === "web") return;
      // unsent question rows are simply cancelled (OB7)
      const cancelled = await repo.cancelUnsent(tx.db, scope, c.id, now(), input.questionId);
      const target = await repo.findQuestionMessage(tx.db, scope, c.id, input.questionId);
      if (!target || target.status === "cancelled" || target.status === "failed") return;
      if (cancelled.some((r) => r.id === target.id)) return;
      if (target.kind === "digest") return; // digest messages are not edited per question (MVP-α)
      const orig = (target.payload as OutboxPayload).message.text;
      const header = orig.split("\n\n").slice(0, 2).join("\n");
      await enqueue(tx, scope, {
        channelId: c.id,
        kind: "question_update",
        idempotencyKey: `question_update:${input.questionId}:${c.id}:${input.state}`,
        questionId: input.questionId,
        payload: {
          op: "edit",
          editRef: target.status === "sent" ? target.providerMessageRef : null,
          editQuestionId: target.status === "sent" ? null : input.questionId,
          message: { text: `${header}\n\n${input.text}`, buttons: [] },
        },
      });
    },

    async sendNotice(tx, scope, notice) {
      let channel: Channel | undefined;
      if (notice.channelId) channel = await mustChannel(tx.db, scope, notice.channelId);
      else channel = (await service.preferredChannels(scope, tx)).find((c) => c.kind !== "web" && c.status === "active");
      if (!channel || channel.kind === "web" || channel.status !== "active") return null;
      const questionRef = notice.refs?.find((r) => r.refType === "question")?.refId ?? notice.replyToQuestionId ?? null;
      const buttons = (notice.buttons ?? []).filter((b) => b.value.startsWith("v1|")).map((b) => ({ label: b.label, data: b.value }));
      const r = await enqueue(tx, scope, {
        channelId: channel.id,
        kind: notice.kind,
        idempotencyKey: notice.idempotencyKey,
        questionId: questionRef,
        payload: { op: "send", message: renderNotice(notice.text, buttons, notice.forceReply ?? false), replyToQuestionId: notice.replyToQuestionId ?? null, refs: notice.refs ?? [] },
      });
      return { outboxId: r.id };
    },

    async sendConceptMessage(tx, scope, input) {
      const c = await messengerChannel(tx, scope, input.channelId);
      const buttons =
        input.conceptSessionId && input.options?.length
          ? input.options
              .filter((o) => /^\d{1,3}$/.test(o.value))
              .map((o) => ({ label: o.label, data: encodeCallback({ action: "c", id: input.conceptSessionId!, idx: Number(o.value) }) }))
          : [];
      const r = await enqueue(tx, scope, {
        channelId: c.id,
        kind: "concept_message",
        idempotencyKey: `concept_message:${input.conceptMessageId}:${c.id}:1`,
        payload: {
          op: "send",
          message: renderNotice(input.text, buttons),
          conceptMessageId: input.conceptMessageId,
          ...(input.conceptSessionId ? { conceptSessionId: input.conceptSessionId } : {}),
        },
      });
      return { outboxId: r.id };
    },

    async deliverReminder(tx, scope, view, channelId, input) {
      const c = await mustChannel(tx.db, scope, channelId);
      if (c.kind === "web" || c.status !== "active") return null;
      const r = await enqueue(tx, scope, {
        channelId: c.id,
        kind: "reminder",
        idempotencyKey: `reminder:${view.questionId}:${c.id}:${input.reminderNo}`,
        questionId: view.questionId,
        payload: { op: "send", message: { text: truncate(input.text, 4096), buttons: questionButtons(view, { maxTextChars: 4096, maxButtons: 8, optionLabelMaxChars: 40, callbackMaxBytes: 64 }) }, replyToQuestionId: view.questionId },
      });
      return { outboxId: r.id };
    },

    async deliverDigest(tx, scope, input) {
      const c = await mustChannel(tx.db, scope, input.channelId);
      if (c.kind === "web" || c.status !== "active" || !input.views.length) return null;
      const r = await enqueue(tx, scope, {
        channelId: c.id,
        kind: "digest",
        idempotencyKey: `digest:${input.digestBatchId}:${c.id}:1`,
        digestBatchId: input.digestBatchId,
        payload: {
          op: "send",
          message: renderDigest(input.headerText, input.views.map((v) => ({ view: v, topicLabel: topicLabel(v) }))),
          questionIds: input.views.map((v) => v.questionId),
        },
      });
      return { outboxId: r.id };
    },

    registerInboundHandler(h) {
      handlers.push(h);
    },
    onDeliveryResult(hook) {
      deliveryHooks.push(hook);
    },

    async pollOnce(signal) {
      const bots = await repo.listPollingBots(uow.db);
      const counts = await Promise.all(bots.map((b) => pollBot(b, signal).catch((err) => (log.error({ err, botId: b.id }, "telegram poll failed"), 0))));
      return counts.reduce((a, b) => a + b, 0);
    },
    async processInboxOnce() {
      const at = now();
      await uow.run((tx) => repo.recoverStaleInbox(tx.db, new Date(at.getTime() - PROCESSING_STALE_MS), at)); // IN7
      const rows = await uow.run((tx) => repo.claimInbox(tx.db, at, 20));
      for (const row of rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) await processInboxRow(row);
      return rows.length;
    },
    async processOutboxOnce() {
      const at = now();
      const stale = await uow.run(async (tx) => {
        const rows = await repo.recoverStaleOutbox(tx.db, new Date(at.getTime() - SENDING_STALE_MS), at); // OB5 after crash
        for (const r of rows) await fireDelivery(tx, r, "delivery_unknown", "process stopped while sending");
        await repo.expireTokens(tx.db, at); // BT3
        return rows.length;
      });
      const rows = await uow.run((tx) => repo.claimOutbox(tx.db, at, 20));
      for (const row of rows) {
        try {
          await sendRow(row);
        } catch (err) {
          log.error({ err, outboxId: row.id }, "outbox send failed unexpectedly");
          await finishOutbox(row, "retry", { nextAttemptAt: new Date(clock.now() + 5000) }, (err as Error).message).catch(() => undefined);
        }
      }
      if (stale) log.warn({ count: stale }, "outbox rows left in sending marked delivery_unknown");
      return rows.length;
    },
    setTelegramTransportFactory(factory) {
      deps.setTransportFactory(factory);
      clients.clear();
      botStates.clear();
      chatLastSent.clear();
    },
  };

  return {
    service,
    checkBotTokens,
    checkChannelReach,
    async recoverOnBoot() {
      const at = now();
      await uow.run((tx) => repo.recoverStaleInbox(tx.db, at, at)); // IN7 on restart
    },
  };
}
