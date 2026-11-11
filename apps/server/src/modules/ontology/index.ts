/**
 * ontology — public API (design/06 entire; 03 §5; ADR-005/006/007; 04 §9.8).
 * Owns: ontology_schema_versions, timelines, entities, entity_names, narrative_frames, mentions,
 * facts, fact_versions, fact_cardinality_slots, schema_change_proposals, glossary_terms,
 * identity_decisions, identity_decision_moves, entity_distinct_pairs.
 *
 * `OntologyRepository` (06 §11.4) is the ONLY path to these tables for every other module
 * (08 §3.2 `ontology-port`): linking, continuity, foreshadow, agents (context), hitl (answer apply),
 * manuscript (promotion on E9/E13/E14). Read methods take `NovelScope` first; writes take `tx` first.
 * Story time: `storyPoint = episodeNo*1000 + sceneOrd` (00 §5.5); ranges are half-open [from,to).
 */
import type {
  CanonStatus,
  FactChangeReason,
  EntityStatus,
  EntityType,
  FactKind,
  FactSourceKind,
  KnowledgeStance,
  LinkStatus,
  MentionKind,
  MentionSourceKind,
  NameKind,
  NameVisibility,
  RefType,
} from "@ncs/shared";
import type {
  EntitiesRow,
  EntityNamesRow,
  FactsRow,
  FactVersionsRow,
  IdentityDecisionsRow,
  MentionsRow,
  OntologySchemaVersionsRow,
  TimelinesRow,
} from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { OntologySchemaData } from "./domain/base-schema.js";

export type { OntologySchemaData, RelationTypeDef, AttributeDef, EntityTypeDef } from "./domain/base-schema.js";
export { BASE_SCHEMA_V1, lookupPredicate, mapPredicateLabel } from "./domain/base-schema.js";
export { normalizedKey, jamoKey, translitKey, editDistance, syllableCount } from "./domain/normalize.js";

export type Entity = EntitiesRow;
export type EntityName = EntityNamesRow;
export type Fact = FactsRow;
export type FactVersion = FactVersionsRow;
export type Mention = MentionsRow;
export type Timeline = TimelinesRow;
export type OntologySchemaVersion = OntologySchemaVersionsRow;
export type IdentityDecision = IdentityDecisionsRow;

/** 04 §9.8 */
export interface StoryAnchor {
  storyPoint: number;
  timelineId: string;
  povEntityId?: string;
}
export type Viewer = string | "narrator" | "reader";

export interface StoryRangeInput {
  from: number;
  /** exclusive; null = open-ended */
  to: number | null;
}

export interface FactAtAnchor {
  factId: string;
  factVersionId: string;
  canonStatus: CanonStatus;
  factKind: FactKind;
  predicate: string;
  subjectEntityId: string;
  objectEntityId?: string | null;
  value?: unknown;
  /** rendered sentence for prompts/UI */
  text: string;
  storyRange: StoryRangeInput;
  timelineId: string;
}

/** 설계 추가(수정 반영): a live fact extracted from an episode (listEpisodeFacts) */
export interface EpisodeFact extends FactAtAnchor {
  mentionIds: string[];
  sourceRefType: string;
  sourceRefId: string;
  conflictWith: string | null;
  supersedes: string | null;
  /** waits for a canon_change / retcon approval of a text-edit change (not promoted meanwhile) */
  reconcilePending: boolean;
  /** the author rejected a text-edit change of this fact (kept the old setting) */
  reconcileKeptBy: { approvalId: string; rejectedNewText: string | null } | null;
}

/** 설계 추가(미확정 사실 선행 집필): a fact version a run read, and what became of it (factVersionUsage) */
export interface FactVersionUsage {
  factVersionId: string;
  factId: string;
  /** episode the version was extracted from (content.episodeId) */
  episodeId: string | null;
  /** the fact's canon status now */
  canonStatus: CanonStatus;
  /** the version is still the fact's current one */
  isCurrent: boolean;
  /** the fact's current version now (the latest one, also for a retired fact) */
  currentVersionId: string | null;
  /** the fact is no longer live, or its current version says something else than this one */
  changed: boolean;
}

/** one fact to retire after a text edit, optionally replaced by a newer fact of the new text */
export interface FactRetirement {
  factId: string;
  supersededByFactId?: string | null;
  details?: Record<string, unknown>;
}

