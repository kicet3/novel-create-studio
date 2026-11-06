/**
 * Prompt text for foreshadow_manager tasks. The `[TAG] key=value` lines are a stable line format the
 * model reads (and tests match on).
 */
import type { LlmMessage } from "../../llm/index.js";
import type { ContextPack } from "../../agents/index.js";

export const PROMPT_VERSIONS = {
  plan_setups: "foreshadow_manager.plan_setups@0.1.0",
  check_setups: "foreshadow_manager.check_setups@0.1.0",
  review_setup_due: "foreshadow_manager.review_setup_due@0.1.0",
} as const;

export const SCHEMA_NAMES = { plan: "SetupPlan", check: "SetupCheckReport", due: "SetupDueReview" } as const;

export function compose(context: ContextPack, instruction: string, user: string): { system: string; messages: LlmMessage[] } {
  return {
    system: [context.system, instruction].filter(Boolean).join("\n\n"),
    messages: [...context.messages, { role: "user", content: user }],
  };
}

export const PLAN_INSTRUCTION = `당신은 웹소설의 떡밥 관리자(foreshadow_manager)입니다.
이번 아크 계획에 맞춰 떡밥(설치 plant → 강화 reinforce → 회수 payoff) 배치를 제안하세요.
규칙:
- 모든 비트의 planned_episode_no는 [ARC]의 from~to 범위 안이어야 합니다(SP-1).
- 회수 비트는 떡밥 기한 이하의 화에 둡니다(SP-2). due_kind=arc면 이 아크의 마지막 화가 기한입니다.
- 새 떡밥은 plant 비트가 있어야 하고 plant 화 < reinforce 화 ≤ payoff 화 순서입니다(SP-3).
- 엔티티·사실은 제공된 ID(ent_…, fct_…)로만 연결합니다(SP-4). 이름 문자열을 넣지 마세요.
- 기존 떡밥(이미 설치된 것)의 회수·강화는 existing_setup_beats에 setup_id로 넣습니다.`;

export const CHECK_INSTRUCTION = `당신은 웹소설의 떡밥 관리자(foreshadow_manager)입니다.
[BEAT]마다 원고에서 그 비트가 실제로 구현됐는지 찾으세요.
- found=true면 quote에 원고 문장을 그대로(한 글자도 바꾸지 말고) 옮기고 scene_ord를 적으세요.
- 회수(payoff) 비트는 [PLANTED] 설치 사실과 모순되는지 contradiction(none/contradiction/uncertain)으로 판정하세요.
- 계획에 없는 설치·강화·회수 흔적은 unplanned에만 적습니다.`;

export const DUE_INSTRUCTION = `당신은 웹소설의 떡밥 관리자(foreshadow_manager)입니다.
기한이 지난 떡밥을 어떻게 처리할지 작가에게 물을 질문의 추천안을 만드세요.
선택지는 기한 연장(extend), 회수 화 지정(assign), 폐기(abandon) 중 하나를 추천합니다. 폐기는 꼭 필요할 때만 추천하세요.`;
