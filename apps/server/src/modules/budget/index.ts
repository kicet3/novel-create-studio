/**
 * budget — public API (design/03 §7, 04 §8, 04 §13 BudgetApi; FR-BUD-01~04, G-6).
 * Owns: budget_policies, budget_reservations, cost_events (append-only ledger).
 *
 * Money is integer micro-USD as JS `number` (ADR-016; safe up to ~$9e9). Every LLM call is wrapped by
 * llm.ModelCallPort: reserve (P1) → attachToCall → provider call → settle | release | closeUnknown.
 * INV-COST-01~04: one ledger row per provider call, reservation sum never exceeds the hard limit.
 */
import type { BudgetCategory, BudgetStatus, BudgetWindow, CostBasis, CostCategory, UnpricedUsagePolicy } from "@ncs/shared";
import type { BudgetPoliciesRow, CostEventsRow } from "@ncs/db/schema";
import type { AgentRole } from "@ncs/shared";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { HitlService } from "../hitl/index.js";

export type BudgetPolicy = BudgetPoliciesRow;
export type CostEvent = CostEventsRow;

/** token counts recorded with a cost event (structurally compatible with llm.LlmUsage) */
export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  reportedCostMicros?: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "hard_limit" | "reservation_wait" | "unpriced"; policyId: string };

export interface SettleInput {
  providerCallId: string;
  reservationId: string;
  category: CostCategory;
  basis: CostBasis;
  amountMicros: number;
  usage: UsageRecord;
  provider: string;
  modelId: string;
  providerProfileId: string;
  providerProfileVersion: number;
  isRerun: boolean;
}

export interface BudgetStatusView {
  policyId: string;
  category: BudgetCategory;
  window: BudgetWindow;
  windowStartedAt: Date;
  status: BudgetStatus;
  hardLimitMicros: number;
  softWarnRatio: number;
  spentMicros: number;
  reservedMicros: number;
  remainingMicros: number;
  hardStopEnabled: boolean;
  unpricedUsagePolicy: UnpricedUsagePolicy;
  resumeApprovalId: string | null;
}

export interface BudgetPolicyPatch {
  hardLimitMicros?: number;
  softWarnRatio?: number;
  hardStopEnabled?: boolean;
  unpricedUsagePolicy?: UnpricedUsagePolicy;
  budgetWindow?: BudgetWindow;
}

/** provider identity of a call — needed for ledger rows the budget writes itself (unknown / late) */
export interface CostCallMeta {
  provider: string;
  modelId: string;
  providerProfileId: string;
  providerProfileVersion: number;
  isRerun?: boolean;
}

export interface LateResponseInput {
  providerCallId: string;
  amountMicros: number;
  usage: UsageRecord;
  basis?: CostBasis;
}

export type AdmissionResult = { ok: true } | { ok: false; reason: "hard_limit" | "reservation_wait"; policyId: string };

/** task context of a run, resolved by orchestration (cost_events.task_id / agent_role / arc_id / episode_id, 04 §8.6) */
export interface RunCostContext {
  taskId: string;
  agentRole: AgentRole;
  arcId: string | null;
  episodeId: string | null;
}
export type RunInfoResolver = (tx: Tx, scope: NovelScope, runId: string) => Promise<RunCostContext | null>;

/** called in the transaction that closed a reservation (settled / released / unknown_closed) — 04 §8.3 (b) */
export type ReservationClosedListener = (tx: Tx, scope: NovelScope, e: { reservationId: string; runId: string; status: "settled" | "released" | "unknown_closed" }) => Promise<void>;
/** called in the transaction that resumed a hard-stopped policy — 04 §8.3 "재개" */
export type BudgetResumedListener = (tx: Tx, scope: NovelScope, e: { policyId: string; category: BudgetCategory; approvalId: string | null }) => Promise<void>;

/** hitl surface the budget needs (approval `budget_resume`); wired late because hitl is built after budget */
export type BudgetApprovalPort = Pick<HitlService, "requestApproval" | "registerApprovalHandler"> & Partial<Pick<HitlService, "cancelApproval">>;

export interface RunCostSummary {
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  events: number;
}

export interface DirectSpendCheck {
  category: CostCategory;
  /** estimate of the new spend */
  amountMicros: number;
  /** caller's other in-flight estimates for this novel */
  pendingMicros?: number;
}

export interface DirectCostInput {
  /** unique per novel, e.g. `img:<generationId>` */
  idempotencyKey: string;
  category: CostCategory;
  provider: string;
  modelId: string;
  providerProfileId: string;
  providerProfileVersion: number;
  basis: CostBasis;
  amountMicros: number;
  /** estimate admitted before the call (overrun = amount - reserved) */
  reservedMicros: number;
  /** e.g. `{ images: 2 }` */
  units?: Record<string, unknown>;
}