export interface EntityCard {
  entityId: string;
  /** handle used in prompts (E1, E2 … — 04 §9.6), assigned by agents.ContextBuilder */
  displayName: string;
  entityType: EntityType;
  disambiguator: string | null;
  usableNames: Array<{ nameId: string; surface: string; nameKind: NameKind }>;
  facts: FactAtAnchor[];
  notes: string[];
}

export interface NameCandidate {
  entityId: string;
  nameId: string;
  surface: string;
  nameKind: NameKind;
  matchKind: "exact" | "normalized" | "jamo" | "translit" | "trigram";
  score: number;
}

/** extraction / answer → candidate fact (06 §6.6, 07 §4.3) */
export interface CandidateFactDraft {
  factKind: FactKind;
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string | null;
  objectNameId?: string | null;
  value?: unknown;
  knowledgeStance?: KnowledgeStance | null;
  isNegation?: boolean;
  isSecret?: boolean;
  readerRevealPoint?: number | null;
  timelineId: string;
  storyRange: StoryRangeInput;
  sourceKind: FactSourceKind;
  source: { refType: RefType; refId: string };
  sourceSceneId?: string | null;
  mentionIds?: string[];
  /** starts as `candidate` unless the caller is the bible-approval path */
  canonStatus?: CanonStatus;
  // ── widened (A3) ──
  objectFactId?: string | null;
  /** role → mention id (06 §6.1 `content.arg_mentions`); NULL role + mention = link-held fact (INV-ONT-08) */
  argMentions?: { subject?: string | null; object?: string | null };
  /** episode the fact was extracted from (promoteEpisodeFacts key; stored in fact_versions.content) */
  episodeId?: string | null;
  /** series bible the fact came from (approveBibleFacts key, INV-BIB-03) */
  seriesBibleId?: string | null;
  observedAsNameId?: string | null;
  narrativeFrameId?: string | null;
  runId?: string | null;
}

export interface CandidateFactResult {
  written: Array<{ factId: string; factVersionId: string; diffKind: "new" | "duplicate" | "transition" | "conflict" }>;
  rejected: Array<{ index: number; reason: string }>;
}

export interface MentionDraft {
  sourceKind: MentionSourceKind;
  manuscriptVersionId?: string | null;
  sceneId?: string | null;
  charStart?: number | null;
  charEnd?: number | null;
  answerId?: string | null;
  storyPoint: number;
  timelineId: string;
  surface: string;
  mentionKind: MentionKind;
  speakerEntityId?: string | null;
  povEntityId?: string | null;
  candidates: Array<{ entityId: string; score: number; via?: string }>;
  linkedEntityId?: string | null;
  viaNameId?: string | null;
  confidence: number;
  rationale?: string | null;
  linkStatus: LinkStatus;
  linkerVersion: string;
  runId?: string | null;
  // ── widened (A3) ──
  chainKey?: string | null;
  viaEntityId?: string | null;
  narrativeFrameId?: string | null;
  questionId?: string | null;
}

export interface EntityListFilter {
  entityTypes?: EntityType[];
  statuses?: EntityStatus[];
  q?: string;
  limit?: number;
}

export interface EntityListItem {
  entity: Entity;
  preferredName: string;
  appearanceEpisodeCount: number;
  unresolvedMentionCount: number;
}

export interface EntityDetail {
  entity: Entity;
  names: EntityName[];
  appearances: Array<{ episodeNo: number; sceneId: string }>;
  titleHolders: Array<{ entityId: string; storyRange: StoryRangeInput }>;
  factsSummary: FactAtAnchor[];
  identityDecisions: IdentityDecision[];
}

export interface CreateEntityInput {
  entityType: EntityType;
  preferredName: { surface: string; nameKind?: NameKind; visibility?: NameVisibility };
  disambiguator?: string | null;
  summary?: string | null;
  createdFromMentionId?: string | null;
  status?: "candidate" | "active";
  // ── widened (A3) ──
  /** provenance of the preferred name (default: user_input / entity itself) */
  source?: { kind: FactSourceKind; refType: RefType; refId: string };
  conceptCharacterKey?: string | null;
  /** extra names registered with the entity */
  names?: AddEntityNameInput[];
}

/** widened (A3): full name input for addEntityName */
export interface AddEntityNameInput {
  surface: string;
  nameKind: NameKind;
  storyRange?: StoryRangeInput;
  timelineId?: string | null;
  status?: "proposed" | "active";
  surfaceVisibility?: NameVisibility;
  surfaceKnownByEntityIds?: string[];
  identityVisibility?: NameVisibility;
  identityKnownByEntityIds?: string[];
  usedByCondition?: unknown;
  readerRevealPoint?: number | null;
  source?: { kind: FactSourceKind; refType: RefType; refId: string };
}

