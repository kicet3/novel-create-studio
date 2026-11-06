/** QuestionView builder (05 §3.2): channel-neutral, built from rows every time (never stored). */
import { labelKo } from "@ncs/shared";
import type { QuestionView } from "../../messaging/index.js";
import type { Question } from "../index.js";
import type { QuestionLink, QuestionOption } from "../adapters/db/hitl-repository.js";
import { readRecommendation } from "../domain/questions.js";
import { afterDeadlineLabel, wallClock } from "../domain/schedule.js";

export function buildQuestionView(
  q: Question,
  options: QuestionOption[],
  links: QuestionLink[],
  ctx: { timezone: string; webBaseUrl: string },
): QuestionView {
  const rec = readRecommendation(q.recommendation);
  const recOption = rec.option_idx !== null ? options.find((o) => o.idx === rec.option_idx) : undefined;
  const first = links[0];
  return {
    questionId: q.id,
    novelId: q.novelId,
    displayNo: `Q-${q.displayNo}`,
    grade: q.grade,
    topic: q.topic,
    questionType: q.questionType,
    targetLabel: first ? labelKo("ref_type", first.refType) : "",
    title: q.title,
    body: q.body,
    preview: rec.preview,
    recommendation: q.grade === "informational" ? null : recOption || rec.text ? { label: recOption?.label ?? rec.text ?? "", rationale: rec.rationale || q.rationale } : null,
    blockingBasisLabel: q.grade === "blocking" ? labelKo("blocking_basis", q.blockingBasis) : null,
    gradeReason: q.gradeReason,
    options: options.map((o) => ({ optionId: String(o.idx), label: o.label, value: o.value, isRecommended: o.isRecommended })),
    allowFreeText: rec.allow_free_text && q.questionType !== "approve_reject" && q.questionType !== "multi_choice" && q.grade !== "informational",
    deadline: q.deadlineAt && q.grade !== "informational" ? { at: q.deadlineAt, wallClock: wallClock(q.deadlineAt, ctx.timezone), afterLabel: afterDeadlineLabel(q.grade, rec.default_action) } : null,
    webUrl: `${ctx.webBaseUrl}/novels/${q.novelId}/inbox/${q.id}`,
  };
}
