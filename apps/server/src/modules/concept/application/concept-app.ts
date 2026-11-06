/**
 * concept application layer: use cases (design/11 §2.3–§3.10, §4, §5.8), task handlers
 * (concept_turn / import_concept / check_concept_brief), the hitl approval handler (concept_brief → N2)
 * and the messaging inbound handler (concept_message).
 */
import { z } from "zod";
import { DEFAULTS, labelKo, usdToMicros, type ConceptSessionStatus, type ConceptStage } from "@ncs/shared";
import {
  actors,
  ConflictError,
  DomainValidationError,
  NotFoundError,
  NotImplementedError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { ApprovalDecisionContext, HitlService } from "../../hitl/index.js";
import type { LlmService, LlmStreamEvent, ModelCallPort } from "../../llm/index.js";
import type { InboundAction, InboundContext, InboundResult, MessagingService } from "../../messaging/index.js";
import type { NovelService } from "../../novel/index.js";
import { ModelCallError } from "../../llm/index.js";
import type { CommitOutcome, OrchestrationService, TaskContext, TaskKindHandler } from "../../orchestration/index.js";
import type { ConceptBrief, ConceptMessage, ConceptService, ConceptSession, PostMessageInput, StartSessionInput } from "../index.js";
import { conceptRepo as repo } from "../adapters/db/repository.js";
import {
  contributionSummary,
  emptyWorkingBrief,
  getPath,
  isEmptyValue,
  normalizeText,
  parseWorkingBrief,
  valueToText,
  workingBriefHash,
  type WorkingBrief,
} from "../domain/brief.js";
import { DEFAULT_SAFETY_LISTS, groundedRealPersonName, runDeterministicChecks, submitBlockers, type InstallSafetyLists } from "../domain/checks.js";
import { CONTROL, control, controlKeyOf, missingRequired, selectNext, summaryText } from "../domain/next-question.js";
import {
  briefCheckProposalSchema,
  conceptTurnProposalSchema,
  importProposalSchema,
  titleSuggestionsProposalSchema,
  type BriefCheckProposal,
  type ConceptTurnProposal,
  type ImportProposal,
} from "../domain/proposal.js";
import { cleanTitle, hasTitleMaterial, normalizeTitleSuggestions, type TitleSuggestion } from "../domain/title.js";
import { COMMON_1, DEF_BY_PATH, QUESTION_SET_VERSION, isKnownPath, requiredPaths, slotLabel } from "../domain/question-set.js";
import { renderApprovalSummary, renderBriefMarkdown } from "../domain/render.js";
import type { SlotDiff, StoredOption } from "../domain/slot-guard.js";
import { assertSessionTransition, assertStageTransition } from "../domain/transitions.js";
import { planFieldEdit, planImport, planTurn, resolveOption, type PlanTurnOutput, type TurnLimits, type TurnMessage } from "../domain/turn.js";
import { CHECK_TEMPLATE_ID, IMPORT_TEMPLATE_ID, TITLES_TEMPLATE_ID, TURN_TEMPLATE_ID, renderCheckPrompt, renderImportPrompt, renderTitlesPrompt, renderTurnPrompt } from "./prompts.js";
import { createFieldStreamer } from "../domain/partial-json.js";
import { createTurnStreamHub } from "./turn-stream.js";

export interface ConceptAppDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  llm: LlmService;
  orchestration: OrchestrationService;
  messaging: MessagingService;
  hitl: HitlService;
}

/** Swappable outbound ports (tests replace hitl while the hitl module is still a placeholder). */
export interface ConceptPorts {
  hitl: Pick<HitlService, "requestApproval" | "cancelApproval">;
  modelCalls: () => ModelCallPort;
  lists: InstallSafetyLists;
}

/** Turn reservation estimate (3.8 / INV-CON-09): 16k in × $5/M + 2.5k out × $25/M ≈ $0.14 (assumption). */
export const TURN_RESERVE_MICROS = 150_000;
const TURN_PRIORITY = 950; // X-4
const CHECK_PRIORITY = 950;
const TERMINAL: readonly ConceptSessionStatus[] = ["approved", "abandoned"];

export interface SessionView {
  session: ConceptSession;
  workingBrief: WorkingBrief;
  progress: { requiredTotal: number; requiredConfirmed: number; missing: Array<{ path: string; label: string }> };
  blockers: Array<{ code: string; message: string; fieldPaths: string[] }>;
  canSubmit: boolean;
  turns: { used: number; limit: number; extensionsLeft: number; softWarning: number };
  budget: { spentMicros: number; limitMicros: number; checkReserveMicros: number };
  statusLabel: string;
  stageLabel: string;
  fieldBadges: Record<string, { originLabel: string; stateLabel: string }>;
  nextStep: { kind: string; path: string | null; text: string };
  /** 설계 추가: 추천 제목 (고르기 전까지 작품 제목은 가제/임시) */
  titleSuggestions: { items: TitleSuggestion[]; generatedAt: string | null; refreshing: boolean; error: string | null; canRefresh: boolean };
}

export interface GoalFormDefaults {
  conceptBriefId: string;
  endingDirection: string | null;
  totalEpisodesMin: number | null;
  totalEpisodesMax: number | null;
  cadenceEpisodesPerWeek: number | null;
  lengthHint: string | null;
  suggestMultiTimeline: boolean;
  suggestPossessionMode: boolean;
}

export type ConceptServiceExt = ConceptService;

/** `titles: true` = "다른 추천 받기" (title suggestions only: no reply message, no turn count) */
type TurnInput = { session_id: string; resume?: boolean; titles?: boolean };
type TurnProposal = { proposal: ConceptTurnProposal | null; costMicros: number; observedMaxSeq: number; failed?: string; titles?: TitleSuggestion[] | null };
type ImportInput = { session_id: string; message_id: string };
type ImportOut = { proposal: ImportProposal | null; costMicros: number };
type CheckInput = { session_id: string; working_brief_hash: string; requested_by_user_id: string };
type CheckOut = { proposal: BriefCheckProposal | null; costMicros: number };