export interface IdentityImpact {
  mentions: number;
  facts: number;
  /** widened (A3): facts by canon status (published_locked > 0 → identity_change approval, FR-ONT-16) */
  factsByStatus?: Partial<Record<CanonStatus, number>>;
  names?: number;
  setupLinks: number;
  sceneParticipants: number;
  slotConflicts: Array<{ slotKey: string; factIds: string[] }>;
}

export interface SchemaViolation {
  factId: string;
  rule: string;
  message: string;
  // ── widened (A3): enough for continuity to open `schema_violation` issues ──
  crRule?: "CR-05" | "CR-09" | "CR-10" | "CR-11";
  /** continuity_issue_evidence.schema_rule_key, e.g. `base@1:spouse_of:max_per_subject` */
  schemaRuleKey?: string;
  severity?: "high" | "medium" | "low";
  relatedFactIds?: string[];
}

/** widened (A3) */
export interface MentionDecision {
  kind: "entity" | "not_entity";
  /** required for kind=entity */
  entityId?: string;
}

export interface ProposeIdentityInput {
  kind: IdentityDecision["kind"];
  entityIds: string[];
  mentionIds?: string[];
  rationale: string;
  // ── widened (A3) ──
  /** merge survivor (default entityIds[0]) */
  survivorEntityId?: string;
  /** relink target (mentions move from entityIds[0] to this entity) */
  relinkToEntityId?: string;
  /** split: which references move to the new entity */
  split?: { factIds?: string[]; nameIds?: string[]; newEntity: { entityType?: EntityType; preferredName: string } };
  evidence?: Record<string, unknown>;
  questionId?: string | null;
  approvalId?: string | null;
}

export interface IntegrityProblem {
  rule: string;
  message: string;
  refs: string[];
}

/** 설계 추가(화 삭제): the episode whose generated manuscript is being deleted */
export interface ManuscriptPurgeInput {
  episodeId: string;
  /** every manuscript version of the episode */
  versionIds: string[];
  /** every scene of those versions (the caller deletes them after the purge) */
  sceneIds: string[];
}
export interface ManuscriptPurgePreview {
  /** live facts the episode produced, by canon status */
  facts: { candidate: number; approved: number; publishedLocked: number };
  mentionCount: number;
  /** candidate entities created from this text with no other evidence (retired by the purge) */
  entityRetireCount: number;
}
export interface ManuscriptPurgeResult {
  factsRejected: number;
  factsRetracted: number;
  /** facts of other episodes whose evidence list lost this episode's mentions */
  otherFactsPruned: number;
  /** facts of other episodes retired because this text was their only evidence */
  otherFactsRetired: number;
  mentions: number;
  entitiesRetired: number;
  namesDeleted: number;
  frames: number;
  /** open questions (mention links) that referred to the removed mentions — the caller cancels them */
  questionIds: string[];
}

export interface OntologySchemaInfo {
  version: OntologySchemaVersion;
  /** compiled base + extension (06 §4.1) */
  schema: OntologySchemaData;
}

