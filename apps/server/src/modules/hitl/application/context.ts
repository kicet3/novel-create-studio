/**
 * agents ContextSectionProvider "constraints" (04 §9.5): accepted answers seeded into a run
 * (`spec.seeds.answerIds`, F3 — the task context carries answer ids) rendered as constraints, with
 * confirmed interpretations only (INV-AI-01: unconfirmed free text is never presented as canon).
 */
import type { Platform } from "../../../platform/index.js";
import type { ContextSectionProvider } from "../../agents/index.js";
import { hitlRepo as repo } from "../adapters/db/hitl-repository.js";
import type { AnswerPayload } from "../domain/questions.js";

export function createAnswerConstraintsSection(platform: Platform): ContextSectionProvider {
  return {
    section: "constraints",
    module: "hitl",
    async build(scope, spec) {
      const ids = spec.seeds.answerIds;
      if (!ids.length) return null;
      const db = platform.uow.db;
      const lines: string[] = [];
      const used: string[] = [];
      const interps = await repo.listInterpretationsForAnswers(db, scope, ids);
      for (const id of ids) {
        const a = await repo.getAnswer(db, scope, id);
        if (!a || a.disposition !== "accepted") continue;
        const q = await repo.getQuestion(db, scope, a.questionId);
        if (!q) continue;
        const p = a.payload as AnswerPayload;
        if (p.text) {
          const ok = interps.filter((i) => i.answerId === id && (i.status === "confirmed" || i.status === "corrected"));
          for (const i of ok) {
            const ch = ((i.finalChanges ?? i.proposedChanges) as { changes?: Array<{ description_ko: string }> }).changes ?? [];
            for (const c of ch) lines.push(`- [Q-${q.displayNo} 확인된 답] ${c.description_ko}`);
          }
          if (ok.length) used.push(id);
          continue;
        }
        const options = await repo.listOptions(db, scope, q.id);
        const label = p.decision ? (p.decision === "approved" ? "승인" : `반려: ${p.decision_note ?? ""}`) : p.selected_idx.map((i) => options[i]?.label).join(", ");
        lines.push(`- [Q-${q.displayNo} ${q.title}] 사용자 답: ${label}`);
        used.push(id);
      }
      if (!lines.length) return null;
      const text = `사용자 답변에서 나온 제약(반드시 지킬 것):\n${lines.join("\n")}`;
      return { text, tokenEstimate: Math.ceil(text.length / 2), refs: { answerIds: used } };
    },
  };
}
