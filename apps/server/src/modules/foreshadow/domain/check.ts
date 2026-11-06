/**
 * P3e setup check (07 §5.2): LLM output schema (`SetupCheckReport`) and pure helpers. No I/O.
 */
import { z } from "zod";
import { ENUMS } from "@ncs/shared";

export const setupBeatFindingSchema = z.object({
  beat_id: z.string(),
  found: z.boolean(),
  /** verbatim excerpt of the manuscript that realises the beat (used to locate the span) */
  quote: z.string().max(2000).optional(),
  scene_ord: z.number().int().min(1).optional(),
  /** payoff only: does the payoff contradict the planted facts? */
  contradiction: z.enum(["none", "contradiction", "uncertain"]).default("none"),
  contradiction_note: z.string().max(2000).optional(),
  note: z.string().max(1000).optional(),
});

export const setupCheckReportSchema = z.object({
  findings: z.array(setupBeatFindingSchema).default([]),
  /** unplanned plant/reinforce/payoff traces — MVP-α: report only (FR-FOR-03 is v1) */
  unplanned: z
    .array(z.object({ kind: z.enum(ENUMS.setup_beat_kind), quote: z.string().max(2000), setup_id: z.string().optional(), note: z.string().max(1000).optional() }))
    .default([]),
});
export type SetupCheckReport = z.infer<typeof setupCheckReportSchema>;
export type SetupBeatFinding = z.infer<typeof setupBeatFindingSchema>;

export interface SceneSpan {
  id: string;
  ord: number;
  charStart: number;
  charEnd: number;
}

export interface LocatedSpan {
  sceneId: string;
  charStart: number;
  charEnd: number;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Find `quote` in `content`. Exact match first, then whitespace-insensitive match, then (when a scene
 * ord is given) fall back to the whole scene. Returns null when no location can be established.
 */
export function locateQuote(content: string, scenes: readonly SceneSpan[], quote: string | undefined, sceneOrd?: number): LocatedSpan | null {
  const sceneAt = (pos: number) => scenes.find((s) => pos >= s.charStart && pos < Math.max(s.charEnd, s.charStart + 1)) ?? scenes.at(-1);
  if (quote && quote.trim()) {
    const q = quote.trim();
    let idx = content.indexOf(q);
    let len = q.length;
    if (idx < 0) {
      // whitespace-insensitive: map normalized index back to the original string
      const map: number[] = [];
      let norm = "";
      let prevSpace = false;
      for (let i = 0; i < content.length; i++) {
        const ch = content[i]!;
        const space = /\s/.test(ch);
        if (space) {
          if (!prevSpace && norm.length) {
            norm += " ";
            map.push(i);
          }
        } else {
          norm += ch;
          map.push(i);
        }
        prevSpace = space;
      }
      const nq = normalize(q);
      const j = norm.indexOf(nq);
      if (j >= 0) {
        idx = map[j]!;
        const endIdx = map[j + nq.length - 1]!;
        len = endIdx - idx + 1;
      }
    }
    if (idx >= 0) {
      const scene = sceneAt(idx);
      if (scene) return { sceneId: scene.id, charStart: idx, charEnd: idx + len };
    }
  }
  if (sceneOrd != null) {
    const s = scenes.find((x) => x.ord === sceneOrd);
    if (s) return { sceneId: s.id, charStart: s.charStart, charEnd: s.charEnd };
  }
  return null;
}

/** setup_due answer option values (05 §3.4). */
export const setupDueOptionValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("extend"), to_due_episode_no: z.number().int().min(1) }),
  z.object({ kind: z.literal("assign"), episode_no: z.number().int().min(1) }),
  z.object({ kind: z.literal("abandon") }),
]);
export type SetupDueOptionValue = z.infer<typeof setupDueOptionValueSchema>;

/** review_setup_due LLM output: the question proposal (hitl grades it, agents never set grade). */
export const setupDueReviewSchema = z.object({
  recommendation: z.enum(["extend", "assign", "abandon"]).default("extend"),
  extend_to_episode_no: z.number().int().min(1).optional(),
  assign_episode_no: z.number().int().min(1).optional(),
  rationale: z.string().max(2000).default(""),
  body: z.string().max(4000).optional(),
});
export type SetupDueReview = z.infer<typeof setupDueReviewSchema>;
