/**
 * hitl application service (05 §2–§8, §10; 03 §4.4–4.5): questions (grading, dispatch, deadlines),
 * approvals (1:1 with an approve_reject question, ADR-014), answers (CAS / late / duplicate),
 * interpretations, reflections + notices.
 */
import { sql } from "@ncs/db/orm";
import { DEFAULTS, labelKo, type ApprovalType, type QuestionTopic, type ReflectionChangeKind } from "@ncs/shared";
import {
  actors,
  DomainValidationError,
  InvalidTransitionError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Ref,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { AgentsService } from "../../agents/index.js";
import type { Channel, MessagingService, QuestionView } from "../../messaging/index.js";
import type { NovelService } from "../../novel/index.js";
import type { OntologyService } from "../../ontology/index.js";
import type { OrchestrationService } from "../../orchestration/index.js";
import type {
  AcceptAnswerInput,
  Answer,
  AnswerApplier,
  Approval,
  ApprovalHandler,
  ApprovalRequest,
  CreateQuestionContext,
  HitlService,
  Question,
  QuestionDraft,
} from "../index.js";
import { hitlRepo as repo, type Interpretation, type Reflection } from "../adapters/db/hitl-repository.js";
import { approvalQuestionShape, gradeQuestion, HOLD_TOPICS, TOPIC_RULES } from "../domain/grading.js";
import {
  buildRecommendation,
  interpretAnswerOutputSchema,
  isDuplicateOf,
  needsInterpretation,
  normalizeAnswer,
  questionDraftSchema,
  readRecommendation,
  type AnswerPayload,
  type InterpretAnswerOutput,
} from "../domain/questions.js";
import {
  APPROVAL_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  INTERPRETATION_TRANSITIONS,
  LATE_TRANSITIONS,
  QUESTION_TRANSITIONS,
  REFLECTION_TRANSITIONS,
  defaultResolution,
  findRule,
  fromStatuses,
} from "../domain/transitions.js";
import { deadlineHours, hhmm, hoursAgoLabel, inQuietHours, nextReminderAt, recomputeDeadline } from "../domain/schedule.js";
import { buildQuestionView } from "./views.js";

export interface HitlServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  messaging: MessagingService;
  orchestration: OrchestrationService;
  ontology: OntologyService;
  agents: AgentsService;
}

type ReflectionInput = Awaited<ReturnType<AnswerApplier>>;

export interface CreateQuestionExtra {
  approval?: { basis: Question["blockingBasis"] };
  parent?: Question | null;
}

/** what a task kind registry flag tells the core (set by tasks.ts) */
export interface TaskAvailability {
  interpret: boolean;
  grade: boolean;
}

const SYS_MESSENGER = actors.system("messenger");
const SYS_SCHEDULER = actors.system("scheduler");
const SYS_ORCH = actors.system("orchestrator");

