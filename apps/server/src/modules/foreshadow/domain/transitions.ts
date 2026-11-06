/**
 * Setup state machines (03 §4.7) and SetupBeat status (07 §5.2). Pure — no I/O.
 * "표에 없는 전이는 거부합니다": every change goes through these tables.
 */
import type { CanonStatus, SetupBeatKind, SetupBeatStatus, SetupNarrativeStatus } from "@ncs/shared";
import { DomainValidationError, InvalidTransitionError } from "../../../platform/errors.js";

export interface TransitionRule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  trigger: string;
}

/** 03 §4.7 narrative status. S1 (creation → planned) and S6 ([v1] detected → planted) are creations, not transitions. */
export const SETUP_NARRATIVE_TRANSITIONS: readonly TransitionRule<SetupNarrativeStatus>[] = [
  { id: "S2", from: ["planned"], to: "planted", trigger: "plant 비트 confirmed (E9)" },
  { id: "S3", from: ["planted", "reinforced"], to: "reinforced", trigger: "reinforce 비트 confirmed (E9)" },
  { id: "S4", from: ["planted", "reinforced"], to: "paid_off", trigger: "payoff 비트 confirmed (E9)" },
  { id: "S5", from: ["planned", "planted", "reinforced"], to: "abandoned", trigger: "setup_abandon 승인" },
];

/** 03 §4.7 canon status of the setup itself. SC1 is creation (candidate). */
export const SETUP_CANON_TRANSITIONS: readonly TransitionRule<CanonStatus>[] = [
  { id: "SC2", from: ["candidate"], to: "approved", trigger: "arc_plan 승인 (full_auto는 자동)" },
  { id: "SC3", from: ["candidate"], to: "rejected", trigger: "아크 계획에서 제외" },
  { id: "SC4", from: ["approved"], to: "published_locked", trigger: "plant 비트가 있는 화 공개 (E13)" },
  { id: "SC5", from: ["published_locked"], to: "approved", trigger: "그 화 공개 취소 (E14)" },
  { id: "SC6", from: ["approved", "published_locked"], to: "retracted", trigger: "떡밥 철회 (canon_change / retcon 승인)" },
];

/** 07 §5.2 setup_beat_status (incl. detected → planned on rewrite). */
export const SETUP_BEAT_TRANSITIONS: readonly TransitionRule<SetupBeatStatus>[] = [
  { id: "B1", from: ["planned"], to: "detected", trigger: "떡밥 검사가 근거 위치를 찾음" },
  { id: "B2", from: ["planned"], to: "missing", trigger: "떡밥 검사가 찾지 못함" },
  { id: "B3", from: ["missing"], to: "detected", trigger: "재작성 후 재검사에서 찾음" },
  { id: "B3m", from: ["missing"], to: "missing", trigger: "재작성 후 재검사에서도 찾지 못함 (같은 상태, 검사 버전만 갱신)" },
  { id: "B4", from: ["detected"], to: "planned", trigger: "재작성으로 근거 씬이 바뀌어 재검사 대상 (근거 필드 비움)" },
  { id: "B5", from: ["detected"], to: "confirmed", trigger: "화 확정 (E9)" },
  { id: "B6", from: ["planned", "missing"], to: "cancelled", trigger: "아웃라인 재작성에서 배정 해제 / 기한 변경" },
];

/** 03 §4.7 two-axis combination constraint. */
export const NARRATIVE_ALLOWED_CANON: Readonly<Record<SetupNarrativeStatus, readonly CanonStatus[]>> = {
  planned: ["candidate", "approved", "rejected"],
  planted: ["approved", "published_locked"],
  reinforced: ["approved", "published_locked"],
  paid_off: ["approved", "published_locked"],
  abandoned: ["approved", "published_locked", "retracted"],
};

export const TERMINAL_NARRATIVE: readonly SetupNarrativeStatus[] = ["paid_off", "abandoned"];

function find<S extends string>(table: readonly TransitionRule<S>[], aggregate: string, from: S, to: S): TransitionRule<S> {
  const rule = table.find((r) => r.to === to && r.from.includes(from));
  if (!rule) throw new InvalidTransitionError(aggregate, from, to);
  return rule;
}