/** 06 §11.4 port — owned and implemented by the ontology module (PgOntologyRepository). */
export interface OntologyRepository {
  resolveEntityId(scope: NovelScope, id: string, tx?: Tx): Promise<string>;
  resolveEntityIds(scope: NovelScope, ids: string[], tx?: Tx): Promise<Map<string, string>>;
  findNameCandidates(scope: NovelScope, key: string, storyPoint: number, timelineId: string, opts?: { relaxed?: boolean }): Promise<NameCandidate[]>;
  getTitleHolders(scope: NovelScope, titleEntityId: string, timelineId: string, storyPoint?: number): Promise<Array<{ entityId: string; storyRange: StoryRangeInput }>>;
  getCanonAt(scope: NovelScope, entityIds: string[], storyPoint: number, timelineId: string, opts?: { include?: "canon" | "canon_and_safe_candidates" }, tx?: Tx): Promise<FactAtAnchor[]>;
  knowledgeOf(scope: NovelScope, viewer: Viewer, storyPoint: number, timelineId: string): Promise<FactAtAnchor[]>;
  nameValidAt(scope: NovelScope, nameId: string, storyPoint: number, timelineId: string): Promise<boolean>;
  surfaceKnownBy(scope: NovelScope, nameId: string, viewer: Viewer, storyPoint: number): Promise<boolean>;
  identityKnownBy(scope: NovelScope, nameId: string, viewer: Viewer, storyPoint: number): Promise<boolean>;
  nameUsableBy(scope: NovelScope, nameId: string, viewer: Viewer, anchor: StoryAnchor): Promise<boolean>;
  getEntityCards(scope: NovelScope, entityIds: string[], anchor: StoryAnchor, layer: "canon" | "reader" | "pov"): Promise<EntityCard[]>;
  getConstraints(scope: NovelScope, q: { entityIds: string[]; answerIds: string[]; anchor: StoryAnchor }): Promise<FactAtAnchor[]>;
  listEntities(scope: NovelScope, filter?: EntityListFilter, tx?: Tx): Promise<EntityListItem[]>;
  getEntityDetail(scope: NovelScope, entityId: string): Promise<EntityDetail>;
  listMentions(
    scope: NovelScope,
    q: { entityId?: string; linkStatus?: LinkStatus[]; manuscriptVersionId?: string; limit?: number; questionId?: string; ids?: string[]; sourceKinds?: MentionSourceKind[] },
    tx?: Tx,
  ): Promise<Mention[]>;
  writeCandidateFacts(tx: Tx, scope: NovelScope, drafts: CandidateFactDraft[], actor: ActorRef): Promise<CandidateFactResult>;
  /** user-sourced withdrawal: canon → retracted (F9), candidate → rejected (F4), slots released; returns changed ids */
  withdrawFacts(tx: Tx, scope: NovelScope, factIds: string[], actor: ActorRef, reason: string): Promise<string[]>;
  /** 06 §6.4: episode-sourced facts candidate→approved (E9), approved→published_locked (E13), reverse (E14) */
  promoteEpisodeFacts(tx: Tx, scope: NovelScope, episodeId: string, to: "approved" | "published_locked", actor: ActorRef): Promise<{ promoted: number; held: string[] }>;
  demoteEpisodeFacts(tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef): Promise<{ demoted: number }>;
  /** 설계 추가(수정 반영): live facts extracted from the episode (current content.episodeId) + evidence mentions */
  listEpisodeFacts(scope: NovelScope, episodeId: string, tx?: Tx): Promise<EpisodeFact[]>;
  /** 설계 추가(미확정 사실 선행 집필): fact versions recorded in context snapshots → source episode + changed since */
  factVersionUsage(scope: NovelScope, factVersionIds: string[], tx?: Tx): Promise<FactVersionUsage[]>;
  /** canon → retracted / candidate → rejected with an optional successor link (fact.superseded / fact.retracted) */
  retireFacts(
    tx: Tx,
    scope: NovelScope,
    changes: FactRetirement[],
    actor: ActorRef,
    opts: { changeReason: FactChangeReason; approvalId?: string | null; reason: string; details?: Record<string, unknown> },
  ): Promise<string[]>;
  /** drop evidence mentions that point at older manuscript versions (re-point to the new text) */
  pruneFactMentions(tx: Tx, scope: NovelScope, factIds: string[], dropVersionIds: string[]): Promise<number>;
  /** hold / release candidates while a canon change of the same edit waits for approval */
  setFactReconcileHold(tx: Tx, scope: NovelScope, factIds: string[], pending: boolean, actor: ActorRef): Promise<number>;
  /** the author rejected the text-edit change of these canon facts: remember it (history appended) */
  markFactsKeptByDecision(tx: Tx, scope: NovelScope, marks: Array<{ factId: string; rejectedNewText: string | null }>, approvalId: string, actor: ActorRef): Promise<number>;
  /** bible approval (INV-BIB-03): series_bible + build_initial_ontology facts → approved */
  approveBibleFacts(tx: Tx, scope: NovelScope, seriesBibleId: string, actor: ActorRef): Promise<{ approved: number }>;
  computeIdentityImpact(scope: NovelScope, entityIds: string[], tx?: Tx): Promise<IdentityImpact>;
  computeRelinkImpact(scope: NovelScope, mentionIds: string[], toEntityId: string, tx?: Tx): Promise<IdentityImpact>;
  applyIdentityDecision(tx: Tx, scope: NovelScope, decisionId: string, actor: ActorRef): Promise<IdentityDecision>;
  revertIdentityDecision(tx: Tx, scope: NovelScope, decisionId: string, actor: ActorRef): Promise<IdentityDecision>;
  findDuplicateCandidates(scope: NovelScope, entityId?: string, tx?: Tx): Promise<Array<{ entityIds: [string, string]; score: number; reason: string }>>;
  writeMentions(tx: Tx, scope: NovelScope, mentions: MentionDraft[], actor: ActorRef): Promise<{ mentionIds: string[] }>;
  findSchemaViolations(scope: NovelScope, factIds?: string[]): Promise<SchemaViolation[]>;
  findIdentityLeaks(scope: NovelScope, manuscriptVersionId: string): Promise<Array<{ mentionId: string; nameId: string; viewer: Viewer; message: string }>>;
  getSetupLinkedFacts(scope: NovelScope, factIds: string[]): Promise<FactAtAnchor[]>;
  getCanonAsRecorded(scope: NovelScope, entityIds: string[], storyPoint: number, timelineId: string, recordedAt: Date): Promise<FactAtAnchor[]>;
}

