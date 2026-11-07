/** Structured output of one revision-chat agent turn (callWithRepair validates patches/fact ids deterministically). */
import { z } from "zod";
import { ENUMS } from "@ncs/shared";

export const SOURCE_KINDS = ["outline", "plan", "fact", "setup", "cast", "world", "prompt_input", "previous_episode", "author_note", "none"] as const;

export const revisionTurnOutputSchema = z.object({
  reply_text: z.string().min(1).max(4000),
  diagnosis_kind: z.enum(ENUMS.revision_diagnosis_kind),
  sources: z
    .array(z.object({ kind: z.enum(SOURCE_KINDS), ref_id: z.string().nullable().default(null), quote: z.string().nullable().default(null) }))
    .max(20)
    .default([]),
  question: z
    .object({ text: z.string().min(1).max(500), options: z.array(z.string().min(1).max(300)).max(6).default([]) })
    .nullable()
    .default(null),
  proposals: z
    .array(
      z.object({
        kind: z.enum(ENUMS.revision_proposal_kind),
        /** text_patch */
        patches: z.array(z.object({ quote: z.string().max(4000), replacement: z.string().max(4000), reason: z.string().max(1000).default("") })).max(12).default([]),
        /** setting_change / impact_note: [F:id] of the fact */
        fact_id: z.string().nullable().default(null),
        new_value: z.string().nullable().default(null),
        reason: z.string().default(""),
      }),
    )
    .max(6)
    .default([]),
});
export type RevisionTurnOutput = z.infer<typeof revisionTurnOutputSchema>;
export type RevisionTurnProposal = RevisionTurnOutput["proposals"][number];

/** the reply must say so when nothing supports the text (no invented reasons) */
export const NO_SOURCE_PHRASE = "근거 없이 쓴 부분";

export function ensureNoSourcePhrase(out: RevisionTurnOutput): RevisionTurnOutput {
  const none = out.sources.length > 0 && out.sources.every((s) => s.kind === "none");
  if (none && !out.reply_text.includes(NO_SOURCE_PHRASE)) return { ...out, reply_text: `(${NO_SOURCE_PHRASE}입니다.) ${out.reply_text}` };
  return out;
}
