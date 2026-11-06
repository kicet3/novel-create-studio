/**
 * manuscript — public API (design/03 §3.2, §4.1 E1–E16; 07 entire; FR-AGT-03/05/12, FR-MAN-01~07).
 * Owns: episodes, manuscript_versions (append-only), episode_rejections, scenes, scene_participants,
 * episode_recaps.
 *
 * Also hosts the PLANNING + WRITING PIPELINE task handlers (built with agents.defineAgentTask):
 *   plan_series_bible, plan_arc, schedule_episodes, outline_episode, draft_episode, split_scenes,
 *   polish_episode, revise_episode, plan_rework, check_text_safety
 * and the approval handlers for `series_bible`, `arc_plan`, `arc`, `episode` (hitl.registerApprovalHandler).
 * On N3 it creates `plan_series_bible` via novel.onGoalSaved (03 §4.12, 11 M-09).
 *
 * Check gate (07 §5.3) is evaluated HERE from contributors registered by continuity and foreshadow
 * (`registerCheckGateContributor`) so neither needs to import the other. Episode transitions invoke
 * `onEpisodeTransition` hooks in the same transaction (E9/E13/E14 fact & beat promotion, etc.).
 */
import type { CountBasis, EpisodeBlockReason, EpisodeStatus, IssueFixScope, ManuscriptVersionKind, ReworkFrom } from "@ncs/shared";
import type { EpisodesRow, EpisodeRejectionsRow, ManuscriptVersionsRow, ScenesRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";

export type Episode = EpisodesRow;
export type ManuscriptVersion = ManuscriptVersionsRow;
export type Scene = ScenesRow;
export type EpisodeRejection = EpisodeRejectionsRow;

/** E1–E16 identifiers (03 §4.1) */
export type EpisodeRuleId = `E${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16}`;

export interface AttributionSpan {
  start: number;
  end: number;
  actorType: "user" | "agent" | "system";
  actorId: string;
  originVersionId: string;
}

export interface SaveVersionInput {
  kind: ManuscriptVersionKind;
  content: string;
  /** required for kind=outline (07 §3.1.1 OutlineData) */
  outlineData?: unknown;
  writerAnnotations?: unknown;
  parentVersionId?: string | null;
  author: ActorRef;
  modelId?: string | null;
  isHumanEdit?: boolean;
  isFallbackModel?: boolean;
}

export interface SceneDraft {
  ord: number;
  charStart: number;
  charEnd: number;
  summary: string;
  timelineId?: string;
  povEntityId?: string | null;
  locationEntityId?: string | null;
  narrationMode?: Scene["narrationMode"];
}

export interface CheckGateVerdict {
  /** contributor name, e.g. "continuity", "foreshadow" */
  source: string;
  pass: boolean;
  /** strongest required fix scope when failing (07 §5.3 GC-5/GC-6) */
  fixScope?: IssueFixScope;
  blockers: Array<{ refType: string; refId: string; message: string; /** scene to rewrite (GC-6 대상 씬) */ sceneId?: string | null }>;
  /** still running (extraction/linking/checks not finished) → gate waits */
  pending?: boolean;
}

export interface CheckGateContributor {
  name: string;
  evaluate(scope: NovelScope, episode: Episode, versionId: string, tx?: Tx): Promise<CheckGateVerdict>;
}

export interface EpisodeTransitionContext {
  tx: Tx;
  scope: NovelScope;
  episode: Episode;
  from: EpisodeStatus;
  to: EpisodeStatus;
  ruleId: EpisodeRuleId;
  actor: ActorRef;
  approvalId?: string | null;
}

/** arc plan approval decided (AR2 approved / AR3 rejected) — foreshadow applies SC2/SC3 to the arc's setups */
export interface ArcPlanDecisionContext {
  tx: Tx;
  scope: NovelScope;
  arcId: string;
  decision: "approved" | "rejected";
  actor: ActorRef;
  approvalId: string;
}

export interface EpisodeFilter {
  arcId?: string;
  statuses?: EpisodeStatus[];
  fromNo?: number;
  toNo?: number;
}

export interface ReserveSummary {
  includingAwaiting: number;
  approvedOnly: number;
  target: number;
}

/** P3g findings are persisted as ContinuityIssue(kind=safety_*) by the module that owns issues (continuity registers). */
export interface SafetyIssueDraft {
  kind: "safety_age_rating" | "safety_minor_sexual" | "safety_real_person" | "human_edit_conflict";
  severity: "high" | "medium" | "low";
  episodeId: string;
  manuscriptVersionId: string;
  sceneId: string | null;
  charStart: number | null;
  charEnd: number | null;
  message: string;
  fixScope: IssueFixScope;
}
export type ManuscriptIssueSink = (tx: Tx, scope: NovelScope, issue: SafetyIssueDraft, actor: ActorRef) => Promise<{ issueId: string }>;

/** extra data for `GET …/versions/:id?with=issues,beats` supplied by continuity / foreshadow */
export type VersionAnnotator = (scope: NovelScope, version: ManuscriptVersion) => Promise<unknown[]>;

export type GateOutcome =
  | { kind: "wait"; reason: string }
  | { kind: "not_checking" }
  | { kind: "passed"; next: "polish_episode" | "awaiting_approval" }
  | { kind: "rewrite"; to: "drafting" | "outlining"; taskId: string | null }
  | { kind: "rewrite_limit"; questionId: string | null };

export interface ScheduleResult {
  createdTasks: Array<{ kind: string; taskId: string; targetId: string }>;
  reserve: ReserveSummary;
  inFlight: number;
  notes: string[];
}

export interface ManuscriptService {
  // episodes
  createPlannedEpisodes(tx: Tx, scope: NovelScope, arcId: string, episodes: Array<{ episodeNo: number; title?: string | null; hookNote?: string | null }>, actor: ActorRef): Promise<Episode[]>;
  getEpisode(scope: NovelScope, episodeId: string, tx?: Tx): Promise<Episode>;
  getEpisodeByNo(scope: NovelScope, episodeNo: number, tx?: Tx): Promise<Episode>;
  listEpisodes(scope: NovelScope, filter?: EpisodeFilter): Promise<Episode[]>;
  /** guarded E1–E16 transition + audit + hooks; throws InvalidTransitionError when not in the table */
  transitionEpisode(tx: Tx, scope: NovelScope, episodeId: string, to: EpisodeStatus, actor: ActorRef, opts?: { ruleId?: EpisodeRuleId; reason?: string; approvalId?: string | null }): Promise<Episode>;
  setBlockReason(tx: Tx, scope: NovelScope, episodeId: string, reason: EpisodeBlockReason, on: boolean, actor: ActorRef): Promise<Episode>;
  setEpisodePaused(scope: NovelScope, episodeId: string, paused: boolean, actor: ActorRef): Promise<Episode>;

  // versions & scenes
  saveVersion(tx: Tx, scope: NovelScope, episodeId: string, input: SaveVersionInput): Promise<ManuscriptVersion>;
  /** E16 (FR-MAN-07): human edit → new version (is_human_edit) → checking */
  saveHumanEdit(scope: NovelScope, episodeNo: number, input: { content: string; baseVersionId: string }, actor: ActorRef): Promise<ManuscriptVersion>;
  getVersion(scope: NovelScope, versionId: string, tx?: Tx): Promise<ManuscriptVersion>;
  listVersions(scope: NovelScope, episodeId: string): Promise<ManuscriptVersion[]>;
  /** 07 §6.3 scene-ID retention; retires unmatched scenes (scene.resegmented) */
  replaceScenes(tx: Tx, scope: NovelScope, versionId: string, scenes: SceneDraft[], actor: ActorRef): Promise<Scene[]>;
  listScenes(scope: NovelScope, episodeId: string, opts?: { versionId?: string; includeRetired?: boolean }): Promise<Scene[]>;
  countChars(text: string, basis: CountBasis): number;

  // rejection / publish
  /** E10/E11 + episode_rejections row + plan_rework task */
  rejectEpisode(tx: Tx, scope: NovelScope, episodeId: string, input: { decisionNote: string; reworkFrom: ReworkFrom; approvalId: string | null }, actor: ActorRef): Promise<EpisodeRejection>;
  /** E13 (INV-EP-03) — promotes facts to published_locked via hooks */
  publishEpisode(scope: NovelScope, episodeId: string, actor: ActorRef): Promise<Episode>;
  /** E14 — requires "외부 미공개" confirmation + reason */
  unpublishEpisode(scope: NovelScope, episodeId: string, input: { reason: string; confirmedNotPublishedExternally: true }, actor: ActorRef): Promise<Episode>;

  // extension points
  registerCheckGateContributor(c: CheckGateContributor): void;
  evaluateCheckGate(scope: NovelScope, episodeId: string, tx?: Tx): Promise<{ pass: boolean; pending: boolean; fixScope: IssueFixScope | null; verdicts: CheckGateVerdict[] }>;
  onEpisodeTransition(hook: (ctx: EpisodeTransitionContext) => Promise<void>): void;
  /** runs in the arc_plan approval transaction (03 §4.7 SC2/SC3) */
  onArcPlanDecision(hook: (ctx: ArcPlanDecisionContext) => Promise<void>): void;

  // home
  reserveSummary(scope: NovelScope): Promise<ReserveSummary>;

  // ── widened in the implementation phase (A4) ──
  /** E11 from the web (approved → revising): same input as a rejection, no approval required */
  requestRevision(scope: NovelScope, episodeNo: number, input: { decisionNote: string; reworkFrom: ReworkFrom }, actor: ActorRef): Promise<EpisodeRejection>;
  /** rejection history of an episode (rejection_no order) */
  listRejections(scope: NovelScope, episodeId: string): Promise<EpisodeRejection[]>;
  /**
   * P3f gate evaluation (07 §5.3). Check-task owners (continuity, foreshadow) call this in their commit
   * transaction with `completedTaskId` = their own task (still `running` inside the commit). A background
   * sweep also re-evaluates `checking` episodes, so a missed call only adds latency.
   */
  advanceCheckGate(tx: Tx, scope: NovelScope, episodeId: string, opts?: { completedTaskId?: string }): Promise<GateOutcome>;
  /** AR1 after plan_arc (+ plan_setups): foreshadow may call this from its plan_setups commit */
  requestArcPlanApproval(tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef): Promise<{ approvalId: string | null }>;
  /** deterministic scheduler pass (04 §3.4, system:scheduler) + check-gate sweep; `POST …/planning/schedule` */
  schedule(scope: NovelScope): Promise<ScheduleResult>;
  registerIssueSink(sink: ManuscriptIssueSink): void;
  /** planned SetupBeat ids for an episode (foreshadow) — used by the E2 guard (07 §3.1 결정적 검사 (3)) */
  registerPlannedBeatSource(source: (scope: NovelScope, episodeNo: number) => Promise<string[]>): void;
  registerVersionAnnotator(kind: "issues" | "beats", annotator: VersionAnnotator): void;
  getVersionDetail(scope: NovelScope, versionId: string, include: Array<"spans" | "scenes" | "issues" | "beats" | "lines">): Promise<Record<string, unknown>>;
}

export type { ManuscriptModuleDeps } from "./module.js";
export { createManuscriptModule } from "./module.js";
