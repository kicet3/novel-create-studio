/**
 * Auto-decision policy of the autopilot (설계 추가 0014). Pure: the application layer gathers the facts.
 *
 * Every automatic decision goes through an approval row (created by the owning module as at any level) and is decided
 * by the autopilot with provenance "자동 승인". The autopilot never rejects: an ineligible approval goes to the author
 * (`human`) or waits for a condition the pipeline will satisfy by itself (`wait`).
 */
import type { ApprovalType } from "@ncs/shared";
import type { AutopilotSettings } from "@ncs/shared";

/** approval types the autopilot may decide (DB: approvals_ck_auto) */
export const AUTO_APPROVAL_TYPES = ["concept_brief", "series_bible", "arc_plan", "episode", "story_structure"] as const satisfies readonly ApprovalType[];
export type AutoApprovalType = (typeof AUTO_APPROVAL_TYPES)[number];
export const isAutoApprovalType = (t: string): t is AutoApprovalType => (AUTO_APPROVAL_TYPES as readonly string[]).includes(t);

/** always a human decision at every autonomy level (기존 승인 사실 변경 · 리트콘 · 결말 방향 변경 · 예산 재개 · 떡밥 폐기 …) */
export const ALWAYS_HUMAN_TYPES: readonly ApprovalType[] = [
  "canon_change",
  "retcon",
  "ending_change",
  "budget_resume",
  "setup_abandon",
  "publish_batch",
  "schema_change",
  "identity_change",
  "safety_review",
  "character_sheet",
  "media_quote",
  "draft_adoption",
  "arc",
];

export type ApprovalFacts =
  | {
      type: "episode";
      episodeStatus: string;
      episodeNo: number;
      belowFloor: boolean;
      openHigh: number;
      openMedium: number;
      /** safety_* issues ever opened on this episode (정책·저작권 경고는 사람) */
      safetyEver: number;
      rewriteLimit: boolean;
      /** pending retcon / canon_change / identity_change approvals linked to the episode */
      pendingCanon: number;
    }
  | {
      type: "arc_plan";
      arcStatus: string;
      arcTitle: string;
      replan: boolean;
      structureApproved: boolean;
      /** plot characters with empty required fields */
      castMissing: number;
      /** complete AI proposals not accepted yet (the autopilot accepts them, origins kept) */
      castUnaccepted: number;
      /** fill attempts the autopilot already made for this plot (`draft_cast` fill_missing) */
      fillAttempts: number;
      fillRunning: boolean;
    }
  | { type: "series_bible"; bibleStatus: string; latest: boolean }
  | {
      type: "story_structure";
      status: string;
      reasons: string[];
      endingChanged: boolean;
      castComplete: boolean;
      revisionMatches: boolean;
      /** main-cast fill attempts / a live fill task (planning has no cast step: the autopilot fills before approving) */
      fillAttempts: number;
      fillRunning: boolean;
    }
  | {
      type: "concept_brief";
      briefStatus: string;
      initial: boolean;
      safetyHits: number;
      similarityHits: number;
      /** the LLM similarity / safety check ran and answered (checks.llm_checked); false = unchecked → author */
      llmChecked: boolean;
    }
  | { type: "other"; approvalType: string };

export type Verdict =
  | { kind: "auto"; at: Date; prepare?: "accept_plot_cast" }
  | { kind: "wait"; reasonKo: string; action?: "fill_plot_cast" | "fill_cast" }
  | { kind: "human"; gate: string; reasonKo: string };

export const MAX_FILL_ATTEMPTS = 2;

/** setting that enables auto decisions of an approval type */
export function settingFor(type: AutoApprovalType, s: AutopilotSettings): boolean {
  switch (type) {
    case "episode":
      return s.autoApproveEpisodes;
    case "arc_plan":
      return s.autoApprovePlots;
    case "series_bible":
      return s.autoApproveBible;
    case "story_structure":
      return s.autoApproveStructure;
    case "concept_brief":
      return s.autoConfirmConcept;
  }
}

const SETTING_LABEL: Record<AutoApprovalType, string> = {
  episode: "화 자동 승인",
  arc_plan: "플롯 계획 자동 승인",
  series_bible: "기획서 자동 승인",
  story_structure: "전체 구성 자동 승인",
  concept_brief: "컨셉 확정 자동 승인",
};

