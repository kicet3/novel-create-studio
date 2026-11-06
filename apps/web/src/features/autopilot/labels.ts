/** 설계 추가 0014 — Korean wording of the 완전 자율 screens (pure; unit-tested). */
import type { AutopilotView } from "@ncs/shared";
import { formatUsd, labelKo } from "@ncs/shared";

export const PHASE_LABEL: Record<AutopilotView["phase"], string> = {
  off: "꺼짐",
  halted: "멈춤",
  paused: "작품 일시정지",
  throttled: "오늘 상한 도달",
  concept: "컨셉",
  world_cast: "세계관·캐릭터",
  goal: "연재 목표",
  bible: "기획서",
  structure: "전체 구성",
  plots: "플롯 계획",
  writing: "집필",
  completed: "목표 화수 도달",
};

/** what full_auto does automatically (confirmation dialog / settings) */
export const AUTO_ITEMS: string[] = [
  "화 승인(분량 3,000자 이상이고 심각도 높음 연속성 이슈·정책 경고·재작성 상한이 없을 때)",
  "플롯 계획 승인(새 인물의 AI 제안 수락 포함)",
  "세계관 후보 승인(충돌 항목은 '미확정'으로 남김)",
  "캐릭터 빈 항목 AI 채움과 캐스트 확정(직접 쓴 항목은 바꾸지 않음)",
  "컨셉 값으로 연재 목표 저장",
  "기획서 승인",
  "질문 자동 응답(민감도 보통인 선택형, 기본 30분 뒤 추천안)",
];
/** only when the publish policy is "scheduled" */
export const AUTO_PUBLISH_ITEM = "승인된 화를 연재 주기에 맞춰 예약 공개";

/** opt-in name (concept confirm + structure / ending approval) */
export const STRUCTURE_OPT_IN_LABEL = "컨셉 확정·구성·결말도 자동 승인";

const HALT_REASON: Record<string, string> = { user: "작가 요청", budget_warning: "월 예산 경고", error: "오류" };

export const ALWAYS_HUMAN: string[] = ["기존 승인 사실 변경", "리트콘", "결말 방향 변경(승인 후)", "예산 하드 한도 도달 후 재개", "떡밥 폐기"];

/** "완전 자율 진행 중 · 다음: 3화 초안 작성" */
export function bannerTitle(
  v: Pick<AutopilotView, "level" | "active" | "phase" | "next" | "halted" | "throttle"> & { waitingHuman?: AutopilotView["waitingHuman"] },
  opts: { llmDown?: boolean } = {},
): string {
  if (v.level !== "full_auto") return "";
  if (v.halted) return `완전 자율 멈춤 (${HALT_REASON[v.halted.reason] ?? labelKo("autopilot_halt_reason", v.halted.reason)})`;
  if (v.phase === "paused") return "완전 자율 · 작품이 일시정지되어 진행하지 않습니다";
  if (v.throttle) return `완전 자율 · ${v.throttle.reason === "daily_budget" ? "하루 비용 상한" : "하루 화 수 상한"}에 닿아 내일 이어 갑니다`;
  if (v.phase === "completed") return "완전 자율 · 목표 화수에 도달했습니다(예약 공개는 계속)";
  if (opts.llmDown) return "완전 자율 · AI 연결 없음 — 연결될 때까지 진행하지 못합니다";
  const waiting = v.waitingHuman?.length ?? 0;
  if (waiting > 0) return `완전 자율 · 사람 확인 대기 ${waiting}건${v.next ? ` · 다음: ${v.next}` : ""}`;
  return `완전 자율 진행 중${v.next ? ` · 다음: ${v.next}` : ""}`;
}

export function todayLine(v: Pick<AutopilotView, "today">): string {
  const t = v.today;
  const cost = `오늘 비용 ${formatUsd(t.spentMicros)}${t.dailyBudgetMicros !== null ? ` / ${formatUsd(t.dailyBudgetMicros)}` : ""}`;
  return `오늘 착수 ${t.startedEpisodes}/${t.maxEpisodes}화 · 오늘 승인 ${t.approvedEpisodes}화 · ${cost}`;
}

const ACTION_LABEL: Record<string, string> = {
  "autopilot.enabled": "완전 자율 켬",
  "autopilot.disabled": "완전 자율 끔",
  "autopilot.settings_changed": "완전 자율 설정 변경",
  "autopilot.halted": "자율 진행 멈춤",
  "autopilot.resumed": "자율 진행 재개",
  "autopilot.approval_decided": "자동 승인",
  "autopilot.question_answered": "자동 응답",
  "autopilot.step": "자동 진행",
  "autopilot.gate_hit": "사람 확인 필요",
  "autopilot.throttled": "하루 상한 도달",
  "autopilot.completed": "목표 도달",
};
export const autopilotActionLabel = (action: string) => ACTION_LABEL[action] ?? action;

const STEP_LABEL: Record<string, string> = {
  concept_submit: "컨셉 확정·승인 요청",
  world_approve: "세계관 후보 승인",
  cast_fill: "캐릭터 빈 항목 채움",
  cast_confirm: "캐스트 확정",
  goal_save: "연재 목표 저장",
  structure_request: "전체 구성 작성 요청",
};

/** one-line summary of an autopilot.* activity row */
export function autopilotEventText(e: { action: string; after: unknown; reason: string | null; details: unknown }): string {
  const after = (e.after ?? {}) as Record<string, unknown>;
  const details = (e.details ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "autopilot.approval_decided": {
      // "기획서 1판 승인 요청" → "기획서 1판 승인" (the title already names the subject)
      const title = details.title ? String(details.title).replace(/\s*승인 요청(\s*\(.*\))?$/, "$1").trim() : "";
      return title ? `${title} 승인` : `${labelKo("approval_type", String(after.approvalType ?? ""))} 승인`;
    }
    case "autopilot.step":
      return `${STEP_LABEL[String(after.step ?? "")] ?? String(after.step ?? "")}${after.failed ? " 실패" : ""}${e.reason ? ` · ${e.reason}` : ""}`;
    default:
      return e.reason ?? "";
  }
}