export interface OntologyService extends OntologyRepository {
  /** N1 participant body: schema version 1 (`base@1`, id = ctx.schemaVersionId) + default main timeline — already implemented */
  initializeNovel(tx: Tx, scope: NovelScope, schemaVersionId: string): Promise<{ schemaVersionId: string; mainTimelineId: string }>;
  getDefaultTimeline(scope: NovelScope, tx?: Tx): Promise<Timeline>;
  listTimelines(scope: NovelScope): Promise<Timeline[]>;
  getActiveSchemaVersion(scope: NovelScope): Promise<OntologySchemaVersion>;
  createEntity(tx: Tx, scope: NovelScope, input: CreateEntityInput, actor: ActorRef): Promise<{ entity: Entity; preferredName: EntityName }>;
  addEntityName(tx: Tx, scope: NovelScope, entityId: string, name: AddEntityNameInput, actor: ActorRef): Promise<EntityName>;
  /** make an active name the entity's preferred (대표) name */
  setPreferredName(tx: Tx, scope: NovelScope, entityId: string, nameId: string, actor: ActorRef): Promise<EntityName>;
  /** name status (NM3/NM4/RL-2); the preferred name cannot be retired */
  setEntityNameStatus(tx: Tx, scope: NovelScope, nameId: string, to: "proposed" | "active" | "retired", actor: ActorRef): Promise<EntityName>;
  setEntityStatus(tx: Tx, scope: NovelScope, entityId: string, to: EntityStatus, actor: ActorRef, reason?: string): Promise<Entity>;
  /** propose merge/split/confirm_distinct/relink (identity.proposed) — applied via applyIdentityDecision */
  proposeIdentityDecision(tx: Tx, scope: NovelScope, input: ProposeIdentityInput, actor: ActorRef): Promise<IdentityDecision>;

  // ── widened (A3) ──────────────────────────────────────────────────────
  getSchema(scope: NovelScope, tx?: Tx): Promise<OntologySchemaInfo>;
  /** resolves merged ids; `redirectedFrom` is set when `entityId` was merged */
  getEntity(scope: NovelScope, entityId: string, tx?: Tx): Promise<Entity & { redirectedFrom: string | null }>;
  getEntities(scope: NovelScope, entityIds: string[], tx?: Tx): Promise<Entity[]>;
  listEntityNames(scope: NovelScope, entityId: string, tx?: Tx): Promise<EntityName[]>;
  /** entity_distinct_pairs touching the given entities (L3 / dedupe) */
  listDistinctPairs(scope: NovelScope, entityIds: string[], tx?: Tx): Promise<Array<[string, string]>>;
  /** MN5 / MN6 + LB-3 (resolution_filled / F4) for facts citing the mention */
  decideMention(
    tx: Tx,
    scope: NovelScope,
    mentionId: string,
    decision: MentionDecision,
    actor: ActorRef,
    ctx?: { questionId?: string; answerId?: string },
  ): Promise<{ mention: Mention; filledFactIds: string[]; rejectedFactIds: string[] }>;
  setMentionQuestion(tx: Tx, scope: NovelScope, mentionIds: string[], questionId: string): Promise<void>;
  /**
   * EN3(b) equivalence check result (06 §3.1). 설계 추가(world): "review" = a world ontology candidate waiting for the
   * author (only the world review or a bible approval that names it activates it), "rejected" = the author rejected it
   * in the world review (no promotion path activates it).
   */
  setEquivalenceCheck(
    tx: Tx,
    scope: NovelScope,
    entityId: string,
    check: { status: "passed" | "failed" | "question" | "review" | "rejected"; duplicateOf?: string | null; questionId?: string | null; votes?: unknown; source?: string; taskId?: string; seriesBibleId?: string },
  ): Promise<void>;
  getIdentityDecision(scope: NovelScope, decisionId: string, tx?: Tx): Promise<IdentityDecision>;
  listIdentityDecisions(scope: NovelScope, q?: { entityId?: string; statuses?: IdentityDecision["status"][] }, tx?: Tx): Promise<IdentityDecision[]>;
  /** ID3 */
  rejectIdentityDecision(tx: Tx, scope: NovelScope, decisionId: string, actor: ActorRef, reason?: string): Promise<IdentityDecision>;
  setIdentityDecisionRefs(tx: Tx, scope: NovelScope, decisionId: string, refs: { questionId?: string | null; approvalId?: string | null }): Promise<void>;
  /** SP1 (06 §4.5): schema-external predicate → proposal (examples appended to an open proposal of the same label) */
  proposeSchemaChange(
    tx: Tx,
    scope: NovelScope,
    input: { label: string; examples: unknown[]; similarKeys?: Array<{ key: string; score: number; reason: string }> },
    actor: ActorRef,
  ): Promise<{ proposalId: string; created: boolean }>;
  /** `ontology_integrity` health check body (INV-ONT-02/05/07/09) */
  checkIntegrity(scope: NovelScope): Promise<IntegrityProblem[]>;

