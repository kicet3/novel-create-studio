/**
 * Shared internals of the manuscript application layer: registries, cross-module calls that may hit
 * still-placeholder modules (NotImplementedError → graceful fallback), defaults.
 */
import { createHash } from "node:crypto";
import { defaultValue, type TaskKind } from "@ncs/shared";
import { NotImplementedError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ApprovalRequest, QuestionDraft } from "../../hitl/index.js";
import type { CreateTaskInput } from "../../orchestration/index.js";
import type {
  CheckGateContributor,
  EpisodeDeleteParticipant,
  EpisodeTransitionContext,
  ManuscriptIssueSink,
  PlanningCastPort,
  SafetyIssueDraft,
  VersionAnnotator,
} from "../index.js";
import type { ManuscriptModuleDeps } from "../module.js";

export const MANUSCRIPT_TASK_KINDS = [
  "plan_series_bible",
  "plan_arc",
  "schedule_episodes",
  "outline_episode",
  "draft_episode",
  "split_scenes",
  "polish_episode",
  "revise_episode",
  "plan_rework",
  "check_text_safety",
  "plan_structure",
  "adjust_length",
] as const satisfies readonly TaskKind[];

/** tasks that write the episode manuscript (04 §3.3 동시 실행 제약) */
export const WRITING_KINDS: readonly TaskKind[] = ["outline_episode", "draft_episode", "revise_episode", "polish_episode", "adjust_length", "plan_rework", "split_scenes"];
/** P3 tasks whose completion the gate waits for (GC-1) — only kinds with a registered handler count */
export const CHECK_PHASE_KINDS: readonly TaskKind[] = ["split_scenes", "extract_facts", "link_mentions", "check_continuity", "check_setups", "check_text_safety"];

export const isNotImplemented = (err: unknown) => err instanceof NotImplementedError || (err as { code?: string })?.code === "not_implemented";

export async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNotImplemented(err)) return fallback;
    throw err;
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface ManuscriptSettings {
  maxRejections: number;
  maxAutoRewrites: number;
  sceneOverlapMin: number;
  maxScenes: number;
  polishRecheckOnFactDiff: boolean;
  maxEpisodesInFlight: number;
  reserveTarget: number;
  /** 설계 추가: draft continuation when the draft is under the profile minimum */
  draftContinueMaxAttempts: number;
  /** stop continuing when one continuation added fewer chars than this */
  draftContinueMinGrowth: number;
  /** 설계 추가 0017: trim / expand rounds after a draft or revision (one more after polishing) */
  lengthAdjustMaxRounds: number;
  /** share of maxChars accepted above the profile maximum (0.03 → 5,500 × 1.03) */
  lengthTolerance: number;
}

export function settings(): ManuscriptSettings {
  return {
    maxRejections: defaultValue("episode.max_rejections"),
    maxAutoRewrites: defaultValue("continuity.max_auto_rewrites_per_episode"),
    sceneOverlapMin: defaultValue("scene.id_retention_overlap_min"),
    maxScenes: defaultValue("scene.max_per_episode"),
    polishRecheckOnFactDiff: defaultValue("polish.recheck_on_fact_diff"),
    maxEpisodesInFlight: defaultValue("schedule.max_episodes_in_flight"), // 04 §3.4
    reserveTarget: defaultValue("reserve.target_episodes"),
    draftContinueMaxAttempts: 2,
    draftContinueMinGrowth: 200,
    lengthAdjustMaxRounds: defaultValue("length.adjust_max_rounds"),
    lengthTolerance: defaultValue("length.adjust_tolerance_ratio"),
  };
}

export interface Registries {
  contributors: CheckGateContributor[];
  transitionHooks: Array<(ctx: EpisodeTransitionContext) => Promise<void>>;
  arcPlanHooks: Array<(ctx: import("../index.js").ArcPlanDecisionContext) => Promise<void>>;
  issueSinks: ManuscriptIssueSink[];
  annotators: { issues: VersionAnnotator[]; beats: VersionAnnotator[] };
  beatSources: Array<(scope: NovelScope, episodeNo: number) => Promise<string[]>>;
  /** 설계 추가: cast completeness / roster (registered by cast) */
  castPort: PlanningCastPort | null;
  /** 설계 추가(화 삭제): continuity / foreshadow / revision remove their records of a deleted manuscript */
  deleteParticipants: EpisodeDeleteParticipant[];
}

export function createRegistries(): Registries {
  return { contributors: [], transitionHooks: [], arcPlanHooks: [], issueSinks: [], annotators: { issues: [], beats: [] }, beatSources: [], castPort: null, deleteParticipants: [] };
}

/** port used when cast never registered (unit tests): everything complete, nothing to write */
export const NO_CAST_PORT: PlanningCastPort = {
  completeness: async () => ({ complete: true, items: [], message: "" }),
  roster: async () => [],
  applyFirstAppearances: async () => undefined,
  proposePlotCharacters: async () => ({ characterIds: [] }),
  confirmPlotCharacters: async () => undefined,
  requestFill: async () => null,
};
export const castPortOf = (reg: Registries): PlanningCastPort => reg.castPort ?? NO_CAST_PORT;

export interface Ports {
  readonly deps: ManuscriptModuleDeps;
  readonly reg: Registries;
  isRegistered(kind: TaskKind): boolean;
  createTask(tx: Tx, scope: NovelScope, input: CreateTaskInput): Promise<string | null>;
  requestApproval(tx: Tx, scope: NovelScope, req: ApprovalRequest): Promise<{ approvalId: string | null; questionId: string | null }>;
  createQuestion(tx: Tx, scope: NovelScope, draft: QuestionDraft, ctx: { createdBy: ActorRef; taskId?: string | null; runId?: string | null }): Promise<string | null>;
  openIssue(tx: Tx, scope: NovelScope, issue: SafetyIssueDraft, actor: ActorRef): Promise<string | null>;
  defaultTimelineId(scope: NovelScope, tx: Tx): Promise<string>;
}

export function createPorts(deps: ManuscriptModuleDeps, reg: Registries): Ports {
  const { orchestration, hitl, ontology, platform } = deps;
  return {
    deps,
    reg,
    isRegistered: (kind) => !!orchestration.getTaskKind(kind),
    async createTask(tx, scope, input) {
      const r = await orchestration.createTask(tx, scope, input);
      return r.taskId;
    },
    async requestApproval(tx, scope, req) {
      try {
        return await hitl.requestApproval(tx, scope, req);
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        platform.log.warn({ approvalType: req.approvalType, target: req.target }, "hitl not implemented: approval not requested");
        return { approvalId: null, questionId: null };
      }
    },
    async createQuestion(tx, scope, draft, ctx) {
      try {
        return (await hitl.createQuestion(tx, scope, draft, ctx)).questionId;
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        platform.log.warn({ topic: draft.topic }, "hitl not implemented: question not created");
        return null;
      }
    },
    async openIssue(tx, scope, issue, actor) {
      const sink = reg.issueSinks[0];
      if (!sink) {
        platform.log.warn({ kind: issue.kind, episodeId: issue.episodeId }, "no issue sink registered: issue not persisted");
        return null;
      }
      return (await sink(tx, scope, issue, actor)).issueId;
    },
    async defaultTimelineId(scope, tx) {
      return (await ontology.getDefaultTimeline(scope, tx)).id;
    },
  };
}
