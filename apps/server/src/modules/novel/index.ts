/**
 * novel — public API (design/03 §3.1, §4.11–4.12; 11 §5.8; 08 §9.8).
 * Owns: users, novels, goals, series_bibles, arcs, length_profiles, notification_policies, novel_counters.
 *
 * Cross-module participation without import cycles (novel depends only on audit):
 *  - N1 creation set (INV-NOV-06): other modules register a `NovelCreationParticipant`
 *    (ontology → schema v1 + main timeline, messaging → web channel, budget → default policy,
 *    llm → role bindings, concept → ConceptSession). All run in the creating transaction.
 *  - `onGoalSaved` / `onStatusChanged` hooks run in the same transaction (e.g. orchestration creates
 *    `plan_series_bible` on N3, INV-GOL-02 wakes planning tasks on goal revisions).
 */
import type {
  ArcStatus,
  AutonomyLevel,
  ConceptEntryMode,
  NarrationMode,
  NovelCounterKind,
  NovelStatus,
  PauseReason,
  PublishPolicy,
  QuestionThreshold,
  CountBasis,
  AgeRating,
  ArcPlanFlag,
  StoryEnding,
  StoryStructureStatus,
  StructurePendingChanges,
} from "@ncs/shared";
import type {
  ArcsRow,
  GoalsRow,
  LengthProfilesRow,
  NotificationPoliciesRow,
  NovelsRow,
  SeriesBiblesRow,
  StoryPartsRow,
  StoryStructuresRow,
  UsersRow,
  ArcSetupPlanJson,
} from "@ncs/db/schema";
import type { ActorRef, ModuleName, NovelScope, Tx } from "../../platform/index.js";

export type User = UsersRow;
export type Novel = NovelsRow;
export type Goal = GoalsRow;
export type SeriesBible = SeriesBiblesRow;
export type Arc = ArcsRow;
export type LengthProfile = LengthProfilesRow;
export type NotificationPolicy = NotificationPoliciesRow;
export type StoryStructure = StoryStructuresRow;
export type StoryPart = StoryPartsRow;
export type StoryStructureWithParts = StoryStructure & { parts: StoryPart[] };
export type { StructureProposalInput, PartDraft } from "./domain/structure.js";

// ── hooks ────────────────────────────────────────────────────────────────
export interface NovelCreatedContext {
  tx: Tx;
  scope: NovelScope;
  novel: Novel;
  actor: ActorRef;
  ownerUserId: string;
  entryMode: ConceptEntryMode;
  /** pre-allocated `osv_` id: the ontology participant MUST insert schema version 1 with this id */
  schemaVersionId: string;
  /** what each participant's `prepare` returned (read before the transaction), keyed by module */
  prepared: Partial<Record<ModuleName, unknown>>;
  /** participants publish ids for later participants (lower `order` runs first) */
  outputs: {
    mainTimelineId?: string;
    webChannelId?: string;
    budgetPolicyId?: string;
    conceptSessionId?: string;
  };
}

export interface NovelCreationParticipant {
  module: ModuleName;
  /** ontology 10, messaging 20, budget 30, llm 40, concept 50 */
  order: number;
  /**
   * optional read BEFORE the creation transaction (e.g. state that reads through uow.db, which would wait on the open
   * transaction with one PGlite connection); the result is handed in as `ctx.prepared[module]`
   */
  prepare?(): Promise<unknown>;
  onNovelCreated(ctx: NovelCreatedContext): Promise<void>;
}

export interface NovelStatusChangedContext {
  tx: Tx;
  scope: NovelScope;
  from: NovelStatus;
  to: NovelStatus;
  ruleId: string;
  novel: Novel;
  actor: ActorRef;
}

export interface GoalSavedContext {
  tx: Tx;
  scope: NovelScope;
  goal: Goal;
  previous: Goal | null;
  novel: Novel;
  /** true when this save performed N3 (onboarding → planning) */
  enteredPlanning: boolean;
  actor: ActorRef;
}

