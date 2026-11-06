/**
 * DTOs of the read-only agent overview ("에이전트 현황", module orchestration).
 *
 *   GET …/agents/overview          → agentsOverviewSchema   (roster, stages, gates; polled every few seconds)
 *   GET …/agents/timeline?hours=6  → agentsTimelineSchema   (runs overlapping the last `hours` hours; polled slower)
 *
 * Gate counts here are tasks held behind a gate; the pending approvals themselves come from
 * `GET …/approvals?status=pending` (see AGENT_GATE_APPROVAL_TYPES). No prompts, inputs, provider
 * responses or run error messages are included (the run detail reads `GET …/tasks/:taskId/runs`).
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import type { ApprovalType, TaskKind } from "../enums.js";
import { isoDateTime } from "./common.js";

/** Pipeline stages in display order (컨셉 → 세계관 → 캐릭터 → 구성 → 플롯 → 화 개요 → 초고 → 교정 → 점검). */
export const AGENT_PIPELINE_STAGES = ["concept", "world", "cast", "structure", "plot", "outline", "draft", "polish", "check"] as const;
export type AgentPipelineStage = (typeof AGENT_PIPELINE_STAGES)[number];

/** Human approval gates and the stage each one follows. */
export const AGENT_PIPELINE_GATES = ["concept", "structure", "plot", "episode"] as const;
export type AgentPipelineGate = (typeof AGENT_PIPELINE_GATES)[number];
/** approval_type → gate it represents (approval types not listed are not pipeline gates). */
export const AGENT_GATE_APPROVAL_TYPES: Readonly<Record<AgentPipelineGate, readonly ApprovalType[]>> = {
  concept: ["concept_brief"],
  structure: ["series_bible", "story_structure"],
  plot: ["arc_plan", "arc"],
  episode: ["episode"],
};
export const AGENT_GATE_AFTER_STAGE: Readonly<Record<AgentPipelineGate, AgentPipelineStage>> = {
  concept: "concept",
  structure: "structure",
  plot: "plot",
  episode: "check",
};

/** task_kind → pipeline stage; kinds not listed (HITL helpers, v1 media) are counted under `other`. */
export const TASK_KIND_STAGE: Readonly<Partial<Record<TaskKind, AgentPipelineStage>>> = {
  concept_turn: "concept",
  import_concept: "concept",
  check_concept_brief: "concept",
  build_world_ontology: "world",
  build_initial_ontology: "world",
  dedupe_entities: "world",
  draft_cast: "cast",
  draft_design_sheet: "cast",
  plan_series_bible: "structure",
  plan_structure: "structure",
  plan_arc: "plot",
  plan_setups: "plot",
  schedule_episodes: "plot",
  outline_episode: "outline",
  draft_episode: "draft",
  revise_episode: "draft",
  plan_rework: "draft",
  polish_episode: "polish",
  check_continuity: "check",
  check_setups: "check",
  check_text_safety: "check",
  extract_facts: "check",
  link_mentions: "check",
  split_scenes: "check",
  review_setup_due: "check",
};

export const agentsTimelineQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(72).default(6),
});
export type AgentsTimelineQuery = z.infer<typeof agentsTimelineQuerySchema>;

/** A failed task turns its role card to `error` only for this long; older failures stay in the counts. */
export const AGENT_RECENT_ERROR_MS = 24 * 3_600_000;

/**
 * Derived role state: running > error (failure within AGENT_RECENT_ERROR_MS) > blocked (not on a human)
 * > awaiting_human (waiting for an answer / approval — normal flow) > waiting > idle.
 */
export const AGENT_ROLE_STATES = ["running", "error", "blocked", "awaiting_human", "waiting", "idle"] as const;
export type AgentRoleState = (typeof AGENT_ROLE_STATES)[number];

const statusCountsSchema = z.object({
  pending: z.number().int(),
  ready: z.number().int(),
  running: z.number().int(),
  blocked: z.number().int(),
  failed: z.number().int(),
  done: z.number().int(),
});
export type AgentStatusCounts = z.infer<typeof statusCountsSchema>;

const usageSchema = z.object({
  runs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
});

