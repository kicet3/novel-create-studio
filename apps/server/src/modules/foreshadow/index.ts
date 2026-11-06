/**
 * foreshadow — public API (design/03 §3.7, §4.7; 06 §8; 07 §1.3, §5.2; FR-FOR-01~08).
 * Owns: setups, setup_beats, setup_due_changes, setup_links.
 * Registers task kinds: plan_setups, check_setups, review_setup_due.
 * Registers with manuscript: a CheckGateContributor ("missing beats = 0", INV-EP-02) and an
 * onEpisodeTransition hook (E9: beats → confirmed, setups canon_status promotion; E13 locking).
 * Registers an `assigned_beats` ContextSectionProvider with agents.
 * Registers with hitl: `setup_due` answer applier, `setup_abandon` approval handler.
 *
 * `continuity` (built after foreshadow) registers a `SetupIssueSink` here so that check_setups can open
 * `setup_missing` / `setup_contradiction` issues without importing continuity (registry inversion).
 */
import type { CanonStatus, IssueFixScope, IssueSeverity, SetupBeatKind, SetupBeatStatus, SetupDueKind, SetupImportance, SetupNarrativeStatus } from "@ncs/shared";
import type { SetupBeatsRow, SetupDueChangesRow, SetupsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Ref, Tx } from "../../platform/index.js";
import type { SetupReport } from "./domain/report.js";

export type Setup = SetupsRow;
export type SetupBeat = SetupBeatsRow;
export type SetupDueChange = SetupDueChangesRow;
export type { SetupReport } from "./domain/report.js";

export interface SetupInput {
  title: string;
  description: string;
  importance: SetupImportance;
  dueKind: SetupDueKind;
  dueEpisodeNo?: number | null;
  dueArcId?: string | null;
  links?: Ref[];
  /** arc whose plan created the setup (FR-FOR-02) */
  plannedArcId?: string | null;
}

export interface BeatPlan {
  kind: SetupBeatKind;
  plannedEpisodeNo: number;
  note?: string;
}

export interface SetupFilter {
  narrativeStatuses?: SetupNarrativeStatus[];
  canonStatuses?: CanonStatus[];
  importance?: SetupImportance[];
  overdueOnly?: boolean;
  dueWithinEpisodes?: number;
  plannedArcId?: string;
}

export interface SetupListItem extends Setup {
  beats: SetupBeat[];
  /** due − current episode (negative = overdue) */
  remainingEpisodes: number | null;
  /** due resolved to an episode number (arc due → arc's planned_episode_to) */
  effectiveDueEpisodeNo: number | null;
}

/** setup issue opened through the continuity-registered sink (07 §5.2) */
export interface SetupIssueDraft {
  kind: "setup_missing" | "setup_contradiction";
  severity: IssueSeverity;
  setupId: string;
  beatId: string;
  episodeId: string;
  manuscriptVersionId: string;
  sceneId?: string | null;
  charStart?: number | null;
  charEnd?: number | null;
  message: string;
  suggestion?: string | null;
  fixScope?: IssueFixScope | null;
  /** pinned / planted fact versions used as evidence (CR-15) */
  factVersionIds?: Array<{ factId: string; factVersionId: string }>;
}

export interface SetupIssueSink {
  /**
   * Open (or re-link by dedupe key) the given setup issues for this version and resolve the open
   * setup_missing / setup_contradiction issues of the episode that are no longer reproduced.
   */
  reconcileSetupIssues(
    tx: Tx,
    scope: NovelScope,
    input: { episodeId: string; manuscriptVersionId: string; drafts: SetupIssueDraft[]; runId: string | null },
    actor: ActorRef,
  ): Promise<{ opened: string[]; relinked: string[]; resolved: string[] }>;
  /** open setup_contradiction issues (report R4) */
  listOpenSetupIssues(scope: NovelScope): Promise<Array<{ setupId: string | null; issueId: string; issueDisplayNo: number; severity: IssueSeverity; message: string; kind: string }>>;
}

export interface ForeshadowService {
  createSetup(tx: Tx, scope: NovelScope, input: SetupInput, actor: ActorRef): Promise<Setup>;
  updateSetup(tx: Tx, scope: NovelScope, setupId: string, patch: Partial<SetupInput>, actor: ActorRef, opts?: { approvalId?: string | null }): Promise<Setup>;
  planBeats(tx: Tx, scope: NovelScope, setupId: string, beats: BeatPlan[], actor: ActorRef): Promise<SetupBeat[]>;
  /** S2–S5 (S5 needs opts.approvalId of an approved setup_abandon approval + reason) */
  transitionNarrative(tx: Tx, scope: NovelScope, setupId: string, to: SetupNarrativeStatus, actor: ActorRef, reason?: string, opts?: { approvalId?: string | null; beatId?: string | null }): Promise<Setup>;
  /** SC2–SC6 (SC6 needs opts.approvalId) */
  transitionCanon(tx: Tx, scope: NovelScope, setupId: string, to: CanonStatus, actor: ActorRef, opts?: { approvalId?: string | null; reason?: string }): Promise<Setup>;
  changeDue(tx: Tx, scope: NovelScope, setupId: string, due: { dueKind: SetupDueKind; dueEpisodeNo?: number | null; dueArcId?: string | null; reason: string; questionId?: string | null; approvalId?: string | null }, actor: ActorRef): Promise<Setup>;
  /** check_setups result for a version (setup.beat_detected / beat_missing) */
  recordBeatResult(tx: Tx, scope: NovelScope, beatId: string, result: { status: Extract<SetupBeatStatus, "detected" | "missing">; manuscriptVersionId: string; episodeId?: string | null; sceneId?: string | null; charStart?: number | null; charEnd?: number | null; runId?: string | null }, actor: ActorRef): Promise<SetupBeat>;
  beatsForEpisode(scope: NovelScope, episodeNo: number, tx?: Tx): Promise<Array<SetupBeat & { setup: Setup }>>;
  missingBeats(scope: NovelScope, episodeId: string, versionId: string, tx?: Tx): Promise<SetupBeat[]>;
  listSetups(scope: NovelScope, filter?: SetupFilter): Promise<SetupListItem[]>;
  getSetup(scope: NovelScope, setupIdOrNo: string | number): Promise<SetupListItem & { dueChanges: SetupDueChange[]; links: Array<Ref & { pinnedFactVersionId: string | null }> }>;
  /** 06 §8.1 SetupReport R1–R5 / §8.2 metrics */
  report(scope: NovelScope, asOfEpisodeNo?: number): Promise<SetupReport>;
  /** SC2 / SC3 for every candidate setup planned by the arc (arc_plan decided). Returns changed setup ids. */
  applyArcPlanDecision(tx: Tx, scope: NovelScope, arcId: string, decision: "approved" | "rejected", actor: ActorRef, approvalId?: string | null): Promise<string[]>;
  /** continuity registers itself here (registry inversion) */
  registerIssueSink(sink: SetupIssueSink): void;
}

export type { ForeshadowModuleDeps } from "./module.js";
export { createForeshadowModule } from "./module.js";