  // ── 설계 추가 (world: 세계관 온톨로지 후보 검토) ──
  /** summary / disambiguator edit (audit entity.updated) */
  updateEntity(tx: Tx, scope: NovelScope, entityId: string, patch: { summary?: string | null; disambiguator?: string | null }, actor: ActorRef): Promise<Entity>;
  /** value edit of a candidate fact (new FactVersion, user_edit); 409 fact_not_candidate otherwise */
  reviseCandidateFact(tx: Tx, scope: NovelScope, factId: string, patch: { value: unknown }, actor: ActorRef): Promise<Fact>;
  /** F3 for the given candidate facts (06 §6.4 gate: active entities, schema, slots); unpromotable ones stay candidate in `held` */
  approveCandidateFacts(tx: Tx, scope: NovelScope, factIds: string[], actor: ActorRef): Promise<{ promoted: number; held: string[]; heldReasons: Record<string, string> }>;
  /** facts by id (any status) rendered like getCanonAt */
  getFactsByIds(scope: NovelScope, factIds: string[], tx?: Tx): Promise<FactAtAnchor[]>;

  // ── 설계 추가 0015 (linking: 엔티티 판정 에이전트 메모리) ──
  /** remember a surface as "not an entity" (glossary_terms category non_entity; idempotent per normalized key) */
  recordNonEntitySurface(tx: Tx, scope: NovelScope, surface: string, actor: ActorRef, note?: string): Promise<{ termId: string; created: boolean } | null>;
  /** normalized keys remembered as not an entity */
  listNonEntitySurfaces(scope: NovelScope, tx?: Tx): Promise<string[]>;
  /** live entities with a (non-retired, non-hidden) name of exactly this normalized key — readable inside a commit */
  findExactNamedEntities(scope: NovelScope, surface: string, opts?: { entityType?: string }, tx?: Tx): Promise<Array<{ entityId: string; entityType: string; status: string; nameId: string }>>;

  // ── 설계 추가(화 삭제) ──
  /** read-only: what `purgeManuscriptVersions` would do */
  previewManuscriptPurge(scope: NovelScope, input: Pick<ManuscriptPurgeInput, "episodeId" | "versionIds">, tx?: Tx): Promise<ManuscriptPurgePreview>;
  /**
   * the episode's facts → rejected / retracted (change_reason episode_deleted, history kept), other facts lose the
   * evidence mentions of this text (retired when nothing else supports them), mentions / narrative frames / unused
   * extracted names deleted, candidate entities with no evidence left → retired (EN5). Scene / version rows are the
   * caller's (facts' scene anchors are cleared here). Active entities are never touched.
   */
  purgeManuscriptVersions(tx: Tx, scope: NovelScope, input: ManuscriptPurgeInput, actor: ActorRef, opts: { reason: string }): Promise<ManuscriptPurgeResult>;
}

export type { OntologyModuleDeps } from "./module.js";
export { createOntologyModule } from "./module.js";