/**
 * Cheap check (dispatcher, inside its transaction): is this pending approval expected to be decided automatically?
 * true = web inbox only ("자동 승인 예정"), no messenger push. Facts that need other modules are checked later; an
 * approval the autopilot then refuses is marked held (`payload.autopilot.heldReason`) and goes out to the messengers.
 */
export function holdsForAuto(type: string, payload: unknown, s: AutopilotSettings): boolean {
  if (!isAutoApprovalType(type) || !settingFor(type, s)) return false;
  const p = (payload ?? {}) as { autopilot?: { heldReason?: unknown }; lengthBelowFloor?: unknown; pendingChanges?: { ending?: unknown; goalEndingChanged?: unknown } };
  if (p.autopilot?.heldReason) return false;
  if (type === "episode" && p.lengthBelowFloor) return false;
  if (type === "story_structure" && (p.pendingChanges?.ending || p.pendingChanges?.goalEndingChanged)) return false;
  return true;
}

export function evaluateApproval(
  a: { approvalType: string; createdAt: Date; payload: unknown },
  facts: ApprovalFacts,
  s: AutopilotSettings,
): Verdict {
  const type = a.approvalType;
  if (!isAutoApprovalType(type)) {
    return { kind: "human", gate: "always_human", reasonKo: "모든 자율성 수준에서 사람이 결정하는 승인입니다." };
  }
  if (!settingFor(type, s)) return { kind: "human", gate: "setting_off", reasonKo: `완전 자율 설정에서 '${SETTING_LABEL[type]}'이 꺼져 있습니다.` };
  const held = ((a.payload ?? {}) as { autopilot?: { heldReason?: string } }).autopilot?.heldReason;
  if (held) return { kind: "human", gate: "held", reasonKo: held };
  const at = new Date(a.createdAt.getTime() + s.approveDelayMinutes * 60_000);
  switch (facts.type) {
    case "episode": {
      if (facts.episodeStatus !== "awaiting_approval") return { kind: "wait", reasonKo: "화 상태가 바뀌었습니다." };
      if (facts.belowFloor) return { kind: "human", gate: "length_below_floor", reasonKo: `${facts.episodeNo}화가 분량 하한(3,000자)에 못 미칩니다.` };
      if (facts.safetyEver > 0) return { kind: "human", gate: "safety", reasonKo: `${facts.episodeNo}화에 정책·안전 경고가 있었습니다.` };
      if (facts.rewriteLimit) return { kind: "human", gate: "rewrite_limit", reasonKo: `${facts.episodeNo}화가 자동 재작성 상한에 닿았습니다.` };
      if (facts.openHigh > 0) return { kind: "human", gate: "open_high_issue", reasonKo: `${facts.episodeNo}화에 심각도 높음 연속성 이슈가 ${facts.openHigh}건 열려 있습니다.` };
      if (s.holdOnMediumIssues && facts.openMedium > 0) return { kind: "human", gate: "open_medium_issue", reasonKo: `${facts.episodeNo}화에 심각도 중간 연속성 이슈가 ${facts.openMedium}건 열려 있습니다.` };
      if (facts.pendingCanon > 0) return { kind: "wait", reasonKo: `${facts.episodeNo}화에 걸린 캐논 변경·리트콘 승인을 사람이 먼저 결정해야 합니다.` };
      return { kind: "auto", at };
    }
    case "arc_plan": {
      if (!facts.replan && facts.arcStatus !== "plan_awaiting_approval") return { kind: "wait", reasonKo: "플롯 상태가 바뀌었습니다." };
      if (facts.replan && facts.arcStatus !== "active") return { kind: "wait", reasonKo: "플롯 상태가 바뀌었습니다." };
      if (!facts.structureApproved) return { kind: "wait", reasonKo: "전체 구성 승인을 기다립니다." };
      if (facts.castMissing > 0) {
        if (facts.fillRunning) return { kind: "wait", reasonKo: `「${facts.arcTitle}」 새 인물의 빈 항목을 AI가 채우는 중입니다.` };
        if (facts.fillAttempts >= MAX_FILL_ATTEMPTS) {
          return { kind: "human", gate: "plot_cast_incomplete", reasonKo: `「${facts.arcTitle}」 새 인물의 필수 항목을 AI가 채우지 못했습니다. 캐릭터 화면에서 채워 주세요.` };
        }
        return { kind: "wait", reasonKo: `「${facts.arcTitle}」 새 인물의 빈 항목을 채웁니다.`, action: "fill_plot_cast" };
      }
      return facts.castUnaccepted > 0 ? { kind: "auto", at, prepare: "accept_plot_cast" } : { kind: "auto", at };
    }
    case "series_bible":
      if (facts.bibleStatus !== "awaiting_approval" || !facts.latest) return { kind: "wait", reasonKo: "기획서가 새 판으로 바뀌었습니다." };
      return { kind: "auto", at };
    case "story_structure":
      if (facts.status !== "awaiting_approval" || !facts.revisionMatches) return { kind: "wait", reasonKo: "전체 구성이 바뀌어 새 승인 요청을 기다립니다." };
      if (facts.endingChanged) return { kind: "human", gate: "ending_changed", reasonKo: "승인된 결말이 바뀐 전체 구성은 작가가 다시 승인해야 합니다." };
      if (facts.reasons.length) return { kind: "human", gate: "structure_incomplete", reasonKo: `전체 구성을 자동 승인할 수 없습니다: ${facts.reasons[0]}` };
      if (!facts.castComplete) {
        if (facts.fillRunning) return { kind: "wait", reasonKo: "AI가 캐릭터 필수 항목을 채우는 중입니다." };
        if (facts.fillAttempts >= MAX_FILL_ATTEMPTS) return { kind: "human", gate: "cast_incomplete", reasonKo: "캐릭터 필수 항목을 AI가 채우지 못했습니다. 캐릭터 화면에서 채워 주세요." };
        return { kind: "wait", reasonKo: "캐릭터 필수 항목을 채웁니다.", action: "fill_cast" };
      }
      return { kind: "auto", at };
    case "concept_brief":
      if (facts.briefStatus !== "awaiting_approval") return { kind: "wait", reasonKo: "컨셉 브리프 상태가 바뀌었습니다." };
      if (!facts.initial) return { kind: "human", gate: "concept_revision", reasonKo: "컨셉 개정은 작가가 직접 확정합니다." };
      if (!facts.llmChecked) return { kind: "human", gate: "concept_unchecked", reasonKo: "AI 유사성·안전 점검이 끝나지 않아(응답 오류 또는 AI 연결 없음) 작가가 확인해야 합니다." };
      if (facts.safetyHits > 0 || facts.similarityHits > 0) {
        return { kind: "human", gate: "policy_copyright", reasonKo: `컨셉 점검에서 안전 ${facts.safetyHits}건·유사성 ${facts.similarityHits}건 신호가 나와 작가가 확인해야 합니다.` };
      }
      return { kind: "auto", at };
    case "other":
      return { kind: "human", gate: "always_human", reasonKo: "사람이 결정하는 승인입니다." };
  }
}

