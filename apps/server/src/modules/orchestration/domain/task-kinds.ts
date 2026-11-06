/** `TASK_KIND_ROLE` (04 §2.2): fixed role per task_kind, copied to tasks.agent_role on creation. */
import type { AgentRole, TargetType, TaskKind } from "@ncs/shared";

export const TASK_KIND_ROLE: Readonly<Record<TaskKind, AgentRole>> = {
  concept_turn: "concept_partner",
  import_concept: "concept_partner",
  check_concept_brief: "continuity_editor",
  plan_series_bible: "planner",
  build_initial_ontology: "world_keeper",
  plan_arc: "planner",
  plan_setups: "foreshadow_manager",
  outline_episode: "planner",
  draft_episode: "writer",
  extract_facts: "world_keeper",
  link_mentions: "world_keeper",
  check_continuity: "continuity_editor",
  check_setups: "foreshadow_manager",
  polish_episode: "line_editor",
  split_scenes: "world_keeper",
  revise_episode: "writer",
  check_text_safety: "continuity_editor",
  plan_rework: "showrunner",
  interpret_answer: "world_keeper",
  apply_answer: "world_keeper",
  review_setup_due: "foreshadow_manager",
  schedule_episodes: "showrunner",
  grade_question: "showrunner",
  dedupe_entities: "world_keeper",
  // [v1/v2] media — enum values kept, no handlers in MVP-α
  split_shots: "scene_director",
  build_prompt_ir: "scene_director",
  classify_safety: "scene_director",
  render_prompts: "scene_director",
  generate_character_sheet: "visual_producer",
  generate_keyframes: "visual_producer",
  generate_illustrations: "visual_producer",
  generate_clips: "visual_producer",
  assemble_scene_video: "visual_producer",
  edit_trailer: "visual_producer",
  // 설계 추가: 캐릭터 설정 단계(module cast)
  draft_cast: "concept_partner",
  draft_design_sheet: "world_keeper",
  // 설계 추가: 전체 구성(1~4부 + 결말)
  plan_structure: "planner",
  // 설계 추가: 컨셉 승인 뒤 세계관 온톨로지 후보(module world)
  build_world_ontology: "world_keeper",
  // 설계 추가 0015: 엔티티 판정 백로그 정리
  resolve_entities: "world_keeper",
};

/** target_type per task_kind (04 §2.2 표; build_initial_ontology uses target novel + input.series_bible_id). */
export const TASK_KIND_TARGET: Readonly<Partial<Record<TaskKind, TargetType>>> = {
  concept_turn: "concept_session",
  import_concept: "concept_session",
  check_concept_brief: "concept_session",
  plan_series_bible: "novel",
  build_initial_ontology: "novel",
  plan_arc: "arc",
  plan_setups: "arc",
  schedule_episodes: "goal",
  outline_episode: "episode",
  draft_episode: "episode",
  split_scenes: "episode",
  extract_facts: "episode",
  link_mentions: "episode",
  check_continuity: "episode",
  check_setups: "episode",
  check_text_safety: "episode",
  polish_episode: "episode",
  plan_rework: "episode",
  revise_episode: "episode",
  interpret_answer: "question",
  apply_answer: "question",
  grade_question: "question",
  review_setup_due: "setup",
  draft_cast: "novel",
  draft_design_sheet: "character",
  plan_structure: "novel",
  build_world_ontology: "novel",
  resolve_entities: "novel",
};

/** Concept tasks are the only ones allowed without goal_id (INV-TSK-01 / INV-CON-08). */
export const CONCEPT_TASK_KINDS: readonly TaskKind[] = ["concept_turn", "import_concept", "check_concept_brief"];

/** Kinds allowed without goal_id: concept tasks + the cast step and world ontology that come before the goal (설계 추가, 0006/0012 tasks_ck_1). */
export const GOAL_OPTIONAL_TASK_KINDS: readonly TaskKind[] = [...CONCEPT_TASK_KINDS, "draft_cast", "draft_design_sheet", "build_world_ontology", "resolve_entities"];

export const MVP_ALPHA_TASK_KINDS: readonly TaskKind[] = Object.keys(TASK_KIND_TARGET) as TaskKind[];
