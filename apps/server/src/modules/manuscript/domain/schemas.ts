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

// ── B3 plan_arc proposal ──
export const arcPlanProposalSchema = z.object({
  title: str(200),
  goal_text: str(2000),
  conflict_text: str(2000),
  end_condition: str(2000),
  episodes: z
    .array(z.object({ episode_no: z.number().int().min(1), title: z.string().max(200).nullable().default(null), hook_note: z.string().max(500).nullable().default(null), summary: str(1000) }))
    .default([]),
});
export type ArcPlanProposal = z.output<typeof arcPlanProposalSchema>;

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

export const planArcInputSchema = z.object({ arc_id: z.string(), rejection_note: z.string().nullable().optional(), answer_ids: z.array(z.string()).optional() }).passthrough();
export type PlanArcInput = z.output<typeof planArcInputSchema>;

export const scheduleEpisodesInputSchema = z.object({ goal_id: z.string(), reason: z.string().optional() }).passthrough();
export type ScheduleEpisodesInput = z.output<typeof scheduleEpisodesInputSchema>;
