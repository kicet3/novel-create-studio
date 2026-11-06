/**
 * Retry with feedback (설계 추가): a task attempt that follows an `invalid_output` failure must not repeat the
 * identical prompt. The previous run's error and its last validator critique (repair dialogue) are added to the
 * system prompt of the producing call of the new attempt. Only the producing call gets it (the purpose recorded
 * in the failed dialogue, else the first call of the run); a different prompt also means no stored response reuse.
 */
import { repairDialoguesOf } from "@ncs/shared";
import type { ModelCallPort } from "../../llm/index.js";
import type { Run } from "../../orchestration/index.js";

export interface PriorFailureFeedback {
  /** purpose of the call the feedback is for (null = first call of the run) */
  purpose: string | null;
  text: string;
  fromRunId: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** feedback from the latest finished prior run when it failed with invalid_output; null otherwise */
export function priorFailureFeedback(runs: readonly Run[], currentRunId: string): PriorFailureFeedback | null {
  const prior = runs
    .filter((r) => r.id !== currentRunId && r.finishedAt && r.errorFamily)
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0) || b.id.localeCompare(a.id))[0];
  if (!prior || prior.errorFamily !== "invalid_output") return null;
  const dialogues = repairDialoguesOf(prior.outputSummary);
  const d = dialogues[dialogues.length - 1];
  const lastCritique = d?.rounds[d.rounds.length - 1]?.critique ?? null;
  const remaining = d?.remaining.length ? d.remaining.map((i) => `- ${i.item}: ${i.problem}`).join("\n") : null;
  const lines = [
    "## 직전 시도 실패 피드백",
    "이 작업의 직전 시도는 출력 검증에서 실패했습니다. 아래 지적을 반영해 같은 오류를 반복하지 마세요.",
    `- 실패 사유: ${clip(prior.errorMessage ?? "출력 형식 오류", 600)}`,
  ];
  if (remaining) lines.push("- 끝까지 해결되지 않은 항목:", clip(remaining, 1200));
  else if (lastCritique) lines.push("- 마지막 검증 지적:", clip(lastCritique, 1200));
  return { purpose: d?.purpose ?? null, text: lines.join("\n"), fromRunId: prior.id };
}

/** ModelCallPort that appends the feedback to the system prompt of the producing call(s) */
export function withRetryFeedback(port: ModelCallPort, fb: PriorFailureFeedback): ModelCallPort {
  let first = true;
  return {
    call(input) {
      const target = fb.purpose ? input.purpose === fb.purpose || input.purpose === `${fb.purpose}_repair` : first;
      first = false;
      return port.call(target ? { ...input, system: `${input.system}\n\n${fb.text}` } : input);
    },
  };
}