export interface BudgetService {
  /** N1 participant body: default `all` policy (budget.novel_monthly_hard_limit_usd) — already implemented */
  createDefaultPolicies(tx: Tx, scope: NovelScope): Promise<BudgetPolicy[]>;

  // run side (04 §8)
  reserve(tx: Tx, scope: NovelScope, r: { runId: string; category: CostCategory; maxCostMicros: number | null }): Promise<ReserveResult>;
  /** CAS on status=active; false → do not send, reserve again */
  attachToCall(tx: Tx, scope: NovelScope, reservationId: string, providerCallId: string, meta?: CostCallMeta): Promise<{ attached: boolean }>;
  settle(tx: Tx, scope: NovelScope, s: SettleInput): Promise<{ costEventId: string; overrunMicros: number }>;
  release(tx: Tx, scope: NovelScope, reservationId: string): Promise<void>;
  /** interrupted `sent` call → cost_basis=unknown ledger row (FR-AGT-02 (3)) */
  closeUnknown(tx: Tx, scope: NovelScope, providerCallId: string, reservationId: string, meta?: CostCallMeta): Promise<{ costEventId: string }>;
  /** P7: response arrived after the call was closed as unknown → correction row `pcl:<id>:late` (INV-COST-04) */
  recordLateResponse(tx: Tx, scope: NovelScope, input: LateResponseInput): Promise<{ costEventId: string; created: boolean }>;
  /** last refusal of `reserve()` for a run (engine uses it to pick T7 budget vs budget_reservation_wait) */
  refusalForRun(runId: string): Extract<ReserveResult, { ok: false }> | null;
  /** pre-lease gate (T8): refuses when a policy for the category is hard_stopped */
  admission(scope: NovelScope, category?: CostCategory, tx?: Tx): Promise<AdmissionResult>;
  /** 03 §7.4 step 7 in the caller's tx (idempotent): policy hard_stopped + novel pause + budget_resume approval */
  enforceHardStop(tx: Tx, scope: NovelScope, policyId: string, actor?: ActorRef): Promise<void>;
  /** reclaim / run end: release unattached active reservations, close attached ones as unknown when meta is known */
  closeRunReservations(tx: Tx, scope: NovelScope, runId: string): Promise<{ released: number; unknownClosed: number; leftActive: number }>;
  activeReservationCount(scope: NovelScope, tx?: Tx): Promise<number>;
  /** ledger totals of one run (runs.cost_micros cache) */
  runCostSummary(scope: NovelScope, runId: string, tx?: Tx): Promise<RunCostSummary>;
  /** 02 §7.2: release unattached active reservations older than `olderThanMs` whose run is not active */
  sweepStaleReservations(opts?: { olderThanMs?: number }): Promise<number>;

  // direct spend (no run / provider call — e.g. the image tab, module `imaging`)
  /**
   * Admission for a spend outside the run engine, under the per-novel lock of `tx`. `pendingMicros` are the caller's
   * own in-flight estimates (they hold no budget_reservations row because reservations need a run). INV-COST-02 rules.
   */
  checkDirectSpend(tx: Tx, scope: NovelScope, r: DirectSpendCheck): Promise<AdmissionResult>;
  /** ledger row without a run (idempotent on `idempotencyKey`), then the usual warning / hard-stop evaluation */
  recordDirectCost(tx: Tx, scope: NovelScope, c: DirectCostInput): Promise<{ costEventId: string; created: boolean }>;

  // registries (orchestration registers; hitl is connected by composition)
  registerRunInfoResolver(resolver: RunInfoResolver): void;
  registerActiveRunProbe(isActive: (runId: string) => boolean): void;
  onReservationClosed(listener: ReservationClosedListener): void;
  onResumed(listener: BudgetResumedListener): void;
  /** composition: `budget.service.connectApprovals(hitl.service)` after hitl is built (registers `budget_resume`) */
  connectApprovals(port: BudgetApprovalPort): void;

  // read & settings
  status(scope: NovelScope, category?: CostCategory): Promise<BudgetStatusView[]>;
  listPolicies(scope: NovelScope): Promise<BudgetPolicy[]>;
  updatePolicy(scope: NovelScope, category: BudgetCategory, patch: BudgetPolicyPatch, actor: ActorRef): Promise<BudgetPolicy>;
  /** resume after hard stop (budget.resumed; also unblocks tasks via orchestration — wired by budget agent) */
  resume(scope: NovelScope, category: BudgetCategory, actor: ActorRef, approvalId?: string): Promise<BudgetPolicy>;
  listCostEvents(scope: NovelScope, filter?: { runId?: string; since?: Date; limit?: number }): Promise<CostEvent[]>;
}

export type { BudgetModuleDeps } from "./module.js";
export { createBudgetModule } from "./module.js";
