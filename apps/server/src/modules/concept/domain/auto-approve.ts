/**
 * 설계 추가: 자동 승인 모드 (concept chat auto-approve). Pure.
 *
 * The user turns the mode on for a session; after every partner turn the server (turn commit, not the browser)
 * answers the partner's latest prompt on the user's behalf with the partner's own recommendation and queues the
 * next turn, until the brief is ready for the manual "승인 요청" (컨셉 확정 stays a user action) or a stop
 * condition hits. This module decides WHAT the auto step answers; the application layer persists it.
 *
 * Provenance: values chosen this way are `agent_auto_accepted` (never `user_stated`), proposals accepted this way
 * are `accepted/auto_accepted`. Fields the user wrote (`user_stated`/`user_edited`) are never changed by an auto
 * pick: an auto pick that differs becomes a change proposal, and a change proposal on such a field is only
 * auto-accepted when the user also enabled `accept_user_field_proposals` (default off → the run waits for the user).
 */
import type { WorkingBrief } from "./brief.js";
import { valueToText } from "./brief.js";
import { CONTROL } from "./next-question.js";
import { slotLabel } from "./question-set.js";
import type { StoredOption } from "./slot-guard.js";

export const AUTO_APPROVE_DEFAULT_MAX_STEPS = 20;
export const AUTO_APPROVE_MAX_STEPS_LIMIT = 60;
/** body prefix of the user-side message an auto step posts */
export const AUTO_PREFIX = "자동 승인: ";

export type AutoApproveStatus = "off" | "running" | "waiting_user";
export type AutoStopReason = "completed" | "step_cap" | "turn_cap" | "budget" | "error" | "user_stopped" | "toggled_off" | "session_closed" | "messenger";
export type AutoWaitReason = "open_question" | "user_field_proposal" | "conflict";

export interface AutoApproveState {
  enabled: boolean;
  status: AutoApproveStatus;
  /** increments every time the mode is switched on */
  run_no: number;
  /** auto picks in the current run */
  steps: number;
  max_steps: number;
  accept_user_field_proposals: boolean;
  /** the user who delegated (author of the auto messages) */
  enabled_by_user_id: string | null;
  waiting: { reason: AutoWaitReason; prompt_id: string } | null;
  stop_reason: AutoStopReason | null;
  /** path the current run already pressed [추천해 줘] for (at most once per path) */
  recommended_for: string | null;
  /** prompt message the last auto pick answered (one auto pick per prompt) */
  last_prompt_id: string | null;
  updated_at: string | null;
}

export function autoApproveState(raw: AutoApproveState | null | undefined): AutoApproveState {
  return {
    enabled: false,
    status: "off",
    run_no: 0,
    steps: 0,
    max_steps: AUTO_APPROVE_DEFAULT_MAX_STEPS,
    accept_user_field_proposals: false,
    enabled_by_user_id: null,
    waiting: null,
    stop_reason: null,
    recommended_for: null,
    last_prompt_id: null,
    updated_at: null,
    ...(raw ?? {}),
  };
}

export interface AutoPrompt {
  id: string;
  options: StoredOption[] | null;
  askedFieldPaths: string[] | null;
}

