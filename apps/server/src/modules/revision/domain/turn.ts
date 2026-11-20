/** Structured output of one revision-chat agent turn (callWithRepair validates patches/fact ids deterministically). */
import { z } from "zod";
import { ENUMS } from "@ncs/shared";
import { handleLeakRepairIssues, leakedHandleTokens } from "../../agents/index.js";

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

// ── 설계 추가 0026 (P4): entity handles (E7 …) never stay in what a turn stores ──
/** prompt rule appended to the turn's system prompt (P7) */
export const TURN_HANDLE_RULE =
  "- 'E7'처럼 E와 숫자로 된 기호는 이름이 아닙니다. reply_text·question·replacement·reason·new_value에는 기호를 쓰지 말고 반드시 인물·장소의 이름으로 씁니다(작가가 메시지에 직접 쓴 기호를 reply_text에서 그대로 가리키는 것만 예외). 원고에 기호가 남아 있어도 quote는 원문 그대로 인용하고 replacement에서 이름으로 고칩니다.";

export interface TurnHandleCheck {
  issues: Array<{ item: string; problem: string }>;
  /** reply_text / question still carry a symbol: the turn cannot be stored as it is */
  blocking: boolean;
  /** text_patch patches to drop: proposal index → patch indices */
  patches: Map<number, Set<number>>;
  /** setting_change proposals to drop (proposal index) */
  proposals: Set<number>;
}

/**
 * `story` = tokens inside real entity names (the only general exemption); `human` = tokens the author typed in this
 * thread, allowed in the reply body only. A patch `quote` is the base text verbatim and is never scanned or changed;
 * its `replacement` / `reason` and a setting change's `new_value` / `reason` must not carry a symbol.
 */
export function checkTurnHandles(out: RevisionTurnOutput, story: ReadonlySet<string>, human: ReadonlySet<string>): TurnHandleCheck {
  const reply = handleLeakRepairIssues(leakedHandleTokens({ reply_text: out.reply_text }, new Set([...story, ...human])), "답변");
  const question = handleLeakRepairIssues(leakedHandleTokens({ question: out.question }, story), "답변");
  const issues = [...reply, ...question];
  const patches = new Map<number, Set<number>>();
  const proposals = new Set<number>();
  out.proposals.forEach((p, pi) => {
    if (p.kind === "text_patch") {
      p.patches.forEach((x, i) => {
        const found = handleLeakRepairIssues(leakedHandleTokens({ replacement: x.replacement, reason: x.reason }, story), `proposals[${pi}].patches[${i}]`);
        if (!found.length) return;
        issues.push(...found);
        patches.set(pi, (patches.get(pi) ?? new Set<number>()).add(i));
      });
    } else if (p.kind === "setting_change") {
      const found = handleLeakRepairIssues(leakedHandleTokens({ new_value: p.new_value, reason: p.reason }, story), `proposals[${pi}]`);
      if (!found.length) return;
      issues.push(...found);
      proposals.add(pi);
    }
  });
  return { issues, blocking: reply.length + question.length > 0, patches, proposals };
}

/** a source quote that carries a symbol is not stored (the source itself — kind / ref — stays) */
export function dropLeakingSourceQuotes(out: RevisionTurnOutput, allow: ReadonlySet<string>): RevisionTurnOutput {
  if (!out.sources.some((s) => s.quote && leakedHandleTokens(s.quote, allow).length)) return out;
  return { ...out, sources: out.sources.map((s) => (s.quote && leakedHandleTokens(s.quote, allow).length ? { ...s, quote: null } : s)) };
}
