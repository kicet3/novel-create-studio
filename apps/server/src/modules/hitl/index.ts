/**
 * hitl — public API (design/05 §2–§8, §10; 03 §3.4, §4.4–4.5; ADR-014; FR-HIL-*, FR-MSG-05~09, 16~18).
 * Owns: questions, question_options, question_links, question_deliveries, answers,
 * answer_interpretations, answer_reflections, answer_reflection_items, approvals, digest_batches,
 * answer_sessions.
 *
 * Agents propose `QuestionDraft`s; hitl validates, grades (05 §4 — agents never set grade), stores,
 * schedules delivery (web inbox always + messenger via messaging.deliverQuestion), accepts answers
 * with CAS (Q3 / late / duplicate), and dispatches decisions:
 *  - approvals → `registerApprovalHandler(approvalType, …)` owners (concept_brief → concept;
 *    series_bible/arc_plan/arc/episode → manuscript; budget_resume → budget …) in the decision tx;
 *  - answers → `registerAnswerApplier(topic, …)` (entity_disambiguation → linking …) or the
 *    `interpret_answer`/`apply_answer` tasks; blocked tasks are released via orchestration.unblockByRef.
 * Every answer ends with an AnswerReflection (applied | not_applied + reason) and a reflection notice (G-5).
 */
import type {
  AnswerDisposition,
  ApprovalStatus,
  ApprovalType,
  BlockingBasis,
  QuestionGrade,
  QuestionStatus,
  QuestionTopic,
  QuestionType,
  ReflectionChangeKind,
  ReflectionStatus,
  ReworkFrom,
} from "@ncs/shared";
import type { AnswersRow, ApprovalsRow, QuestionsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Ref, Tx } from "../../platform/index.js";
import type { PreviewExcerpt, QuestionView } from "../messaging/index.js";

export type Question = QuestionsRow;
export type Approval = ApprovalsRow;
export type Answer = AnswersRow;

/** 05 §4.3 */
export interface QuestionRecommendation {
  optionValue: unknown;
  /** what happens at the deadline for non_blocking questions */
  defaultAction: "apply" | "hold";
  rationale: string;
}

/** 05 §2.3 — agent-proposed question (zod schema lives in hitl/domain; DTO in @ncs/shared dto/hitl.ts). */
export interface QuestionDraft {
  topic: QuestionTopic;
  questionType: QuestionType;
  title: string;
  body: string;
  options: Array<{ label: string; value: unknown; isRecommended?: boolean }>;
  recommendation?: QuestionRecommendation | null;
  rationale?: string;
  /** ≥ 1 (INV-Q-05) */
  links: Ref[];
  preview?: PreviewExcerpt[];
  dependsOnQuestionId?: string | null;
  proposedBlockingBasis?: BlockingBasis | null;
  /** informational notice (grade=informational, no options; 05 §3.3 last paragraph) */
  notice?: boolean;
  /** offer "직접 입력" (free text outside the options → interpret_answer, FR-MSG-16) */
  allowFreeText?: boolean;
  /** 설계 추가 0014: an agent may only RAISE the sensitivity (high = never auto-answered in full_auto) */
  sensitivity?: "high";
  /** deterministic G2 inputs the asking module knows (05 §4.2 U1–U7) */
  gradeHints?: {
    touchesApprovedCanon?: boolean;
    touchesPublishedCanon?: boolean;
    majorCharacterFate?: boolean;
    endingDirection?: boolean;
    arcGoal?: boolean;
    budgetChange?: boolean;
    setupDueHigh?: boolean;
  };
}

export interface CreateQuestionContext {
  createdBy: ActorRef;
  taskId?: string | null;
  runId?: string | null;
}

export interface ApprovalRequest {
  approvalType: ApprovalType;
  target: Ref;
  /** approve/reject question shown to the user (title/body/preview) */
  question: Pick<QuestionDraft, "title" | "body" | "preview" | "links">;
  requestedBy: ActorRef;
  taskId?: string | null;
  /** previous pending approval of the same target to supersede (A5); a pending approval of the same
   *  (subject, approval_type) is superseded automatically (INV-APR-01) */
  supersedes?: string | null;
  /** approvals.payload (summary, warnings, diff refs … 05 §10.2) */
  payload?: Record<string, unknown>;
}