/** non-approval question auto-answer eligibility (05 §4 grade + 0014 sensitivity) */
export function questionAutoAnswerable(
  q: { approvalId: string | null; grade: string; blockingBasis: string; sensitivity: string; questionType: string; createdAt: Date; status: string },
  s: AutopilotSettings,
  now: Date,
): { ok: true } | { ok: false; reason: string; at?: Date } {
  if (!s.autoAnswerQuestions) return { ok: false, reason: "setting_off" };
  if (q.approvalId) return { ok: false, reason: "approval" };
  if (q.status !== "open" && q.status !== "pending") return { ok: false, reason: "closed" };
  if (q.grade === "informational") return { ok: false, reason: "informational" };
  if (q.sensitivity === "high") return { ok: false, reason: "high_sensitivity" };
  if (q.questionType !== "single_choice" && q.questionType !== "multi_choice") return { ok: false, reason: "not_choice" };
  if (q.grade === "blocking" && !(s.autoAnswerImportant && (q.blockingBasis === "arc_goal" || q.blockingBasis === "setup_due_high"))) return { ok: false, reason: "blocking" };
  const at = new Date(q.createdAt.getTime() + s.autoAnswerAfterMinutes * 60_000);
  if (at.getTime() > now.getTime()) return { ok: false, reason: "not_yet", at };
  return { ok: true };
}
