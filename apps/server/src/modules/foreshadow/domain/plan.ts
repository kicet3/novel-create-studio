/**
 * B4 setup placement (07 §1.3): LLM output schema (`SetupPlan`) and deterministic checks SP-1..SP-4. Pure.
 */
import { z } from "zod";
import { ENUMS, type SetupBeatKind, type SetupNarrativeStatus } from "@ncs/shared";

const ENTITY_ID = /^ent_[0-9A-HJKMNP-TV-Z]{26}$/;
const FACT_ID = /^fct_[0-9A-HJKMNP-TV-Z]{26}$/;

export const plannedBeatSchema = z.object({
  kind: z.enum(ENUMS.setup_beat_kind),
  planned_episode_no: z.number().int().min(1),
  note: z.string().max(500).optional(),
});

export const setupPlanSchema = z.object({
  new_setups: z
    .array(
      z.object({
        /** model-local key used in messages ("N1", "N2") */
        key: z.string().max(40).optional(),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(4000),
        importance: z.enum(ENUMS.setup_importance),
        due_kind: z.enum(ENUMS.setup_due_kind).default("arc"),
        due_episode_no: z.number().int().min(1).nullable().optional(),
        beats: z.array(plannedBeatSchema).min(1),
        entity_ids: z.array(z.string()).default([]),
        fact_ids: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** beats added to existing setups (e.g. payoff of a setup planted in a previous arc) */
  existing_setup_beats: z
    .array(z.object({ setup_id: z.string(), beats: z.array(plannedBeatSchema).min(1) }))
    .default([]),
  rationale: z.string().max(4000).optional(),
});
export type SetupPlan = z.infer<typeof setupPlanSchema>;

export interface PlanCheckContext {
  arc: { id: string; plannedEpisodeFrom: number; plannedEpisodeTo: number };
  /** planned_episode_to of every known arc (SP-2 arc due) */
  arcEnds: ReadonlyMap<string, number>;
  existing: ReadonlyMap<
    string,
    {
      narrativeStatus: SetupNarrativeStatus;
      dueKind: "episode" | "arc";
      dueEpisodeNo: number | null;
      dueArcId: string | null;
      /** a plant beat is confirmed (narrative planted/reinforced) */
      plantConfirmed: boolean;
      /** episode of the earliest non-cancelled plant beat, if any */
      plantEpisodeNo: number | null;
    }
  >;
}

export interface PlanViolation {
  rule: "SP-1" | "SP-2" | "SP-3" | "SP-4" | "SP-0";
  target: string;
  message: string;
}

function dueOf(dueKind: "episode" | "arc", dueEpisodeNo: number | null | undefined, dueArcId: string | null | undefined, arcEnds: ReadonlyMap<string, number>): number | null {
  if (dueKind === "episode") return dueEpisodeNo ?? null;
  return dueArcId ? (arcEnds.get(dueArcId) ?? null) : null;
}

function checkOrder(target: string, beats: Array<{ kind: SetupBeatKind; planned_episode_no: number }>, plantFloor: number | null, out: PlanViolation[]) {
  const plants = beats.filter((b) => b.kind === "plant").map((b) => b.planned_episode_no);
  const plant = plants.length ? Math.min(...plants) : plantFloor;
  if (plant == null) return;
  for (const b of beats) {
    if (b.kind === "reinforce" && !(b.planned_episode_no > plant)) {
      out.push({ rule: "SP-3", target, message: `강화 비트(${b.planned_episode_no}화)는 설치(${plant}화)보다 뒤여야 합니다.` });
    }
    if (b.kind === "payoff" && !(b.planned_episode_no > plant)) {
      out.push({ rule: "SP-3", target, message: `회수 비트(${b.planned_episode_no}화)는 설치(${plant}화)보다 뒤여야 합니다.` });
    }
  }
  const reinforces = beats.filter((b) => b.kind === "reinforce").map((b) => b.planned_episode_no);
  const payoffs = beats.filter((b) => b.kind === "payoff").map((b) => b.planned_episode_no);
  if (reinforces.length && payoffs.length && Math.max(...reinforces) > Math.min(...payoffs)) {
    out.push({ rule: "SP-3", target, message: "강화 비트는 회수 비트 이하의 화에 있어야 합니다." });
  }
}

/** SP-1..SP-4 — returns all violations (empty = ok). */
export function validateSetupPlan(plan: SetupPlan, ctx: PlanCheckContext): PlanViolation[] {
  const out: PlanViolation[] = [];
  const { plannedEpisodeFrom: from, plannedEpisodeTo: to, id: arcId } = ctx.arc;
  const inRange = (target: string, n: number) => {
    if (n < from || n > to) out.push({ rule: "SP-1", target, message: `비트 화(${n}화)가 아크 범위(${from}~${to}화) 밖입니다.` });
  };

  plan.new_setups.forEach((s, i) => {
    const target = s.key ?? `new[${i}] ${s.title}`;
    for (const b of s.beats) inRange(target, b.planned_episode_no);
    if (s.due_kind === "episode" && s.due_episode_no == null) {
      out.push({ rule: "SP-0", target, message: "화 기한 떡밥은 due_episode_no가 있어야 합니다." });
    }
    const due = dueOf(s.due_kind, s.due_episode_no, s.due_kind === "arc" ? arcId : null, ctx.arcEnds);
    for (const b of s.beats.filter((x) => x.kind === "payoff")) {
      if (due != null && b.planned_episode_no > due) {
        out.push({ rule: "SP-2", target, message: `회수 비트(${b.planned_episode_no}화)가 기한(${due}화)보다 늦습니다.` });
      }
    }
    if (!s.beats.some((b) => b.kind === "plant")) {
      out.push({ rule: "SP-3", target, message: "새 떡밥에는 설치(plant) 비트가 있어야 합니다." });
    }
    checkOrder(target, s.beats, null, out);
    for (const id of s.entity_ids) if (!ENTITY_ID.test(id)) out.push({ rule: "SP-4", target, message: `엔티티 참조 '${id}'는 엔티티 ID가 아닙니다.` });
    for (const id of s.fact_ids) if (!FACT_ID.test(id)) out.push({ rule: "SP-4", target, message: `사실 참조 '${id}'는 사실 ID가 아닙니다.` });
  });

  for (const e of plan.existing_setup_beats) {
    const target = e.setup_id;
    const ex = ctx.existing.get(e.setup_id);
    if (!ex) {
      out.push({ rule: "SP-4", target, message: `기존 떡밥 '${e.setup_id}'을(를) 찾을 수 없습니다.` });
      continue;
    }
    if (ex.narrativeStatus === "paid_off" || ex.narrativeStatus === "abandoned") {
      out.push({ rule: "SP-3", target, message: "이미 끝난 떡밥에는 비트를 더할 수 없습니다." });
      continue;
    }
    for (const b of e.beats) inRange(target, b.planned_episode_no);
    const due = dueOf(ex.dueKind, ex.dueEpisodeNo, ex.dueArcId, ctx.arcEnds);
    for (const b of e.beats.filter((x) => x.kind === "payoff")) {
      if (due != null && b.planned_episode_no > due) {
        out.push({ rule: "SP-2", target, message: `회수 비트(${b.planned_episode_no}화)가 기한(${due}화)보다 늦습니다.` });
      }
    }
    const hasPlant = e.beats.some((b) => b.kind === "plant") || ex.plantConfirmed || ex.plantEpisodeNo != null;
    if (!hasPlant) out.push({ rule: "SP-3", target, message: "설치 없이 회수·강화만 있는 떡밥은 배치할 수 없습니다." });
    checkOrder(target, e.beats, ex.plantEpisodeNo, out);
  }
  return out;
}

export function describeViolations(v: PlanViolation[]): string {
  return v.map((x) => `- [${x.rule}] ${x.target}: ${x.message}`).join("\n");
}
