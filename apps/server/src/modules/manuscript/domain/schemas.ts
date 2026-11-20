/**
 * zod schemas for manuscript-owned structured data and LLM proposals (07 §3). Every LLM output goes
 * through one of these (07 §3 공통: 검증 실패 = invalid_output). Proposal schemas are lenient (defaults)
 * so that sparse outputs are completed deterministically by the handler instead of failing the task.
 */
import { z } from "zod";

const str = (max = 4000) => z.string().max(max).default("");
const idOrNull = z.string().nullable().optional().transform((v) => v ?? null);

// ── 07 §3.1.1 OutlineData (manuscript_versions.outline_data) ──
export const outlineSceneSchema = z.object({
  key: z.string().min(1).max(20),
  summary: str(1000),
  pov_entity_id: idOrNull,
  location_entity_id: idOrNull,
  participant_entity_ids: z.array(z.string()).default([]),
  timeline_id: idOrNull,
  setup_beat_ids: z.array(z.string()).default([]),
  answer_ids: z.array(z.string()).default([]),
});
export const outlineDataSchema = z.object({
  beats: z.array(z.object({ ord: z.number().int().min(1), purpose: str(500) })).default([]),
  scenes: z.array(outlineSceneSchema).default([]),
  new_entity_proposals: z
    .array(z.object({ local_key: z.string(), entity_type: z.string(), proposed_name: z.string(), rationale: str(500) }))
    .default([]),
  hook: str(500),
  target_chars: z.number().int().min(0).default(0),
});
export type OutlineData = z.output<typeof outlineDataSchema>;
/**
 * 설계 추가 0026: entity REFERENCE / key fields of an outline — they carry handles or ids and are resolved before
 * storing; every other string of an outline is a sentence a person reads (never a handle like "E7").
 */
export const OUTLINE_REF_KEYS = ["key", "local_key", "pov_entity_id", "location_entity_id", "participant_entity_ids", "timeline_id", "setup_beat_ids", "answer_ids"] as const;

// ── 07 §3.2.1 WriterAnnotations ──
export const writerAnnotationsSchema = z.object({
  scene_breaks: z.array(z.object({ outline_scene_key: z.string(), char_start: z.number().int().min(0) })).default([]),
  entity_hints: z
    .array(z.object({ char_start: z.number().int(), char_end: z.number().int(), surface: z.string(), entity_id: z.string(), mention_kind: z.string() }))
    .default([]),
  new_entity_refs: z
    .array(z.object({ char_start: z.number().int(), char_end: z.number().int(), surface: z.string(), outline_local_key: z.string() }))
    .default([]),
  answer_spans: z.array(z.object({ answer_id: z.string(), char_start: z.number().int(), char_end: z.number().int() })).default([]),
  setup_beat_spans: z.array(z.object({ setup_beat_id: z.string(), char_start: z.number().int(), char_end: z.number().int() })).default([]),
});
export type WriterAnnotations = z.output<typeof writerAnnotationsSchema>;

// ── B1 plan_series_bible proposal ──
export const bibleProposalSchema = z.object({
  logline: str(500),
  synopsis: str(6000),
  world: str(6000),
  hook: str(1000),
  ending_direction: str(2000),
  characters: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        role: str(100),
        description: str(2000),
        source_field_path: z.string().nullable().default(null),
        character_key: z.string().nullable().default(null),
      }),
    )
    .default([]),
  world_rules: z.array(z.object({ statement: z.string().min(1).max(1000), source_field_path: z.string().nullable().default(null) })).default([]),
  avoid_list: z.array(z.string().max(500)).default([]),
  arc_outline: z
    .array(z.object({ title: z.string().min(1).max(200), episode_count: z.number().int().min(1).max(200).default(10), summary: str(2000) }))
    .default([]),
  open_questions: z.array(z.string().max(500)).default([]),
});
export type BibleProposal = z.output<typeof bibleProposalSchema>;

