/**
 * Budget application service (03 §7, 04 §8, FR-BUD-01~04, G-6).
 *
 * Run side (called by llm.ModelCallPort inside its transactions):
 *   reserve (P1, advisory lock per novel) → attachToCall → settle | release | closeUnknown (| recordLateResponse)
 * INV-COST-01 one ledger row per provider call (idempotency key `pcl:<id>` + partial unique index)
 * INV-COST-02 spent + active reservations + new reservation ≤ hard_limit (decideReservation)
 * INV-COST-03 overrun recorded with `cost.overrun_recorded`
 * INV-COST-04 ledger is append-only; late responses add a correction row
 * Hard limit (03 §7.4 step 7): policy hard_stopped + novel pause(budget_hard_limit) + budget_resume approval.
 */
import { DEFAULTS, usdToMicros, type BudgetCategory, type CostCategory } from "@ncs/shared";
import {
  actors,
  ConflictError,
  DomainValidationError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { NovelService } from "../../novel/index.js";
import type {
  AdmissionResult,
  BudgetApprovalPort,
  BudgetPolicy,
  BudgetResumedListener,
  BudgetService,
  BudgetStatusView,
  CostCallMeta,
  ReservationClosedListener,
  ReserveResult,
  RunCostContext,
  RunInfoResolver,
} from "../index.js";
import {
  autoStatusTransition,
  costKeys,
  decideReservation,
  overrunMicros,
  policyCategoriesFor,
  remainingMicros,
  resumeTransition,
  statusForSpent,
  windowElapsed,
  windowStartFor,
} from "../domain/policy.js";
import { budgetRepo as repo, type Reservation } from "../adapters/db/budget-repository.js";
import { insertDefaultBudgetPolicies } from "../adapters/db/bootstrap.js";

export interface BudgetServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
}

const GUARD = actors.system("budget_guard");
const MAX_REFUSALS = 1000;

const DEFAULT_LIMIT_USD: Record<BudgetCategory, number | null> = {
  all: DEFAULTS["budget.novel_monthly_hard_limit_usd"],
  text: DEFAULTS["budget.text_monthly_hard_limit_usd"],
  image: DEFAULTS["budget.image_monthly_hard_limit_usd"],
  video: DEFAULTS["budget.video_monthly_hard_limit_usd"],
};