export type NovelHook<C> = (ctx: C) => Promise<void>;

/**
 * 설계 추가: guard run inside `saveGoal` before the FIRST goal save (N3, onboarding → planning). Throw a
 * `DomainValidationError` to refuse (e.g. cast: the character-setup step must be confirmed first).
 */
export interface GoalGuardContext {
  tx: Tx;
  scope: NovelScope;
  novel: Novel;
  actor: ActorRef;
}
export interface GoalGuard {
  module: ModuleName;
  check(ctx: GoalGuardContext): Promise<void>;
}

/** hitl surface for `ending_change` approvals; wired late because hitl is built after novel */
export type NovelApprovalPort = Pick<import("../hitl/index.js").HitlService, "requestApproval" | "registerApprovalHandler"> &
  Partial<Pick<import("../hitl/index.js").HitlService, "cancelApproval">>;

/** saveGoal result: the stored goal plus a pending ending_change approval when the ending was revised */
export type SavedGoal = Goal & { pendingEndingChange?: { approvalId: string; questionId: string; endingDirection: string } };

// ── inputs ───────────────────────────────────────────────────────────────
export interface CreateNovelInput {
  title?: string;
  ageRating?: AgeRating;
  entryMode?: ConceptEntryMode;
  timezone?: string;
}

export interface NovelSettingsPatch {
  title?: string;
  /** confirm the current (auto/provisional) title as the user's title without changing it */
  confirmTitle?: boolean;
  targetAudience?: string | null;
  questionThreshold?: QuestionThreshold;
  defaultNarrationMode?: NarrationMode;
  timezone?: string;
  possessionModeEnabled?: boolean;
  /** 설계 추가 0011: 인터넷 검색(기본 켬)과 호출 1회당 검색 상한(1~10) */
  webSearchEnabled?: boolean;
  webSearchMaxUses?: number;
  /** 설계 추가 0015: 엔티티 판정 에이전트(기본 켬)와 자동 적용 신뢰도 기준 */
  entityAgentResolution?: boolean;
  entityAgentMinConfidence?: number;
}

export interface ChangeAutonomyInput {
  autonomyLevel: AutonomyLevel;
  publishPolicy?: PublishPolicy;
  acknowledgedFullAutoWarning: boolean;
  /** 설계 추가 0014: required when switching full_auto ON */
  acknowledgedAutoItems?: boolean;
  /** required when concept confirm / structure auto-approval turns on */
  acknowledgedStructureAutoWarning?: boolean;
  /** autopilot settings merged on the switch (AutopilotSettings keys; invalid keys rejected) */
  autopilot?: Record<string, unknown>;
  reason?: string;
}

/** 설계 추가 0014: autopilot settings patch (AutopilotSettings keys) */
export interface AutopilotSettingsPatchInput {
  settings: Record<string, unknown>;
  acknowledgedStructureAutoWarning?: boolean;
}

/** 11 M-01~M-05 fields copied from the approved ConceptBrief (N2 / pre-bible revision). */
export interface ConceptApprovalInput {
  conceptBriefId: string;
  purpose: "initial" | "revision";
  /** brief `title` (user-confirmed) → novels.title, title_source=user */
  title?: string;
  /** brief `title_candidates[]` — M-01 fallback: first candidate when the novel title is still provisional */
  titleCandidates?: string[];
  genre: string;
  ageRating: AgeRating;
  targetAudience?: string | null;
  defaultNarrationMode?: NarrationMode;
  category: Record<string, unknown>;
  approvalId?: string;
}

export interface SaveGoalInput {
  totalEpisodesMin: number;
  totalEpisodesMax: number | null;
  cadenceEpisodesPerWeek: number;
  reserveTargetEpisodes: number;
  endingDirection: string;
  notes: string | null;
  expectedRevision?: number;
}