// ── 설계 추가: plan_structure proposal (전체 구성 1~4부 + 결말) ──
export const structureProposalSchema = z.object({
  ending: z
    .object({
      world_state: str(2000),
      conflict_resolution: str(2000),
      character_final_states: z.array(z.object({ character_id: z.string(), final_state: str(1000) })).default([]),
      protagonist_change: z.object({ from: str(1000), to: str(1000) }).default({ from: "", to: "" }),
      foreshadow_payoffs: z.array(z.object({ setup: str(500), payoff: str(1000) })).default([]),
    })
    .default({ world_state: "", conflict_resolution: "", character_final_states: [], protagonist_change: { from: "", to: "" }, foreshadow_payoffs: [] }),
  parts: z
    .array(
      z.object({
        ord: z.number().int(),
        title: str(200),
        goal: str(2000),
        turning_points: z.array(z.string().max(500)).default([]),
        episode_from: z.number().int().default(0),
        episode_to: z.number().int().default(0),
        character_states: z.array(z.object({ character_id: z.string(), state: str(1000) })).default([]),
        plots: z.array(z.object({ title: str(200), core_event: str(1000), episode_count: z.number().int().default(1) })).default([]),
      }),
    )
    .default([]),
  first_appearances: z.array(z.object({ character_id: z.string(), episode_no: z.number().int() })).default([]),
});
export type StructureProposal = z.output<typeof structureProposalSchema>;

export const planStructureInputSchema = z
  .object({
    scope: z.enum(["all", "ending", "parts"]).default("all"),
    instructions: z.string().nullable().optional(),
    rejection_note: z.string().nullable().optional(),
    requested_by_user_id: z.string().optional(),
  })
  .passthrough();
export type PlanStructureInput = z.output<typeof planStructureInputSchema>;

/** a character the plot introduces (plan_arc) — the same required fields as the initial cast */
export const plotCharacterProposalSchema = z.object({
  name: z.string().max(80).default(""),
  role: z.enum(["sub_protagonist", "antagonist", "supporting"]).default("supporting"),
  age: str(40),
  appearance: str(1000),
  personality: str(2000),
  desire: str(2000),
  motivation: str(2000),
  weakness: str(2000),
  background: str(4000),
  speech_sample: str(500),
  arc_start: str(1000),
  arc_end: str(1000),
  story_role: str(200),
  relation_to_protagonist: str(200),
  first_appearance_episode_no: z.number().int().nullable().default(null),
});
export type PlotCharacterProposal = z.output<typeof plotCharacterProposalSchema>;

/** 설계 추가 0023: one story episode (에피소드 묶음) of a plan — inclusive 화 range */
export const storyEpisodeSchema = z.object({
  title: z.string().max(200).default(""),
  from: z.number().int(),
  to: z.number().int(),
});

