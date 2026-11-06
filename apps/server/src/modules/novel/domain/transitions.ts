/**
 * State machines owned by `novel` (03 §4.11, §4.12). Pure functions, no I/O.
 * "표에 없는 전이는 거부합니다" — every transition goes through these tables.
 */
import type { ArcStatus, AutonomyLevel, NovelStatus, PublishPolicy, SeriesBibleStatus } from "@ncs/shared";
import { DomainValidationError, InvalidTransitionError } from "../../../platform/errors.js";

export interface TransitionRule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  /** human-readable trigger (docs) */
  trigger: string;
}

/**
 * novel_status. N1–N3 are 03 §4.12. N4–N6 are not yet tabled in 03 (9절 미결) — assumptions:
 * N4 planning→serializing when the first episode is approved/published (system:orchestrator|publisher|user),
 * N5 serializing→completed by the user, N6 any non-archived → archived by the user.
 */
export const NOVEL_TRANSITIONS: readonly TransitionRule<NovelStatus>[] = [
  { id: "N2", from: ["concept"], to: "onboarding", trigger: "첫 ConceptBrief 승인(CS4, purpose=initial)" },
  { id: "N3", from: ["onboarding"], to: "planning", trigger: "목표 폼 저장(Goal 생성)" },
  { id: "N4", from: ["planning"], to: "serializing", trigger: "첫 화 승인·공개 (가정)" },
  { id: "N5", from: ["serializing"], to: "completed", trigger: "사용자 완결 처리 (가정)" },
  { id: "N6", from: ["concept", "onboarding", "planning", "serializing", "completed"], to: "archived", trigger: "사용자 보관 (가정)" },
];

export const SERIES_BIBLE_TRANSITIONS: readonly TransitionRule<SeriesBibleStatus>[] = [
  { id: "B1", from: ["draft"], to: "awaiting_approval", trigger: "series_bible 승인 요청(A1)" },
  { id: "B2", from: ["awaiting_approval"], to: "approved", trigger: "승인(A2) — 이전 approved는 같은 트랜잭션에서 superseded" },
  { id: "B3", from: ["awaiting_approval"], to: "draft", trigger: "반려(A3)" },
  { id: "B4", from: ["approved", "draft", "awaiting_approval"], to: "superseded", trigger: "새 버전 승인 / 컨셉 개정 승인(11 3.10)" },
];

/** arc_status (03 §4.11): planned → plan_awaiting_approval → active → (awaiting_approval) → completed, anywhere → cancelled. */
export const ARC_TRANSITIONS: readonly TransitionRule<ArcStatus>[] = [
  { id: "AR1", from: ["planned"], to: "plan_awaiting_approval", trigger: "arc_plan 승인 요청" },
  { id: "AR2", from: ["plan_awaiting_approval"], to: "active", trigger: "arc_plan 승인" },
  { id: "AR3", from: ["plan_awaiting_approval"], to: "planned", trigger: "arc_plan 반려 (재계획)" },
  { id: "AR4", from: ["planned"], to: "active", trigger: "full_auto: 계획 승인 없이 시작 (INV-ARC-02 예외)" },
  { id: "AR5", from: ["active"], to: "awaiting_approval", trigger: "arc_approval: 아크의 모든 화가 awaiting_approval" },
  { id: "AR6", from: ["awaiting_approval"], to: "active", trigger: "arc 승인 반려 (05 10.3)" },
  { id: "AR7", from: ["awaiting_approval", "active"], to: "completed", trigger: "arc 승인 / 마지막 화 승인" },
  { id: "AR8", from: ["planned", "plan_awaiting_approval", "active", "awaiting_approval"], to: "cancelled", trigger: "취소" },
];

export function findTransition<S extends string>(table: readonly TransitionRule<S>[], aggregate: string, from: S, to: S): TransitionRule<S> {
  const rule = table.find((r) => r.to === to && r.from.includes(from));
  if (!rule) throw new InvalidTransitionError(aggregate, from, to);
  return rule;
}

export const assertNovelTransition = (from: NovelStatus, to: NovelStatus) => findTransition(NOVEL_TRANSITIONS, "novel", from, to);
export const assertBibleTransition = (from: SeriesBibleStatus, to: SeriesBibleStatus) =>
  findTransition(SERIES_BIBLE_TRANSITIONS, "series_bible", from, to);
export const assertArcTransition = (from: ArcStatus, to: ArcStatus) => findTransition(ARC_TRANSITIONS, "arc", from, to);

/**
 * INV-NOV-02 / INV-NOV-04: non-full_auto forces publish_policy=manual; full_auto needs the warning acknowledgement.
 * 설계 추가 0014: switching full_auto ON also needs the "자동으로 진행할 항목" acknowledgement, and concept confirm /
 * structure auto-approval ("구성·결말도 자동 승인") turned on needs its own warning acknowledgement.
 * `batch_question` has no publish handler yet (준비 중) and is refused.
 */
export function resolveAutonomy(
  input: {
    autonomyLevel: AutonomyLevel;
    publishPolicy?: PublishPolicy;
    acknowledgedFullAutoWarning: boolean;
    acknowledgedAutoItems?: boolean;
    acknowledgedStructureAutoWarning?: boolean;
  },
  ctx: { wasFullAuto?: boolean; structureOptInTurnedOn?: boolean } = {},
): { autonomyLevel: AutonomyLevel; publishPolicy: PublishPolicy } {
  if (input.autonomyLevel !== "full_auto") return { autonomyLevel: input.autonomyLevel, publishPolicy: "manual" };
  if (!input.acknowledgedFullAutoWarning) {
    throw new DomainValidationError("full_auto_ack_required", "완전 자율을 켜려면 정책·저작권 경고를 확인해야 합니다.");
  }
  if (!ctx.wasFullAuto && !input.acknowledgedAutoItems) {
    throw new DomainValidationError("full_auto_items_ack_required", "완전 자율을 켜려면 에이전트가 자동으로 진행할 항목을 확인해야 합니다.");
  }
  if (ctx.structureOptInTurnedOn && !input.acknowledgedStructureAutoWarning) {
    throw new DomainValidationError("structure_auto_ack_required", "컨셉 확정·전체 구성 자동 승인을 켜려면 경고를 확인해야 합니다.");
  }
  if (input.publishPolicy === "batch_question") {
    throw new DomainValidationError("publish_policy_unavailable", "'일괄 질문' 공개 방식은 아직 준비 중입니다. 수동 또는 예약을 고르세요.");
  }
  return { autonomyLevel: "full_auto", publishPolicy: input.publishPolicy ?? "manual" };
}

/** INV-NOV-01: MVP builds allow age_rating ∈ {all, age_12, age_15}. */
export function assertMvpAgeRating(ageRating: string): void {
  if (!["all", "age_12", "age_15"].includes(ageRating)) {
    throw new DomainValidationError("age_rating_not_supported", "현재 버전은 15세 이용가까지만 지원합니다.");
  }
}

/** INV-ARC-01 (app-level mirror of the EXCLUDE constraint): inclusive ranges must not overlap. */
export function rangesOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Shallow diff of changed keys (for audit before/after). */
export function diffFields<T extends Record<string, unknown>>(before: T, patch: Partial<T>): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const k of Object.keys(patch) as Array<keyof T>) {
    if (patch[k] === undefined) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(patch[k])) {
      b[k] = before[k];
      a[k] = patch[k];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}
