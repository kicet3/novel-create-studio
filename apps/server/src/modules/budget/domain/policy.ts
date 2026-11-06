/**
 * Budget domain (03 §7, 04 §8) — pure functions, no I/O.
 *
 *  - window arithmetic (calendar_month / lifetime)
 *  - reservation admission (03 §7.4 step 1: (a) hard_limit / (b) reservation_wait)
 *  - policy status transitions B1–B5 and reservation transitions RS1–RS3 (state tables)
 *  - overrun computation (INV-COST-03)
 */
import type { BudgetCategory, BudgetStatus, BudgetWindow, CostCategory, ReservationStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/index.js";

// ── windows ─────────────────────────────────────────────────────────────
/** start of the window containing `now` (UTC month start for calendar_month; epoch for lifetime). */
export function windowStartFor(window: BudgetWindow, now: Date): Date {
  if (window === "lifetime") return new Date(0);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** true when the stored window has elapsed and must roll to the current one. */
export function windowElapsed(window: BudgetWindow, windowStartedAt: Date, now: Date): boolean {
  if (window === "lifetime") return false;
  return windowStartFor(window, now).getTime() > windowStartedAt.getTime();
}

/** budget policies that apply to a cost category: `all` + the category itself (03 §7.4 step 1). */
export function policyCategoriesFor(category: CostCategory): BudgetCategory[] {
  return ["all", category];
}

/** cost categories counted by a policy category */
export function costCategoriesOf(category: BudgetCategory): CostCategory[] {
  return category === "all" ? ["text", "image", "video"] : [category];
}

// ── admission (03 §7.4 step 1, 04 §8.3) ─────────────────────────────────
export interface PolicyLedger {
  hardLimitMicros: number;
  hardStopEnabled: boolean;
  status: BudgetStatus;
  /** ledger sum of the current window (original + correction rows) */
  spentMicros: number;
  /** sum of active reservations */
  reservedMicros: number;
}

export type AdmissionDecision = { ok: true } | { ok: false; reason: "hard_limit" | "reservation_wait" };

/**
 * INV-COST-02: spent + active reservations + this reservation ≤ hard_limit.
 *  (a) spent + amount > limit                        → hard_limit (policy must stop)
 *  (b) spent + amount ≤ limit < spent + reserved + amount → reservation_wait (no stop, no question)
 * A policy already `hard_stopped` refuses everything (resume needs approval).
 * `hardStopEnabled=false` turns the policy into a warning-only policy (FR-BUD-02).
 */
export function decideReservation(p: PolicyLedger, amountMicros: number): AdmissionDecision {
  if (!p.hardStopEnabled) return { ok: true };
  if (p.status === "hard_stopped") return { ok: false, reason: "hard_limit" };
  if (p.spentMicros + amountMicros > p.hardLimitMicros) return { ok: false, reason: "hard_limit" };
  if (p.spentMicros + p.reservedMicros + amountMicros > p.hardLimitMicros) return { ok: false, reason: "reservation_wait" };
  return { ok: true };
}

/** status the ledger implies after a settlement (03 §7.4 step 7: only the ledger stops, not reservations). */
export function statusForSpent(p: { hardLimitMicros: number; softWarnRatio: number; hardStopEnabled: boolean; spentMicros: number }): BudgetStatus {
  if (p.hardStopEnabled && p.spentMicros >= p.hardLimitMicros) return "hard_stopped";
  if (p.spentMicros >= Math.floor(p.hardLimitMicros * p.softWarnRatio)) return "warning";
  return "ok";
}

export function overrunMicros(amountMicros: number, reservedMicros: number): number {
  return Math.max(0, amountMicros - reservedMicros);
}

export function remainingMicros(p: { hardLimitMicros: number; spentMicros: number; reservedMicros: number }): number {
  return Math.max(0, p.hardLimitMicros - p.spentMicros - p.reservedMicros);
}

// ── policy status transitions ───────────────────────────────────────────
export interface Transition<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  /** activity action recorded with the transition */
  action: "budget.warning_reached" | "budget.hard_stop_reached" | "budget.resumed" | "budget.policy_changed";
}

export const BUDGET_STATUS_TRANSITIONS: readonly Transition<BudgetStatus>[] = [
  { id: "B1", from: ["ok"], to: "warning", action: "budget.warning_reached" },
  { id: "B2", from: ["ok", "warning"], to: "hard_stopped", action: "budget.hard_stop_reached" },
  { id: "B3a", from: ["hard_stopped"], to: "ok", action: "budget.resumed" },
  { id: "B3b", from: ["hard_stopped"], to: "warning", action: "budget.resumed" },
  // window roll / limit change: a warning can clear without approval (hard_stopped never auto-clears, 04 U-5)
  { id: "B4", from: ["warning"], to: "ok", action: "budget.policy_changed" },
];

/** automatic transitions (settle / window roll / limit change) — never leaves hard_stopped */
export function autoStatusTransition(from: BudgetStatus, to: BudgetStatus): Transition<BudgetStatus> | null {
  if (from === to || from === "hard_stopped") return null;
  return BUDGET_STATUS_TRANSITIONS.find((t) => t.from.includes(from) && t.to === to && t.id !== "B3a" && t.id !== "B3b") ?? null;
}

export function resumeTransition(from: BudgetStatus, to: "ok" | "warning"): Transition<BudgetStatus> {
  const t = BUDGET_STATUS_TRANSITIONS.find((x) => x.from.includes(from) && x.to === to && x.action === "budget.resumed");
  if (!t) throw new InvalidTransitionError("budget_policy", from, to, "예산 한도로 멈춘 정책만 재개할 수 있습니다.");
  return t;
}

// ── reservation transitions (03 §7.2, 04 §6.2) ──────────────────────────
export const RESERVATION_TRANSITIONS: readonly { id: string; from: readonly ReservationStatus[]; to: ReservationStatus }[] = [
  { id: "RS1", from: ["active"], to: "settled" }, // P3 / P4 billed
  { id: "RS2", from: ["active"], to: "released" }, // P4 not billed, P6, stale sweep
  { id: "RS3", from: ["active"], to: "unknown_closed" }, // P5
];

export function assertReservationTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!RESERVATION_TRANSITIONS.some((t) => t.from.includes(from) && t.to === to)) {
    throw new InvalidTransitionError("budget_reservation", from, to);
  }
}

/** idempotency keys of ledger rows (03 §7.3) */
export const costKeys = {
  call: (providerCallId: string) => `pcl:${providerCallId}`,
  late: (providerCallId: string) => `pcl:${providerCallId}:late`,
};
