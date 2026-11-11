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
import type {
  CastCompleteness,
  CharacterRole,
  CountBasis,
  DeleteManuscriptRequest,
  EpisodeBlockReason,
  EpisodeDeletePreviewDto,
  EpisodeStatus,
  EpisodeUnitDto,
  IssueFixScope,
  ManuscriptVersionKind,
  RetitleApplyRequest,
  RetitleApplyResult,
  RetitleProposalView,
  ReworkFrom,
  StructureView,
} from "@ncs/shared";
import type { EpisodesRow, EpisodeRejectionsRow, ManuscriptVersionsRow, ScenesRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { EpisodeFact } from "../ontology/index.js";

export type Episode = EpisodesRow;
export type ManuscriptVersion = ManuscriptVersionsRow;
export type Scene = ScenesRow;
export type EpisodeRejection = EpisodeRejectionsRow;

/** E1–E16 identifiers (03 §4.1) + E17 (설계 추가: 화 삭제 → planned) */
export type EpisodeRuleId = `E${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17}`;

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

// ── 설계 추가(화 삭제): modules built after manuscript remove / count their records of a deleted manuscript ──
export interface EpisodeDeleteContext {
  episodeId: string;
  episodeNo: number;
  /** every manuscript version of the episode (all of them are deleted) */
  versionIds: string[];
  /** every scene of those versions (active + retired) */
  sceneIds: string[];
}
/**
 * A record owner (continuity issues, foreshadow beats, revision chat) registered with `registerEpisodeDeleteParticipant`.
 * `count` feeds the delete preview; `purge` runs inside the delete transaction before the versions are deleted and
 * returns how many records it removed plus open questions the caller should cancel (hitl is cancelled by manuscript).
 */
export interface EpisodeDeleteParticipant {
  name: "issues" | "beats" | "sessions";
  count(scope: NovelScope, ctx: EpisodeDeleteContext, tx?: Tx): Promise<number>;
  purge(tx: Tx, scope: NovelScope, ctx: EpisodeDeleteContext, actor: ActorRef, reason: string): Promise<{ count: number; questionIds?: string[] }>;
}

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

// ── 설계 추가: 전체 구성 → 플롯 → 화 (cast reads through this port; cast is built after manuscript) ──
export interface PlanningRosterEntry {
  id: string;
  name: string;
  role: CharacterRole;
  entityId: string | null;
  status: string;
  proposed: boolean;
  firstAppearanceEpisodeNo: number | null;
  introducedArcId: string | null;
}

/** a character a plot introduces (plan_arc new_characters) — profile fields of the cast */
export interface PlotCharacterDraft {
  name: string;
  role: "sub_protagonist" | "antagonist" | "supporting";
  age: string;
  appearance: string;
  personality: string;
  desire: string;
  motivation: string;
  weakness: string;
  background: string;
  speechSample: string;
  arcStart: string;
  arcEnd: string;
  storyRole: string;
  relationToProtagonist: string;
  firstAppearanceEpisodeNo: number | null;
}

export interface PlanningCastPort {
  /** initial cast (introducedArcId null) or the characters a plot introduced */
  completeness(scope: NovelScope, opts: { scope: "initial" } | { scope: "arc"; arcId: string } | { scope: "plots" }, tx?: Tx): Promise<CastCompleteness>;
  roster(scope: NovelScope, tx?: Tx): Promise<PlanningRosterEntry[]>;
  /** agent write: only characters whose first appearance is still empty (a user value is never overwritten) */
  applyFirstAppearances(tx: Tx, scope: NovelScope, items: Array<{ characterId: string; episodeNo: number }>, actor: ActorRef): Promise<void>;
  proposePlotCharacters(tx: Tx, scope: NovelScope, arcId: string, drafts: PlotCharacterDraft[], actor: ActorRef): Promise<{ characterIds: string[] }>;
  /** arc_plan approved / AR4: confirm the plot's characters (ontology sync of those only) */
  confirmPlotCharacters(tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef): Promise<void>;
  /** `draft_cast` fill_missing for these characters (coalesced); null when nothing to fill */
  requestFill(tx: Tx, scope: NovelScope, characterIds: string[], actor: ActorRef): Promise<string | null>;
}

export interface ManuscriptService {
  // episodes
  createPlannedEpisodes(
    tx: Tx,
    scope: NovelScope,
    arcId: string,
    episodes: Array<{ episodeNo: number; title?: string | null; hookNote?: string | null; planSummary?: string; plannedSceneCount?: number | null; targetChars?: number | null }>,
    actor: ActorRef,
  ): Promise<Episode[]>;
  getEpisode(scope: NovelScope, episodeId: string, tx?: Tx): Promise<Episode>;
  getEpisodeByNo(scope: NovelScope, episodeNo: number, tx?: Tx): Promise<Episode>;
  listEpisodes(scope: NovelScope, filter?: EpisodeFilter, tx?: Tx): Promise<Episode[]>;
  /** guarded E1–E16 transition + audit + hooks; throws InvalidTransitionError when not in the table */
  transitionEpisode(tx: Tx, scope: NovelScope, episodeId: string, to: EpisodeStatus, actor: ActorRef, opts?: { ruleId?: EpisodeRuleId; reason?: string; approvalId?: string | null }): Promise<Episode>;
  setBlockReason(tx: Tx, scope: NovelScope, episodeId: string, reason: EpisodeBlockReason, on: boolean, actor: ActorRef): Promise<Episode>;
  setEpisodePaused(scope: NovelScope, episodeId: string, paused: boolean, actor: ActorRef): Promise<Episode>;

  // versions & scenes
  saveVersion(tx: Tx, scope: NovelScope, episodeId: string, input: SaveVersionInput): Promise<ManuscriptVersion>;
  /** E16 (FR-MAN-07): human edit → new version (is_human_edit) → checking */
  saveHumanEdit(scope: NovelScope, episodeNo: number, input: { content: string; baseVersionId: string }, actor: ActorRef): Promise<ManuscriptVersion>;
  /**
   * 설계 추가 0018: E16 in the caller's transaction (revision chat accepts agent-proposed patches the author approved).
   * Same rules as saveHumanEdit: published → 422 retcon_required, stale base → 409 stale_base_version, in-flight writing /
   * check tasks cancelled, pending episode approval superseded, approved → checking (facts demoted), split_scenes queued.
   */
  applyHumanEditTx(
    tx: Tx,
    scope: NovelScope,
    episodeId: string,
    input: { content: string; baseVersionId: string; writerAnnotations?: unknown; auditDetails?: Record<string, unknown> },
    actor: ActorRef,
  ): Promise<ManuscriptVersion>;
  getVersion(scope: NovelScope, versionId: string, tx?: Tx): Promise<ManuscriptVersion>;
  listVersions(scope: NovelScope, episodeId: string, tx?: Tx): Promise<ManuscriptVersion[]>;
  /** 07 §6.3 scene-ID retention; retires unmatched scenes (scene.resegmented) */
  replaceScenes(tx: Tx, scope: NovelScope, versionId: string, scenes: SceneDraft[], actor: ActorRef): Promise<Scene[]>;
  listScenes(scope: NovelScope, episodeId: string, opts?: { versionId?: string; includeRetired?: boolean }): Promise<Scene[]>;
  countChars(text: string, basis: CountBasis): number;

  // rejection / publish
  /** E10/E11 + episode_rejections row + plan_rework task */
  rejectEpisode(tx: Tx, scope: NovelScope, episodeId: string, input: { decisionNote: string; reworkFrom: ReworkFrom; approvalId: string | null }, actor: ActorRef): Promise<EpisodeRejection>;
  /** E13 (INV-EP-03) — promotes facts to published_locked via hooks */
  publishEpisode(scope: NovelScope, episodeId: string, actor: ActorRef): Promise<Episode>;
  /** 설계 추가 0014: publish slot of an approved episode (`episode.publish_scheduled`); null clears it */
  setScheduledPublish(scope: NovelScope, episodeId: string, at: Date | null, actor: ActorRef): Promise<Episode>;
  /** E14 — requires "외부 미공개" confirmation + reason */
  unpublishEpisode(scope: NovelScope, episodeId: string, input: { reason: string; confirmedNotPublishedExternally: true }, actor: ActorRef): Promise<Episode>;
  /** 설계 추가(화 삭제): read-only summary of what `deleteManuscript` would remove */
  previewDelete(scope: NovelScope, episodeId: string): Promise<EpisodeDeletePreviewDto>;
  /**
   * 설계 추가(화 삭제, E17): user only. One transaction: published → E14 first (needs confirmedNotPublishedExternally),
   * work in flight cancelled (tasks / approvals / questions), the episode's facts rejected / retracted, mentions,
   * names, frames, scenes, issues, beats, recaps, revision chat and every manuscript version removed; the episode row
   * goes back to `planned` with its plan fields kept. `holdRewrite` pauses the episode. 422 nothing_to_delete /
   * external_confirmation_required / user_required / reason_required.
   */
  deleteManuscript(scope: NovelScope, episodeId: string, input: DeleteManuscriptRequest, actor: ActorRef): Promise<Episode>;
  registerEpisodeDeleteParticipant(p: EpisodeDeleteParticipant): void;

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

  // ── 설계 추가: 전체 구성(1~4부 + 결말) → 플롯 → 화 ──
  registerPlanningCastPort(port: PlanningCastPort): void;
  getStructureView(scope: NovelScope): Promise<StructureView>;
  /** 202: plan_structure (the running one when it exists); 422 goal_required / bible_not_approved / cast_incomplete / structure_too_short */
  requestStructure(scope: NovelScope, input: { scope: "all" | "ending" | "parts"; instructions?: string }, actor: ActorRef): Promise<{ taskId: string }>;
  /** user decision on the story_structure approval (draft → ST1 first); goes through hitl.acceptAnswer */
  decideStructure(scope: NovelScope, input: { decision: "approved" | "rejected"; note?: string; expectedRevision: number }, actor: ActorRef): Promise<StructureView>;
  /** plan_arc again for a plot (flags cleared); 409 arc_not_replannable, 422 structure_not_approved */
  replanArc(scope: NovelScope, arcId: string, note: string | undefined, actor: ActorRef): Promise<{ taskId: string }>;
  /**
   * episode rows with `lengthBelowFloor` (current version under the 3,000-char floor) and `lengthOutOfRange`
   * (설계 추가 0017: outside [minChars, maxChars × (1 + tolerance)] of the profile; null = in range / no text)
   */
  withLengthFlags<E extends Episode>(scope: NovelScope, episodes: E[]): Promise<Array<E & { lengthBelowFloor: boolean; lengthOutOfRange: LengthOutOfRange | null }>>;

  // ── 설계 추가 0019: 화 사이 이어짐 ──
  /** how episode `episodeNo` ends: its latest text version (current, else approved), the end tail and the stored handoff; null without text */
  getEpisodeEnd(scope: NovelScope, episodeNo: number, tx?: Tx): Promise<EpisodeEnd | null>;

  // ── 설계 추가(미확정 사실 선행 집필) ──
  /**
   * live candidate facts of episodes before `episodeNo` that are not approved / published yet (drafts written ahead),
   * not in conflict with canon, not held; relevant to `entityIds` when given; newest source episode first, bounded
   */
  listPendingPriorFacts(scope: NovelScope, episodeNo: number, opts?: { entityIds?: string[]; limit?: number }, tx?: Tx): Promise<PendingPriorFact[]>;

  // ── 설계 추가 0023: 에피소드 묶음 "제목 (1)(2)" ──
  /** active story episodes (에피소드 묶음) of the novel / a plot, in reading order */
  listEpisodeUnits(scope: NovelScope, filter?: { arcId?: string }, tx?: Tx): Promise<EpisodeUnitDto[]>;
  /** episode rows with unitTitle / unitPartNo / unitPartCount (null without a 묶음) — `title` is already the display title */
  withUnitInfo<E extends Episode>(scope: NovelScope, episodes: E[], tx?: Tx): Promise<Array<E & EpisodeUnitInfo>>;
  /** the 묶음 of a 화 for the writing prompts (null without one) */
  getEpisodeUnitContext(scope: NovelScope, episode: Episode, tx?: Tx): Promise<EpisodeUnitContext | null>;
  /** [제목 정리]: 202 plan_arc (retitle) — the running one when it exists */
  proposeRetitle(scope: NovelScope, arcId: string, actor: ActorRef, note?: string): Promise<{ taskId: string }>;
  getRetitle(scope: NovelScope, arcId: string): Promise<RetitleProposalView>;
  /** applies (or rejects) the pending proposal; published 화 change only when listed + confirmed (422 published_rename_confirmation_required) */
  applyRetitle(scope: NovelScope, arcId: string, input: RetitleApplyRequest, actor: ActorRef): Promise<RetitleApplyResult>;

  // ── 설계 추가 0024: 문장 리듬 [문체 다듬기] ──
  /** 202: rhythm-only polish of an awaiting_approval / approved episode → candidate version (current unchanged); 422 rhythm_ok when nothing is flagged */
  requestRhythmPolish(scope: NovelScope, episodeNo: number, actor: ActorRef): Promise<{ taskId: string }>;
  /** keep = E16 human-edit rules with the candidate text; discard = candidate cleared; 409 rhythm_candidate_stale / stale_base_version */
  decideRhythmCandidate(scope: NovelScope, episodeNo: number, input: { versionId: string; decision: "keep" | "discard" }, actor: ActorRef): Promise<Episode>;
}

/** 설계 추가 0023 */
export interface EpisodeUnitInfo {
  unitId: string | null;
  unitTitle: string | null;
  unitPartNo: number | null;
  unitPartCount: number | null;
}

/** 설계 추가 0023: "이 화는 「X」 에피소드의 n/N화" */
export interface EpisodeUnitContext {
  title: string;
  partNo: number;
  partCount: number;
  from: number;
  to: number;
  siblings: Array<{ episodeNo: number; partNo: number; title: string | null; planSummary: string; status: string }>;
}

/** 설계 추가(미확정 사실 선행 집필): a provisional fact of an earlier episode waiting for approval */
export interface PendingPriorFact extends EpisodeFact {
  sourceEpisodeId: string;
  sourceEpisodeNo: number;
  sourceEpisodeStatus: EpisodeStatus;
}

/** 설계 추가 0019: 직전 화 끝 상태 (summarize_episode, episode_recaps.handoff) */
export interface EpisodeHandoffData {
  place: string;
  time: string;
  present: string[];
  physical_state: string;
  emotional_state: string;
  open_hook: string;
  last_line: string;
}

/** 설계 추가 0019: the end of an episode as the next episode continues from it */
export interface EpisodeEnd {
  episodeId: string;
  episodeNo: number;
  /** latest text version (current ?? approved) — what the next episode must continue from */
  versionId: string;
  /** last scene, bounded (~1,200–2,000 chars) */
  tail: string;
  recapId: string | null;
  /** version the stored handoff / summary was made from */
  recapVersionId: string | null;
  handoff: EpisodeHandoffData | null;
  summaryLines: string[];
  /** the text changed after the stored handoff (a newer version is summarized again) */
  stale: boolean;
}

/** 설계 추가 0017: an episode text outside the accepted length range */
export interface LengthOutOfRange {
  deviation: "short" | "long";
  count: number;
  minChars: number;
  maxChars: number;
  /** maxChars × (1 + tolerance) */
  acceptedMaxChars: number;
}

export type { ManuscriptModuleDeps } from "./module.js";
export { createManuscriptModule } from "./module.js";