export function assertCombination(narrative: SetupNarrativeStatus, canon: CanonStatus): void {
  if (!NARRATIVE_ALLOWED_CANON[narrative].includes(canon)) {
    throw new DomainValidationError(
      "setup_status_combination",
      `떡밥 서사 상태 '${narrative}'에서는 캐논 상태 '${canon}'을(를) 쓸 수 없습니다.`,
      { narrative, canon },
    );
  }
}

export interface NarrativeGuardInput {
  from: SetupNarrativeStatus;
  to: SetupNarrativeStatus;
  canon: CanonStatus;
  /** S2–S4: the confirmed beat that justifies the change (INV-SU-01) */
  beat?: { id: string; kind: SetupBeatKind; status: SetupBeatStatus } | null;
  /** S5: approved setup_abandon approval (INV-SU-02) */
  abandonApprovalId?: string | null;
  reason?: string | null;
}

const BEAT_FOR_RULE: Record<string, SetupBeatKind> = { S2: "plant", S3: "reinforce", S4: "payoff" };

/** Returns the rule id; throws InvalidTransitionError / DomainValidationError. */
export function assertNarrativeTransition(g: NarrativeGuardInput): TransitionRule<SetupNarrativeStatus> {
  const rule = find(SETUP_NARRATIVE_TRANSITIONS, "setup", g.from, g.to);
  const beatKind = BEAT_FOR_RULE[rule.id];
  if (beatKind) {
    if (!g.beat || g.beat.kind !== beatKind || g.beat.status !== "confirmed") {
      throw new DomainValidationError(
        "setup_beat_required",
        `떡밥 상태를 바꾸려면 확정된 ${beatKind} 비트(근거 씬)가 있어야 합니다.`,
        { rule: rule.id, beatKind },
      );
    }
  }
  if (rule.id === "S5") {
    if (!g.abandonApprovalId) {
      throw new DomainValidationError("setup_abandon_approval_required", "떡밥 폐기는 setup_abandon 승인이 있어야 합니다.");
    }
    if (!g.reason || !g.reason.trim()) {
      throw new DomainValidationError("setup_abandon_reason_required", "떡밥 폐기 사유를 입력하세요.");
    }
  }
  // combination after the change (planned+candidate → abandoned is not allowed: reject it instead, SC3)
  assertCombination(g.to, g.canon);
  return rule;
}

export function assertCanonTransition(
  narrative: SetupNarrativeStatus,
  from: CanonStatus,
  to: CanonStatus,
  opts: { approvalId?: string | null } = {},
): TransitionRule<CanonStatus> {
  const rule = find(SETUP_CANON_TRANSITIONS, "setup_canon", from, to);
  if (rule.id === "SC6" && !opts.approvalId) {
    throw new DomainValidationError("setup_retract_approval_required", "떡밥 철회는 canon_change 또는 retcon 승인이 있어야 합니다.");
  }
  assertCombination(narrative, to);
  return rule;
}

export function assertBeatTransition(from: SetupBeatStatus, to: SetupBeatStatus): TransitionRule<SetupBeatStatus> {
  return find(SETUP_BEAT_TRANSITIONS, "setup_beat", from, to);
}

/** Narrative change implied by confirming a beat (E9), or null when none applies. */
export function narrativeTargetForBeat(kind: SetupBeatKind, current: SetupNarrativeStatus): SetupNarrativeStatus | null {
  if (kind === "plant") return current === "planned" ? "planted" : null;
  if (kind === "reinforce") return current === "planted" || current === "reinforced" ? "reinforced" : null;
  return current === "planted" || current === "reinforced" ? "paid_off" : null;
}

/** INV-SU-03: title / due / importance edits of an approved setup need approval (canon_change) or a question (due extension). */
export function isCanonLocked(canon: CanonStatus): boolean {
  return canon === "approved" || canon === "published_locked";
}

export function formatSetupNo(displayNo: number): string {
  return `S-${String(displayNo).padStart(2, "0")}`;
}

/** "1" / "01" / "S-01" / "s01" → 1; null when not a display number */
export function parseSetupNo(input: string | number): number | null {
  if (typeof input === "number") return Number.isInteger(input) && input > 0 ? input : null;
  const m = /^(?:s-?)?0*(\d+)$/i.exec(input.trim());
  return m ? Number(m[1]) : null;
}