export function createBudgetService(deps: BudgetServiceDeps): BudgetService {
  const { platform, audit, novel } = deps;
  const { uow, clock, ids, log } = platform;

  let runInfo: RunInfoResolver | null = null;
  let isRunActive: (runId: string) => boolean = () => false;
  const closedListeners: ReservationClosedListener[] = [];
  const resumedListeners: BudgetResumedListener[] = [];
  let approvals: BudgetApprovalPort | null = null;
  /** last refusal per run (bounded) — lets the engine pick T7 budget vs budget_reservation_wait */
  const refusals = new Map<string, Extract<ReserveResult, { ok: false }>>();
  /** provider identity per attached reservation (for unknown rows written by reclaim in this process) */
  const callMeta = new Map<string, CostCallMeta>();

  const policyTarget = (id: string) => ({ type: "budget_policy" as const, id });

  const rememberRefusal = (runId: string, r: Extract<ReserveResult, { ok: false }>) => {
    refusals.delete(runId);
    refusals.set(runId, r);
    if (refusals.size > MAX_REFUSALS) refusals.delete(refusals.keys().next().value!);
  };

  /** roll an elapsed window (hard_stopped never clears on its own, 04 U-5) */
  const roll = async (tx: Tx, scope: NovelScope, p: BudgetPolicy): Promise<BudgetPolicy> => {
    const now = clock.date();
    if (!windowElapsed(p.budgetWindow, p.windowStartedAt, now)) return p;
    const windowStartedAt = windowStartFor(p.budgetWindow, now);
    const spent = await repo.spent(tx.db, scope, p.category, windowStartedAt);
    const desired = statusForSpent({ ...p, spentMicros: spent });
    const t = autoStatusTransition(p.status, desired === "hard_stopped" ? p.status : desired);
    const updated = await repo.updatePolicy(tx.db, scope, p.id, { windowStartedAt, ...(t ? { status: t.to } : {}) });
    if (t) {
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: GUARD,
        action: t.action,
        target: policyTarget(p.id),
        before: { status: p.status, windowStartedAt: p.windowStartedAt },
        after: { status: updated.status, windowStartedAt },
        reason: "window_rolled",
      });
    }
    return updated;
  };

  const ledgerOf = async (tx: Tx | undefined, scope: NovelScope, p: BudgetPolicy) => {
    const db = tx?.db ?? uow.db;
    const since = windowElapsed(p.budgetWindow, p.windowStartedAt, clock.date()) ? windowStartFor(p.budgetWindow, clock.date()) : p.windowStartedAt;
    const [spentMicros, reservedMicros] = await Promise.all([repo.spent(db, scope, p.category, since), repo.activeReserved(db, scope, p.category)]);
    return { spentMicros, reservedMicros, since };
  };

  const toView = async (tx: Tx | undefined, scope: NovelScope, p: BudgetPolicy): Promise<BudgetStatusView> => {
    const l = await ledgerOf(tx, scope, p);
    return {
      policyId: p.id,
      category: p.category,
      window: p.budgetWindow,
      windowStartedAt: l.since,
      status: p.status,
      hardLimitMicros: p.hardLimitMicros,
      softWarnRatio: p.softWarnRatio,
      spentMicros: l.spentMicros,
      reservedMicros: l.reservedMicros,
      remainingMicros: remainingMicros({ hardLimitMicros: p.hardLimitMicros, spentMicros: l.spentMicros, reservedMicros: l.reservedMicros }),
      hardStopEnabled: p.hardStopEnabled,
      unpricedUsagePolicy: p.unpricedUsagePolicy,
      resumeApprovalId: p.resumeApprovalId,
    };
  };

  /** run hitl calls in a savepoint so a failing (or placeholder) hitl never poisons the caller's tx */
  const inSavepoint = async <T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T | null> => {
    try {
      return await tx.db.transaction(async (sp) => fn({ db: sp as unknown as Tx["db"], afterCommit: (h) => tx.afterCommit(h) }));
    } catch (err) {
      log.warn({ err }, "budget: approval port call failed (continuing without approval)");
      return null;
    }
  };

  const enforceHardStop = async (tx: Tx, scope: NovelScope, policyId: string, actor: ActorRef = GUARD): Promise<void> => {
    const p = await repo.getPolicy(tx.db, scope, policyId, true);
    if (!p) throw new NotFoundError("예산 정책", policyId);
    let current = p;
    const transitioned = p.status !== "hard_stopped";
    if (transitioned) {
      const l = await ledgerOf(tx, scope, p);
      current = await repo.updatePolicy(tx.db, scope, p.id, { status: "hard_stopped" });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "budget.hard_stop_reached",
        target: policyTarget(p.id),
        before: { status: p.status },
        after: { status: "hard_stopped" },
        details: { category: p.category, hardLimitMicros: p.hardLimitMicros, spentMicros: l.spentMicros, reservedMicros: l.reservedMicros },
      });
    }
    const n = await novel.getNovel(scope, tx);
    if (!n.pausedAt) await novel.pause(scope, "budget_hard_limit", actor, { tx, note: `budget:${p.category}` });
    if ((transitioned || !current.resumeApprovalId) && approvals) {
      const port = approvals;
      const l = await ledgerOf(tx, scope, current);
      const res = await inSavepoint(tx, (sp) =>
        port.requestApproval(sp, scope, {
          approvalType: "budget_resume",
          target: policyTarget(p.id),
          question: {
            title: "예산 한도에 도달해 작업을 멈췄습니다",
            body: `이번 기간 사용액이 한도에 닿아 자동 작업을 멈췄습니다. 한도를 올린 뒤 승인하면 작업을 다시 시작합니다. (범주: ${p.category}, 사용 ${l.spentMicros} / 한도 ${p.hardLimitMicros} micro-USD)`,
            links: [policyTarget(p.id)],
          },
          requestedBy: GUARD,
        }),
      );
      if (res) await repo.updatePolicy(tx.db, scope, p.id, { resumeApprovalId: res.approvalId });
    }
  };

  /** after any ledger row: warnings / hard stop for the policies covering `category` (03 §7.4 step 7) */
  const afterLedgerChange = async (tx: Tx, scope: NovelScope, category: CostCategory) => {
    for (let p of await repo.listPolicies(tx.db, scope, policyCategoriesFor(category), true)) {
      p = await roll(tx, scope, p);
      const l = await ledgerOf(tx, scope, p);
      const desired = statusForSpent({ ...p, spentMicros: l.spentMicros });
      if (desired === "hard_stopped") {
        await enforceHardStop(tx, scope, p.id);
        continue;
      }
      const t = autoStatusTransition(p.status, desired);
      if (!t) continue;
      await repo.updatePolicy(tx.db, scope, p.id, { status: t.to });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: GUARD,
        action: t.action,
        target: policyTarget(p.id),
        before: { status: p.status },
        after: { status: t.to },
        details: { spentMicros: l.spentMicros, hardLimitMicros: p.hardLimitMicros, softWarnRatio: p.softWarnRatio },
      });
    }
  };

  const notifyClosed = async (tx: Tx, scope: NovelScope, r: Reservation, status: "settled" | "released" | "unknown_closed") => {
    callMeta.delete(r.id);
    for (const l of closedListeners) await l(tx, scope, { reservationId: r.id, runId: r.runId, status });
  };

  const runContext = async (tx: Tx, scope: NovelScope, runId: string): Promise<RunCostContext | null> => (runInfo ? runInfo(tx, scope, runId) : null);

  const mustReservation = async (tx: Tx, scope: NovelScope, id: string) => {
    const r = await repo.getReservation(tx.db, scope, id, true);
    if (!r) throw new NotFoundError("예산 예약", id);
    return r;
  };

  const closeUnknown: BudgetService["closeUnknown"] = async (tx, scope, providerCallId, reservationId, meta) => {
    const existing = await repo.costEventByKey(tx.db, scope, costKeys.call(providerCallId));
    if (existing) return { costEventId: existing.id };
    const r = await mustReservation(tx, scope, reservationId);
    const m = meta ?? callMeta.get(reservationId) ?? r.callMeta ?? undefined;
    if (!m) throw new DomainValidationError("call_meta_required", "호출 정보가 없어 미확인 비용을 기록할 수 없습니다.", { reservationId });
    const ctx = await runContext(tx, scope, r.runId);
    const id = ids.next("cst");
    const inserted = await repo.insertCostEvent(tx.db, {
      id,
      novelId: scope.novelId,
      idempotencyKey: costKeys.call(providerCallId),
      providerCallId,
      runId: r.runId,
      taskId: ctx?.taskId ?? null,
      agentRole: ctx?.agentRole ?? null,
      arcId: ctx?.arcId ?? null,
      episodeId: ctx?.episodeId ?? null,
      category: r.category,
      provider: m.provider,
      modelId: m.modelId,
      providerProfileId: m.providerProfileId,
      providerProfileVersion: m.providerProfileVersion,
      costBasis: "unknown",
      amountMicros: r.amountMicros,
      reservedMicros: r.amountMicros,
      overrunMicros: 0,
      isRerun: m.isRerun ?? false,
      occurredAt: clock.date(),
    });
    if (!inserted) return { costEventId: (await repo.costEventByKey(tx.db, scope, costKeys.call(providerCallId)))!.id };
    const closed = await repo.close(tx.db, scope, r.id, "unknown_closed", clock.date(), null);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: GUARD,
      action: "cost.unknown_recorded",
      target: { type: "cost_event", id },
      details: { providerCallId, reservationId, runId: r.runId, amountMicros: r.amountMicros },
    });
    await afterLedgerChange(tx, scope, r.category);
    if (closed) await notifyClosed(tx, scope, closed, "unknown_closed");
    return { costEventId: id };
  };

  const release: BudgetService["release"] = async (tx, scope, reservationId) => {
    const closed = await repo.close(tx.db, scope, reservationId, "released", clock.date(), null);
    if (closed) await notifyClosed(tx, scope, closed, "released");
  };

  const resumeInTx = async (tx: Tx, scope: NovelScope, p: BudgetPolicy, actor: ActorRef, approvalId: string | null) => {
    const l = await ledgerOf(tx, scope, p);
    if (p.hardStopEnabled && l.spentMicros >= p.hardLimitMicros) {
      throw new DomainValidationError("budget_limit_still_reached", "사용액이 아직 한도 이상입니다. 한도를 올린 뒤 재개하세요.", {
        spentMicros: l.spentMicros,
        hardLimitMicros: p.hardLimitMicros,
      });
    }
    const desired = statusForSpent({ ...p, spentMicros: l.spentMicros });
    const t = resumeTransition(p.status, desired === "warning" ? "warning" : "ok");
    const pendingApproval = p.resumeApprovalId;
    const updated = await repo.updatePolicy(tx.db, scope, p.id, { status: t.to, resumeApprovalId: approvalId });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "budget.resumed",
      target: policyTarget(p.id),
      before: { status: p.status },
      after: { status: t.to },
      approvalId,
      details: { spentMicros: l.spentMicros, hardLimitMicros: p.hardLimitMicros },
    });
    // resumed outside the approval (HTTP): close the pending budget_resume approval
    if (!approvalId && pendingApproval && approvals?.cancelApproval) {
      const port = approvals;
      await inSavepoint(tx, (sp) => port.cancelApproval!(sp, scope, pendingApproval, "budget_resumed_manually", actor));
    }
    const stillStopped = (await repo.listPolicies(tx.db, scope)).some((x) => x.status === "hard_stopped");
    if (!stillStopped) {
      const n = await novel.getNovel(scope, tx);
      if (n.pausedAt && n.pauseReason === "budget_hard_limit") await novel.resume(scope, actor, { tx, note: "budget_resumed" });
    }
    for (const listener of resumedListeners) await listener(tx, scope, { policyId: p.id, category: p.category, approvalId });
    return updated;
  };

  const service: BudgetService = {
    createDefaultPolicies: (tx, scope) => insertDefaultBudgetPolicies(platform, tx, scope),

    async reserve(tx, scope, r) {
      await repo.lockNovel(tx.db, scope);
      const policies = await repo.listPolicies(tx.db, scope, policyCategoriesFor(r.category), true);
      if (r.maxCostMicros === null || r.maxCostMicros === undefined) {
        // 04 §8.4: MVP supports `block` only (require_approval has no approval_type yet, U-4)
        const p = policies[0];
        const refusal = { ok: false as const, reason: "unpriced" as const, policyId: p?.id ?? "" };
        rememberRefusal(r.runId, refusal);
        return refusal;
      }
      if (!Number.isInteger(r.maxCostMicros) || r.maxCostMicros < 0) throw new DomainValidationError("invalid_amount", "예약 금액이 올바르지 않습니다.");
      let refusal: Extract<ReserveResult, { ok: false }> | null = null;
      for (let p of policies) {
        p = await roll(tx, scope, p);
        const l = await ledgerOf(tx, scope, p);
        const d = decideReservation({ ...p, spentMicros: l.spentMicros, reservedMicros: l.reservedMicros }, r.maxCostMicros);
        if (d.ok) continue;
        if (!refusal || (d.reason === "hard_limit" && refusal.reason !== "hard_limit")) refusal = { ok: false, reason: d.reason, policyId: p.id };
      }
      if (refusal) {
        if (refusal.reason === "hard_limit") await enforceHardStop(tx, scope, refusal.policyId);
        rememberRefusal(r.runId, refusal);
        return refusal;
      }
      const row = await repo.insertReservation(tx.db, {
        id: ids.next("rsv"),
        novelId: scope.novelId,
        runId: r.runId,
        category: r.category,
        amountMicros: r.maxCostMicros,
        status: "active",
        createdAt: clock.date(),
      });
      refusals.delete(r.runId);
      return { ok: true, reservationId: row.id };
    },

    async attachToCall(tx, scope, reservationId, providerCallId, meta) {
      const attached = await repo.attach(tx.db, scope, reservationId, providerCallId, meta ?? null);
      if (attached && meta) callMeta.set(reservationId, meta);
      return { attached };
    },

    async settle(tx, scope, s) {
      const key = costKeys.call(s.providerCallId);
      const existing = await repo.costEventByKey(tx.db, scope, key);
      if (existing) return { costEventId: existing.id, overrunMicros: existing.overrunMicros }; // INV-COST-01 idempotent
      if (!Number.isInteger(s.amountMicros) || s.amountMicros < 0) throw new DomainValidationError("invalid_amount", "정산 금액이 올바르지 않습니다.");
      const r = await mustReservation(tx, scope, s.reservationId);
      if (r.providerCallId && r.providerCallId !== s.providerCallId) {
        throw new ConflictError("reservation_mismatch", "다른 호출에 연결된 예약입니다.", { reservationId: r.id });
      }
      const ctx = await runContext(tx, scope, r.runId);
      const overrun = overrunMicros(s.amountMicros, r.amountMicros);
      const id = ids.next("cst");
      const inserted = await repo.insertCostEvent(tx.db, {
        id,
        novelId: scope.novelId,
        idempotencyKey: key,
        providerCallId: s.providerCallId,
        runId: r.runId,
        taskId: ctx?.taskId ?? null,
        agentRole: ctx?.agentRole ?? null,
        arcId: ctx?.arcId ?? null,
        episodeId: ctx?.episodeId ?? null,
        category: s.category,
        provider: s.provider,
        modelId: s.modelId,
        providerProfileId: s.providerProfileId,
        providerProfileVersion: s.providerProfileVersion,
        costBasis: s.basis,
        amountMicros: s.amountMicros,
        reservedMicros: r.amountMicros,
        overrunMicros: overrun,
        inputTokens: s.usage.inputTokens,
        outputTokens: s.usage.outputTokens,
        cachedTokens: s.usage.cachedInputTokens ?? null,
        isRerun: s.isRerun,
        occurredAt: clock.date(),
      });
      if (!inserted) {
        const e = (await repo.costEventByKey(tx.db, scope, key))!;
        return { costEventId: e.id, overrunMicros: e.overrunMicros };
      }
      const closed = r.status === "active" ? await repo.close(tx.db, scope, r.id, "settled", clock.date(), id) : null;
      if (overrun > 0) {
        await audit.record(tx, {
          novelId: scope.novelId,
          actor: GUARD,
          action: "cost.overrun_recorded",
          target: { type: "cost_event", id },
          details: { providerCallId: s.providerCallId, reservedMicros: r.amountMicros, amountMicros: s.amountMicros, overrunMicros: overrun },
        });
      }
      await afterLedgerChange(tx, scope, s.category);
      if (closed) await notifyClosed(tx, scope, closed, "settled");
      return { costEventId: id, overrunMicros: overrun };
    },

    release,
    closeUnknown,

    async recordLateResponse(tx, scope, input) {
      const key = costKeys.late(input.providerCallId);
      const existing = await repo.costEventByKey(tx.db, scope, key);
      if (existing) return { costEventId: existing.id, created: false };
      const original = await repo.costEventByCall(tx.db, scope, input.providerCallId);
      if (!original || original.costBasis !== "unknown") {
        throw new ConflictError("not_unknown", "미확인 비용으로 닫힌 호출만 정정할 수 있습니다.", { providerCallId: input.providerCallId });
      }
      const id = ids.next("cst");
      await repo.insertCostEvent(tx.db, {
        id,
        novelId: scope.novelId,
        idempotencyKey: key,
        providerCallId: null,
        adjustsCostEventId: original.id,
        runId: original.runId,
        taskId: original.taskId,
        agentRole: original.agentRole,
        arcId: original.arcId,
        episodeId: original.episodeId,
        sceneId: original.sceneId,
        category: original.category,
        provider: original.provider,
        modelId: original.modelId,
        providerProfileId: original.providerProfileId,
        providerProfileVersion: original.providerProfileVersion,
        costBasis: input.basis ?? "measured",
        amountMicros: input.amountMicros - original.amountMicros,
        reservedMicros: 0,
        overrunMicros: overrunMicros(input.amountMicros, original.reservedMicros),
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cachedTokens: input.usage.cachedInputTokens ?? null,
        isRerun: original.isRerun,
        occurredAt: clock.date(),
      });
      await afterLedgerChange(tx, scope, original.category);
      return { costEventId: id, created: true };
    },

    refusalForRun: (runId) => refusals.get(runId) ?? null,

    async admission(scope, category = "text", tx) {
      const db = tx?.db ?? uow.db;
      const policies = await repo.listPolicies(db, scope, policyCategoriesFor(category));
      const stopped = policies.find((p) => p.hardStopEnabled && p.status === "hard_stopped");
      return stopped ? ({ ok: false, reason: "hard_limit", policyId: stopped.id } satisfies AdmissionResult) : { ok: true };
    },

    enforceHardStop,

    async closeRunReservations(tx, scope, runId) {
      let released = 0;
      let unknownClosed = 0;
      let leftActive = 0;
      for (const r of await repo.reservationsOfRun(tx.db, scope, runId, "active")) {
        if (!r.providerCallId) {
          await release(tx, scope, r.id);
          released++;
        } else if (callMeta.has(r.id) || r.callMeta) {
          await closeUnknown(tx, scope, r.providerCallId, r.id);
          unknownClosed++;
        } else {
          leftActive++; // the llm recovery (provider_calls owner) must close it with call meta
        }
      }
      return { released, unknownClosed, leftActive };
    },

    activeReservationCount: (scope, tx) => repo.activeCount(tx?.db ?? uow.db, scope),
    runCostSummary: (scope, runId, tx) => repo.runSummary(tx?.db ?? uow.db, scope, runId),

    async sweepStaleReservations(opts = {}) {
      const olderThanMs = opts.olderThanMs ?? DEFAULTS["budget.reservation_stale_after_minutes"] * 60_000;
      const stale = await repo.staleUnattached(uow.db, new Date(clock.now() - olderThanMs));
      let n = 0;
      for (const r of stale) {
        if (isRunActive(r.runId)) continue;
        await uow.run(async (tx) => {
          const closed = await repo.close(tx.db, { novelId: r.novelId }, r.id, "released", clock.date(), null);
          if (closed) {
            n++;
            await notifyClosed(tx, { novelId: r.novelId }, closed, "released");
          }
        });
      }
      return n;
    },

    async checkDirectSpend(tx, scope, r) {
      if (!Number.isInteger(r.amountMicros) || r.amountMicros < 0) throw new DomainValidationError("invalid_amount", "예상 금액이 올바르지 않습니다.");
      await repo.lockNovel(tx.db, scope);
      let refusal: Extract<AdmissionResult, { ok: false }> | null = null;
      for (let p of await repo.listPolicies(tx.db, scope, policyCategoriesFor(r.category), true)) {
        p = await roll(tx, scope, p);
        const l = await ledgerOf(tx, scope, p);
        const d = decideReservation({ ...p, spentMicros: l.spentMicros, reservedMicros: l.reservedMicros + (r.pendingMicros ?? 0) }, r.amountMicros);
        if (d.ok) continue;
        if (!refusal || (d.reason === "hard_limit" && refusal.reason !== "hard_limit")) refusal = { ok: false, reason: d.reason, policyId: p.id };
      }
      return refusal ?? { ok: true };
    },

    async recordDirectCost(tx, scope, c) {
      const existing = await repo.costEventByKey(tx.db, scope, c.idempotencyKey);
      if (existing) return { costEventId: existing.id, created: false };
      if (!Number.isInteger(c.amountMicros) || c.amountMicros < 0) throw new DomainValidationError("invalid_amount", "비용 금액이 올바르지 않습니다.");
      const id = ids.next("cst");
      const overrun = overrunMicros(c.amountMicros, c.reservedMicros);
      const inserted = await repo.insertCostEvent(tx.db, {
        id,
        novelId: scope.novelId,
        idempotencyKey: c.idempotencyKey,
        providerCallId: null,
        runId: null,
        category: c.category,
        provider: c.provider,
        modelId: c.modelId,
        providerProfileId: c.providerProfileId,
        providerProfileVersion: c.providerProfileVersion,
        costBasis: c.basis,
        amountMicros: c.amountMicros,
        reservedMicros: c.reservedMicros,
        overrunMicros: overrun,
        units: c.units ?? null,
        isRerun: false,
        occurredAt: clock.date(),
      });
      if (!inserted) {
        const e = (await repo.costEventByKey(tx.db, scope, c.idempotencyKey))!;
        return { costEventId: e.id, created: false };
      }
      if (overrun > 0) {
        await audit.record(tx, {
          novelId: scope.novelId,
          actor: GUARD,
          action: "cost.overrun_recorded",
          target: { type: "cost_event", id },
          details: { idempotencyKey: c.idempotencyKey, reservedMicros: c.reservedMicros, amountMicros: c.amountMicros, overrunMicros: overrun },
        });
      }
      await afterLedgerChange(tx, scope, c.category);
      return { costEventId: id, created: true };
    },

    // ── read & settings ──
    async status(scope, category) {
      return uow.run(async (tx) => {
        const cats = category ? policyCategoriesFor(category) : undefined;
        const out: BudgetStatusView[] = [];
        for (let p of await repo.listPolicies(tx.db, scope, cats, true)) {
          p = await roll(tx, scope, p);
          out.push(await toView(tx, scope, p));
        }
        return out;
      });
    },
    listPolicies: (scope) => repo.listPolicies(uow.db, scope),

    async updatePolicy(scope, category, patch, actor) {
      return uow.run(async (tx) => {
        await repo.lockNovel(tx.db, scope);
        let p = await repo.getPolicyByCategory(tx.db, scope, category, true);
        if (patch.hardLimitMicros !== undefined && (!Number.isInteger(patch.hardLimitMicros) || patch.hardLimitMicros < 0)) {
          throw new DomainValidationError("invalid_amount", "한도 금액이 올바르지 않습니다.");
        }
        if (!p) {
          const limitUsd = DEFAULT_LIMIT_USD[category];
          const hardLimitMicros = patch.hardLimitMicros ?? (limitUsd === null ? null : usdToMicros(limitUsd));
          if (hardLimitMicros === null) throw new DomainValidationError("hard_limit_required", "이 범주의 한도 금액을 입력하세요.");
          const window = patch.budgetWindow ?? DEFAULTS["budget.window"];
          p = await repo.insertPolicy(tx.db, {
            id: ids.next("bgp"),
            novelId: scope.novelId,
            category,
            budgetWindow: window,
            hardLimitMicros,
            softWarnRatio: patch.softWarnRatio ?? DEFAULTS["budget.soft_warn_ratio"],
            hardStopEnabled: patch.hardStopEnabled ?? true,
            unpricedUsagePolicy: patch.unpricedUsagePolicy ?? platform.config.budget.unpriced_usage_policy,
            windowStartedAt: windowStartFor(window, clock.date()),
          });
          await audit.record(tx, { novelId: scope.novelId, actor, action: "budget.policy_changed", target: policyTarget(p.id), after: p, reason: "created" });
        } else {
          const before = p;
          const next: Parameters<typeof repo.updatePolicy>[3] = {};
          if (patch.hardLimitMicros !== undefined) next.hardLimitMicros = patch.hardLimitMicros;
          if (patch.softWarnRatio !== undefined) next.softWarnRatio = patch.softWarnRatio;
          if (patch.hardStopEnabled !== undefined) next.hardStopEnabled = patch.hardStopEnabled;
          if (patch.unpricedUsagePolicy !== undefined) next.unpricedUsagePolicy = patch.unpricedUsagePolicy;
          if (patch.budgetWindow !== undefined && patch.budgetWindow !== p.budgetWindow) {
            next.budgetWindow = patch.budgetWindow;
            next.windowStartedAt = windowStartFor(patch.budgetWindow, clock.date());
          }
          p = await repo.updatePolicy(tx.db, scope, p.id, next);
          const pick = (x: BudgetPolicy) => ({
            hardLimitMicros: x.hardLimitMicros,
            softWarnRatio: x.softWarnRatio,
            hardStopEnabled: x.hardStopEnabled,
            unpricedUsagePolicy: x.unpricedUsagePolicy,
            budgetWindow: x.budgetWindow,
          });
          await audit.record(tx, { novelId: scope.novelId, actor, action: "budget.policy_changed", target: policyTarget(p.id), before: pick(before), after: pick(p) });
        }
        // re-evaluate against the new limit (lowering may stop; raising never auto-resumes a hard stop)
        const l = await ledgerOf(tx, scope, p);
        const desired = statusForSpent({ ...p, spentMicros: l.spentMicros });
        if (desired === "hard_stopped" && p.status !== "hard_stopped") {
          await enforceHardStop(tx, scope, p.id, actor);
        } else {
          const t = autoStatusTransition(p.status, desired === "hard_stopped" ? p.status : desired);
          if (t) {
            await repo.updatePolicy(tx.db, scope, p.id, { status: t.to });
            await audit.record(tx, { novelId: scope.novelId, actor, action: t.action, target: policyTarget(p.id), before: { status: p.status }, after: { status: t.to } });
          }
        }
        return (await repo.getPolicy(tx.db, scope, p.id))!;
      });
    },

    async resume(scope, category, actor, approvalId) {
      return uow.run(async (tx) => {
        const p = await repo.getPolicyByCategory(tx.db, scope, category, true);
        if (!p) throw new NotFoundError("예산 정책", category);
        return resumeInTx(tx, scope, p, actor, approvalId ?? null);
      });
    },

    listCostEvents: (scope, filter = {}) => repo.listCostEvents(uow.db, scope, filter),

    // ── registries ──
    registerRunInfoResolver(resolver) {
      runInfo = resolver;
    },
    registerActiveRunProbe(fn) {
      isRunActive = fn;
    },
    onReservationClosed(listener) {
      closedListeners.push(listener);
    },
    onResumed(listener) {
      resumedListeners.push(listener);
    },
    connectApprovals(port) {
      approvals = port;
      port.registerApprovalHandler("budget_resume", async (ctx) => {
        const scope = ctx.scope;
        const p = await repo.getPolicy(ctx.tx.db, scope, ctx.approval.subjectId, true);
        if (!p) return;
        if (ctx.decision === "rejected") {
          // stays stopped; a later stop may ask again
          await repo.updatePolicy(ctx.tx.db, scope, p.id, { resumeApprovalId: null });
          return;
        }
        if (p.status !== "hard_stopped") return;
        const l = await ledgerOf(ctx.tx, scope, p);
        if (p.hardStopEnabled && l.spentMicros >= p.hardLimitMicros) {
          log.info({ policyId: p.id }, "budget_resume approved but the limit is still reached — raise the limit, then resume");
          await repo.updatePolicy(ctx.tx.db, scope, p.id, { resumeApprovalId: null });
          return;
        }
        await resumeInTx(ctx.tx, scope, p, ctx.actor, ctx.approval.id);
      });
    },
  };
  return service;
}