export const agentCurrentWorkSchema = z.object({
  taskId: z.string(),
  displayNo: z.number().int(),
  kind: z.enum(ENUMS.task_kind),
  runId: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
  leaseExpiresAt: isoDateTime.nullable(),
  /** 1-based attempt of the running run (tasks.attempt_count + 1; the count moves when the run ends) */
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  /** model of the run's latest provider call (null before the first call) */
  model: z.object({ provider: z.string(), modelId: z.string() }).nullable(),
  /** live usage of the run so far (provider calls recorded until now) */
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
});
export type AgentCurrentWorkDto = z.infer<typeof agentCurrentWorkSchema>;

export const agentBlockedWorkSchema = z.object({
  taskId: z.string(),
  displayNo: z.number().int(),
  kind: z.enum(ENUMS.task_kind),
  blockReason: z.enum(ENUMS.task_block_reason).nullable(),
  blockedRefType: z.enum(ENUMS.ref_type).nullable(),
  blockedRefId: z.string().nullable(),
});

export const agentRoleOverviewSchema = z.object({
  role: z.enum(ENUMS.agent_role),
  state: z.enum(AGENT_ROLE_STATES),
  counts: statusCountsSchema,
  /** blocked tasks that wait on a person (question / approval); a subset of counts.blocked */
  awaitingHuman: z.number().int(),
  current: z.array(agentCurrentWorkSchema),
  blocked: z.array(agentBlockedWorkSchema),
  lastError: z
    .object({
      taskId: z.string(),
      displayNo: z.number().int(),
      kind: z.enum(ENUMS.task_kind),
      errorFamily: z.enum(ENUMS.error_family).nullable(),
      errorMessage: z.string().nullable(),
      at: isoDateTime.nullable(),
      /** failed within AGENT_RECENT_ERROR_MS (drives the `error` state) */
      recent: z.boolean(),
    })
    .nullable(),
  /** model bound to the role for this novel (role_model_bindings) */
  boundModelId: z.string().nullable(),
  /** runs finished since the start of today (novel timezone) + usage recorded so far by running runs */
  today: usageSchema,
  /** latest run activity since shortly before today (null = none in that range) */
  lastActiveAt: isoDateTime.nullable(),
});
export type AgentRoleOverviewDto = z.infer<typeof agentRoleOverviewSchema>;

export const agentStageOverviewSchema = z.object({
  stage: z.enum(AGENT_PIPELINE_STAGES),
  counts: statusCountsSchema,
  awaitingQuestion: z.number().int(),
  awaitingApproval: z.number().int(),
});
export type AgentStageOverviewDto = z.infer<typeof agentStageOverviewSchema>;

export const agentGateOverviewSchema = z.object({
  gate: z.enum(AGENT_PIPELINE_GATES),
  afterStage: z.enum(AGENT_PIPELINE_STAGES),
  /** tasks held behind this gate (blocked on approval); pending approvals are counted on the client */
  blockedTasks: z.number().int(),
});
export type AgentGateOverviewDto = z.infer<typeof agentGateOverviewSchema>;

export const agentRunSpanSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskDisplayNo: z.number().int(),
  kind: z.enum(ENUMS.task_kind),
  role: z.enum(ENUMS.agent_role),
  status: z.enum(ENUMS.run_status),
  stopReason: z.enum(ENUMS.run_stop_reason).nullable(),
  errorFamily: z.enum(ENUMS.error_family).nullable(),
  createdAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  /** the task's attempt count now (not per run: runs carry no attempt number) */
  taskAttemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  models: z.array(z.string()),
});
export type AgentRunSpanDto = z.infer<typeof agentRunSpanSchema>;

export const agentsOverviewSchema = z.object({
  now: isoDateTime,
  todayStart: isoDateTime,
  timezone: z.string(),
  paused: z.boolean(),
  roles: z.array(agentRoleOverviewSchema),
  stages: z.array(agentStageOverviewSchema),
  /** tasks whose kind has no pipeline stage (answer handling, media) */
  other: statusCountsSchema,
  gates: z.array(agentGateOverviewSchema),
});
export type AgentsOverviewDto = z.infer<typeof agentsOverviewSchema>;

export const agentsTimelineSchema = z.object({
  now: isoDateTime,
  since: isoDateTime,
  timezone: z.string(),
  runs: z.array(agentRunSpanSchema),
  /** more runs overlapped the window than were returned */
  runsTruncated: z.boolean(),
});
export type AgentsTimelineDto = z.infer<typeof agentsTimelineSchema>;
