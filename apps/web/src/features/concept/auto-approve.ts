/**
 * 설계 추가: 컨셉 대화 자동 승인 모드 — pure view helpers (unit-tested).
 * The loop itself runs on the server (it keeps going with the tab closed); the web only toggles it and shows it.
 */
import type { ConceptAutoApproveViewDto, ConceptMessageDto } from "@ncs/shared";

export const AUTO_PREFIX = "자동 승인: ";

export const AUTO_APPROVE_HELP =
  "켜 두면 컨셉 파트너가 추천한 답을 자동으로 고르며 대화를 계속 이어 갑니다. 창을 닫아도 서버에서 이어지고, 직접 정한 항목은 바꾸지 않습니다. 언제든 메시지를 보내거나 [멈추기]를 누를 수 있고, 컨셉 확정([승인 요청])은 직접 합니다.";

export const AUTO_STOP_LABEL: Record<NonNullable<ConceptAutoApproveViewDto["stopReason"]>, string> = {
  completed: "필수 항목을 모두 정했습니다. 브리프를 검토하고 [승인 요청]을 눌러 컨셉을 확정하세요.",
  step_cap: "정한 횟수만큼 진행해 멈췄습니다. 다시 켜면 이어 갑니다.",
  turn_cap: "대화 안전 상한에 닿아 멈췄습니다.",
  budget: "세션 비용 상한에 닿아 멈췄습니다.",
  error: "응답 오류로 멈췄습니다.",
  user_stopped: "멈추기로 껐습니다.",
  toggled_off: "껐습니다.",
  session_closed: "세션이 진행 중이 아니라 껐습니다.",
  messenger: "메신저로 대화를 이어 가서 껐습니다.",
};

export const AUTO_WAIT_LABEL: Record<NonNullable<ConceptAutoApproveViewDto["waitingReason"]>, string> = {
  open_question: "고를 추천안이 없는 질문이라 직접 답해 주세요",
  user_field_proposal: "직접 정한 항목의 변경 제안이라 직접 골라 주세요",
  conflict: "서로 다른 값이 있어 직접 골라 주세요",
};

/** message posted by the auto-approve mode on the user's behalf */
export function isAutoMessage(m: Pick<ConceptMessageDto, "autoApproved">): boolean {
  // the server flag only (the DTO defaults it to false) — a user's own text that happens to start with the prefix is theirs
  return m.autoApproved === true;
}

/** bubble text without the "자동 승인: " prefix (the badge says it) */
export function autoMessageText(body: string): string {
  return body.startsWith(AUTO_PREFIX) ? body.slice(AUTO_PREFIX.length) : body;
}

export interface AutoStatusLine {
  tone: "accent" | "warn" | "ok" | "neutral";
  text: string;
  /** show [멈추기] next to the line */
  stoppable: boolean;
}

/** status line under the chat header ("자동 승인 중 · N번째 · 멈추기") */
export function autoStatusLine(a: ConceptAutoApproveViewDto | undefined): AutoStatusLine | null {
  if (!a) return null;
  if (a.enabled && a.status === "waiting_user") {
    return { tone: "warn", text: `자동 승인 대기 · ${a.waitingReason ? AUTO_WAIT_LABEL[a.waitingReason] : "직접 답해 주세요"}. 답하면 이어 갑니다.`, stoppable: true };
  }
  if (a.enabled) {
    // steps = auto picks made in this run; 0 → the partner is still answering before the first pick
    if (a.steps <= 0) return { tone: "accent", text: `자동 승인 중 · 첫 추천을 기다리는 중 (최대 ${a.maxSteps}번)`, stoppable: true };
    return { tone: "accent", text: `자동 승인 중 · ${a.steps}번째 (최대 ${a.maxSteps}번)`, stoppable: true };
  }
  if (a.stopReason === "completed") return { tone: "ok", text: `자동 승인 완료 · ${AUTO_STOP_LABEL.completed}`, stoppable: false };
  if (a.stopReason && a.stopReason !== "toggled_off") return { tone: "neutral", text: `자동 승인 꺼짐 · ${AUTO_STOP_LABEL[a.stopReason]}`, stoppable: false };
  return null;
}

/**
 * Send lock: one partner turn at a time — except while auto-approve runs, where a message is queued behind the
 * running turn (the server answers 201, not 409 concept_turn_in_flight) and the user's input is handled first.
 * A paste (import) starts its own task, so it stays locked while a turn runs even then (the server answers 409).
 */
export function sendLocked(busy: boolean, a: ConceptAutoApproveViewDto | undefined, importMode = false): boolean {
  return busy && (!a?.enabled || importMode);
}