export type AutoDecision =
  | { kind: "pick"; option: StoredOption; body: string; what: "option" | "proposal" | "confirm" | "stage" | "recommend" | "retry" }
  | { kind: "wait"; reason: AutoWaitReason; text: string }
  | { kind: "complete"; text: string };

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the auto step answers to `prompt` (the partner's latest question).
 * Order: change proposal → conflict/flip (wait) → reconfirm → the partner's recommended option →
 * stage move → final confirmation cards (complete: manual) → [추천해 줘] once → wait for the user.
 */
export function decideAutoStep(i: { prompt: AutoPrompt; brief: WorkingBrief; state: AutoApproveState; allowRetry?: boolean }): AutoDecision {
  const opts = i.prompt.options ?? [];
  const asked = i.prompt.askedFieldPaths?.[0] ?? null;
  const b = i.brief;

  const accept = opts.find((o) => o.value.startsWith("@accept_proposal:"));
  if (accept) {
    const id = accept.value.slice("@accept_proposal:".length);
    const cp = b.change_proposals.find((p) => p.id === id && p.status === "pending");
    if (cp) {
      const origin = b.field_provenance[cp.field_path]?.origin;
      if ((origin === "user_stated" || origin === "user_edited") && !i.state.accept_user_field_proposals) {
        return {
          kind: "wait",
          reason: "user_field_proposal",
          text: `자동 승인 대기: '${slotLabel(cp.field_path)}'은(는) 직접 정한 항목이라 바꿀지 직접 골라 주세요. 고르면 자동 승인이 이어집니다.`,
        };
      }
      return { kind: "pick", option: accept, body: `${AUTO_PREFIX}'${slotLabel(cp.field_path)}' 변경 제안 수락 → "${clip(valueToText(cp.new_value))}"`, what: "proposal" };
    }
  }
  if (asked && ((b.meta.conflicts ?? []).some((c) => c.field_path === asked) || (b.meta.flip_cards ?? []).some((c) => c.field_path === asked))) {
    return { kind: "wait", reason: "conflict", text: `자동 승인 대기: '${slotLabel(asked)}'은(는) 서로 다른 값이 있어 직접 골라 주세요. 고르면 자동 승인이 이어집니다.` };
  }
  const confirm = opts.find((o) => o.value.startsWith("@confirm_field:"));
  if (confirm) {
    const path = confirm.value.slice("@confirm_field:".length);
    return { kind: "pick", option: confirm, body: `${AUTO_PREFIX}'${slotLabel(path)}' 이해한 내용 확인`, what: "confirm" };
  }
  const choices = opts.filter((o) => o.source !== "control");
  const recommendCtl = opts.find((o) => o.value === CONTROL.recommend.value);
  if (choices.length) {
    const rec = choices.find((o) => o.is_recommended);
    // no recommendation marked (fixed seed list): ask the partner for one first, once per slot
    if (!rec && recommendCtl && asked && i.state.recommended_for !== asked) {
      return { kind: "pick", option: recommendCtl, body: `${AUTO_PREFIX}추천해 줘`, what: "recommend" };
    }
    const pick = rec ?? choices.find((o) => o.source === "agent") ?? choices[0]!;
    return { kind: "pick", option: pick, body: `${AUTO_PREFIX}${pick.label}`, what: "option" };
  }
  const toConfirming = opts.find((o) => o.value === CONTROL.toConfirming.value);
  if (toConfirming) return { kind: "pick", option: toConfirming, body: `${AUTO_PREFIX}${toConfirming.label}`, what: "stage" };
  if (opts.some((o) => o.value === CONTROL.confirmDelegated.value || o.value === CONTROL.confirmImported.value)) {
    return { kind: "complete", text: "자동 승인을 마쳤습니다. 에이전트가 정한 항목을 브리프 패널에서 확인하고 [모두 확정]을 누른 뒤 [승인 요청]으로 컨셉을 확정해 주세요. 컨셉 확정은 직접 해야 합니다." };
  }
  if (opts.some((o) => o.value === CONTROL.submit.value)) {
    return { kind: "complete", text: "자동 승인을 마쳤습니다. 필수 항목이 모두 정해졌습니다. 브리프를 검토한 뒤 [승인 요청]을 눌러 컨셉을 확정해 주세요. 컨셉 확정은 직접 해야 합니다." };
  }
  const retry = opts.find((o) => o.value === CONTROL.retry.value);
  if (retry && i.allowRetry) return { kind: "pick", option: retry, body: `${AUTO_PREFIX}${retry.label}`, what: "retry" };
  if (recommendCtl && asked && i.state.recommended_for !== asked) {
    return { kind: "pick", option: recommendCtl, body: `${AUTO_PREFIX}추천해 줘`, what: "recommend" };
  }
  return {
    kind: "wait",
    reason: "open_question",
    text: `자동 승인 대기: ${asked ? `'${slotLabel(asked)}'은(는) ` : "이 질문은 "}고를 추천안이 없어 직접 답해 주세요. 답하면 자동 승인이 이어집니다.`,
  };
}

/** Korean notice when a run stops by itself / is stopped */
export function autoStopText(reason: AutoStopReason, state: AutoApproveState): string {
  switch (reason) {
    case "step_cap":
      return `자동 승인을 ${state.steps}번 진행해 멈췄습니다. 이어 가려면 자동 승인을 다시 켜세요.`;
    case "turn_cap":
      return "대화 안전 상한에 닿아 자동 승인을 껐습니다. 대화를 이어 가려면 턴 상한을 올린 뒤 자동 승인을 다시 켜세요.";
    case "budget":
      return "세션 비용 상한에 닿아 자동 승인을 껐습니다.";
    case "error":
      return "응답을 만들지 못해 자동 승인을 껐습니다. [다시 시도]를 누르거나 자동 승인을 다시 켜세요.";
    case "user_stopped":
      return "답변을 멈추고 자동 승인을 껐습니다.";
    case "toggled_off":
      return "자동 승인을 껐습니다. 이제 직접 골라 주세요.";
    case "messenger":
      return "메신저로 대화를 이어 가서 자동 승인을 껐습니다.";
    case "session_closed":
      return "세션이 진행 중이 아니라 자동 승인을 껐습니다.";
    case "completed":
      return "자동 승인을 마쳤습니다. 브리프를 검토한 뒤 [승인 요청]을 눌러 컨셉을 확정해 주세요.";
  }
}