export interface CreateBibleVersionInput {
  logline: string;
  synopsis: string;
  content: unknown;
  contentMd: string;
  conceptBriefId: string;
}

export interface ArcInput {
  ord: number;
  title: string;
  goalText: string;
  conflictText: string;
  endCondition: string;
  plannedEpisodeFrom: number;
  plannedEpisodeTo: number;
  /** 0008: plot (= arc) of a story part */
  partId?: string | null;
  coreEvent?: string;
  involvedCharacterIds?: string[];
  changeText?: string;
  setupPlan?: ArcSetupPlanJson;
}

export interface StoryPartPatch {
  title?: string;
  goalText?: string;
  turningPoints?: string[];
  plannedEpisodeFrom?: number;
  plannedEpisodeTo?: number;
  characterStates?: Array<{ characterId: string; state: string }>;
  plotOutline?: Array<{ title: string; coreEvent: string; episodeCount: number }>;
}

export interface LengthProfilePatch {
  minChars?: number;
  maxChars?: number;
  countBasis?: CountBasis;
}

export type NotificationPolicyPatch = Partial<
  Pick<
    NotificationPolicy,
    | "quietHoursStart"
    | "quietHoursEnd"
    | "urgentExceptionEnabled"
    | "dailyCapNonBlocking"
    | "digestWindowMinutes"
    | "digestMaxItems"
    | "deadlineHoursBlocking"
    | "deadlineHoursNonBlocking"
    | "reminderOffsetsMinutes"
    | "questionsPaused"
    | "channelPriority"
    | "dailySummaryTime"
  >
>;

// ── service ──────────────────────────────────────────────────────────────
/**
 * Methods taking `tx` run inside the caller's transaction (02 M-2); methods with `tx?` open their
 * own transaction when omitted. All writes record audit events in the same transaction.
 */
export interface NovelService {
  // users (INV-USR-01: local_trusted has exactly one owner)
  ensureOwnerUser(displayName?: string): Promise<User>;
  getOwnerUser(): Promise<User | null>;

  // hooks
  registerCreationParticipant(p: NovelCreationParticipant): void;
  onStatusChanged(hook: NovelHook<NovelStatusChangedContext>): void;
  onGoalSaved(hook: NovelHook<GoalSavedContext>): void;
  /** 설계 추가: pre-N3 guards (cast confirmation) — run in the saveGoal transaction before the first goal insert */
  registerGoalGuard(guard: GoalGuard): void;

