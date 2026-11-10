/**
 * 설계 추가 0024: 문장 리듬. Korean web-novel prose read aloud stumbles on runs of short declaratives
 * ("~였다. ~다. ~했다.") — the novel setting picks how much of that the pipeline tolerates (간결 / 보통 / 유려)
 * and the prompt rules every writing / polishing step follows.
 */

export const PROSE_RHYTHMS = ["concise", "normal", "flowing"] as const;
export type ProseRhythm = (typeof PROSE_RHYTHMS)[number];
export const DEFAULT_PROSE_RHYTHM: ProseRhythm = "normal";

export const PROSE_RHYTHM_LABELS: Record<ProseRhythm, string> = {
  concise: "간결",
  normal: "보통",
  flowing: "유려",
};

/** one-line explanations for the settings screen */
export const PROSE_RHYTHM_HINTS: Record<ProseRhythm, string> = {
  concise: "짧은 문장으로 속도감 있게 씁니다. 짧은 평서문이 6문장 넘게 이어질 때만 다듬습니다.",
  normal: "긴 문장과 짧은 문장을 섞습니다. 짧은 '~다.' 문장이 4문장 이상 이어지면 연결어미로 이어 다듬습니다.",
  flowing: "문장을 길게 이어 흐름 있게 씁니다. 짧은 평서문이 3문장만 이어져도 다듬습니다.",
};

/** prose rhythm rules shared by draft / revise / polish / length passes (Korean web-novel prose) */
export const PROSE_RHYTHM_RULES = [
  "- 문장 리듬: '~였다. ~다. ~했다.'처럼 짧은 평서문을 연달아 끊어 쓰지 않습니다. 읽는 사람에게 딱딱하고 어색하게 들립니다.",
  "- 이어지는 행동·감각·생각은 연결어미(-고, -며, -자, -면서, -ㄴ 채, -더니, -다가, -는데 등)로 한 문장에 묶고, 긴 문장과 짧은 문장을 섞어 씁니다.",
  "- 문장 끝을 다양하게 씁니다(같은 '-었다.' 어미가 계속 반복되지 않게, 체언·의문·감탄·여운 있는 끝맺음도 섞기).",
  "- 짧게 끊는 문장은 긴장·충격·반전처럼 의도한 순간에만 씁니다.",
  "- 대사와 서술(묘사·행동·내면)의 균형을 맞추고, 대사만 길게 늘어놓거나 서술만 이어 가지 않습니다.",
].join("\n");

/** the setting-specific line appended to the rules */
export function proseRhythmRule(mode: ProseRhythm | null | undefined): string {
  switch (mode ?? DEFAULT_PROSE_RHYTHM) {
    case "concise":
      return "- 이 작품의 문장 리듬은 '간결'입니다. 짧고 빠른 문장을 기본으로 하되, 짧은 평서문이 여섯 문장 넘게 이어지지 않게 사이사이 문장을 잇습니다.";
    case "flowing":
      return "- 이 작품의 문장 리듬은 '유려'입니다. 문장을 길게 이어 흐름을 만들고, 짧게 끊는 문장은 꼭 필요한 순간에만 씁니다.";
    default:
      return "- 이 작품의 문장 리듬은 '보통'입니다. 긴 문장과 짧은 문장을 고루 섞고, 짧은 '~다.' 문장이 네 문장 이상 이어지지 않게 합니다.";
  }
}

export function proseRhythmBlock(mode: ProseRhythm | null | undefined): string {
  return `${PROSE_RHYTHM_RULES}\n${proseRhythmRule(mode)}`;
}
