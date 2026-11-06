import { EPISODE_HARD_MAX_MESSAGE, EPISODE_HARD_MIN_CHARS, EPISODE_HARD_MIN_MESSAGE } from "@ncs/shared";
/** 클라이언트 검증(서버 422 length_min_too_low와 같은 기준) */
export function lengthFormError(min: number, max: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1) return "글자 수는 양의 정수로 입력하세요.";
  if (min < EPISODE_HARD_MIN_CHARS) return EPISODE_HARD_MIN_MESSAGE;
  if (max < EPISODE_HARD_MIN_CHARS) return EPISODE_HARD_MAX_MESSAGE;
  if (max < min) return "최대 글자 수는 최소 글자 수 이상이어야 합니다.";
  return null;
}