export function createHitlCore(deps: HitlServiceDeps) {
  const { platform, audit, novel, messaging, orchestration, ontology } = deps;
  const { uow, ids, clock, log, config } = platform;
  const approvalHandlers = new Map<ApprovalType, ApprovalHandler>();
  const answerAppliers = new Map<QuestionTopic, AnswerApplier>();
  const tasks: TaskAvailability = { interpret: false, grade: false };
  const now = () => clock.date();
  const webBaseUrl = () => config.server.public_base_url?.replace(/\/$/, "") ?? `http://${config.server.host}:${config.server.port}`;

  // ── reads ──
  async function mustQuestion(tx: Tx | undefined, scope: NovelScope, id: string, forUpdate = false): Promise<Question> {
    const q = await repo.getQuestion(tx?.db ?? uow.db, scope, id, forUpdate);
    if (!q) throw new NotFoundError("질문", id);
    return q;
  }
  async function viewOf(tx: Tx | undefined, scope: NovelScope, q: Question): Promise<QuestionView> {
    const db = tx?.db ?? uow.db;
    const [options, links, n] = await Promise.all([repo.listOptions(db, scope, q.id), repo.listLinks(db, scope, q.id), novel.getNovel(scope, tx)]);
    return buildQuestionView(q, options, links, { timezone: n.timezone, webBaseUrl: webBaseUrl() });
  }
  async function channels(tx: Tx, scope: NovelScope): Promise<{ web: Channel | null; messengers: Channel[]; all: Channel[] }> {
    const all = await messaging.preferredChannels(scope, tx);
    return { web: all.find((c) => c.kind === "web") ?? null, messengers: all.filter((c) => c.kind !== "web" && c.status === "active"), all };
  }

  // ── Q1 create ──
  async function create(tx: Tx, scope: NovelScope, draft: QuestionDraft, ctx: CreateQuestionContext, extra: CreateQuestionExtra = {}) {
    const input = { ...draft, options: draft.options ?? [] };
    if (input.questionType === "approve_reject" && !input.options.length) {
      input.options = [
        { label: "승인", value: { kind: "choice", key: "approved" }, isRecommended: true },
        { label: "반려", value: { kind: "choice", key: "rejected" } },
      ];
    }
    const parsed = questionDraftSchema.safeParse({ ...input, links: input.links.map((l) => ({ type: l.type, id: l.id })) });
    if (!parsed.success) throw new DomainValidationError("invalid_question_draft", "질문 초안이 올바르지 않습니다.", parsed.error.issues);
    const d = parsed.data;
    const g = gradeQuestion({
      topic: d.topic,
      questionType: d.questionType,
      links: d.links,
      hints: d.gradeHints,
      proposedBlockingBasis: d.proposedBlockingBasis ?? null,
      approval: extra.approval ?? null,
      parent: extra.parent ? { grade: extra.parent.grade, basis: extra.parent.blockingBasis } : null,
      notice: d.notice,
    });
    const policy = await novel.getNotificationPolicy(scope, tx);
    const at = now();
    const hours = deadlineHours(g.grade, policy);
    const rec = buildRecommendation(d, g.grade, { originTaskId: ctx.taskId ?? null, approval: !!extra.approval });
    const displayNo = await novel.nextDisplayNo(tx, scope, "question");
    const runId = ctx.runId ?? (ctx.createdBy.type === "agent" ? ctx.createdBy.runId : null);
    const q = await repo.insertQuestion(tx.db, {
      id: ids.next("qst"),
      novelId: scope.novelId,
      displayNo,
      grade: g.grade,
      questionType: d.questionType,
      topic: d.topic,
      status: "pending", // Q1
      title: d.title,
      body: d.body,
      recommendation: rec,
      rationale: d.rationale ?? d.recommendation?.rationale ?? "",
      blockingBasis: g.basis,
      gradeReason: g.reason,
      deadlineAt: hours === null ? null : new Date(at.getTime() + hours * 3600_000),
      askedByRole: ctx.createdBy.type === "agent" ? ctx.createdBy.id : null,
      createdByRunId: runId,
      parentQuestionId: extra.parent?.id ?? null,
      dependsOnQuestionId: d.dependsOnQuestionId ?? null,
      createdAt: at,
      updatedAt: at,
    });
    await repo.insertOptions(
      tx.db,
      d.options.map((o, idx) => ({ novelId: scope.novelId, questionId: q.id, idx, label: o.label, value: o.value ?? null, isRecommended: rec.option_idx === idx, createdAt: at })),
    );
    await repo.insertLinks(tx.db, d.links.map((l) => ({ novelId: scope.novelId, questionId: q.id, refType: l.type, refId: l.id, createdAt: at })));
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: ctx.createdBy,
      action: "question.created",
      target: { type: "question", id: q.id },
      after: { status: "pending", grade: g.grade, blockingBasis: g.basis, topic: d.topic, displayNo },
      reason: g.reason,
      questionId: q.id,
    });
    tx.afterCommit(() => platform.workSignal.notify("question", scope.novelId));
    if (g.needsLlm && tasks.grade && (await novel.getGoal(scope, tx))) {
      await orchestration.createTask(tx, scope, { kind: "grade_question", targetType: "question", targetId: q.id, input: { question_id: q.id }, createdBy: SYS_ORCH, priority: 900 });
    }
    return q;
  }

  // ── Q2 publish (D7) ──
  async function publish(tx: Tx, scope: NovelScope, q: Question, opts: { actor: ActorRef; messengers: Channel[]; viaDigest?: boolean }): Promise<Question | null> {
    findRule(QUESTION_TRANSITIONS, "question", q.status, "open");
    const policy = await novel.getNotificationPolicy(scope, tx);
    const at = now();
    const opened = await repo.updateQuestion(tx.db, scope, q.id, ["pending"], {
      status: "open",
      sentAt: at,
      deadlineAt: recomputeDeadline(q.deadlineAt, at, deadlineHours(q.grade, policy)),
      updatedAt: at,
    });
    if (!opened) return null;
    const { web } = await channels(tx, scope);
    if (web) await repo.insertDelivery(tx.db, { id: ids.next("qdl"), novelId: scope.novelId, questionId: q.id, channelId: web.id, state: "posted", postedAt: at, createdAt: at, updatedAt: at }); // QD1+QD2
    const view = opts.messengers.length && !opts.viaDigest ? await viewOf(tx, scope, opened) : null;
    for (const c of opts.messengers) {
      const del = await repo.insertDelivery(tx.db, { id: ids.next("qdl"), novelId: scope.novelId, questionId: q.id, channelId: c.id, state: "pending", createdAt: at, updatedAt: at }); // QD1
      if (del && view) {
        const out = await messaging.deliverQuestion(tx, scope, view, c.id);
        await repo.updateDelivery(tx.db, scope, del.id, ["pending"], { outboxId: out.outboxId, updatedAt: at });
      }
    }
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: opts.actor,
      action: "question.sent",
      target: { type: "question", id: q.id },
      before: { status: "pending" },
      after: { status: "open", channels: [web?.id, ...opts.messengers.map((c) => c.id)].filter(Boolean), viaDigest: !!opts.viaDigest },
      questionId: q.id,
    });
    if (opened.grade === "informational") {
      // Q7: informational notices resolve on delivery (resolution_source=notice_only)
      const done = await repo.updateQuestion(tx.db, scope, q.id, ["open"], { status: "resolved", resolutionSource: "notice_only", resolvedAt: at, updatedAt: at });
      await audit.record(tx, { novelId: scope.novelId, actor: opts.actor, action: "question.resolved", target: { type: "question", id: q.id }, after: { status: "resolved", resolutionSource: "notice_only" }, questionId: q.id });
      return done;
    }
    return opened;
  }

  // ── deliveries ──
  async function closeDeliveries(tx: Tx, scope: NovelScope, q: Question, mode: { answeredVia?: string; state: "answered" | "closed" | "withdrawn"; text: string; hereText?: string }) {
    const at = now();
    for (const d of await repo.listDeliveries(tx.db, scope, q.id)) {
      const here = mode.answeredVia === d.channelId;
      const to = mode.state === "withdrawn" ? "withdrawn" : here ? "answered_here" : "closed_elsewhere";
      if (!fromStatuses(DELIVERY_TRANSITIONS, to).includes(d.state)) continue;
      await repo.updateDelivery(tx.db, scope, d.id, fromStatuses(DELIVERY_TRANSITIONS, to), { state: to, closedAt: at, updatedAt: at });
      const chan = await messaging.getChannel(scope, d.channelId, tx);
      if (chan.kind === "web") continue;
      await messaging.updateQuestionDelivery(tx, scope, {
        questionId: q.id,
        channelId: d.channelId,
        state: to === "answered_here" ? "answered_here" : to === "withdrawn" ? "withdrawn" : "closed_elsewhere",
        text: here && mode.hereText ? mode.hereText : mode.text,
      });
    }
  }

  // ── reflections (05 §8) ──
  async function ensureReflection(tx: Tx, scope: NovelScope, q: Question, answerId: string | null): Promise<Reflection> {
    const at = now();
    return repo.insertReflection(tx.db, { id: ids.next("arf"), novelId: scope.novelId, questionId: q.id, answerId, status: "pending", createdAt: at, updatedAt: at }); // F1 / RF1
  }

  function noticeText(q: Question, r: ReflectionInput): string {
    if (r.status === "not_applied") return `Q-${q.displayNo} 반영하지 않음: ${r.reason ?? "사유 없음"}`;
    const parts = r.items.map((i) => i.summary).filter(Boolean);
    return `Q-${q.displayNo} 반영 완료: ${parts.join(", ") || "변경 없음"}`;
  }

  async function notifyReflection(tx: Tx, scope: NovelScope, q: Question, refl: Reflection, r: ReflectionInput, channelId: string | null, actor: ActorRef) {
    const at = now();
    const out = channelId
      ? await messaging.sendNotice(tx, scope, { kind: "reflection_notice", channelId, text: noticeText(q, r), idempotencyKey: `reflection_notice:${refl.id}:${channelId}:1`, refs: [{ refType: "question", refId: q.id }] })
      : null;
    await repo.updateReflection(tx.db, scope, refl.id, { notifiedAt: at, noticeOutboxId: out?.outboxId ?? null, updatedAt: at });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "answer_reflection.notified",
      target: { type: "question", id: q.id },
      details: { reflectionId: refl.id, channelId, outboxId: out?.outboxId ?? null },
      questionId: q.id,
    });
  }

  /** RF2/RF3 + Q6 (+ F7 notice for blocking questions) */
  async function finishReflection(tx: Tx, scope: NovelScope, q: Question, answer: Answer | null, r: ReflectionInput, actor: ActorRef): Promise<Reflection> {
    const refl = (await repo.reflectionByQuestion(tx.db, scope, q.id, true)) ?? (await ensureReflection(tx, scope, q, answer?.id ?? null));
    if (refl.status !== "pending") return refl; // idempotent
    findRule(REFLECTION_TRANSITIONS, "answer_reflection", refl.status, r.status);
    const at = now();
    const items = r.items.length ? r.items : [{ changeKind: "no_change" as ReflectionChangeKind, summary: r.reason ?? "변경 없음" }];
    let locations = items.filter((i) => i.ref).map((i) => ({ ref_type: i.ref!.type, ref_id: i.ref!.id }));
    if (!locations.length) locations = [{ ref_type: "question", ref_id: q.id }]; // INV-AR-03
    const done = (await repo.updateReflection(
      tx.db,
      scope,
      refl.id,
      {
        status: r.status,
        answerId: answer?.id ?? refl.answerId,
        locations,
        notAppliedReason: r.status === "not_applied" ? (r.reason ?? "반영하지 않음") : null,
        completedAt: at,
        updatedAt: at,
      },
      true,
    ))!;
    await repo.insertReflectionItems(
      tx.db,
      items.map((i) => ({ novelId: scope.novelId, reflectionId: refl.id, changeKind: i.changeKind, refType: i.ref?.type ?? null, refId: i.ref?.id ?? null, summary: i.summary, createdAt: at })),
    );
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "answer_reflection.recorded",
      target: { type: "question", id: q.id },
      after: { status: r.status, items: items.length },
      reason: r.status === "not_applied" ? (r.reason ?? null) : null,
      questionId: q.id,
      answerId: answer?.id ?? null,
    });
    const resolved = await repo.updateQuestion(tx.db, scope, q.id, ["answered", "defaulted"], { status: "resolved", resolvedAt: at, updatedAt: at }); // Q6
    if (resolved) {
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: SYS_ORCH,
        action: "question.resolved",
        target: { type: "question", id: q.id },
        before: { status: q.status },
        after: { status: "resolved", reflection: r.status },
        questionId: q.id,
        answerId: answer?.id ?? null,
      });
    }
    // F7: blocking → immediately to the channel the answer came from; non-blocking → next digest
    if (q.grade === "blocking") await notifyReflection(tx, scope, q, done, r, answer?.channelId ?? null, SYS_MESSENGER);
    return done;
  }

  async function unblock(tx: Tx, scope: NovelScope, q: Question, answerId: string | null, approvalId?: string): Promise<string[]> {
    const out: string[] = [];
    if (approvalId) out.push(...(await orchestration.unblockByRef(tx, scope, { refType: "approval", refId: approvalId }, { reason: "approval_decided", keyPrefix: `approval:${approvalId}` }, answerId ?? undefined)));
    out.push(...(await orchestration.unblockByRef(tx, scope, { refType: "question", refId: q.id }, { reason: "question_answered", keyPrefix: `answer:${answerId ?? q.id}` }, answerId ?? undefined)));
    return out;
  }

  // ── approvals ──
  async function decideApproval(tx: Tx, scope: NovelScope, q: Question, answer: Answer, p: AnswerPayload, actor: ActorRef): Promise<void> {
    const approval = q.approvalId ? await repo.getApproval(tx.db, scope, q.approvalId, true) : await repo.approvalByQuestion(tx.db, scope, q.id);
    if (!approval) throw new DomainValidationError("approval_missing", "이 질문에 연결된 승인 요청이 없습니다.");
    const decision = p.decision!;
    findRule(APPROVAL_TRANSITIONS, "approval", approval.status, decision);
    const at = now();
    const updated = (await repo.updateApproval(tx.db, scope, approval.id, ["pending"], {
      status: decision, // A2 / A3
      decidedByUserId: actor.type === "user" ? actor.id : null,
      decidedAt: at,
      decisionNote: p.decision_note ?? null,
      reworkFrom: p.rework_from ?? null,
      decidedViaChannelId: answer.channelId,
      payload: { ...(approval.payload as object), ...(p.decision_variant ? { decision_variant: p.decision_variant } : {}) },
      updatedAt: at,
    }))!;
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "approval.decided",
      target: { type: "approval", id: approval.id },
      before: { status: "pending" },
      after: { status: decision, reworkFrom: p.rework_from ?? null, subject: { type: approval.subjectType, id: approval.subjectId } },
      reason: p.decision_note ?? null,
      questionId: q.id,
      approvalId: approval.id,
      answerId: answer.id,
    });
    const handler = approvalHandlers.get(approval.approvalType);
    if (handler) {
      await handler({ tx, scope, approval: updated, decision, decisionNote: p.decision_note ?? null, reworkFrom: p.rework_from ?? null, actor, answerId: answer.id });
    } else {
      log.warn({ approvalType: approval.approvalType }, "no approval handler registered; decision recorded only");
    }
    const tasksUnblocked = await unblock(tx, scope, q, answer.id, approval.id);
    const label = labelKo("approval_type", approval.approvalType);
    await finishReflection(
      tx,
      scope,
      q,
      answer,
      {
        status: "applied",
        items: [
          {
            changeKind: approval.approvalType === "series_bible" ? "bible_changed" : tasksUnblocked.length ? "task_changed" : "no_change",
            ref: { type: approval.subjectType, id: approval.subjectId },
            summary: `${label} ${decision === "approved" ? "승인" : "반려"}${p.rework_from ? `(${labelKo("rework_from", p.rework_from)})` : ""}`,
          },
        ],
      },
      actor,
    );
  }

  async function supersede(tx: Tx, scope: NovelScope, old: Approval, newId: string, actor: ActorRef) {
    findRule(APPROVAL_TRANSITIONS, "approval", old.status, "superseded");
    const at = now();
    await repo.updateApproval(tx.db, scope, old.id, ["pending"], { status: "superseded", supersededById: newId, updatedAt: at }); // A5
    await audit.record(tx, { novelId: scope.novelId, actor, action: "approval.superseded", target: { type: "approval", id: old.id }, before: { status: "pending" }, after: { status: "superseded", supersededById: newId }, approvalId: old.id, questionId: old.questionId });
    const q = await repo.getQuestion(tx.db, scope, old.questionId, true);
    if (q && (q.status === "pending" || q.status === "open")) await cancelQ(tx, scope, q, "새 승인 요청으로 대체됐습니다.", actor, false);
  }

  async function cancelApprovalRow(tx: Tx, scope: NovelScope, a: Approval, reason: string, actor: ActorRef) {
    findRule(APPROVAL_TRANSITIONS, "approval", a.status, "cancelled");
    const at = now();
    await repo.updateApproval(tx.db, scope, a.id, ["pending"], { status: "cancelled", decisionNote: reason, updatedAt: at }); // A4
    await audit.record(tx, { novelId: scope.novelId, actor, action: "approval.cancelled", target: { type: "approval", id: a.id }, before: { status: "pending" }, after: { status: "cancelled" }, reason, approvalId: a.id, questionId: a.questionId });
  }

  /** Q8 (+ A4 for a pending linked approval) */
  async function cancelQ(tx: Tx, scope: NovelScope, q: Question, reason: string, actor: ActorRef, cascadeApproval = true) {
    findRule(QUESTION_TRANSITIONS, "question", q.status, "cancelled");
    const at = now();
    const done = await repo.updateQuestion(tx.db, scope, q.id, ["pending", "open"], { status: "cancelled", cancelledReason: reason, updatedAt: at });
    if (!done) throw new InvalidTransitionError("question", q.status, "cancelled");
    await audit.record(tx, { novelId: scope.novelId, actor, action: "question.cancelled", target: { type: "question", id: q.id }, before: { status: q.status }, after: { status: "cancelled" }, reason, questionId: q.id });
    await repo.cancelSessionsForQuestion(tx.db, scope, q.id, at); // AS4
    await closeDeliveries(tx, scope, q, { state: "withdrawn", text: `취소됨: ${reason}` }); // QD6
    if (cascadeApproval && q.approvalId) {
      const a = await repo.getApproval(tx.db, scope, q.approvalId, true);
      if (a?.status === "pending") await cancelApprovalRow(tx, scope, a, reason, actor);
    }
  }

  // ── interpretation (05 §7) ──
  function rootQuestionId(q: Question): string {
    return q.parentQuestionId && (q.topic === "interpretation_confirm" || q.topic === "followup") ? q.parentQuestionId : q.id;
  }
  async function rootOf(tx: Tx, scope: NovelScope, q: Question): Promise<Question> {
    let cur = q;
    for (let i = 0; i < 10 && rootQuestionId(cur) !== cur.id; i++) cur = await mustQuestion(tx, scope, rootQuestionId(cur), true);
    return cur;
  }

  async function startInterpretation(tx: Tx, scope: NovelScope, q: Question, answer: Answer, extra: { correctionText?: string; round?: number } = {}) {
    const root = await rootOf(tx, scope, q);
    if (!tasks.interpret || !(await novel.getGoal(scope, tx))) {
      // INV-AI-01: never canon without confirmation — keep the reflection pending (inbox "반영 확인 필요")
      log.warn({ questionId: q.id }, "interpret_answer unavailable; free-text answer kept pending");
      return;
    }
    await orchestration.createTask(tx, scope, {
      kind: "interpret_answer",
      targetType: "question",
      targetId: root.id,
      input: { question_id: q.id, answer_id: answer.id, root_question_id: root.id, correction_text: extra.correctionText ?? null, round: extra.round ?? 0 },
      createdBy: SYS_ORCH,
      cycleKey: `interpret:${answer.id}:${extra.round ?? 0}`,
      priority: 900,
    });
  }

  /** commit body of interpret_answer (IT1/IT5 + T3/T4) — exposed for the task handler and tests */
  async function commitInterpretation(
    tx: Tx,
    scope: NovelScope,
    input: { question_id: string; answer_id: string; root_question_id: string; round: number },
    runId: string,
    actor: ActorRef,
    raw: unknown,
  ): Promise<{ interpretationId: string; questionId: string }> {
    const out: InterpretAnswerOutput = interpretAnswerOutputSchema.parse(raw);
    const q = await mustQuestion(tx, scope, input.question_id);
    const root = await mustQuestion(tx, scope, input.root_question_id);
    const at = now();
    // IT6: a previous needs_followup interpretation of the same root is replaced
    const prior = await repo.listInterpretationsForAnswers(tx.db, scope, (await repo.listAnswers(tx.db, scope, root.id)).map((a) => a.id));
    for (const p of prior) if (p.status === "needs_followup") await repo.updateInterpretation(tx.db, scope, p.id, ["needs_followup"], { status: "rejected", updatedAt: at });
    const itp = await repo.insertInterpretation(tx.db, {
      id: ids.next("itp"),
      novelId: scope.novelId,
      answerId: input.answer_id,
      runId,
      status: out.status, // IT1 / IT5
      proposedChanges: { root_question_id: root.id, round: input.round, summary_ko: out.summary_ko, changes: out.changes },
      createdAt: at,
      updatedAt: at,
    });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "answer.interpreted",
      target: { type: "answer", id: input.answer_id },
      after: { status: out.status, changes: out.changes.length },
      questionId: q.id,
      answerId: input.answer_id,
    });
    const links: Ref[] = [
      { type: "question", id: root.id },
      { type: "answer", id: input.answer_id },
    ];
    let created: Question;
    if (out.status === "needs_followup") {
      created = await create(
        tx,
        scope,
        { topic: "followup", questionType: "free_text", title: `후속 질문: ${root.title}`, body: out.followup_question_ko ?? out.summary_ko, options: [], links, rationale: out.summary_ko },
        { createdBy: actor, runId },
        { parent: root },
      );
    } else {
      created = await create(
        tx,
        scope,
        {
          topic: "interpretation_confirm",
          questionType: "single_choice",
          title: `답변 해석 확인: ${root.title}`,
          body: interpretationConfirmBodyFrom(out),
          options: [
            { label: "맞습니다", value: { kind: "choice", key: "confirm" }, isRecommended: true },
            { label: "취소", value: { kind: "choice", key: "cancel" } },
          ],
          allowFreeText: true,
          links,
          rationale: out.summary_ko,
        },
        { createdBy: actor, runId },
        { parent: root },
      );
      await repo.updateInterpretation(tx.db, scope, itp.id, [out.status], { confirmQuestionId: created.id, updatedAt: at });
    }
    return { interpretationId: itp.id, questionId: created.id };
  }

  /** resolve followup questions of `root` that are still waiting (their answer fed this interpretation) */
  async function closeFollowups(tx: Tx, scope: NovelScope, root: Question, actor: ActorRef, summary: string) {
    for (const c of await repo.childQuestions(tx.db, scope, root.id)) {
      if (c.status !== "answered" || c.topic !== "followup") continue;
      const ans = c.acceptedAnswerId ? await repo.getAnswer(tx.db, scope, c.acceptedAnswerId) : null;
      await finishReflection(tx, scope, c, ans, { status: "applied", items: [{ changeKind: "no_change", ref: { type: "question", id: root.id }, summary }] }, actor);
    }
  }

  async function applyConfirmedChanges(tx: Tx, scope: NovelScope, root: Question, rootAnswer: Answer | null, itp: Interpretation, actor: ActorRef) {
    const changes = ((itp.finalChanges ?? itp.proposedChanges) as { changes?: InterpretAnswerOutput["changes"] }).changes ?? [];
    const items: ReflectionInput["items"] = [];
    let timelineId: string | null = null;
    for (const c of changes) {
      if (c.kind === "fact" || c.kind === "constraint") {
        if (c.subject_entity_id && c.predicate) {
          try {
            timelineId ??= (await ontology.getDefaultTimeline(scope, tx)).id;
            const res = await ontology.writeCandidateFacts(
              tx,
              scope,
              [
                {
                  factKind: c.fact_kind ?? (c.kind === "constraint" ? "constraint" : "attribute"),
                  subjectEntityId: c.subject_entity_id,
                  predicate: c.predicate,
                  objectEntityId: c.object_entity_id ?? null,
                  value: { text: c.description_ko },
                  timelineId,
                  storyRange: { from: c.story_range?.from ?? 0, to: c.story_range?.to ?? null } as never,
                  sourceKind: "answer",
                  source: { refType: "answer", refId: rootAnswer?.id ?? itp.answerId },
                  canonStatus: "approved", // FR-MSG-16: confirmed answer facts are approved canon
                },
              ],
              actor,
            );
            const w = res.written[0];
            items.push({ changeKind: c.kind === "constraint" ? "constraint_created" : "fact_created", ...(w ? { ref: { type: "fact" as const, id: w.factId } } : {}), summary: c.description_ko });
            continue;
          } catch (err) {
            log.warn({ err: (err as Error).message }, "ontology write for confirmed answer failed; recorded as constraint text");
          }
        }
        items.push({ changeKind: "constraint_created", ref: { type: "answer", id: rootAnswer?.id ?? itp.answerId }, summary: c.description_ko });
      } else if (c.kind === "name_rule") items.push({ changeKind: "entity_name_rule", summary: c.description_ko });
      else items.push({ changeKind: "task_changed", summary: c.description_ko });
    }
    const unblocked = await unblock(tx, scope, root, rootAnswer?.id ?? null);
    for (const t of unblocked) items.push({ changeKind: "task_changed", ref: { type: "task", id: t }, summary: "답변을 반영해 작업을 다시 시작합니다" });
    await finishReflection(tx, scope, root, rootAnswer, { status: "applied", items }, SYS_ORCH);
  }

  async function handleConfirmAnswer(tx: Tx, scope: NovelScope, q: Question, answer: Answer, p: AnswerPayload, actor: ActorRef) {
    const itp = await repo.interpretationByConfirmQuestion(tx.db, scope, q.id);
    const root = await rootOf(tx, scope, q);
    const rootAnswer = root.acceptedAnswerId ? await repo.getAnswer(tx.db, scope, root.acceptedAnswerId) : null;
    const at = now();
    if (!itp || itp.status !== "proposed") {
      await finishReflection(tx, scope, q, answer, { status: "not_applied", reason: "확인할 해석이 없습니다", items: [] }, actor);
      return;
    }
    const options = await repo.listOptions(tx.db, scope, q.id);
    const key = p.selected_idx.length ? ((options[p.selected_idx[0]!]?.value as { key?: string } | null)?.key ?? null) : null;
    if (key === "confirm") {
      findRule(INTERPRETATION_TRANSITIONS, "answer_interpretation", itp.status, "confirmed");
      const confirmed = (await repo.updateInterpretation(tx.db, scope, itp.id, ["proposed"], { status: "confirmed", finalChanges: itp.proposedChanges, updatedAt: at }))!; // IT2
      await audit.record(tx, { novelId: scope.novelId, actor, action: "answer.interpretation_decided", target: { type: "answer", id: itp.answerId }, after: { status: "confirmed" }, questionId: root.id, answerId: itp.answerId });
      await finishReflection(tx, scope, q, answer, { status: "applied", items: [{ changeKind: "no_change", ref: { type: "question", id: root.id }, summary: "해석 확인" }] }, actor);
      await closeFollowups(tx, scope, root, actor, "원 질문에 반영");
      await applyConfirmedChanges(tx, scope, root, rootAnswer, confirmed, actor);
      return;
    }
    findRule(INTERPRETATION_TRANSITIONS, "answer_interpretation", itp.status, "rejected");
    await repo.updateInterpretation(tx.db, scope, itp.id, ["proposed"], { status: "rejected", updatedAt: at }); // IT4
    await audit.record(tx, { novelId: scope.novelId, actor, action: "answer.interpretation_decided", target: { type: "answer", id: itp.answerId }, after: { status: "rejected", correction: !!p.text }, questionId: root.id, answerId: itp.answerId });
    const round = ((itp.proposedChanges as { round?: number }).round ?? 0) + 1;
    if (p.text) {
      // T6: correction → new interpretation round (max interpretation.max_correction_rounds via messenger)
      await finishReflection(tx, scope, q, answer, { status: "applied", items: [{ changeKind: "no_change", ref: { type: "question", id: root.id }, summary: "해석 정정 요청" }] }, actor);
      if (round > DEFAULTS["interpretation.max_correction_rounds"]) {
        await messaging.sendNotice(tx, scope, { kind: "command_reply", channelId: answer.channelId, text: `Q-${root.displayNo}: 정정 횟수를 넘었습니다. PC의 웹 인박스에서 해석을 직접 고쳐 주세요.`, idempotencyKey: `correction_limit:${itp.id}` }).catch(() => null);
        return;
      }
      await startInterpretation(tx, scope, root, rootAnswer ?? answer, { correctionText: p.text, round });
      return;
    }
    // T7 cancel: root not_applied ("해석 기각") + followup asking again
    await finishReflection(tx, scope, q, answer, { status: "applied", items: [{ changeKind: "no_change", ref: { type: "question", id: root.id }, summary: "해석 취소" }] }, actor);
    await closeFollowups(tx, scope, root, actor, "해석 취소");
    const blocked = await unblock(tx, scope, root, rootAnswer?.id ?? null);
    await finishReflection(tx, scope, root, rootAnswer, { status: "not_applied", reason: "해석 기각", items: [] }, SYS_ORCH);
    const follow = await create(
      tx,
      scope,
      { topic: "followup", questionType: "free_text", title: `다시 답해 주세요: ${root.title}`, body: root.body, options: [], links: [{ type: "question", id: root.id }], rationale: "이전 답의 해석을 취소했습니다." },
      { createdBy: SYS_ORCH },
      { parent: root },
    );
    for (const t of blocked) if (root.grade === "blocking") await orchestration.blockTask(tx, scope, t, "question", { refType: "question", refId: follow.id }, SYS_ORCH);
  }

  async function handleLateConflictAnswer(tx: Tx, scope: NovelScope, q: Question, answer: Answer, p: AnswerPayload, actor: ActorRef) {
    const options = await repo.listOptions(tx.db, scope, q.id);
    const key = (options[p.selected_idx[0] ?? -1]?.value as { key?: string } | null)?.key;
    const lateId = (await repo.listLinks(tx.db, scope, q.id)).find((l) => l.refType === "answer")?.refId;
    const late = lateId ? await repo.getAnswer(tx.db, scope, lateId) : null;
    if (!late || late.lateResolution !== "pending_user_choice") {
      await finishReflection(tx, scope, q, answer, { status: "not_applied", reason: "이미 처리된 늦은 답변입니다", items: [] }, actor);
      return;
    }
    if (key === "dismiss") {
      await resolveLate(tx, scope, late, "dismissed", actor);
      await finishReflection(tx, scope, q, answer, { status: "applied", items: [{ changeKind: "no_change", ref: { type: "answer", id: late.id }, summary: "늦은 답변 무시" }] }, actor);
      return;
    }
    // MVP-α: revision tasks belong to manuscript (revise_episode / E11) — guide the user to the web screen
    await finishReflection(tx, scope, q, answer, { status: "not_applied", reason: "수정 요청은 PC 웹의 화 화면에서 만들어 주세요", items: [] }, actor);
  }

  async function resolveLate(tx: Tx, scope: NovelScope, late: Answer, to: "dismissed", actor: ActorRef): Promise<Answer> {
    findRule(LATE_TRANSITIONS, "late_answer", late.lateResolution ?? "pending_user_choice", to);
    const updated = (await repo.updateAnswer(tx.db, scope, late.id, { lateResolution: to, updatedAt: now() }))!;
    await audit.record(tx, { novelId: scope.novelId, actor, action: "question.late_answer_resolved", target: { type: "answer", id: late.id }, before: { lateResolution: late.lateResolution }, after: { lateResolution: to }, questionId: late.questionId, answerId: late.id });
    return updated;
  }

  /** choice answers: registered applier, else generic (wake blocked tasks with the answer in context) */
  async function applyChoice(tx: Tx, scope: NovelScope, q: Question, answer: Answer, actor: ActorRef) {
    const applier = answerAppliers.get(q.topic);
    let r: ReflectionInput;
    if (applier) {
      const opts = await repo.listOptions(tx.db, scope, q.id);
      const selectedOptions = ((answer.payload as AnswerPayload).selected_idx ?? [])
        .map((i) => opts.find((o) => o.idx === i))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .map((o) => ({ idx: o.idx, label: o.label, value: o.value }));
      r = await applier({ tx, scope, question: q, answer, actor, selectedOptions });
      const unblocked = await unblock(tx, scope, q, answer.id);
      if (r.status === "applied") for (const t of unblocked) r.items.push({ changeKind: "task_changed", ref: { type: "task", id: t }, summary: "답변을 반영해 작업을 다시 시작합니다" });
    } else {
      const unblocked = await unblock(tx, scope, q, answer.id);
      const options = await repo.listOptions(tx.db, scope, q.id);
      const labels = ((answer.payload as AnswerPayload).selected_idx ?? []).map((i) => options[i]?.label).filter(Boolean);
      r = {
        status: "applied",
        items: unblocked.length
          ? unblocked.map((t) => ({ changeKind: "task_changed" as const, ref: { type: "task" as const, id: t }, summary: `선택 "${labels.join(", ")}"을(를) 반영해 작업을 다시 시작합니다` }))
          : [{ changeKind: "no_change", ref: { type: "answer", id: answer.id }, summary: `선택 "${labels.join(", ")}" 기록(다음 작업 컨텍스트에 반영)` }],
      };
    }
    await finishReflection(tx, scope, q, answer, r, SYS_ORCH);
  }

  async function afterAccepted(tx: Tx, scope: NovelScope, q: Question, answer: Answer, p: AnswerPayload, actor: ActorRef) {
    const at = now();
    const chan = await messaging.getChannel(scope, answer.channelId, tx);
    const options = await repo.listOptions(tx.db, scope, q.id);
    const choice = p.decision ? (p.decision === "approved" ? "승인" : "반려") : p.selected_idx.map((i) => options[i]?.label).filter(Boolean).join(", ") || "직접 입력";
    const via = `${labelKo("channel_kind", chan.kind)}, ${hhmm(at, (await novel.getNovel(scope, tx)).timezone)}`;
    await closeDeliveries(tx, scope, q, { answeredVia: answer.channelId, state: "answered", text: `답변 완료(${via})`, hereText: `선택: ${choice} (${via})` }); // I7, QD3/QD4
    await repo.cancelSessionsForQuestion(tx.db, scope, q.id, at); // AS4 for sessions on other channels
    await ensureReflection(tx, scope, q, answer.id); // F1
    if (q.questionType === "approve_reject" || q.questionType === "attachment_review") return decideApproval(tx, scope, q, answer, p, actor);
    if (q.topic === "interpretation_confirm") return handleConfirmAnswer(tx, scope, q, answer, p, actor);
    if (q.topic === "late_answer_conflict") return handleLateConflictAnswer(tx, scope, q, answer, p, actor);
    if (needsInterpretation(q.questionType, p)) return startInterpretation(tx, scope, q, answer); // INV-AI-01
    return applyChoice(tx, scope, q, answer, actor);
  }

  // ── acceptAnswer (05 §6.2) ──
  async function acceptAnswer(scope: NovelScope, input: AcceptAnswerInput, outer?: Tx) {
    return uow.join(outer, async (tx) => {
      let q = await mustQuestion(tx, scope, input.questionId, true);
      const replay = await repo.findAnswerBySource(tx.db, scope, q.id, input.sourceKey);
      if (replay) return { disposition: replay.disposition, answerId: replay.id }; // idempotent replay (same inbox row / request)
      if (q.grade === "informational") throw new DomainValidationError("not_answerable", "정보성 알림에는 답할 수 없습니다.");
      const options = await repo.listOptions(tx.db, scope, q.id);
      const approval = q.approvalId ? await repo.getApproval(tx.db, scope, q.approvalId) : null;
      const p = normalizeAnswer({
        questionType: q.questionType,
        optionCount: options.length,
        optionValues: options.map((o) => o.value),
        isEpisodeApproval: approval?.approvalType === "episode",
        optionIds: input.optionIds,
        text: input.text,
        approval: input.approval,
        sourceKey: input.sourceKey,
      });
      const channel = await messaging.getChannel(scope, input.channelId, tx);
      const at = now();
      if (q.status === "pending") {
        // web answer before dispatch: Q2(b) then answer (user opened it)
        q = (await publish(tx, scope, q, { actor: actors.user(input.responderUserId), messengers: [] })) ?? q;
      }
      const answer = await repo.insertAnswer(tx.db, {
        id: ids.next("ans"),
        novelId: scope.novelId,
        questionId: q.id,
        channelId: channel.id,
        inboxId: input.sourceKey.startsWith("inb_") ? input.sourceKey : null,
        responderUserId: input.responderUserId,
        receivedAt: at,
        payload: p,
        disposition: "late",
        lateResolution: "pending_user_choice",
        createdAt: at,
        updatedAt: at,
      });
      // CAS (Q3): one statement decides the race (05 §6.2)
      const won =
        q.status === "open"
          ? await repo.updateQuestion(tx.db, scope, q.id, ["open"], { status: "answered", acceptedAnswerId: answer.id, answeredAt: at, resolutionSource: "user_answer", updatedAt: at })
          : null;
      const actor = actors.user(input.responderUserId);
      if (won) {
        const accepted = (await repo.updateAnswer(tx.db, scope, answer.id, { disposition: "accepted", lateResolution: null }))!;
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "question.answered",
          target: { type: "question", id: q.id },
          before: { status: "open" },
          after: { status: "answered", channelId: channel.id },
          questionId: q.id,
          answerId: answer.id,
          approvalId: q.approvalId,
        });
        await afterAccepted(tx, scope, won, accepted, p, actor);
        return { disposition: "accepted" as const, answerId: answer.id };
      }
      const prev = q.acceptedAnswerId ? await repo.getAnswer(tx.db, scope, q.acceptedAnswerId) : null;
      if (prev && prev.responderUserId === input.responderUserId && isDuplicateOf(p, prev.payload as AnswerPayload)) {
        await repo.updateAnswer(tx.db, scope, answer.id, { disposition: "duplicate", lateResolution: null });
        return { disposition: "duplicate" as const, answerId: answer.id };
      }
      if (q.status === "cancelled") await repo.updateAnswer(tx.db, scope, answer.id, { lateResolution: "dismissed" });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "question.late_answer_received",
        target: { type: "question", id: q.id },
        after: { questionStatus: q.status, resolutionSource: q.resolutionSource, channelId: channel.id },
        questionId: q.id,
        answerId: answer.id,
      });
      // 05 §6.5 MVP-α: let the user choose (revision / ignore) unless nothing was applied (hold) or it's an approval
      if (q.status !== "cancelled" && q.resolutionSource !== "deadline_hold" && !q.approvalId && q.topic !== "late_answer_conflict" && q.topic !== "interpretation_confirm") {
        await create(
          tx,
          scope,
          {
            topic: "late_answer_conflict",
            questionType: "single_choice",
            title: `Q-${q.displayNo}에 늦은 답변이 왔습니다`,
            body: `이미 다른 답(또는 추천안)이 반영됐습니다. 늦은 답: ${p.text ?? p.selected_idx.map((i) => options[i]?.label).join(", ")}`,
            options: [
              { label: "수정 요청 만들기", value: { kind: "choice", key: "revise" } },
              { label: "무시", value: { kind: "choice", key: "dismiss" }, isRecommended: true },
            ],
            links: [
              { type: "question", id: q.id },
              { type: "answer", id: answer.id },
            ],
            rationale: "늦은 답변은 자동으로 반영하지 않습니다.",
          },
          { createdBy: SYS_ORCH },
        );
      }
      return { disposition: "late" as const, answerId: answer.id };
    });
  }

  // ── dispatcher (05 §5.1–5.2) ──
  async function dispatchNovel(scope: NovelScope): Promise<number> {
    return uow.run(async (tx) => {
      const n = await novel.getNovel(scope, tx);
      if (n.status === "archived") return 0;
      const policy = await novel.getNotificationPolicy(scope, tx);
      const at = now();
      const quiet = inQuietHours(at, n.timezone, policy.quietHoursStart, policy.quietHoursEnd);
      const { messengers, all } = await channels(tx, scope);
      const primary = messengers[0] ?? null;
      let count = 0;
      if (!policy.questionsPaused) {
        const pending = (await repo.listQuestions(tx.db, scope, { statuses: ["pending"], limit: 500 })).sort((a, b) => a.displayNo - b.displayNo);
        for (const q of pending) {
          if (q.dependsOnQuestionId) {
            const dep = await repo.getQuestion(tx.db, scope, q.dependsOnQuestionId);
            if (dep && dep.status !== "resolved" && dep.status !== "cancelled") continue; // D1
          }
          if (q.digestBatchId) continue;
          if (q.grade === "blocking") {
            const urgent = policy.urgentExceptionEnabled && q.topic === "budget";
            if (await publish(tx, scope, q, { actor: SYS_MESSENGER, messengers: quiet && !urgent ? [] : messengers })) count++; // D3 + D4
          } else if (q.grade === "informational") {
            if (await publish(tx, scope, q, { actor: SYS_MESSENGER, messengers: [] })) count++;
          } else {
            if ((await repo.countNonBlockingSentToday(tx.db, scope, n.timezone, at)) >= policy.dailyCapNonBlocking) continue; // D5
            let batch = await repo.collectingDigest(tx.db, scope, primary?.id ?? null);
            batch ??= await repo.insertDigest(tx.db, {
              id: ids.next("dgb"),
              novelId: scope.novelId,
              kind: "non_blocking_digest",
              status: "collecting", // DG1
              channelId: primary?.id ?? null,
              windowStartAt: at,
              windowEndAt: new Date(at.getTime() + policy.digestWindowMinutes * 60_000),
              createdAt: at,
              updatedAt: at,
            });
            await repo.updateDigest(tx.db, scope, batch.id, { questionIds: [...batch.questionIds, q.id], updatedAt: at });
            await repo.updateQuestion(tx.db, scope, q.id, ["pending"], { digestBatchId: batch.id, updatedAt: at });
            count++;
          }
        }
      }
      // digest flush (DG2 / DG3)
      for (const batch of await repo.listCollectingDigests(tx.db, scope)) {
        const qs = (await Promise.all(batch.questionIds.map((id) => repo.getQuestion(tx.db, scope, id)))).filter((x): x is Question => !!x);
        const live = qs.filter((q) => q.status === "pending" && q.digestBatchId === batch.id);
        if (!live.length) {
          await repo.updateDigest(tx.db, scope, batch.id, { status: "cancelled", updatedAt: at }); // DG3
          continue;
        }
        if (policy.questionsPaused) continue;
        const due = batch.windowEndAt.getTime() <= at.getTime() || live.length >= policy.digestMaxItems;
        if (!due) continue;
        let chan = batch.channelId ? (all.find((c) => c.id === batch.channelId) ?? null) : null;
        if (chan && chan.status !== "active") chan = null;
        if (chan && quiet) continue; // stays collecting until quiet hours end
        const take = live.slice(0, policy.digestMaxItems);
        const rest = live.slice(policy.digestMaxItems);
        const views: QuestionView[] = [];
        for (const q of take) {
          const opened = await publish(tx, scope, q, { actor: SYS_MESSENGER, messengers: chan ? [chan] : [], viaDigest: true });
          if (opened) views.push(await viewOf(tx, scope, opened));
        }
        let outboxId: string | null = null;
        if (chan && views.length) {
          const unnotified = await repo.unnotifiedReflections(tx.db, scope);
          const header = `비차단형 질문 ${views.length}건${unnotified.length ? ` · 반영 완료 ${unnotified.length}건` : ""}`;
          const out = await messaging.deliverDigest(tx, scope, { digestBatchId: batch.id, channelId: chan.id, headerText: header, views });
          outboxId = out?.outboxId ?? null;
          for (const q of take) {
            for (const d of await repo.listDeliveries(tx.db, scope, q.id)) if (d.channelId === chan.id && outboxId) await repo.updateDelivery(tx.db, scope, d.id, ["pending"], { outboxId, updatedAt: at });
          }
          for (const r of unnotified) await repo.updateReflection(tx.db, scope, r.id, { notifiedAt: at, noticeOutboxId: outboxId, updatedAt: at });
        }
        await repo.updateDigest(tx.db, scope, batch.id, { status: "sent", sentAt: at, outboxId, questionIds: take.map((q) => q.id), updatedAt: at }); // DG2
        if (rest.length) {
          const next = await repo.insertDigest(tx.db, { id: ids.next("dgb"), novelId: scope.novelId, kind: "non_blocking_digest", status: "collecting", channelId: batch.channelId, windowStartAt: at, windowEndAt: at, questionIds: rest.map((q) => q.id), createdAt: at, updatedAt: at });
          for (const q of rest) await repo.updateQuestion(tx.db, scope, q.id, ["pending"], { digestBatchId: next.id, updatedAt: at });
        }
        count += views.length;
      }
      // fan-out of open blocking questions to messenger channels they are not on yet (quiet hours end, reconnect)
      if (!quiet && messengers.length && !policy.questionsPaused) {
        for (const q of await repo.listQuestions(tx.db, scope, { statuses: ["open"], grades: ["blocking"], limit: 200 })) {
          const have = new Set((await repo.listDeliveries(tx.db, scope, q.id)).map((d) => d.channelId));
          const missing = messengers.filter((c) => !have.has(c.id));
          if (!missing.length) continue;
          const view = await viewOf(tx, scope, q);
          for (const c of missing) {
            const del = await repo.insertDelivery(tx.db, { id: ids.next("qdl"), novelId: scope.novelId, questionId: q.id, channelId: c.id, state: "pending", createdAt: at, updatedAt: at });
            if (!del) continue;
            const out = await messaging.deliverQuestion(tx, scope, view, c.id);
            await repo.updateDelivery(tx.db, scope, del.id, ["pending"], { outboxId: out.outboxId, updatedAt: at });
            count++;
          }
        }
      }
      return count;
    });
  }

  // ── deadlines & reminders (05 §5.5) ──
  async function applyDefault(tx: Tx, scope: NovelScope, q: Question) {
    const rec = readRecommendation(q.recommendation);
    const source = defaultResolution(q.grade, rec.default_action ?? "hold", HOLD_TOPICS.has(q.topic)); // INV-Q-02/04/06
    findRule(QUESTION_TRANSITIONS, "question", q.status, "defaulted");
    const at = now();
    const done = await repo.updateQuestion(tx.db, scope, q.id, ["open"], { status: "defaulted", resolutionSource: source, updatedAt: at }); // Q4
    if (!done) return;
    await audit.record(tx, { novelId: scope.novelId, actor: SYS_SCHEDULER, action: "question.defaulted", target: { type: "question", id: q.id }, before: { status: "open" }, after: { status: "defaulted", resolutionSource: source }, questionId: q.id });
    await ensureReflection(tx, scope, done, null);
    const options = await repo.listOptions(tx.db, scope, q.id);
    const label = rec.option_idx !== null ? options[rec.option_idx]?.label : null;
    await closeDeliveries(tx, scope, done, { state: "closed", text: source === "default_applied" ? `마감 경과: 추천안(${label ?? "-"})을 적용했습니다` : "마감 경과: 보류했습니다(캐논에 넣지 않음)" });
    const r: ReflectionInput =
      source === "default_applied"
        ? { status: "applied", items: [{ changeKind: "no_change", ref: { type: "question", id: q.id }, summary: `마감 경과로 추천안 "${label ?? "-"}" 적용(잠정 진행 유지)` }] }
        : { status: "not_applied", reason: "마감 경과, 보류", items: [] };
    await finishReflection(tx, scope, done, null, r, SYS_SCHEDULER);
  }

  async function deadlinesNovel(scope: NovelScope): Promise<number> {
    return uow.run(async (tx) => {
      const n = await novel.getNovel(scope, tx);
      const policy = await novel.getNotificationPolicy(scope, tx);
      const at = now();
      const quiet = inQuietHours(at, n.timezone, policy.quietHoursStart, policy.quietHoursEnd);
      let count = 0;
      for (const q of await repo.listQuestions(tx.db, scope, { statuses: ["open"], limit: 500 })) {
        if (!q.deadlineAt || q.deadlineAt.getTime() > at.getTime()) continue;
        if (q.grade === "non_blocking") {
          await applyDefault(tx, scope, q);
          count++;
          continue;
        }
        if (q.grade !== "blocking") continue;
        // fail-closed: blocking stays open, only reminders (INV-Q-02)
        const due = nextReminderAt(q.deadlineAt, policy.reminderOffsetsMinutes, q.reminderCount);
        if (!due || due.getTime() > at.getTime() || quiet) continue;
        const view = await viewOf(tx, scope, q);
        const reminderNo = q.reminderCount + 1;
        const text = `${view.displayNo} 답변 대기 중, 마감 지남(${hoursAgoLabel(q.deadlineAt, at)}). 이 질문에 걸린 작업만 멈춰 있고 다른 작업은 진행 중입니다.\n\n${q.title}`;
        for (const d of await repo.listDeliveries(tx.db, scope, q.id)) {
          if (d.state !== "posted" && d.state !== "pending") continue;
          const c = await messaging.getChannel(scope, d.channelId, tx);
          if (c.kind === "web") continue;
          await messaging.deliverReminder(tx, scope, view, c.id, { reminderNo, text });
        }
        await repo.updateQuestion(tx.db, scope, q.id, ["open"], { reminderCount: reminderNo, lastRemindedAt: at, updatedAt: at });
        await audit.record(tx, { novelId: scope.novelId, actor: SYS_SCHEDULER, action: "question.reminded", target: { type: "question", id: q.id }, after: { reminderCount: reminderNo }, questionId: q.id });
        count++;
      }
      // non-blocking reflection notices with no digest in 24h (05 §5.2)
      for (const r of await repo.unnotifiedReflections(tx.db, scope)) {
        if (!r.completedAt || at.getTime() - r.completedAt.getTime() < 24 * 3600_000) continue;
        const q = await mustQuestion(tx, scope, r.questionId);
        const ans = r.answerId ? await repo.getAnswer(tx.db, scope, r.answerId) : null;
        const items = await repo.listReflectionItems(tx.db, scope, r.id);
        await notifyReflection(tx, scope, q, r, { status: r.status as "applied" | "not_applied", reason: r.notAppliedReason ?? undefined, items: items.map((i) => ({ changeKind: i.changeKind, summary: i.summary })) }, ans?.channelId ?? null, SYS_MESSENGER);
      }
      return count;
    });
  }

  async function forEachNovel(idsP: Promise<Array<{ novelId: string }>>[], fn: (s: NovelScope) => Promise<number>): Promise<number> {
    const set = new Set((await Promise.all(idsP)).flat().map((r) => r.novelId));
    let total = 0;
    for (const novelId of set) {
      try {
        total += await fn({ novelId });
      } catch (err) {
        log.error({ err, novelId }, "hitl loop failed for novel");
      }
    }
    return total;
  }

  // ── public service ──
  const service: HitlService = {
    async createQuestion(tx, scope, draft, ctx) {
      const q = await create(tx, scope, draft, ctx);
      return { questionId: q.id, grade: q.grade, displayNo: q.displayNo };
    },
    async requestApproval(tx, scope, req) {
      const shape = approvalQuestionShape(req.approvalType);
      const old = req.supersedes
        ? await repo.getApproval(tx.db, scope, req.supersedes, true)
        : await repo.pendingApprovalFor(tx.db, scope, req.target.type, req.target.id, req.approvalType);
      const approvalId = ids.next("apr");
      const links = [...req.question.links, { type: req.target.type, id: req.target.id }].filter((l, i, a) => a.findIndex((x) => x.type === l.type && x.id === l.id) === i);
      const q = await create(
        tx,
        scope,
        { topic: shape.topic, questionType: "approve_reject", title: req.question.title, body: req.question.body, preview: req.question.preview, links, options: [], rationale: "" },
        { createdBy: req.requestedBy, taskId: req.taskId ?? null },
        { approval: { basis: shape.basis } },
      );
      if (old && old.status === "pending") {
        await tx.db.execute(sql`SET CONSTRAINTS approvals_superseded_by_id_fk DEFERRED`);
        await supersede(tx, scope, old, approvalId, req.requestedBy);
      }
      const at = now();
      const a = await repo.insertApproval(tx.db, {
        id: approvalId,
        novelId: scope.novelId,
        approvalType: req.approvalType,
        status: "pending", // A1
        subjectType: req.target.type,
        subjectId: req.target.id,
        questionId: q.id,
        payload: req.payload ?? {},
        requestedByActorType: req.requestedBy.type,
        requestedByActorId: req.requestedBy.id,
        createdAt: at,
        updatedAt: at,
      });
      await repo.updateQuestion(tx.db, scope, q.id, null, { approvalId: a.id });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: req.requestedBy,
        action: "approval.requested",
        target: { type: "approval", id: a.id },
        after: { status: "pending", approvalType: a.approvalType, subject: req.target },
        approvalId: a.id,
        questionId: q.id,
      });
      return { approvalId: a.id, questionId: q.id };
    },
    openFromWeb(scope, questionId, actor) {
      return uow.run(async (tx) => {
        const q = await mustQuestion(tx, scope, questionId, true);
        if (q.status === "open") return q;
        const { messengers } = await channels(tx, scope);
        const opened = await publish(tx, scope, q, { actor, messengers: q.grade === "blocking" ? messengers : [] });
        return opened ?? (await mustQuestion(tx, scope, questionId));
      });
    },
    acceptAnswer,
    async cancelQuestion(tx, scope, questionId, reason, actor) {
      await cancelQ(tx, scope, await mustQuestion(tx, scope, questionId, true), reason, actor);
    },
    async cancelApproval(tx, scope, approvalId, reason, actor) {
      const a = await repo.getApproval(tx.db, scope, approvalId, true);
      if (!a) throw new NotFoundError("승인 요청", approvalId);
      await cancelApprovalRow(tx, scope, a, reason, actor);
      const q = await repo.getQuestion(tx.db, scope, a.questionId, true);
      if (q && (q.status === "pending" || q.status === "open")) await cancelQ(tx, scope, q, reason, actor, false);
    },
    async supersedeApproval(tx, scope, approvalId, supersededById, actor) {
      const a = await repo.getApproval(tx.db, scope, approvalId, true);
      if (!a) throw new NotFoundError("승인 요청", approvalId);
      if (!supersededById) {
        // approvals_ck_5 needs superseded_by_id → closing without a successor is A4 (e.g. E16 human edit)
        await service.cancelApproval(tx, scope, approvalId, "사람이 원고를 직접 고쳐 승인 요청을 닫았습니다.", actor);
        return;
      }
      await supersede(tx, scope, a, supersededById, actor);
    },
    async recordReflection(tx, scope, answerId, r, actor) {
      const answer = await repo.getAnswer(tx.db, scope, answerId);
      if (!answer) throw new NotFoundError("답변", answerId);
      const q = await mustQuestion(tx, scope, answer.questionId, true);
      const refl = await finishReflection(tx, scope, q, answer, r, actor);
      return { reflectionId: refl.id };
    },
    registerApprovalHandler(type, handler) {
      if (approvalHandlers.has(type)) throw new Error(`approval handler already registered: ${type}`);
      approvalHandlers.set(type, handler);
    },
    registerAnswerApplier(topic, applier) {
      if (answerAppliers.has(topic)) throw new Error(`answer applier already registered: ${topic}`);
      answerAppliers.set(topic, applier);
    },
    listQuestions: (scope, filter) => repo.listQuestions(uow.db, scope, filter),
    async getQuestionView(scope, questionId) {
      const q = await mustQuestion(undefined, scope, questionId);
      const view = await viewOf(undefined, scope, q);
      return { ...view, status: q.status, answers: await repo.listAnswers(uow.db, scope, q.id) };
    },
    listApprovals: (scope, filter) => repo.listApprovals(uow.db, scope, filter),
    async getApproval(scope, approvalId, tx) {
      const a = await repo.getApproval(tx?.db ?? uow.db, scope, approvalId);
      if (!a) throw new NotFoundError("승인 요청", approvalId);
      return a;
    },
    async pendingCounts(scope) {
      const open = await repo.listQuestions(uow.db, scope, { statuses: ["pending", "open"], limit: 500 });
      const approvals = await repo.listApprovals(uow.db, scope, { statuses: ["pending"] });
      const deadlines = open.filter((q) => q.grade !== "informational" && q.deadlineAt).map((q) => q.deadlineAt!.getTime());
      return {
        blocking: open.filter((q) => q.grade === "blocking").length,
        nonBlocking: open.filter((q) => q.grade === "non_blocking").length,
        informational: open.filter((q) => q.grade === "informational").length,
        approvals: approvals.length,
        earliestDeadlineAt: deadlines.length ? new Date(Math.min(...deadlines)) : null,
      };
    },
    async inboxSummary(scope) {
      const counts = await service.pendingCounts(scope);
      const qs = await repo.listQuestions(uow.db, scope, { statuses: ["pending", "open"], limit: 500 });
      return {
        ...counts,
        open: qs.filter((q) => q.status === "open").length,
        pending: qs.filter((q) => q.status === "pending").length,
        lateAnswers: await repo.countLate(uow.db, scope),
        pendingReflections: await repo.countPendingReflections(uow.db, scope),
      };
    },
    resolveLateAnswer(scope, answerId, resolution, actor) {
      return uow.run(async (tx) => {
        const a = await repo.getAnswer(tx.db, scope, answerId);
        if (!a) throw new NotFoundError("답변", answerId);
        if (a.disposition !== "late") throw new InvalidTransitionError("late_answer", a.disposition, resolution);
        return resolveLate(tx, scope, a, resolution, actor);
      });
    },
    runDispatcherOnce: () => forEachNovel([repo.pendingNovelIds(uow.db), repo.collectingNovelIds(uow.db), repo.openNovelIds(uow.db)], dispatchNovel),
    async runDeadlinesOnce() {
      const at = now();
      const expired = await uow.run(async (tx) => {
        const rows = await repo.expireSessions(tx.db, at); // AS3
        for (const s of rows) {
          await messaging
            .sendNotice(tx, { novelId: s.novelId }, { kind: "command_reply", channelId: s.channelId, text: "입력 시간이 지났습니다. 다시 누르세요.", idempotencyKey: `session_expired:${s.id}` })
            .catch(() => null);
        }
        return rows.length;
      });
      return expired + (await forEachNovel([repo.openNovelIds(uow.db), repo.answeredWithPendingNoticeNovelIds(uow.db)], deadlinesNovel));
    },
  };

  return {
    service,
    tasks,
    create,
    publish,
    viewOf,
    mustQuestion,
    acceptAnswer,
    commitInterpretation,
    applyChoice,
    finishReflection,
    rootOf,
    async onDelivery(r: { tx: Tx; scope: NovelScope; outboxId: string; status: "sent" | "failed" | "cancelled" | "delivery_unknown"; providerMessageRef: string | null }) {
      const at = now();
      for (const d of await repo.deliveriesByOutbox(r.tx.db, r.scope, r.outboxId)) {
        if (r.status === "sent") await repo.updateDelivery(r.tx.db, r.scope, d.id, ["pending"], { state: "posted", providerMessageRef: r.providerMessageRef, postedAt: at, updatedAt: at }); // QD2
        else if (r.status === "failed" || r.status === "cancelled") await repo.updateDelivery(r.tx.db, r.scope, d.id, ["pending"], { state: "failed", updatedAt: at }); // QD5
      }
    },
    topicRules: TOPIC_RULES,
  };
}

function interpretationConfirmBodyFrom(out: InterpretAnswerOutput): string {
  const lines = out.changes.map((c, i) => `(${i + 1}) ${c.description_ko}`);
  return `다음 ${Math.max(1, out.changes.length)}가지로 반영합니다:\n${lines.length ? lines.join("\n") : `(1) ${out.summary_ko}`}\n\n맞습니까? 고칠 점이 있으면 [직접 입력]으로 알려 주세요.`;
}

export type HitlCore = ReturnType<typeof createHitlCore>;