export interface ApprovalDecisionContext {
  tx: Tx;
  scope: NovelScope;
  approval: Approval;
  decision: "approved" | "rejected";
  decisionNote: string | null;
  reworkFrom: ReworkFrom | null;
  actor: ActorRef;
  answerId: string | null;
  /** 설계 추가 0014: decided by the autopilot (full_auto) on behalf of the delegating author */
  auto?: boolean;
}

export type ApprovalHandler = (ctx: ApprovalDecisionContext) => Promise<void>;

export interface AnswerApplyContext {
  tx: Tx;
  scope: NovelScope;
  question: Question;
  answer: Answer;
  actor: ActorRef;
  /** the chosen options (idx order of the answer), with their stored values */
  selectedOptions: Array<{ idx: number; label: string; value: unknown }>;
}

/** returns the reflection to record (05 §8) */
export type AnswerApplier = (ctx: AnswerApplyContext) => Promise<{
  status: Exclude<ReflectionStatus, "pending">;
  reason?: string;
  items: Array<{ changeKind: ReflectionChangeKind; ref?: Ref; summary: string }>;
}>;

export interface AcceptAnswerInput {
  questionId: string;
  channelId: string;
  responderUserId: string;
  /** option ids for choice questions, text for free text / approve-reject note */
  optionIds?: string[];
  text?: string | null;
  /** approve_reject questions */
  approval?: { decision: "approved" | "rejected"; decisionNote?: string; reworkFrom?: ReworkFrom };
  /** messenger_inbox id or web request id — answers are unique per source (idempotent replays) */
  sourceKey: string;
}

export interface QuestionFilter {
  statuses?: QuestionStatus[];
  grades?: QuestionGrade[];
  topics?: QuestionTopic[];
  limit?: number;
}

export interface PendingCounts {
  blocking: number;
  nonBlocking: number;
  informational: number;
  approvals: number;
  earliestDeadlineAt: Date | null;
}

/**
 * 설계 추가 0014: the autopilot (full_auto) registers itself here. `holds` is a cheap check run by the dispatcher in
 * its transaction (true = the approval waits for an auto decision: web inbox only, no messenger push); `confirm`
 * re-checks inside the auto-decision transaction (novel row locked) right before the decision is recorded.
 */
export interface AutoDecider {
  holds(tx: Tx, scope: NovelScope, approval: Approval): Promise<boolean>;
  confirm(tx: Tx, scope: NovelScope, approval: Approval): Promise<{ ok: true; delegatedByUserId: string } | { ok: false; reason: string }>;
  /** may this question be auto-answered now (level / halt / settings re-check in the answer transaction) */
  confirmAnswer(tx: Tx, scope: NovelScope, question: Question): Promise<{ ok: true; delegatedByUserId: string } | { ok: false; reason: string }>;
}

export type AutoDecisionResult = { decided: true; answerId: string } | { decided: false; code: string; reason: string };

export interface HitlService {
  createQuestion(tx: Tx, scope: NovelScope, draft: QuestionDraft, ctx: CreateQuestionContext): Promise<{ questionId: string; grade: QuestionGrade; displayNo: number }>;
  /** A1 + linked approve_reject question in the same tx (ADR-014) */
  requestApproval(tx: Tx, scope: NovelScope, req: ApprovalRequest): Promise<{ approvalId: string; questionId: string }>;
  /** Q2(b) "지금 답하기" from the web inbox */
  openFromWeb(scope: NovelScope, questionId: string, actor: ActorRef): Promise<Question>;
  /** Q3 CAS / late / duplicate (05 §6.2); runs approval handler or answer applier in the same tx */
  acceptAnswer(scope: NovelScope, input: AcceptAnswerInput, tx?: Tx): Promise<{ disposition: AnswerDisposition; answerId: string }>;
  cancelQuestion(tx: Tx, scope: NovelScope, questionId: string, reason: string, actor: ActorRef): Promise<void>;
  cancelApproval(tx: Tx, scope: NovelScope, approvalId: string, reason: string, actor: ActorRef): Promise<void>;
  /** A5 (e.g. E16 human edit closes the pending episode approval) */
  supersedeApproval(tx: Tx, scope: NovelScope, approvalId: string, supersededById: string | null, actor: ActorRef): Promise<void>;
  recordReflection(tx: Tx, scope: NovelScope, answerId: string, r: Awaited<ReturnType<AnswerApplier>>, actor: ActorRef): Promise<{ reflectionId: string }>;