export function createConceptApp(deps: ConceptAppDeps) {
  const { platform, audit, novel, orchestration, messaging } = deps;
  const { uow, ids, clock, log } = platform;
  const ports: ConceptPorts = { hitl: deps.hitl, modelCalls: () => deps.llm.modelCalls, lists: DEFAULT_SAFETY_LISTS };
  /** live replies of in-flight concept turns (SSE route; 설계 추가: 답변 스트리밍) */
  const streams = createTurnStreamHub();
  const orchestrator = actors.system("orchestrator");
  const target = (id: string) => ({ type: "concept_session" as const, id });
  const briefTarget = (id: string) => ({ type: "concept_brief" as const, id });
  const checkReserve = usdToMicros(DEFAULTS["concept.check_reserve_usd"]);
  const limits = (s: ConceptSession, messenger = false): TurnLimits => ({
    flipLimit: DEFAULTS["concept.slot_flip_limit"],
    softWarning: DEFAULTS["concept.turn_soft_warning"],
    agentTurnCount: s.agentTurnCount,
    turnLimit: s.turnLimit,
    messenger,
    replyMaxChars: DEFAULTS["concept.reply_max_chars"],
  });

  // ── helpers ────────────────────────────────────────────────────────────
  const mustSession = async (tx: Tx | undefined, scope: NovelScope, id: string, lock = false) => {
    const s = await repo.getSession(tx?.db ?? uow.db, scope, id, lock && !!tx);
    if (!s) throw new NotFoundError("컨셉 세션", id);
    return s;
  };
  const webChannelOf = (s: ConceptSession) => parseWorkingBrief(s.workingBrief).meta.web_channel_id ?? s.activeChannelId;
  const isMessenger = (s: ConceptSession) => s.activeChannelId !== webChannelOf(s);
  const userIdOf = (actor: ActorRef, s: ConceptSession) => (actor.type === "user" ? actor.id : s.createdByUserId);

  const toTurnMessage = (m: ConceptMessage): TurnMessage => ({
    id: m.id,
    seq: m.seq,
    authorKind: m.authorKind,
    kind: m.kind,
    body: m.body,
    channelId: m.channelId,
    pickedIdx: m.pickedIdx,
    options: (m.options as StoredOption[] | null) ?? null,
    askedFieldPaths: m.askedFieldPaths ?? null,
  });

  async function insertMessage(
    tx: Tx,
    scope: NovelScope,
    session: ConceptSession,
    v: {
      authorKind: "user" | "agent" | "system";
      kind: ConceptMessage["kind"];
      body: string;
      channelId?: string;
      authorUserId?: string | null;
      runId?: string | null;
      options?: StoredOption[] | null;
      askedFieldPaths?: string[] | null;
      respondsToSeq?: number | null;
      isSuperseded?: boolean;
      inboxId?: string | null;
      pickedIdx?: number | null;
      slotUpdates?: SlotDiff[];
    },
  ): Promise<ConceptMessage> {
    const seq = await repo.nextSeq(tx.db, scope, session.id);
    return repo.insertMessage(tx.db, {
      id: ids.next("cnm"),
      novelId: scope.novelId,
      sessionId: session.id,
      seq,
      authorKind: v.authorKind,
      authorUserId: v.authorUserId ?? null,
      runId: v.runId ?? null,
      channelId: v.channelId ?? webChannelOf(session),
      inboxId: v.inboxId ?? null,
      kind: v.kind,
      body: v.body,
      options: v.options && v.options.length ? v.options : null,
      pickedIdx: v.pickedIdx ?? null,
      askedFieldPaths: v.askedFieldPaths && v.askedFieldPaths.length ? v.askedFieldPaths : null,
      slotUpdates: v.slotUpdates ?? [],
      respondsToSeq: v.respondsToSeq ?? null,
      isSuperseded: v.isSuperseded ?? false,
    });
  }

  /** web always sees the message; the active messenger channel gets a copy (4.4) */
  async function deliver(tx: Tx, scope: NovelScope, session: ConceptSession, msg: ConceptMessage) {
    if (!isMessenger(session) || msg.isSuperseded) return;
    const opts = ((msg.options as StoredOption[] | null) ?? []).filter((o) => o.source !== "control" || [900, 901, 902, 903, 904, 905, 906, 907, 918, 919].includes(o.idx));
    try {
      const { outboxId } = await messaging.sendConceptMessage(tx, scope, {
        channelId: session.activeChannelId,
        conceptMessageId: msg.id,
        conceptSessionId: session.id,
        text: msg.body,
        options: opts.map((o) => ({ label: o.label, value: String(o.idx) })),
      });
      await repo.updateMessage(tx.db, scope, msg.id, { outboxId });
    } catch (err) {
      if (!(err instanceof NotImplementedError)) throw err;
      log.debug({ sessionId: session.id }, "messaging placeholder: concept message not delivered");
    }
  }

  async function notice(tx: Tx, scope: NovelScope, session: ConceptSession, body: string, options: StoredOption[] = [], kind: "notice" | "question" = "notice") {
    const msg = await insertMessage(tx, scope, session, { authorKind: "system", kind, body, options });
    await deliver(tx, scope, session, msg);
    return msg;
  }

  async function transition(
    tx: Tx,
    scope: NovelScope,
    s: ConceptSession,
    to: ConceptSessionStatus,
    ruleId: string,
    patch: Parameters<typeof repo.updateSession>[3],
    actor: ActorRef,
    reason?: string | null,
  ): Promise<ConceptSession> {
    assertSessionTransition(s.status, to, ruleId);
    const next = await repo.casSession(tx.db, scope, s.id, [s.status], { ...patch, status: to });
    if (!next) throw new ConflictError("concept_session_changed", "컨셉 세션 상태가 먼저 바뀌었습니다. 새로 고친 뒤 다시 시도하세요.");
    const action = ruleId === "CS6" ? "concept_session.paused" : ruleId === "CS7" ? "concept_session.resumed" : "concept_session.status_changed";
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action,
      target: target(s.id),
      before: { status: s.status, pauseReason: s.pauseReason },
      after: { status: next.status, pauseReason: next.pauseReason, rule: ruleId },
      reason: reason ?? null,
      approvalId: next.pendingApprovalId ?? s.pendingApprovalId ?? null,
    });
    return next;
  }

  async function changeStage(tx: Tx, scope: NovelScope, s: ConceptSession, to: ConceptStage, actor: ActorRef): Promise<ConceptSession> {
    if (s.stage === to) return s;
    assertStageTransition(s.stage, to);
    const next = await repo.updateSession(tx.db, scope, s.id, { stage: to });
    await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_session.stage_changed", target: target(s.id), before: { stage: s.stage }, after: { stage: to } });
    return next;
  }

  /** CS9/CS8 helper: cancel the pending approval (A4) and reject the awaiting brief (CB4) */
  async function cancelPendingApproval(tx: Tx, scope: NovelScope, s: ConceptSession, actor: ActorRef, note: string) {
    const brief = await repo.briefByStatus(tx.db, scope, "awaiting_approval", true);
    if (s.pendingApprovalId) await ports.hitl.cancelApproval(tx, scope, s.pendingApprovalId, note, actor);
    if (brief) {
      await repo.casBrief(tx.db, scope, brief.id, ["awaiting_approval"], { status: "rejected" });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "concept_brief.status_changed",
        target: briefTarget(brief.id),
        before: { status: "awaiting_approval" },
        after: { status: "rejected", rule: "CB4" },
        reason: note,
        approvalId: s.pendingApprovalId,
      });
    }
  }

  function budgetExhausted(s: ConceptSession): boolean {
    return s.spentMicros + TURN_RESERVE_MICROS > s.budgetLimitMicros - checkReserve; // INV-CON-09
  }

  async function budgetNotice(tx: Tx, scope: NovelScope, s: ConceptSession) {
    return notice(tx, scope, s, "세션 비용 상한에 닿았습니다. [상한 올리기]는 PC 웹에서 할 수 있고, [폼으로 마저 입력]을 고르면 대화 없이 브리프를 채워 승인 요청까지 갈 수 있습니다.", [
      control("raiseBudget"),
      control("formMode"),
      control("defer"),
    ]);
  }

  async function limitNotice(tx: Tx, scope: NovelScope, s: ConceptSession) {
    const b = parseWorkingBrief(s.workingBrief);
    const ready = submitBlockers(b).length === 0;
    const opts = [
      ...(ready ? [control("submit")] : []),
      control("delegateAll"),
      control("formMode"),
      ...(s.turnExtensionCount < DEFAULTS["concept.max_turn_extensions"] ? [control("extendTurns")] : []),
      control("later"),
    ];
    return notice(tx, scope, s, `대화 턴 상한(${s.turnLimit}턴)에 닿았습니다. ${summaryText(b)}`, opts);
  }

  /** TC-3: create/coalesce the concept_turn task, honoring turn and budget caps (3.8, INV-CON-09) */
  async function enqueueTurn(tx: Tx, scope: NovelScope, s: ConceptSession, cycleKey: string, actor: ActorRef, extra: Partial<TurnInput> = {}): Promise<string | null> {
    if (s.status !== "active" || s.llmDisabled) return null;
    if (s.agentTurnCount >= s.turnLimit) {
      await limitNotice(tx, scope, s);
      return null;
    }
    if (budgetExhausted(s)) {
      const paused = await transition(tx, scope, s, "paused", "CS6", { pauseReason: "budget_limit" }, actors.system("budget_guard"), "세션 비용 상한");
      await budgetNotice(tx, scope, paused);
      return null;
    }
    const { taskId } = await orchestration.createTask(tx, scope, {
      kind: "concept_turn",
      targetType: "concept_session",
      targetId: s.id,
      input: { session_id: s.id, ...extra },
      createdBy: actor,
      cycleKey,
      priority: TURN_PRIORITY,
    });
    await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: taskId });
    return taskId;
  }

  async function startCheck(tx: Tx, scope: NovelScope, s: ConceptSession, actor: ActorRef): Promise<{ taskId: string }> {
    if (s.status !== "active") throw new InvalidStateError(s.status);
    const b = parseWorkingBrief(s.workingBrief);
    b.checks = runDeterministicChecks(b, ports.lists, []);
    const blockers = submitBlockers(b);
    if (blockers.length) {
      throw new DomainValidationError("concept_brief_not_ready", blockers.map((x) => x.message).join(" "), { blockers });
    }
    const hash = workingBriefHash(b);
    const { taskId } = await orchestration.createTask(tx, scope, {
      kind: "check_concept_brief",
      targetType: "concept_session",
      targetId: s.id,
      input: { session_id: s.id, working_brief_hash: hash, requested_by_user_id: userIdOf(actor, s) },
      createdBy: actor,
      cycleKey: `check:${hash}`,
      priority: CHECK_PRIORITY,
    });
    return { taskId };
  }

  class InvalidStateError extends ConflictError {
    constructor(status: string) {
      super("concept_session_not_active", `컨셉 세션이 '${labelKo("concept_session_status", status)}' 상태라 이 작업을 할 수 없습니다.`);
    }
  }

  async function callModel<T>(
    ctx: TaskContext<unknown>,
    purpose: string,
    prompt: { system: string; messages: { role: "user" | "assistant"; content: string }[] },
    schemaName: string,
    schema: z.ZodType<T>,
    onStream?: (ev: LlmStreamEvent) => void,
  ) {
    try {
      const port = ports.modelCalls();
      if (!port || typeof (port as Partial<ModelCallPort>).call !== "function") return null;
      const out = await port.call<T>({
        run: ctx.run,
        purpose,
        system: prompt.system,
        messages: prompt.messages,
        output: { kind: "object", schemaName, schema },
        maxOutputTokens: DEFAULTS["llm.max_output_tokens.concept_partner"],
        ...(onStream ? { onStream } : {}),
      });
      const parsed = schema.safeParse(out.value);
      return { value: parsed.success ? parsed.data : null, costMicros: out.costMicros };
    } catch (err) {
      if (err instanceof NotImplementedError) {
        ctx.log.debug({ purpose }, "llm placeholder: deterministic concept fallback");
        return null;
      }
      throw err;
    }
  }

  // ── working title (설계 추가: 대화하면서 작품 제목 자동 생성) ───────────────
  /**
   * A title the user stated/edited in the brief (`title`, or `title_candidates[0]` changed by the user in this
   * commit) becomes the confirmed novel title (title_source=user). Otherwise the model's `working_title`
   * replaces the novel title while it is still provisional/auto. Returns the newly applied auto title (for the reply).
   */
  async function syncNovelTitle(
    tx: Tx,
    scope: NovelScope,
    brief: WorkingBrief,
    diffs: ReadonlyArray<{ field_path: string; origin: string }>,
    working: { title: string; reason: string } | null,
    actor: ActorRef,
  ): Promise<string | null> {
    const byUser = (o: string) => o === "user_stated" || o === "user_edited" || o === "agent_proposed_accepted" || o === "agent_proposed_modified";
    const userDiff = diffs.find((d) => (d.field_path === "title" || d.field_path === "title_candidates") && byUser(d.origin));
    if (userDiff) {
      const v = userDiff.field_path === "title" ? brief.content.title : brief.content.title_candidates?.[0];
      const t = cleanTitle(v);
      if (t) {
        await novel.applyWorkingTitle(tx, scope, { title: t, source: "user", reason: "컨셉 대화에서 사용자가 정한 제목" }, actor);
        return null;
      }
    }
    const t = cleanTitle(working?.title);
    if (!t) return null;
    const r = await novel.applyWorkingTitle(tx, scope, { title: t, source: "auto", reason: working?.reason || "컨셉 대화 가제" }, actor);
    return r.applied ? t : null;
  }

  // ── title suggestions ("다른 추천 받기", concept_turn with input.titles) ─────
  async function executeTitles(ctx: TaskContext<TurnInput>): Promise<TurnProposal> {
    const s = await mustSession(undefined, ctx.scope, ctx.input.session_id);
    const b = parseWorkingBrief(s.workingBrief);
    if (s.status !== "active" || s.llmDisabled) return { proposal: null, costMicros: 0, observedMaxSeq: 0, titles: null };
    const nv = await novel.getNovel(ctx.scope);
    const recent = (await repo.recentMessages(uow.db, ctx.scope, s.id, DEFAULTS["concept.recent_messages_in_context"])).map(toTurnMessage);
    const previous = b.meta.title_suggestions?.items ?? [];
    const prompt = renderTitlesPrompt({ brief: b, novelTitle: { title: nv.title, source: nv.titleSource }, previous, recent });
    try {
      const res = await callModel(ctx as TaskContext<unknown>, "concept_titles", prompt, "TitleSuggestions", titleSuggestionsProposalSchema);
      const items = res?.value ? normalizeTitleSuggestions(res.value.suggestions, { exclude: previous.map((x) => x.title) }) : null;
      return { proposal: null, costMicros: res?.costMicros ?? 0, observedMaxSeq: 0, titles: items, ...(items ? {} : { failed: "invalid_output" }) };
    } catch (err) {
      const retryable = err instanceof ModelCallError ? err.retryable : (err as { retryable?: boolean }).retryable !== false;
      if (!retryable || ctx.run.attempt >= ctx.task.maxAttempts) return { proposal: null, costMicros: 0, observedMaxSeq: 0, titles: null, failed: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async function commitTitles(tx: Tx, ctx: TaskContext<TurnInput>, p: TurnProposal): Promise<CommitOutcome> {
    const scope = ctx.scope;
    const s = await mustSession(tx, scope, ctx.input.session_id, true);
    const b = parseWorkingBrief(s.workingBrief);
    const mine = b.meta.title_refresh?.task_id === ctx.task.id;
    if (p.titles?.length) {
      b.meta.title_suggestions = { items: p.titles, generated_at: clock.date().toISOString(), run_id: ctx.run.runId, source: "refresh" };
      if (mine) b.meta.title_refresh = null;
    } else if (mine) {
      b.meta.title_refresh = { ...b.meta.title_refresh!, error: "새 추천 제목을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요." };
    }
    await repo.updateSession(tx.db, scope, s.id, { workingBrief: b, spentMicros: s.spentMicros + p.costMicros });
    if (!p.titles?.length) return p.failed ? { kind: "failed", reason: p.failed } : { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
    const nv = await novel.getNovel(scope, tx);
    if (nv.titleSource === "provisional") {
      await novel.applyWorkingTitle(tx, scope, { title: p.titles[0]!.title, source: "auto", reason: p.titles[0]!.reason || "추천 제목" }, actors.agent("concept_partner", ctx.run.runId));
    }
    return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
  }

  async function requestTitleSuggestionsTx(tx: Tx, scope: NovelScope, sessionId: string, actor: ActorRef): Promise<{ taskId: string }> {
    const s = await mustSession(tx, scope, sessionId, true);
    if (s.status !== "active") throw new InvalidStateError(s.status);
    if (s.llmDisabled) throw new DomainValidationError("concept_llm_disabled", "LLM 없이 진행 중이라 제목 추천을 받을 수 없습니다. 제목을 직접 입력해 주세요.");
    const b = parseWorkingBrief(s.workingBrief);
    if (!hasTitleMaterial(b)) throw new DomainValidationError("concept_title_no_material", "제목을 추천하려면 이야기 내용이 조금 더 필요합니다. 씨앗 아이디어나 장르를 먼저 알려 주세요.");
    if (budgetExhausted(s)) throw new DomainValidationError("concept_budget_limit", "세션 비용 상한에 닿아 제목 추천을 받을 수 없습니다. 상한을 올리거나 제목을 직접 입력해 주세요.");
    const { taskId } = await orchestration.createTask(tx, scope, {
      kind: "concept_turn",
      targetType: "concept_session",
      targetId: s.id,
      input: { session_id: s.id, titles: true },
      createdBy: actor,
      cycleKey: `titles:${s.id}`,
      priority: TURN_PRIORITY,
    });
    b.meta.title_refresh = { task_id: taskId, requested_at: clock.date().toISOString(), error: null };
    await repo.updateSession(tx.db, scope, s.id, { workingBrief: b });
    return { taskId };
  }

  async function titleSuggestionsView(scope: NovelScope, s: ConceptSession, b: WorkingBrief): Promise<SessionView["titleSuggestions"]> {
    const ts = b.meta.title_suggestions;
    const r = b.meta.title_refresh;
    let refreshing = !!r && !r.error;
    let error = r?.error ?? null;
    if (refreshing && r) {
      const task = await orchestration.getTask(scope, r.task_id).catch(() => null);
      if (!task || task.status === "done" || task.status === "failed" || task.status === "cancelled") {
        refreshing = false;
        if (task?.status !== "done") error = "새 추천 제목을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
      }
    }
    return {
      items: ts?.items ?? [],
      generatedAt: ts?.generated_at ?? null,
      refreshing,
      error,
      canRefresh: s.status === "active" && !s.llmDisabled && !refreshing && hasTitleMaterial(b),
    };
  }

  // ── task handlers ──────────────────────────────────────────────────────
  /**
   * A turn / import run that ended WITHOUT its commit (stopped at a safe point, commit rolled back, retry): the model
   * cost it already spent still counts against the session budget; when the task is over (cancelled / failed) the
   * session is no longer in flight; the live reply ends (`done` null) or, while the task runs again later, is reset.
   */
  async function runUncommitted(tx: Tx, ctx: TaskContext<{ session_id: string }>, costMicros: number) {
    const s = await repo.getSession(tx.db, ctx.scope, ctx.input.session_id, true);
    if (!s) return;
    const t = await orchestration.getTask(ctx.scope, ctx.task.id, tx).catch(() => null);
    const over = !t || ["done", "failed", "cancelled"].includes(t.status);
    const patch = {
      ...(costMicros > 0 ? { spentMicros: s.spentMicros + costMicros } : {}),
      ...(over && s.inFlightTaskId === ctx.task.id ? { inFlightTaskId: null } : {}),
    };
    if (Object.keys(patch).length) await repo.updateSession(tx.db, ctx.scope, s.id, patch);
    tx.afterCommit(() => (over ? streams.done(s.id, ctx.task.id, null) : streams.abandon(s.id, ctx.task.id)));
  }

  const turnHandler: TaskKindHandler<TurnInput, TurnProposal> = {
    kind: "concept_turn",
    role: "concept_partner",
    promptTemplateVersion: TURN_TEMPLATE_ID,
    inputSchema: z.object({ session_id: z.string(), resume: z.boolean().optional(), titles: z.boolean().optional() }),
    onUncommitted: (tx, ctx, info) => runUncommitted(tx, ctx, info.proposal?.costMicros ?? 0),
    async execute(ctx) {
      if (ctx.input.titles) return executeTitles(ctx);
      const s = await mustSession(undefined, ctx.scope, ctx.input.session_id);
      const b = parseWorkingBrief(s.workingBrief);
      const newMsgs = (await repo.userMessagesAfter(uow.db, ctx.scope, s.id, b.meta.processed_seq ?? 0)).map(toTurnMessage);
      const observedMaxSeq = newMsgs.reduce((m, x) => Math.max(m, x.seq), b.meta.processed_seq ?? 0);
      if (s.status !== "active") return { proposal: null, costMicros: 0, observedMaxSeq };
      const promptRow = await repo.latestPrompt(uow.db, ctx.scope, s.id, newMsgs[0]?.seq);
      const dry = planTurn({
        brief: b,
        stage: s.stage,
        entryMode: s.entryMode,
        messages: newMsgs,
        prompt: promptRow ? toTurnMessage(promptRow) : null,
        proposal: null,
        runId: ctx.run.runId,
        lists: ports.lists,
        limits: limits(s, isMessenger(s)),
        newId: () => "dry",
      });
      const recent = (await repo.recentMessages(uow.db, ctx.scope, s.id, DEFAULTS["concept.recent_messages_in_context"])).map(toTurnMessage);
      const step = selectNext(dry.brief, dry.stage, {});
      const nv = await novel.getNovel(ctx.scope);
      const prompt = renderTurnPrompt({
        brief: dry.brief,
        novelTitle: { title: nv.title, source: nv.titleSource },
        titleSuggestions: b.meta.title_suggestions?.items ?? [],
        stage: dry.stage,
        next: step,
        recent,
        newMessages: newMsgs,
        ageCeiling: dry.brief.content.age_rating ?? "age_15",
        maxReplyChars: DEFAULTS["concept.reply_max_chars"],
      });
      // live reply: the model writes ConceptTurnProposal JSON; only `reply_text` is shown while it streams
      streams.begin(s.id, ctx.task.id);
      const reply = createFieldStreamer("reply_text");
      const onStream = (ev: LlmStreamEvent) => {
        if (ev.type === "reset") {
          reply.reset();
          streams.reset(s.id, ctx.task.id);
          return;
        }
        const add = reply.push(ev.text);
        if (add) streams.delta(s.id, ctx.task.id, add);
      };
      try {
        const res = await callModel(ctx as TaskContext<unknown>, "concept_turn", prompt, "ConceptTurnProposal", conceptTurnProposalSchema, onStream);
        return { proposal: res?.value ?? null, costMicros: res?.costMicros ?? 0, observedMaxSeq };
      } catch (err) {
        streams.reset(s.id, ctx.task.id);
        // X-8: last attempt → keep the session active and leave a retry notice (no blocking question)
        const retryable = err instanceof ModelCallError ? err.retryable : (err as { retryable?: boolean }).retryable !== false;
        if (!retryable || ctx.run.attempt >= ctx.task.maxAttempts) return { proposal: null, costMicros: 0, observedMaxSeq, failed: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    },
    async commit(tx, ctx, p) {
      if (ctx.input.titles) return commitTitles(tx, ctx, p);
      const scope = ctx.scope;
      let s = await mustSession(tx, scope, ctx.input.session_id, true);
      const clearInflight = s.inFlightTaskId === ctx.task.id ? { inFlightTaskId: null } : {};
      if (s.status !== "active") {
        await repo.updateSession(tx.db, scope, s.id, { ...clearInflight, spentMicros: s.spentMicros + p.costMicros });
        tx.afterCommit(() => streams.done(s.id, ctx.task.id, null));
        return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
      }
      if (p.failed) {
        await repo.updateSession(tx.db, scope, s.id, { ...clearInflight, spentMicros: s.spentMicros + p.costMicros });
        await notice(tx, scope, s, "응답을 만들지 못했습니다. [다시 시도]를 눌러 주세요.", [control("retry")]);
        tx.afterCommit(() => streams.error(s.id, ctx.task.id, "응답을 만들지 못했습니다."));
        return { kind: "failed", reason: p.failed };
      }
      const b = parseWorkingBrief(s.workingBrief);
      const cursor = b.meta.processed_seq ?? 0;
      const fresh = (await repo.userMessagesAfter(tx.db, scope, s.id, cursor)).map(toTurnMessage);
      const handled = fresh.filter((m) => m.seq <= p.observedMaxSeq);
      const superseded = fresh.length > handled.length; // X-7
      const promptRow = await repo.latestPrompt(tx.db, scope, s.id, handled[0]?.seq ?? fresh[0]?.seq);
      const plan = planTurn({
        brief: b,
        stage: s.stage,
        entryMode: s.entryMode,
        messages: handled,
        prompt: promptRow ? toTurnMessage(promptRow) : null,
        proposal: p.proposal,
        runId: ctx.run.runId,
        lists: ports.lists,
        limits: limits(s, isMessenger(s)),
        newId: () => ids.next("cnm").replace("cnm_", "cpr_"),
        forceSummary: !!ctx.input.resume,
      });
      plan.brief.meta.processed_seq = Math.max(cursor, p.observedMaxSeq);
      const agentActor = actors.agent("concept_partner", ctx.run.runId);
      const nvBefore = await novel.getNovel(scope, tx);
      // 설계 추가: 추천 제목 — stored per session until the user picks one (never while the title is user-confirmed)
      const suggested =
        nvBefore.titleSource !== "user" && p.proposal?.title_suggestions.length && hasTitleMaterial(plan.brief)
          ? normalizeTitleSuggestions(p.proposal.title_suggestions)
          : null;
      const prevTitles = plan.brief.meta.title_suggestions?.items.map((x) => x.title).join("\n") ?? "";
      const suggestionsChanged = !!suggested && suggested.map((x) => x.title).join("\n") !== prevTitles;
      if (suggested && suggestionsChanged) {
        plan.brief.meta.title_suggestions = { items: suggested, generated_at: clock.date().toISOString(), run_id: ctx.run.runId, source: "turn" };
      }
      s = await persistPlan(tx, scope, s, plan, agentActor, { spent: p.costMicros, countTurn: !superseded, ...clearInflight });
      // the working title stays a preview (title_source=auto); without one the first suggestion previews
      const working = p.proposal?.working_title ?? (suggested ? { title: suggested[0]!.title, reason: suggested[0]!.reason } : null);
      const newTitle = await syncNovelTitle(tx, scope, plan.brief, [...plan.diffs.values()].flat(), working, agentActor);
      const titleNote = suggestionsChanged
        ? isMessenger(s)
          ? `\n\n추천 제목: ${suggested!.map((x, i) => `${i + 1}. ${x.title}`).join(" / ")}\n마음에 드는 제목을 말씀해 주시거나 웹의 제목 칸에서 고르세요.`
          : `\n\n(추천 제목 ${suggested!.length}개를 위쪽 제목 칸에 올려 두었어요. 고르거나 고쳐서 정할 수 있어요.)`
        : newTitle
          ? `\n\n(가제를 『${newTitle}』(으)로 붙여 두었어요. 마음에 드는 제목이 있으면 말씀해 주세요.)`
          : "";
      const msg = await insertMessage(tx, scope, s, {
        authorKind: "agent",
        kind: "question",
        body: `${plan.reply.body}${titleNote}`,
        runId: ctx.run.runId,
        options: plan.reply.options,
        askedFieldPaths: plan.reply.askedFieldPaths,
        respondsToSeq: handled[handled.length - 1]?.seq ?? null,
        isSuperseded: superseded,
      });
      if (superseded) {
        const newest = fresh[fresh.length - 1]!;
        const res = await orchestration.createTask(tx, scope, {
          kind: "concept_turn",
          targetType: "concept_session",
          targetId: s.id,
          input: { session_id: s.id },
          createdBy: orchestrator,
          cycleKey: newest.id,
          priority: TURN_PRIORITY,
        });
        if (res.taskId === ctx.task.id) {
          // the engine coalesced into the running task: enqueue right after commit
          tx.afterCommit(() => uow.run(async (tx2) => void (await enqueueTurn(tx2, scope, await mustSession(tx2, scope, s.id, true), newest.id, orchestrator))));
        } else await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: res.taskId });
      } else await deliver(tx, scope, s, msg);
      tx.afterCommit(() => streams.done(s.id, ctx.task.id, msg.id));
      return { kind: "done", outputRefs: [{ refType: "concept_message", refId: msg.id }] };
    },
  };

  /** write a planned turn/import/edit into the session row, message slot diffs and the audit log */
  async function persistPlan(
    tx: Tx,
    scope: NovelScope,
    s: ConceptSession,
    plan: Pick<PlanTurnOutput, "brief" | "stage" | "stageChange" | "diffs">,
    actor: ActorRef,
    o: { spent?: number; countTurn?: boolean; inFlightTaskId?: null } = {},
  ): Promise<ConceptSession> {
    let next = await repo.updateSession(tx.db, scope, s.id, {
      workingBrief: plan.brief,
      fieldFlipCounts: (plan.brief.meta as { flips?: Record<string, number> }).flips ?? {},
      spentMicros: s.spentMicros + (o.spent ?? 0),
      agentTurnCount: s.agentTurnCount + (o.countTurn ? 1 : 0),
      ...("inFlightTaskId" in o ? { inFlightTaskId: null } : {}),
    });
    for (const [messageId, diffs] of plan.diffs) {
      if (messageId === "_" || messageId === "_import") continue;
      const m = await repo.getMessage(tx.db, scope, messageId);
      if (m) await repo.updateMessage(tx.db, scope, messageId, { slotUpdates: [...((m.slotUpdates as SlotDiff[]) ?? []), ...diffs] });
    }
    if (plan.stageChange) {
      next = await changeStage(tx, scope, next, plan.stage, plan.stageChange.by === "user" ? actors.user(s.createdByUserId) : actor.type === "agent" ? actor : orchestrator);
    }
    return next;
  }

  const importHandler: TaskKindHandler<ImportInput, ImportOut> = {
    kind: "import_concept",
    role: "concept_partner",
    promptTemplateVersion: IMPORT_TEMPLATE_ID,
    inputSchema: z.object({ session_id: z.string(), message_id: z.string() }),
    onUncommitted: (tx, ctx, info) => runUncommitted(tx, ctx, info.proposal?.costMicros ?? 0),
    async execute(ctx) {
      const s = await mustSession(undefined, ctx.scope, ctx.input.session_id);
      const m = await repo.getMessage(uow.db, ctx.scope, ctx.input.message_id);
      if (!m) throw new NotFoundError("컨셉 메시지", ctx.input.message_id);
      const res = await callModel(ctx as TaskContext<unknown>, "import_concept", renderImportPrompt(parseWorkingBrief(s.workingBrief), m.body), "ConceptImportProposal", importProposalSchema);
      return { proposal: res?.value ?? null, costMicros: res?.costMicros ?? 0 };
    },
    async commit(tx, ctx, p) {
      const scope = ctx.scope;
      let s = await mustSession(tx, scope, ctx.input.session_id, true);
      const m = await repo.getMessage(tx.db, scope, ctx.input.message_id);
      if (s.status !== "active" || !m) {
        await repo.updateSession(tx.db, scope, s.id, { spentMicros: s.spentMicros + p.costMicros, ...(s.inFlightTaskId === ctx.task.id ? { inFlightTaskId: null } : {}) });
        return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
      }
      const b = parseWorkingBrief(s.workingBrief);
      const plan = planImport({ brief: b, stage: s.stage, message: toTurnMessage(m), proposal: p.proposal, lists: ports.lists, limits: limits(s), newId: () => ids.next("cnm") });
      plan.brief.meta.processed_seq = Math.max(b.meta.processed_seq ?? 0, m.seq);
      s = await persistPlan(tx, scope, s, plan, actors.agent("concept_partner", ctx.run.runId), {
        spent: p.costMicros,
        countTurn: true,
        ...(s.inFlightTaskId === ctx.task.id ? { inFlightTaskId: null } : {}),
      });
      const msg = await insertMessage(tx, scope, s, {
        authorKind: "agent",
        kind: "question",
        body: plan.reply.body,
        runId: ctx.run.runId,
        options: plan.reply.options,
        askedFieldPaths: plan.reply.askedFieldPaths,
        respondsToSeq: m.seq,
      });
      await deliver(tx, scope, s, msg);
      return { kind: "done", outputRefs: [{ refType: "concept_message", refId: msg.id }] };
    },
  };

  const checkHandler: TaskKindHandler<CheckInput, CheckOut> = {
    kind: "check_concept_brief",
    role: "continuity_editor",
    promptTemplateVersion: CHECK_TEMPLATE_ID,
    inputSchema: z.object({ session_id: z.string(), working_brief_hash: z.string(), requested_by_user_id: z.string() }),
    async execute(ctx) {
      const s = await mustSession(undefined, ctx.scope, ctx.input.session_id);
      const res = await callModel(ctx as TaskContext<unknown>, "check_concept_brief", renderCheckPrompt(parseWorkingBrief(s.workingBrief)), "ConceptBriefCheck", briefCheckProposalSchema);
      return { proposal: res?.value ?? null, costMicros: res?.costMicros ?? 0 };
    },
    async commit(tx, ctx, p) {
      const scope = ctx.scope;
      let s = await mustSession(tx, scope, ctx.input.session_id, true);
      s = await repo.updateSession(tx.db, scope, s.id, { spentMicros: s.spentMicros + p.costMicros });
      if (s.status !== "active") return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
      const b = parseWorkingBrief(s.workingBrief);
      b.checks = runDeterministicChecks(b, ports.lists, []);
      if (p.proposal) {
        b.checks.similarity.llm_overlap_signals = p.proposal.llm_overlap_signals;
        for (const f of p.proposal.safety_flags) {
          if (f.kind === "real_person") {
            const name = groundedRealPersonName(b.content, f.name);
            if (name) b.checks.safety.real_person_hits.push({ name, field_path: f.field_path, source: "llm" });
            else log.warn({ field: f.field_path }, "ignored an ungrounded real_person flag (no name from the brief)");
          }
          else if (f.kind === "over_age_rating") b.checks.safety.age_rating_flags.push({ field_path: f.field_path, keyword: f.note || "등급 초과", message_id: null });
          else b.checks.safety.minor_flags.push({ character_key: f.field_path ?? "unknown", note: f.note });
        }
      }
      b.checks.working_brief_hash = ctx.input.working_brief_hash;
      b.checks.checked_by_run_id = ctx.run.runId;
      s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: b });
      const user = actors.user(ctx.input.requested_by_user_id);
      if (workingBriefHash(b) !== ctx.input.working_brief_hash) {
        // INV-CON-13: the brief changed after the check started → re-run the check, CS3 waits
        await notice(tx, scope, s, "점검 중에 브리프가 바뀌어 다시 점검합니다.");
        tx.afterCommit(() => uow.run(async (tx2) => void (await startCheck(tx2, scope, await mustSession(tx2, scope, s.id, true), user).catch(() => undefined))));
        return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
      }
      const blockers = submitBlockers(b);
      if (blockers.length) {
        await notice(tx, scope, s, `승인 요청을 보낼 수 없습니다. ${blockers.map((x) => x.message).join(" ")}`);
        return { kind: "done", outputRefs: [{ refType: "concept_session", refId: s.id }] };
      }
      const brief = await submitBriefVersion(tx, scope, s, b, user, ctx.task.id);
      return { kind: "done", outputRefs: [{ refType: "concept_brief", refId: brief.id }] };
    },
  };

  /** CS3 + CB1 + A1 in one transaction (author_actor_type=user; LLM output never enters this path, 04 P-2) */
  async function submitBriefVersion(tx: Tx, scope: NovelScope, s: ConceptSession, b: WorkingBrief, user: ActorRef, taskId: string | null): Promise<ConceptBrief> {
    if (await repo.briefByStatus(tx.db, scope, "awaiting_approval")) {
      throw new ConflictError("concept_brief_pending", "이미 승인 대기 중인 컨셉 브리프가 있습니다.");
    }
    const approved = await repo.briefByStatus(tx.db, scope, "approved");
    const versionNo = await repo.nextBriefVersion(tx.db, scope);
    const n = await novel.getNovel(scope, tx);
    const content = { ...b.content, field_provenance: b.field_provenance, contribution_summary: contributionSummary(b), checks: b.checks };
    const brief = await repo.insertBrief(tx.db, {
      id: ids.next("cbf"),
      novelId: scope.novelId,
      sessionId: s.id,
      versionNo,
      status: "awaiting_approval",
      supersedesId: s.purpose === "revision" ? (s.baseBriefId ?? approved?.id ?? null) : null,
      authorActorType: "user",
      authorActorId: user.id,
      entryMode: s.entryMode,
      questionSetVersion: s.questionSetVersion,
      templateRefs: s.templateRefs ?? [],
      templateOverrides: [],
      content,
      contentMd: renderBriefMarkdown(b, b.content.title ?? n.title),
    });
    const summary = renderApprovalSummary(b, DEFAULTS["concept.messenger_summary_max_chars"]);
    const { approvalId } = await ports.hitl.requestApproval(tx, scope, {
      approvalType: "concept_brief",
      target: briefTarget(brief.id),
      question: {
        title: `컨셉 브리프 v${versionNo} 승인`,
        body: `${summary}\n\n유사성 점검은 법적 판단이 아닙니다.`,
        preview: [{ label: "로그라인", text: b.content.logline ?? "", ref: { refType: "concept_brief", refId: brief.id } }],
        links: [briefTarget(brief.id), target(s.id)],
      },
      requestedBy: user,
      taskId,
    });
    await repo.casBrief(tx.db, scope, brief.id, ["awaiting_approval"], { approvalId });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: user,
      action: "concept_brief.version_created",
      target: briefTarget(brief.id),
      after: { versionNo, status: "awaiting_approval", sessionId: s.id, contribution: content.contribution_summary },
      approvalId,
    });
    const next = await transition(tx, scope, s, "awaiting_approval", "CS3", { pendingApprovalId: approvalId }, user);
    await notice(tx, scope, next, "점검을 통과해 승인 요청을 보냈습니다. 인박스에서 [승인] 또는 [반려]를 눌러 주세요.");
    return { ...brief, approvalId };
  }

  // ── approval handler (hitl, concept_brief) ─────────────────────────────
  const REJECTION_HINTS: Array<[RegExp, string]> = [
    [/결말|엔딩/, "ending_direction"],
    [/로그라인/, "logline"],
    [/장르/, "category.genre_label"],
    [/주인공/, "protagonist.starting_condition"],
    [/욕망|목표/, "protagonist.desire"],
    [/대립|악역|적대/, "opposition"],
    [/훅|차별/, "core_hook"],
    [/등급/, "age_rating"],
  ];

  async function onApprovalDecided(ctx: ApprovalDecisionContext): Promise<void> {
    const { tx, scope, approval, actor } = ctx;
    const brief = await repo.getBrief(tx.db, scope, approval.subjectId, true);
    if (!brief) throw new NotFoundError("컨셉 브리프", approval.subjectId);
    let s = await mustSession(tx, scope, brief.sessionId, true);
    const b = parseWorkingBrief(s.workingBrief);
    const now = clock.date();
    if (ctx.decision === "approved") {
      const approvedBible = await novel.getApprovedBible(scope, tx);
      if (approvedBible) {
        // CB6 (MVP-β path): direction only, approved brief/novel untouched
        const r = await repo.casBrief(tx.db, scope, brief.id, ["awaiting_approval"], { status: "approved_direction", approvalId: approval.id, approvedAt: now });
        if (!r) throw new ConflictError("concept_brief_changed", "컨셉 브리프 상태가 먼저 바뀌었습니다.");
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.status_changed", target: briefTarget(brief.id), before: { status: brief.status }, after: { status: "approved_direction", rule: "CB6" }, approvalId: approval.id, answerId: ctx.answerId });
      } else {
        const prev = await repo.briefByStatus(tx.db, scope, "approved", true);
        if (prev && prev.id !== brief.id) {
          await repo.casBrief(tx.db, scope, prev.id, ["approved"], { status: "superseded" });
          await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.status_changed", target: briefTarget(prev.id), before: { status: "approved" }, after: { status: "superseded", rule: "CB5" }, approvalId: approval.id });
        }
        const r = await repo.casBrief(tx.db, scope, brief.id, ["awaiting_approval"], { status: "approved", approvalId: approval.id, approvedAt: now });
        if (!r) throw new ConflictError("concept_brief_changed", "컨셉 브리프 상태가 먼저 바뀌었습니다.");
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.status_changed", target: briefTarget(brief.id), before: { status: brief.status }, after: { status: "approved", rule: "CB2" }, approvalId: approval.id, answerId: ctx.answerId });
        const c = (brief.content ?? {}) as WorkingBrief["content"];
        const tropes = c.category?.trope_labels ?? [];
        await novel.applyConceptApproval(
          tx,
          scope,
          {
            conceptBriefId: brief.id,
            purpose: s.purpose,
            title: c.title,
            titleCandidates: c.title_candidates,
            genre: `${c.category?.genre_label ?? c.category?.genre_key ?? ""}${tropes.length ? ` · ${tropes.join(", ")}` : ""}`,
            ageRating: c.age_rating ?? "age_15",
            targetAudience: c.target?.readers ?? null,
            defaultNarrationMode: c.tone?.narration_mode,
            category: (c.category ?? {}) as Record<string, unknown>,
            approvalId: approval.id,
          },
          actor,
        );
        if (s.purpose === "revision") tx.afterCommit(() => supersedePlanning(scope, brief.id, actor));
      }
      s = await transition(tx, scope, s, "approved", "CS4", { approvedBriefId: brief.id, pendingApprovalId: null, inFlightTaskId: null }, actor);
      await notice(tx, scope, s, "컨셉이 승인됐습니다. 목표 폼에서 화수·연재 주기·결말 방향 초안을 확인하고 저장해 주세요.");
      return;
    }
    // A3 → CB3 + CS5 (stage converging, decision note as system message, mentioned fields re-asked)
    await repo.casBrief(tx.db, scope, brief.id, ["awaiting_approval"], { status: "rejected", approvalId: approval.id });
    await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.status_changed", target: briefTarget(brief.id), before: { status: brief.status }, after: { status: "rejected", rule: "CB3" }, reason: ctx.decisionNote, approvalId: approval.id, answerId: ctx.answerId });
    const note = ctx.decisionNote?.trim() || "사유 없음";
    for (const [re, path] of REJECTION_HINTS) {
      if (!re.test(note)) continue;
      const p = b.field_provenance[path];
      if (p && p.slot_state === "confirmed") p.slot_state = "proposed";
      // CS5 / INV-CON-03: a mention in the decision note only re-asks; the logline keeps its value and
      // is re-confirmed (value changes of parent fields clear it later via applyDependencies, 3.7).
      const lp = b.field_provenance.logline;
      if (path !== "logline" && lp && lp.slot_state === "confirmed") lp.slot_state = "proposed";
    }
    s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: b });
    s = await transition(tx, scope, s, "active", "CS5", { pendingApprovalId: null }, actor, note);
    if (s.stage !== "converging") s = await changeStage(tx, scope, s, "converging", actor);
    const msg = await notice(tx, scope, s, `컨셉 브리프가 반려됐습니다. 사유: ${note}`);
    await enqueueTurn(tx, scope, s, msg.id, actor);
  }

  /** FR-NOV-10a (pre-bible revision): replace in-flight planning with the new brief (3.10). Post-commit follow-up. */
  async function supersedePlanning(scope: NovelScope, briefId: string, actor: ActorRef) {
    try {
      const tasks = await orchestration.listTasks(scope, { kinds: ["plan_series_bible"], statuses: ["pending", "ready", "running", "blocked"] });
      const bibles = (await novel.listBibles(scope)).filter((x) => x.status === "draft" || x.status === "awaiting_approval");
      await uow.run(async (tx) => {
        for (const t of tasks) await orchestration.cancelTask(tx, scope, t.id, actor);
        for (const bible of bibles) {
          if (bible.status === "awaiting_approval" && bible.approvalId) await ports.hitl.cancelApproval(tx, scope, bible.approvalId, "컨셉 개정으로 기획서를 다시 씁니다.", actor).catch(() => undefined);
          await novel.transitionBible(tx, scope, bible.id, "superseded", actor, { reason: "컨셉 개정 승인" });
        }
        const n = await novel.getNovel(scope, tx);
        if (n.status === "planning") {
          await orchestration.createTask(tx, scope, {
            kind: "plan_series_bible",
            targetType: "novel",
            targetId: scope.novelId,
            input: { concept_brief_id: briefId, source_message_ids: [] },
            createdBy: actor,
            cycleKey: `concept_revision:${briefId}`,
          });
        }
      });
    } catch (err) {
      log.warn({ err, novelId: scope.novelId }, "concept revision: superseding planning failed");
    }
  }

  // ── inbound (messaging concept_message) ────────────────────────────────
  async function onInbound(action: InboundAction, ctx: InboundContext): Promise<InboundResult> {
    if (action.kind !== "concept_message") return { status: "ignored", reason: "unsupported" };
    const { tx, scope } = ctx;
    if (await repo.findByInbox(tx.db, scope, ctx.inboxId)) return { status: "ignored", reason: "duplicate" }; // NFR-REL-02
    let s = action.conceptSessionId ? await repo.getSession(tx.db, scope, action.conceptSessionId, true) : await repo.getOpenSession(tx.db, scope, true);
    // no open session: messaging falls through to its own routing (incl. the MVP-β "컨셉 고치기" guidance, 3.10)
    if (!s || TERMINAL.includes(s.status)) return { status: "ignored", reason: "unsupported" };
    const ov = action.optionValue ?? undefined;
    const idx = ov !== undefined && /^\d+$/.test(ov) ? Number(ov) : null;
    const key = controlKeyOf(ov);
    // messenger replies go to this channel from now on (4.4)
    if (s.activeChannelId !== ctx.channel.id) s = await repo.updateSession(tx.db, scope, s.id, { activeChannelId: ctx.channel.id });
    if (s.status === "awaiting_approval") {
      if (key === "yes") {
        await cancelPendingApproval(tx, scope, s, ctx.actor, "사용자가 대화를 이어 감");
        s = await transition(tx, scope, s, "active", "CS9", { pendingApprovalId: null }, ctx.actor);
        await notice(tx, scope, s, "승인 요청을 취소했습니다. 이어서 말씀해 주세요.");
      } else if (key === "no") {
        await notice(tx, scope, s, "승인 요청을 그대로 둡니다.");
      } else {
        await notice(tx, scope, s, "승인 요청을 취소하고 대화를 이어 갈까요?", [control("yes"), control("no")]);
      }
      return { status: "processed" };
    }
    if (s.status === "paused" && s.pauseReason === "budget_limit") {
      if (key === "raiseBudget") await notice(tx, scope, s, "상한은 PC 웹 설정에서 올려 주세요.");
      else if (key === "formMode") {
        s = await enterFormMode(tx, scope, s, ctx.actor);
        await notice(tx, scope, s, "PC 웹 폼에서 마저 입력해 주세요.");
      } else if (key === "defer" || key === "later") await notice(tx, scope, s, "알겠습니다. 나중에 이어 가겠습니다.");
      else {
        await insertMessage(tx, scope, s, { authorKind: "user", kind: "text", body: action.text, channelId: ctx.channel.id, authorUserId: ctx.actor.id, inboxId: ctx.inboxId });
        await budgetNotice(tx, scope, s);
      }
      return { status: "processed" };
    }
    // stale button (4.2 condition 2): a user message after the latest prompt
    if (idx !== null || key) {
      const prompt = await repo.latestPrompt(tx.db, scope, s.id);
      const lastUser = await repo.lastUserSeq(tx.db, scope, s.id);
      const refMismatch = !!(prompt?.providerMessageRef && ctx.providerMessageRef && prompt.providerMessageRef !== ctx.providerMessageRef);
      if (prompt && (lastUser > prompt.seq || refMismatch)) {
        await notice(tx, scope, s, "지난 질문의 버튼입니다(이미 답했거나 새 질문이 있습니다).");
        return { status: "ignored", reason: "unsupported" };
      }
    }
    await postUserMessageTx(
      tx,
      scope,
      s,
      { body: action.text, kind: idx !== null || key ? "option_pick" : "text", optionValue: ov, channelId: ctx.channel.id, sourceKey: ctx.inboxId },
      ctx.actor,
      { inboxId: ctx.inboxId, pickedIdx: idx },
    );
    return { status: "processed" };
  }

  async function enterFormMode(tx: Tx, scope: NovelScope, s: ConceptSession, actor: ActorRef): Promise<ConceptSession> {
    const before = s.entryMode;
    let next = await repo.updateSession(tx.db, scope, s.id, { entryMode: "direct_input", llmDisabled: s.status === "paused" && s.pauseReason === "budget_limit" ? true : s.llmDisabled });
    await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_session.entry_mode_changed", target: target(s.id), before: { entryMode: before }, after: { entryMode: "direct_input", llmDisabled: next.llmDisabled } });
    if (next.status === "paused") next = await transition(tx, scope, next, "active", "CS7", { pauseReason: null }, actor, "폼으로 마저 입력");
    return next;
  }

  // ── use cases ──────────────────────────────────────────────────────────
  async function postUserMessageTx(
    tx: Tx,
    scope: NovelScope,
    locked: ConceptSession,
    input: PostMessageInput & { pickedIdx?: number | null },
    actor: ActorRef,
    o: { inboxId?: string | null; pickedIdx?: number | null } = {},
  ): Promise<{ message: ConceptMessage; taskId: string | null }> {
    if (actor.type !== "user") throw new DomainValidationError("user_actor_required", "사용자 메시지만 저장할 수 있습니다.");
    let s = locked;
    if (o.inboxId) {
      const dup = await repo.findByInbox(tx.db, scope, o.inboxId);
      if (dup) return { message: dup, taskId: null };
    }
    if (TERMINAL.includes(s.status)) throw new InvalidStateError(s.status);
    if (input.rejectWhileTurnInFlight && (await liveInFlightTask(tx, scope, s))) {
      // web chat: one agent turn at a time (a second tab / double send must not race the running turn)
      throw new ConflictError("concept_turn_in_flight", "컨셉 파트너가 답을 쓰는 중입니다. 답변이 끝난 뒤에 보내 주세요.", { inFlightTaskId: s.inFlightTaskId });
    }
    if (s.status === "awaiting_approval") {
      await cancelPendingApproval(tx, scope, s, actor, "사용자가 대화를 이어 감");
      s = await transition(tx, scope, s, "active", "CS9", { pendingApprovalId: null }, actor);
    }
    const kind = input.kind ?? "text";
    if (s.status === "paused") {
      if (s.pauseReason === "budget_limit") {
        const message = await insertMessage(tx, scope, s, { authorKind: "user", kind: kind === "option_pick" ? "text" : kind, body: input.body, channelId: input.channelId, authorUserId: actor.id, inboxId: o.inboxId });
        await budgetNotice(tx, scope, s);
        return { message, taskId: null };
      }
      s = await transition(tx, scope, s, "active", "CS7", { pauseReason: null }, actor, "메시지로 이어 하기");
    }
    let body = input.body;
    let pickedIdx: number | null = input.pickedIdx ?? o.pickedIdx ?? null;
    let picked: StoredOption | null = null;
    if (kind === "option_pick") {
      const prompt = await repo.latestPrompt(tx.db, scope, s.id);
      picked = resolveOption(prompt ? toTurnMessage(prompt) : null, { id: "", seq: 0, authorKind: "user", kind, body, channelId: input.channelId, pickedIdx, options: null, askedFieldPaths: null }, input.optionValue ?? null);
      if (!picked) throw new DomainValidationError("concept_option_not_found", "고른 선택지를 찾을 수 없습니다. 새로 고친 뒤 다시 골라 주세요.");
      body = picked.label;
      pickedIdx = picked.idx >= 0 ? picked.idx : null;
    }
    if (kind === "import_text" && body.length > DEFAULTS["concept.import_max_chars"]) {
      throw new DomainValidationError("import_too_long", `붙여 넣기는 ${DEFAULTS["concept.import_max_chars"].toLocaleString("ko-KR")}자까지 받을 수 있습니다.`);
    }
    if (!body.trim()) throw new DomainValidationError("empty_message", "빈 메시지는 보낼 수 없습니다.");
    const message = await insertMessage(tx, scope, s, {
      authorKind: "user",
      kind,
      body,
      channelId: input.channelId,
      authorUserId: actor.id,
      inboxId: o.inboxId,
      pickedIdx: kind === "option_pick" ? pickedIdx : null,
    });
    s = await repo.updateSession(tx.db, scope, s.id, {
      userMessageCount: s.userMessageCount + 1,
      lastUserMessageAt: clock.date(),
      remindedAt: null,
      activeChannelId: input.channelId,
    });
    // immediate controls (no model turn needed)
    const key = picked?.source === "control" ? controlKeyOf(picked.value) : null;
    if (key === "later") {
      await transition(tx, scope, s, "paused", "CS6", { pauseReason: "user" }, actor, "나중에");
      return { message, taskId: null };
    }
    if (key === "raiseBudget") {
      await notice(tx, scope, s, "상한은 PC 웹 설정에서 올려 주세요.");
      return { message, taskId: null };
    }
    if (key === "formMode") {
      s = await enterFormMode(tx, scope, s, actor);
      await notice(tx, scope, s, "브리프 패널의 폼에서 남은 항목을 직접 입력해 주세요. 필수 항목을 채우면 [승인 요청]을 누를 수 있습니다.");
      return { message, taskId: null };
    }
    if (key === "submit") {
      const { taskId } = await startCheck(tx, scope, s, actor);
      return { message, taskId };
    }
    if (key === "extendTurns") {
      s = await extendTx(tx, scope, s, { turns: 1 }, actor);
    }
    if (kind === "import_text") {
      if (s.entryMode !== "import") {
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_session.entry_mode_changed", target: target(s.id), before: { entryMode: s.entryMode }, after: { entryMode: "import" } });
        s = await repo.updateSession(tx.db, scope, s.id, { entryMode: "import" });
      }
      if (budgetExhausted(s)) {
        s = await transition(tx, scope, s, "paused", "CS6", { pauseReason: "budget_limit" }, actors.system("budget_guard"), "세션 비용 상한");
        await budgetNotice(tx, scope, s);
        return { message, taskId: null };
      }
      const { taskId } = await orchestration.createTask(tx, scope, {
        kind: "import_concept",
        targetType: "concept_session",
        targetId: s.id,
        input: { session_id: s.id, message_id: message.id },
        createdBy: actor,
        cycleKey: message.id,
        priority: TURN_PRIORITY,
      });
      await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: taskId });
      return { message, taskId };
    }
    const taskId = await enqueueTurn(tx, scope, s, message.id, actor);
    return { message, taskId };
  }

  async function extendTx(tx: Tx, scope: NovelScope, s: ConceptSession, input: { turns?: number; budgetMicros?: number }, actor: ActorRef): Promise<ConceptSession> {
    const patch: Parameters<typeof repo.updateSession>[3] = {};
    if (input.turns) {
      if (s.turnExtensionCount >= DEFAULTS["concept.max_turn_extensions"]) {
        throw new DomainValidationError("turn_extension_exhausted", "턴 연장은 세션당 2회까지입니다. 남은 항목은 [전부 맡기기]나 폼으로 정리해 주세요.");
      }
      patch.turnLimit = s.turnLimit + DEFAULTS["concept.turn_extension"];
      patch.turnExtensionCount = s.turnExtensionCount + 1;
    }
    if (input.budgetMicros !== undefined) {
      if (input.budgetMicros <= s.budgetLimitMicros) throw new DomainValidationError("budget_not_raised", "지금 상한보다 큰 금액으로만 올릴 수 있습니다.");
      patch.budgetLimitMicros = input.budgetMicros;
    }
    if (!Object.keys(patch).length) throw new DomainValidationError("nothing_to_extend", "늘릴 항목을 지정해 주세요.");
    let next = await repo.updateSession(tx.db, scope, s.id, patch);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "concept_session.limit_extended",
      target: target(s.id),
      before: { turnLimit: s.turnLimit, budgetLimitMicros: s.budgetLimitMicros },
      after: { turnLimit: next.turnLimit, budgetLimitMicros: next.budgetLimitMicros, turnExtensionCount: next.turnExtensionCount },
    });
    if (next.status === "paused" && next.pauseReason === "budget_limit" && next.budgetLimitMicros > next.spentMicros + checkReserve + TURN_RESERVE_MICROS) {
      next = await transition(tx, scope, next, "active", "CS7", { pauseReason: null, llmDisabled: false }, actor, "비용 상한 상향");
    }
    return next;
  }

  async function hasUnprocessed(tx: Tx, scope: NovelScope, s: ConceptSession) {
    const b = parseWorkingBrief(s.workingBrief);
    return (await repo.userMessagesAfter(tx.db, scope, s.id, b.meta.processed_seq ?? 0)).length > 0;
  }

  const service: ConceptServiceExt = {
    async startInitialSession(tx, scope, input, actor) {
      return createSession(tx, scope, input, actor, emptyWorkingBrief({ web_channel_id: input.activeChannelId }));
    },

    startRevision(scope, actor) {
      return uow.run(async (tx) => {
        const n = await novel.getNovel(scope, tx);
        if (n.status === "concept") throw new DomainValidationError("revision_before_initial", "첫 컨셉 승인 전에는 개정할 수 없습니다.");
        if (n.status === "archived" || n.status === "completed") throw new DomainValidationError("novel_closed", "완결·보관된 작품의 컨셉은 고칠 수 없습니다.");
        if (await novel.getApprovedBible(scope, tx)) {
          throw new DomainValidationError(
            "revision_after_bible_unsupported",
            "연재 중 컨셉 개정은 다음 버전에서 제공합니다. 지금은 기획서 수정·캐논 변경(canon_change)·결말 변경(ending_change)으로 바꿀 수 있습니다.",
          );
        }
        if (await repo.getOpenSession(tx.db, scope)) throw new ConflictError("concept_session_open", "이미 진행 중인 컨셉 세션이 있습니다.");
        const base = await repo.briefByStatus(tx.db, scope, "approved");
        if (!base) throw new DomainValidationError("no_approved_brief", "승인된 컨셉 브리프가 없습니다.");
        const prevSession = await repo.getSession(tx.db, scope, base.sessionId);
        const raw = (base.content ?? {}) as Record<string, unknown>;
        const { field_provenance, contribution_summary: _cs, checks: _ck, ...content } = raw;
        const wb = parseWorkingBrief({ content, field_provenance, meta: { web_channel_id: prevSession ? webChannelOf(prevSession) : undefined } });
        const webId = wb.meta.web_channel_id ?? prevSession?.activeChannelId;
        if (!webId) throw new DomainValidationError("web_channel_missing", "웹 채널을 찾을 수 없습니다.");
        const s = await createSession(tx, scope, { entryMode: "conversation", activeChannelId: webId, createdByUserId: actor.id, purpose: "revision", baseBriefId: base.id }, actor, wb);
        return repo.updateSession(tx.db, scope, s.id, { stage: "converging" });
      });
    },

    async getActiveSession(scope, tx) {
      return repo.getOpenSession(tx?.db ?? uow.db, scope);
    },
    getSession: (scope, sessionId, tx) => mustSession(tx, scope, sessionId),
    async listMessages(scope, sessionId, opts) {
      await mustSession(undefined, scope, sessionId);
      return repo.listMessages(uow.db, scope, sessionId, opts);
    },

    postUserMessage(scope, sessionId, input, actor, tx) {
      return uow.join(tx, async (t) => postUserMessageTx(t, scope, await mustSession(t, scope, sessionId, true), input, actor));
    },

    editWorkingBrief(scope, sessionId, path, value, actor) {
      return uow.run(async (tx) => {
        let s = await mustSession(tx, scope, sessionId, true);
        if (actor.type !== "user") throw new DomainValidationError("user_actor_required", "사용자만 브리프를 직접 고칠 수 있습니다.");
        if (!isKnownPath(path)) throw new DomainValidationError("unknown_field", `알 수 없는 브리프 항목입니다: ${path}`);
        if (path === "age_rating" && typeof value === "string" && /19/.test(value)) throw new DomainValidationError("age_rating_not_supported", "현재는 15세 이용가까지만 지원합니다.");
        if (TERMINAL.includes(s.status)) throw new InvalidStateError(s.status);
        if (s.status === "awaiting_approval") {
          await cancelPendingApproval(tx, scope, s, actor, "사용자가 브리프를 고침");
          s = await transition(tx, scope, s, "active", "CS9", { pendingApprovalId: null }, actor);
        }
        if (s.status === "paused" && s.pauseReason !== "budget_limit") s = await transition(tx, scope, s, "active", "CS7", { pauseReason: null }, actor, "브리프 수정");
        if (s.status === "paused" && !s.llmDisabled) throw new InvalidStateError(s.status);
        const before = getPath(parseWorkingBrief(s.workingBrief).content, path);
        const msg = await insertMessage(tx, scope, s, { authorKind: "user", kind: "form_edit", body: `'${slotLabel(path)}' 수정`, authorUserId: actor.id });
        const plan = planFieldEdit({
          brief: parseWorkingBrief(s.workingBrief),
          stage: s.stage,
          entryMode: s.entryMode,
          messageId: msg.id,
          path,
          value,
          lists: ports.lists,
          flipLimit: DEFAULTS["concept.slot_flip_limit"],
          newId: () => ids.next("cnm").replace("cnm_", "cpr_"),
        });
        if (getPath(plan.brief.content, path) === undefined && value !== null && !(typeof value === "string" && !value.trim())) {
          throw new DomainValidationError("invalid_field_value", `'${slotLabel(path)}' 값으로 쓸 수 없습니다.`);
        }
        await repo.updateMessage(tx.db, scope, msg.id, { slotUpdates: plan.diffs });
        await syncNovelTitle(tx, scope, plan.brief, plan.diffs, null, actor);
        s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: plan.brief, fieldFlipCounts: (plan.brief.meta as { flips?: Record<string, number> }).flips ?? {}, userMessageCount: s.userMessageCount + 1, lastUserMessageAt: clock.date() });
        if (plan.stage !== s.stage) s = await changeStage(tx, scope, s, plan.stage, actor);
        const short = (v: unknown) => valueToText(v).slice(0, 200);
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.field_edited", target: target(s.id), before: { path, value: short(before) }, after: { path, value: short(getPath(plan.brief.content, path)) } });
        if (plan.notices.length) await notice(tx, scope, s, [...new Set(plan.notices)].join("\n"));
        return s;
      });
    },

    requestTitleSuggestions(scope, sessionId, actor) {
      return uow.run((tx) => requestTitleSuggestionsTx(tx, scope, sessionId, actor));
    },

    async chooseTitle(scope, sessionId, title, actor) {
      if (actor.type !== "user") throw new DomainValidationError("user_actor_required", "사용자만 제목을 정할 수 있습니다.");
      const t = cleanTitle(title);
      if (!t) throw new DomainValidationError("invalid_title", "쓸 수 있는 제목을 입력해 주세요.");
      const s = await mustSession(undefined, scope, sessionId);
      // closed session (approved/abandoned): the brief is frozen, only the novel title changes
      if (TERMINAL.includes(s.status)) {
        await novel.updateSettings(scope, { title: t, confirmTitle: true }, actor);
        return s;
      }
      // editing the brief while awaiting approval would silently withdraw the approval request (review3 #7)
      if (s.status === "awaiting_approval") {
        throw new DomainValidationError("title_locked_awaiting_approval", "승인을 기다리는 중에는 제목을 바꿀 수 없습니다. 승인 요청을 취소한 뒤에 바꾸거나, 승인한 뒤 작품 설정에서 바꾸세요.");
      }
      // brief `title` (user_edited) → novel title_source=user via syncNovelTitle; approval keeps it (N2)
      return service.editWorkingBrief(scope, sessionId, "title", t, actor);
    },

    async setStage(tx, scope, sessionId, stage, actor) {
      const s = await mustSession(tx, scope, sessionId, true);
      if (s.status !== "active") throw new InvalidStateError(s.status);
      return changeStage(tx, scope, s, stage, actor);
    },

    async inFlightTurnTaskId(scope, sessionId) {
      return liveInFlightTask(undefined, scope, await mustSession(undefined, scope, sessionId));
    },

    stopTurn(scope, sessionId, actor) {
      return uow.run(async (tx) => {
        // lock order task → session, like the engine's commit (task fenced FOR UPDATE, then the handler locks the session)
        const peek = await mustSession(tx, scope, sessionId);
        if (!peek.inFlightTaskId) return peek;
        let taskId = await liveInFlightTask(tx, scope, peek);
        // running → cancel_requested; the engine drops the turn at its next safe point or at the commit (never both a
        // stop notice and a reply); queued → cancelled now
        if (taskId) {
          try {
            await orchestration.cancelTask(tx, scope, taskId, actor);
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
            taskId = null; // finished meanwhile (its commit won the race)
          }
        }
        const s = await mustSession(tx, scope, sessionId, true);
        if (s.inFlightTaskId !== peek.inFlightTaskId) return s; // a commit or a new turn changed it meanwhile
        await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: null });
        if (taskId) await notice(tx, scope, s, "답변을 멈췄습니다. 메시지를 보내면 앞의 메시지까지 함께 보고 다시 답합니다.");
        tx.afterCommit(() => streams.done(s.id, taskId, null));
        return mustSession(tx, scope, s.id);
      });
    },

    pauseSession(scope, sessionId, reason, actor) {
      return uow.run(async (tx) => {
        const s = await mustSession(tx, scope, sessionId, true);
        return transition(tx, scope, s, "paused", "CS6", { pauseReason: reason }, actor, labelKo("concept_pause_reason", reason));
      });
    },

    resumeSession(scope, sessionId, actor) {
      return uow.run(async (tx) => {
        let s = await mustSession(tx, scope, sessionId, true);
        if (s.status !== "paused") throw new InvalidTransitionError2(s.status);
        if (s.pauseReason === "budget_limit" && !(s.budgetLimitMicros > s.spentMicros + checkReserve + TURN_RESERVE_MICROS)) {
          throw new DomainValidationError("concept_budget_limit", "세션 비용 상한에 닿아 있습니다. 상한을 올리거나 [폼으로 마저 입력]을 고르세요.");
        }
        s = await transition(tx, scope, s, "active", "CS7", { pauseReason: null }, actor, "이어 하기");
        if (s.entryMode === "conversation" && !s.llmDisabled) {
          await enqueueTurn(tx, scope, s, `resume:${s.id}:${s.userMessageCount}:${clock.date().getTime()}`, actor, (await hasUnprocessed(tx, scope, s)) ? {} : { resume: true });
        }
        return mustSession(tx, scope, s.id);
      });
    },

    extendLimit(scope, sessionId, input, actor) {
      return uow.run(async (tx) => {
        const s = await extendTx(tx, scope, await mustSession(tx, scope, sessionId, true), input, actor);
        if (s.status === "active" && (await hasUnprocessed(tx, scope, s))) {
          const last = (await repo.userMessagesAfter(tx.db, scope, s.id, parseWorkingBrief(s.workingBrief).meta.processed_seq ?? 0)).pop();
          await enqueueTurn(tx, scope, s, last?.id ?? `extend:${s.id}`, actor);
        }
        return mustSession(tx, scope, s.id);
      });
    },

    switchEntryMode(scope, sessionId, mode, actor) {
      return uow.run(async (tx) => {
        let s = await mustSession(tx, scope, sessionId, true);
        if (TERMINAL.includes(s.status) || s.status === "awaiting_approval") throw new InvalidStateError(s.status);
        if (mode === "direct_input") return enterFormMode(tx, scope, s, actor);
        if (s.entryMode === mode) return s;
        const prevMode = s.entryMode;
        const llmDisabled = s.llmDisabled && budgetExhausted(s);
        s = await repo.updateSession(tx.db, scope, s.id, { entryMode: mode, llmDisabled });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_session.entry_mode_changed", target: target(s.id), before: { entryMode: prevMode }, after: { entryMode: mode, llmDisabled } });
        if (s.status === "paused" && s.pauseReason !== "budget_limit") s = await transition(tx, scope, s, "active", "CS7", { pauseReason: null }, actor);
        if (mode === "conversation") {
          if (s.stage === "opening") s = await changeStage(tx, scope, s, "diverging", actor);
          await enqueueTurn(tx, scope, s, `mode:${s.id}:${clock.date().getTime()}`, actor, { resume: true }); // "대화로 마저 채우기"
        } else if (mode === "import") {
          await notice(tx, scope, s, "시놉시스·메모를 붙여 넣어 주세요. 붙여 넣은 원문은 LLM 공급자로 전송됩니다.");
        }
        return mustSession(tx, scope, s.id);
      });
    },

    abandonSession(scope, sessionId, actor) {
      return uow.run(async (tx) => (await abandonTx(tx, scope, sessionId, actor)).abandoned);
    },

    restartSession(scope, sessionId, actor) {
      return uow.run(async (tx) => {
        const { abandoned } = await abandonTx(tx, scope, sessionId, actor);
        const n = await novel.getNovel(scope, tx);
        if (n.status !== "concept") throw new DomainValidationError("restart_after_approval", "승인된 컨셉은 [컨셉 고치기]로 개정해 주세요.");
        const session = await createSession(tx, scope, { entryMode: abandoned.entryMode, activeChannelId: webChannelOf(abandoned), createdByUserId: userIdOf(actor, abandoned) }, actor, emptyWorkingBrief({ web_channel_id: webChannelOf(abandoned) }));
        return { abandoned, session };
      });
    },

    submitForApproval(scope, sessionId, actor) {
      return uow.run(async (tx) => startCheck(tx, scope, await mustSession(tx, scope, sessionId, true), actor));
    },

    async getBrief(scope, briefId, tx) {
      const b = await repo.getBrief(tx?.db ?? uow.db, scope, briefId);
      if (!b) throw new NotFoundError("컨셉 브리프", briefId);
      return b;
    },
    listBriefs: (scope) => repo.listBriefs(uow.db, scope),
    getApprovedBrief: (scope, tx) => repo.briefByStatus(tx?.db ?? uow.db, scope, "approved"),
    sessionStatusLabel: (status) => labelKo("concept_session_status", status),

    async getSessionView(scope, sessionId) {
      const s = sessionId ? await mustSession(undefined, scope, sessionId) : ((await repo.getOpenSession(uow.db, scope)) ?? (await repo.latestSession(uow.db, scope)));
      if (!s) return null;
      const b = parseWorkingBrief(s.workingBrief);
      const req = requiredPaths(b.content);
      const missing = missingRequired(b);
      const blockers = submitBlockers({ ...b, checks: runDeterministicChecks(b, ports.lists, []) });
      const step = selectNext(b, s.stage, {});
      const badges: SessionView["fieldBadges"] = {};
      for (const [path, p] of Object.entries(b.field_provenance)) {
        badges[path] = { originLabel: labelKo("concept_field_origin", p.origin), stateLabel: labelKo("concept_slot_state", p.slot_state) };
      }
      return {
        session: s,
        workingBrief: b,
        progress: { requiredTotal: req.length, requiredConfirmed: req.length - missing.length, missing: missing.map((p) => ({ path: p, label: slotLabel(p) })) },
        blockers,
        canSubmit: s.status === "active" && blockers.length === 0,
        turns: { used: s.agentTurnCount, limit: s.turnLimit, extensionsLeft: Math.max(0, DEFAULTS["concept.max_turn_extensions"] - s.turnExtensionCount), softWarning: DEFAULTS["concept.turn_soft_warning"] },
        budget: { spentMicros: s.spentMicros, limitMicros: s.budgetLimitMicros, checkReserveMicros: checkReserve },
        statusLabel: labelKo("concept_session_status", s.status),
        stageLabel: labelKo("concept_stage", s.stage),
        fieldBadges: badges,
        // a closed / waiting session has no "next question" (review3 visual #3)
        nextStep: s.status === "active" ? { kind: step.kind, path: "path" in step ? step.path : null, text: step.text } : { kind: s.status === "awaiting_approval" ? "awaiting_approval" : "closed", path: null, text: "" },
        titleSuggestions: await titleSuggestionsView(scope, s, b),
      };
    },

    async getGoalFormDefaults(scope) {
      const brief = await repo.briefByStatus(uow.db, scope, "approved");
      if (!brief) return null;
      const c = (brief.content ?? {}) as WorkingBrief["content"];
      const tropes = (c.category?.trope_labels ?? []).map(normalizeText);
      return {
        conceptBriefId: brief.id,
        endingDirection: c.ending_direction ?? null,
        totalEpisodesMin: c.serial_plan?.total_episodes_min ?? null,
        totalEpisodesMax: c.serial_plan?.total_episodes_max ?? null,
        cadenceEpisodesPerWeek: c.serial_plan?.cadence_episodes_per_week ?? null,
        lengthHint: c.serial_plan?.length_hint ?? null,
        suggestMultiTimeline: tropes.some((t) => t.includes("회귀")),
        suggestPossessionMode: tropes.some((t) => t.includes("빙의")),
      };
    },

    decideChangeProposal(scope, sessionId, proposalId, decision, actor) {
      return uow.run(async (tx) => {
        let s = await mustSession(tx, scope, sessionId, true);
        if (s.status !== "active") throw new InvalidStateError(s.status);
        const b = parseWorkingBrief(s.workingBrief);
        const cp = b.change_proposals.find((p) => p.id === proposalId && p.status === "pending");
        if (!cp) throw new NotFoundError("변경 제안", proposalId);
        const msg = await insertMessage(tx, scope, s, { authorKind: "user", kind: "form_edit", body: decision === "accepted" ? `'${slotLabel(cp.field_path)}' 변경 제안 수락` : `'${slotLabel(cp.field_path)}' 변경 제안 거절`, authorUserId: actor.id });
        const before = getPath(b.content, cp.field_path);
        let diffs: SlotDiff[] = [];
        if (decision === "accepted") {
          const plan = planTurn({
            brief: b,
            stage: s.stage,
            entryMode: s.entryMode,
            messages: [{ id: msg.id, seq: msg.seq, authorKind: "user", kind: "option_pick", body: msg.body, channelId: msg.channelId, pickedIdx: null, options: null, askedFieldPaths: null }],
            prompt: { id: "_", seq: 0, authorKind: "system", kind: "question", body: "", channelId: "", pickedIdx: null, options: [{ idx: 1, label: msg.body, value: `@accept_proposal:${cp.id}`, source: "control" }], askedFieldPaths: null },
            proposal: null,
            runId: null,
            lists: ports.lists,
            limits: limits(s),
            newId: () => ids.next("cnm").replace("cnm_", "cpr_"),
          });
          // keep only the brief effects of the acceptance (no reply)
          plan.brief.meta.processed_seq = b.meta.processed_seq;
          diffs = plan.diffs.get(msg.id) ?? [];
          s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: plan.brief });
        } else {
          cp.status = "rejected";
          s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: b });
        }
        await repo.updateMessage(tx.db, scope, msg.id, { slotUpdates: diffs });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "concept_brief.change_proposal_decided",
          target: target(s.id),
          before: { path: cp.field_path, value: valueToText(before).slice(0, 200) },
          after: { path: cp.field_path, decision, value: valueToText(cp.new_value).slice(0, 200) },
        });
        return s;
      });
    },

    confirmFields(scope, sessionId, which, actor) {
      return uow.run(async (tx) => {
        let s = await mustSession(tx, scope, sessionId, true);
        if (s.status !== "active") throw new InvalidStateError(s.status);
        const b = parseWorkingBrief(s.workingBrief);
        const paths =
          typeof which === "object"
            ? which.paths
            : Object.entries(b.field_provenance)
                .filter(([, p]) => p.slot_state === "proposed" && p.origin === (which === "imported" ? "imported" : "agent_delegated"))
                .map(([k]) => k);
        const msg = await insertMessage(tx, scope, s, { authorKind: "user", kind: "form_edit", body: typeof which === "object" ? "항목 확정" : which === "imported" ? "추출값 전체 확인" : "에이전트가 정한 항목 모두 확정", authorUserId: actor.id });
        const diffs: SlotDiff[] = [];
        for (const path of paths) {
          const p = b.field_provenance[path];
          if (!p || p.slot_state === "confirmed" || isEmptyValue(getPath(b.content, path))) continue;
          p.slot_state = "confirmed"; // origin kept (D-4)
          p.evidence_message_ids = [...new Set([...p.evidence_message_ids, msg.id])];
          diffs.push({ field_path: path, before: getPath(b.content, path) ?? null, after: getPath(b.content, path) ?? null, origin: p.origin, slot_state: "confirmed" });
        }
        b.checks = runDeterministicChecks(b, ports.lists, []);
        await repo.updateMessage(tx.db, scope, msg.id, { slotUpdates: diffs });
        s = await repo.updateSession(tx.db, scope, s.id, { workingBrief: b });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "concept_brief.field_edited", target: target(s.id), after: { confirmed: diffs.map((d) => d.field_path) }, details: { ids: diffs.map((d) => d.field_path), count: diffs.length } });
        return s;
      });
    },

    async sweepIdle(now = clock.date()) {
      const remindAfter = DEFAULTS["concept.idle_reminder_hours"] * 3600_000;
      const pauseAfter = DEFAULTS["concept.session_idle_days"] * 86_400_000;
      let reminded = 0;
      let paused = 0;
      for (const c of await repo.idleCandidates(uow.db, new Date(now.getTime() - remindAfter))) {
        const scope = { novelId: c.novelId };
        await uow.run(async (tx) => {
          const s = await mustSession(tx, scope, c.id, true);
          if (s.status !== "active") return;
          const last = (s.lastUserMessageAt ?? s.createdAt).getTime();
          if (now.getTime() - last >= pauseAfter) {
            await transition(tx, scope, s, "paused", "CS6", { pauseReason: "idle" }, actors.system("scheduler"), "휴면");
            paused++;
          } else if (!s.remindedAt) {
            await repo.updateSession(tx.db, scope, s.id, { remindedAt: now });
            await notice(tx, scope, s, `컨셉 대화가 멈춰 있습니다. ${summaryText(parseWorkingBrief(s.workingBrief))} 이어서 답해 주세요.`);
            reminded++;
          }
        });
      }
      return { reminded, paused };
    },
  };

  /** the session's in-flight task id when that task is still queued/running (a stale id of a finished task → null) */
  async function liveInFlightTask(tx: Tx | undefined, scope: NovelScope, s: ConceptSession): Promise<string | null> {
    if (!s.inFlightTaskId) return null;
    const t = await orchestration.getTask(scope, s.inFlightTaskId, tx).catch(() => null);
    return t && !["done", "failed", "cancelled"].includes(t.status) ? t.id : null;
  }

  class InvalidTransitionError2 extends ConflictError {
    constructor(status: string) {
      super("invalid_transition", `컨셉 세션을 '${labelKo("concept_session_status", status)}' 상태에서 이어 할 수 없습니다.`);
    }
  }

  async function abandonTx(tx: Tx, scope: NovelScope, sessionId: string, actor: ActorRef) {
    let s = await mustSession(tx, scope, sessionId, true);
    if (s.status === "awaiting_approval") await cancelPendingApproval(tx, scope, s, actor, "세션을 처음부터 다시 시작함");
    if (s.inFlightTaskId) {
      const t = await orchestration.getTask(scope, s.inFlightTaskId, tx).catch(() => null);
      if (t && !["done", "failed", "cancelled"].includes(t.status)) await orchestration.cancelTask(tx, scope, t.id, actor);
    }
    s = await transition(tx, scope, s, "abandoned", "CS8", { pendingApprovalId: null, inFlightTaskId: null, pauseReason: null }, actor);
    return { abandoned: s };
  }

  async function createSession(tx: Tx, scope: NovelScope, input: StartSessionInput, actor: ActorRef, wb: WorkingBrief): Promise<ConceptSession> {
    const s = await repo.insertSession(tx.db, {
      id: ids.next("cns"),
      novelId: scope.novelId,
      purpose: input.purpose ?? "initial",
      entryMode: input.entryMode,
      baseBriefId: input.baseBriefId ?? null,
      status: "active",
      stage: "opening",
      turnLimit: DEFAULTS["concept.max_turns"],
      budgetLimitMicros: usdToMicros(DEFAULTS["concept.session_budget_usd"]),
      activeChannelId: input.activeChannelId,
      questionSetVersion: QUESTION_SET_VERSION,
      createdByUserId: input.createdByUserId,
      workingBrief: wb,
    });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "concept_session.created",
      target: target(s.id),
      after: { purpose: s.purpose, entryMode: s.entryMode, status: "active" },
    });
    // first prompt (CQ-01) is deterministic: a system question, no model call needed
    const seed = DEF_BY_PATH.get("seed_notes")!;
    if (s.purpose === "revision") {
      await insertMessage(tx, scope, s, { authorKind: "system", kind: "question", body: `승인된 컨셉을 바탕으로 개정을 시작합니다. 바꾸고 싶은 부분을 말씀해 주세요.\n${summaryText(wb)}`, askedFieldPaths: [] });
    } else if (input.entryMode === "import") {
      await insertMessage(tx, scope, s, { authorKind: "system", kind: "notice", body: "이미 정리한 시놉시스·메모를 붙여 넣어 주세요. 붙여 넣은 원문은 LLM 공급자로 전송됩니다." });
    } else if (input.entryMode === "direct_input") {
      await insertMessage(tx, scope, s, { authorKind: "system", kind: "notice", body: "브리프 패널의 폼에서 필수 항목(장르·연령 등급·주인공·욕망·대립·핵심 훅·결말 방향·로그라인)을 채운 뒤 [승인 요청]을 눌러 주세요." });
    } else {
      await insertMessage(tx, scope, s, {
        authorKind: "system",
        kind: "question",
        body: `[질문] ${seed.ask_ko}`,
        options: [{ idx: 1, label: "아직 없음", value: CONTROL.none.value, source: "control", field_path: "seed_notes" }, control("summary")],
        askedFieldPaths: ["seed_notes"],
      });
    }
    return s;
  }

  return {
    service,
    ports,
    handlers: { turn: turnHandler, import: importHandler, check: checkHandler },
    streams,
    onApprovalDecided,
    onInbound,
    templates: { TURN_TEMPLATE_ID, IMPORT_TEMPLATE_ID, TITLES_TEMPLATE_ID, CHECK_TEMPLATE_ID, COMMON_1 },
  };
}

export type ConceptApp = ReturnType<typeof createConceptApp>;
export type { CommitOutcome };

export { cleanTitle } from "../domain/title.js";