  // novel
  /** N1: novel(status=concept) + length profile + notification policy + all creation participants, one transaction */
  createNovel(input: CreateNovelInput, actor: ActorRef): Promise<Novel>;
  exists(novelId: string): Promise<boolean>;
  getNovel(scope: NovelScope, tx?: Tx): Promise<Novel>;
  listNovels(opts?: { includeArchived?: boolean }): Promise<Novel[]>;
  updateSettings(scope: NovelScope, patch: NovelSettingsPatch, actor: ActorRef, tx?: Tx): Promise<Novel>;
  changeAutonomy(scope: NovelScope, input: ChangeAutonomyInput, actor: ActorRef): Promise<Novel>;
  // ── 설계 추가 0014: 완전 자율(autopilot) 설정·킬 스위치·상태 ──
  /** merged settings (`autopilot.settings_changed`); turning concept/structure auto-approval on needs the warning ack */
  updateAutopilotSettings(scope: NovelScope, input: AutopilotSettingsPatchInput, actor: ActorRef): Promise<Novel>;
  /** kill switch: every auto decision / auto answer / auto step stops (`autopilot.halted`); idempotent */
  haltAutopilot(scope: NovelScope, reason: import("@ncs/shared").AutopilotHaltReason, actor: ActorRef, opts?: { tx?: Tx; note?: string }): Promise<Novel>;
  resumeAutopilot(scope: NovelScope, actor: ActorRef, opts?: { note?: string }): Promise<Novel>;
  /** system bookkeeping of the autopilot loop (no audit, updatedAt untouched): shallow merge, `null` deletes a key */
  setAutopilotState(scope: NovelScope, patch: Record<string, unknown>, tx?: Tx): Promise<void>;
  /** row lock (FOR UPDATE) of the novel in the caller's transaction — serializes auto decisions with level changes */
  lockNovel(tx: Tx, scope: NovelScope): Promise<Novel>;
  /** sets paused_at/pause_reason (INV-NOV-03 is enforced by orchestration when leasing) */
  pause(scope: NovelScope, reason: PauseReason, actor: ActorRef, opts?: { tx?: Tx; note?: string }): Promise<Novel>;
  resume(scope: NovelScope, actor: ActorRef, opts?: { tx?: Tx; note?: string }): Promise<Novel>;
  /** generic guarded transition (N4–N6); N2 via applyConceptApproval, N3 via saveGoal */
  transitionStatus(tx: Tx, scope: NovelScope, to: NovelStatus, actor: ActorRef, reason?: string): Promise<Novel>;
  /** N2 (purpose=initial, concept → onboarding) or pre-bible revision (11 3.10) — called by concept in the approval tx */
  applyConceptApproval(tx: Tx, scope: NovelScope, input: ConceptApprovalInput, actor: ActorRef): Promise<Novel>;
  /**
   * Working title from the concept conversation (설계 추가). Applied only while `title_source` is not `user`
   * (a user-set title is never overwritten); sets `title_source=auto` and audits `novel.settings_changed`.
   * `source: "user"` is used when the user stated the title in the conversation.
   */
  applyWorkingTitle(tx: Tx, scope: NovelScope, input: { title: string; source: "auto" | "user"; reason?: string }, actor: ActorRef): Promise<{ novel: Novel; applied: boolean }>;
  /** display numbers T-12, CI-3, S-01 … (00 §5.2) */
  nextDisplayNo(tx: Tx, scope: NovelScope, kind: NovelCounterKind): Promise<number>;

  // goal
  getGoal(scope: NovelScope, tx?: Tx): Promise<Goal | null>;
  /**
   * create (N3 when onboarding) or revise (revision+1, optimistic check). After the first save a new
   * `endingDirection` is not applied directly: an `ending_change` approval is requested (03 Goal, 05 §10)
   * and the value is applied when it is approved; the other fields are saved at once.
   */
  saveGoal(scope: NovelScope, input: SaveGoalInput, actor: ActorRef): Promise<SavedGoal>;
  /** composition: `novel.service.connectApprovals(hitl.service)` after hitl is built (registers `ending_change`) */
  connectApprovals(port: NovelApprovalPort): void;

  // series bible
  createBibleVersion(tx: Tx, scope: NovelScope, input: CreateBibleVersionInput, actor: ActorRef): Promise<SeriesBible>;
  /** draft→awaiting_approval (approvalId), awaiting_approval→approved (supersedes previous approved), →draft, →superseded */
  transitionBible(
    tx: Tx,
    scope: NovelScope,
    bibleId: string,
    to: SeriesBible["status"],
    actor: ActorRef,
    opts?: { approvalId?: string; reason?: string },
  ): Promise<SeriesBible>;
  getBible(scope: NovelScope, bibleId: string, tx?: Tx): Promise<SeriesBible>;
  getApprovedBible(scope: NovelScope, tx?: Tx): Promise<SeriesBible | null>;
  listBibles(scope: NovelScope, tx?: Tx): Promise<SeriesBible[]>;