  registerApprovalHandler(approvalType: ApprovalType, handler: ApprovalHandler): void;
  /** 설계 추가 0014 (one decider; the autopilot module) */
  registerAutoDecider(decider: AutoDecider): void;
  /**
   * approve a pending approval on behalf of the delegating author (answer row auto_answered, question
   * resolution_source=auto_answer, approval auto_decided, handler ctx.auto). Never rejects. A handler refusal rolls the
   * decision back and marks the approval held (payload.autopilot.heldReason) — it then goes to the human path.
   */
  autoDecideApproval(scope: NovelScope, approvalId: string, opts: { actor: ActorRef; note?: string }): Promise<AutoDecisionResult>;
  /** answer an open (non-approval) choice question with its recommended option (`auto_answer`) */
  autoAnswerQuestion(scope: NovelScope, questionId: string, opts: { actor: ActorRef }): Promise<AutoDecisionResult>;
  /**
   * 설계 추가 0015: an agent (entity resolver) answers an open non-blocking choice question in the CALLER's transaction, at
   * any autonomy level (answer auto_answered on behalf of the owner, question resolution_source=agent_resolved). `applier`
   * replaces the registered topic applier (the agent's exact decision); the reflection is recorded as usual.
   */
  agentResolveQuestion(tx: Tx, scope: NovelScope, questionId: string, opts: { optionIdx: number; actor: ActorRef; note?: string; applier?: AnswerApplier }): Promise<AutoDecisionResult>;
  /**
   * 설계 추가 0015: close an open interpretation_confirm question without asking again: the confirm question is cancelled
   * (reason prefixed "에이전트가 정리"), its interpretation rejected (no follow-up is created) and waiting followups of the
   * root closed. The caller applies the decision to the root and records the root reflection (recordReflection).
   */
  agentCloseInterpretation(tx: Tx, scope: NovelScope, confirmQuestionId: string, actor: ActorRef, reason: string): Promise<{ rootQuestionId: string; rootAnswerId: string | null; rootStatus: QuestionStatus } | null>;
  /** the autopilot will not decide this approval: payload.autopilot.heldReason (the dispatcher sends it to messengers) */
  markAutoHeld(scope: NovelScope, approvalId: string, reason: string, tx?: Tx): Promise<void>;
  registerAnswerApplier(topic: QuestionTopic, applier: AnswerApplier): void;

  // read side (web inbox, home)
  listQuestions(scope: NovelScope, filter?: QuestionFilter, tx?: Tx): Promise<Question[]>;
  getQuestionView(scope: NovelScope, questionId: string): Promise<QuestionView & { status: QuestionStatus; resolutionSource: Question["resolutionSource"]; sensitivity: Question["sensitivity"]; answers: Answer[] }>;
  listApprovals(scope: NovelScope, filter?: { statuses?: ApprovalStatus[]; types?: ApprovalType[] }, tx?: Tx): Promise<Approval[]>;
  getApproval(scope: NovelScope, approvalId: string, tx?: Tx): Promise<Approval>;
  pendingCounts(scope: NovelScope): Promise<PendingCounts>;
  /** web inbox summary (counts + late answers + reflections waiting) */
  inboxSummary(scope: NovelScope): Promise<PendingCounts & { lateAnswers: number; pendingReflections: number; open: number; pending: number; agentResolved: number }>;
  /** user decision on a late answer (05 §6.5 AN2: dismiss) */
  resolveLateAnswer(scope: NovelScope, answerId: string, resolution: "dismissed", actor: ActorRef): Promise<Answer>;

  // workers (background loops call these; tests call them directly)
  /** D1–D7 for pending questions + digest flush + messenger fan-out of open blocking questions */
  runDispatcherOnce(): Promise<number>;
  /** Q4 non-blocking deadlines, blocking reminders (fail-closed), AnswerSession expiry, overdue notices */
  runDeadlinesOnce(): Promise<number>;
}

export type { HitlModuleDeps } from "./module.js";
export { createHitlModule } from "./module.js";