// ── B3 plan_arc proposal (설계 추가: 플롯 세부 + 화 계획 + 신규 인물) ──
export const arcPlanProposalSchema = z.object({
  title: str(200),
  goal_text: str(2000),
  conflict_text: str(2000),
  end_condition: str(2000),
  core_event: str(2000),
  involved_character_ids: z.array(z.string()).default([]),
  change_text: str(2000),
  setup_plan: z.object({ plant: z.array(z.string().max(500)).default([]), payoff: z.array(z.string().max(500)).default([]) }).default({ plant: [], payoff: [] }),
  new_characters: z.array(plotCharacterProposalSchema).default([]),
  episodes: z
    .array(
      z.object({
        episode_no: z.number().int().min(1),
        title: z.string().max(200).nullable().default(null),
        hook_note: z.string().max(500).nullable().default(null),
        summary: str(1000),
        scene_count: z.number().int().nullable().default(null),
        target_chars: z.number().int().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * 설계 추가 0023: 에피소드 묶음 — the plot's 화 split into consecutive groups (usually 2–5 화) sharing one title;
   * each 화 is titled "<title> (n)". Ignored when the novel uses per-episode titles.
   */
  story_episodes: z.array(storyEpisodeSchema).default([]),
});
export type ArcPlanProposal = z.output<typeof arcPlanProposalSchema>;

// ── 설계 추가 0023: [제목 정리] proposal (existing 화 grouped into story episodes) ──
export const retitleProposalSchema = z.object({
  story_episodes: z.array(storyEpisodeSchema).default([]),
  rationale: str(1000),
});
export type RetitleProposal = z.output<typeof retitleProposalSchema>;

// ── P1 outline proposal (OutlineData + human summary) ──
export const outlineProposalSchema = z.object({ summary: str(4000), title: z.string().max(200).nullable().default(null), outline: outlineDataSchema.default(outlineDataSchema.parse({})) });
export type OutlineProposal = z.output<typeof outlineProposalSchema>;

// ── P3a LLM boundary estimate (SceneSegmentationResult, 07 §6.1) ──
export const sceneSegmentationSchema = z.object({
  scenes: z
    .array(
      z.object({
        char_start: z.number().int().min(0),
        summary: str(1000),
        narration_mode: z.enum(["first_person", "third_limited", "third_omniscient"]).nullable().default(null),
      }),
    )
    .default([]),
});
export type SceneSegmentation = z.output<typeof sceneSegmentationSchema>;

// ── P6 plan_rework proposal ──
export const reworkPlanSchema = z.object({
  target_scene_ords: z.array(z.number().int().min(1)).default([]),
  instructions: str(4000),
});
export type ReworkPlan = z.output<typeof reworkPlanSchema>;

// ── P3g check_text_safety verdict ──
export const safetyKindSchema = z.enum(["safety_age_rating", "safety_minor_sexual", "safety_real_person"]);
export const safetyVerdictSchema = z.object({
  /** empty = no problem */
  violations: z
    .array(
      z.object({
        scene_ord: z.number().int().min(1),
        kind: safetyKindSchema,
        rationale: str(1000),
        char_start: z.number().int().min(0).nullable().default(null),
        char_end: z.number().int().min(0).nullable().default(null),
      }),
    )
    .default([]),
});
export type SafetyVerdict = z.output<typeof safetyVerdictSchema>;

// ── task inputs (TC-5: ids only) ──
export const episodeTaskInputSchema = z
  .object({
    episode_id: z.string(),
    manuscript_version_id: z.string().optional(),
    rework_cause: z.enum(["check", "rejection"]).optional(),
    rework_from: z.enum(["outline", "draft", "polish"]).optional(),
    target_scene_ids: z.array(z.string()).optional(),
    issue_refs: z.array(z.object({ refType: z.string(), refId: z.string(), message: z.string().default("") })).optional(),
    rejection_id: z.string().optional(),
    answer_ids: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    cycle_key: z.string().optional(),
  })
  .passthrough();
export type EpisodeTaskInput = z.output<typeof episodeTaskInputSchema>;

export const planSeriesBibleInputSchema = z
  .object({
    concept_brief_id: z.string(),
    source_message_ids: z.array(z.string()).default([]),
    rejection_note: z.string().nullable().optional(),
    previous_bible_id: z.string().nullable().optional(),
    answer_ids: z.array(z.string()).optional(),
  })
  .passthrough();
export type PlanSeriesBibleInput = z.output<typeof planSeriesBibleInputSchema>;

export const planArcInputSchema = z
  .object({
    arc_id: z.string(),
    rejection_note: z.string().nullable().optional(),
    answer_ids: z.array(z.string()).optional(),
    replan: z.boolean().optional(),
    /** 설계 추가 0023: [제목 정리] — group the plot's existing 화 into story episodes (proposal only, approval applies it) */
    retitle: z.boolean().optional(),
  })
  .passthrough();
export type PlanArcInput = z.output<typeof planArcInputSchema>;

export const scheduleEpisodesInputSchema = z.object({ goal_id: z.string(), reason: z.string().optional() }).passthrough();
export type ScheduleEpisodesInput = z.output<typeof scheduleEpisodesInputSchema>;