  // arcs
  createArc(tx: Tx | undefined, scope: NovelScope, input: ArcInput, actor: ActorRef): Promise<Arc>;
  updateArc(scope: NovelScope, arcId: string, patch: Partial<ArcInput>, actor: ActorRef, tx?: Tx): Promise<Arc>;
  transitionArc(
    tx: Tx,
    scope: NovelScope,
    arcId: string,
    to: ArcStatus,
    actor: ActorRef,
    opts?: { planApprovalId?: string; arcApprovalId?: string; reason?: string },
  ): Promise<Arc>;
  setArcPaused(scope: NovelScope, arcId: string, paused: boolean, actor: ActorRef, tx?: Tx): Promise<Arc>;
  getArc(scope: NovelScope, arcId: string, tx?: Tx): Promise<Arc>;
  listArcs(scope: NovelScope, tx?: Tx): Promise<Arc[]>;
  /** arc whose planned range contains the episode (non-cancelled) */
  findArcForEpisode(scope: NovelScope, episodeNo: number, tx?: Tx): Promise<Arc | null>;

  // length profile & notification policy
  getLengthProfile(scope: NovelScope, tx?: Tx): Promise<LengthProfile>;
  listLengthPresets(): Promise<LengthProfile[]>;
  /** edits a novel-owned copy (clones the install preset on first edit) */
  updateLengthProfile(scope: NovelScope, patch: LengthProfilePatch, actor: ActorRef): Promise<LengthProfile>;
  getNotificationPolicy(scope: NovelScope, tx?: Tx): Promise<NotificationPolicy>;
  updateNotificationPolicy(scope: NovelScope, patch: NotificationPolicyPatch, actor: ActorRef): Promise<NotificationPolicy>;

  // ── 설계 추가: 전체 구성(1~4부 + 결말), plots = arcs (0008) ──
  getStructure(scope: NovelScope, tx?: Tx): Promise<StoryStructureWithParts | null>;
  /**
   * agent write (plan_structure commit): creates the structure (4 parts) or merges the proposal keeping `user` fields.
   * An approved structure goes back to draft (ST4, pending.regenerated + changed parts / ending); an awaiting one ST5.
   */
  saveStructureProposal(tx: Tx, scope: NovelScope, input: import("./domain/structure.js").StructureProposalInput, actor: ActorRef): Promise<StoryStructureWithParts>;
  /** user edit (origin user); approved → ST4, awaiting → ST5 (+ pending approval cancelled) */
  updateStructureEnding(scope: NovelScope, patch: Partial<StoryEnding>, expectedRevision: number, actor: ActorRef): Promise<StoryStructureWithParts>;
  updateStoryPart(scope: NovelScope, partId: string, patch: StoryPartPatch, expectedRevision: number, actor: ActorRef): Promise<StoryStructureWithParts>;
  transitionStructure(tx: Tx, scope: NovelScope, to: StoryStructureStatus, actor: ActorRef, opts?: { approvalId?: string; reason?: string; ruleId?: string }): Promise<StoryStructure>;
  /** goal ending_change etc.: approved/awaiting → draft with pending changes merged (no-op without a structure) */
  reopenStructure(tx: Tx, scope: NovelScope, change: StructurePendingChanges, actor: ActorRef, reason: string): Promise<void>;
  /** structure revision+1 & first appearances (plan_structure / approval bookkeeping) */
  setStructureFirstAppearances(tx: Tx, scope: NovelScope, items: Array<{ characterId: string; episodeNo: number }>): Promise<void>;
  /** empty array = clear (`arc.plan_flags_cleared`) */
  setArcPlanFlags(tx: Tx, scope: NovelScope, arcId: string, flags: ArcPlanFlag[], actor: ActorRef): Promise<Arc>;
}

export type { NovelModuleDeps } from "./module.js";
export { createNovelModule } from "./module.js";
export { NOVEL_TRANSITIONS, ARC_TRANSITIONS, SERIES_BIBLE_TRANSITIONS } from "./domain/transitions.js";
export {
  STRUCTURE_TRANSITIONS,
  normalizeStructure,
  structureCompleteness,
  structureTotal,
  toStoryStructureDto,
  validatePartRanges,
  distribute,
  mergeAgentFields,
} from "./domain/structure.js";
