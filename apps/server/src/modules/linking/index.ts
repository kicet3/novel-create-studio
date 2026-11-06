/**
 * linking — public API (design/06 §2.2, §3.4–3.10, §12; 07 §4).
 * Owns NO tables (Mention domain + linker L0–L8 logic). Mentions are stored through
 * `ontology.writeMentions` (08 §2.3 / `ontology-port`).
 *
 * Registers task kinds: `extract_facts`, `link_mentions`, `dedupe_entities`, `build_initial_ontology`
 * (via agents.defineAgentTask). Exposes decision APIs used by hitl when a disambiguation question is
 * answered (05 §2.1, §3.6).
 */
import type { MentionKind, MentionSourceKind, NarrationMode } from "@ncs/shared";
import type { NovelScope, ActorRef, Tx } from "../../platform/index.js";
import type { MentionDraft, StoryAnchor } from "../ontology/index.js";
import type { RunHandle } from "../orchestration/index.js";

export interface LinkerInputMention {
  surface: string;
  charStart: number;
  charEnd: number;
  sceneId: string;
  storyPoint: number;
  /** writer annotation hint (07 §4.2) */
  hintEntityId?: string | null;
  speakerEntityId?: string | null;
  // ── widened (A3) ──
  /** default `named` */
  mentionKind?: MentionKind;
  chainKey?: string | null;
  povEntityId?: string | null;
  /** extraction-local key (facts reference mentions by it) */
  localKey?: string;
  entityTypeHint?: string | null;
  /** scene participants (manuscript) — L2 3rd pass / L3 "씬 미등장" */
  sceneParticipantEntityIds?: string[];
  excerpt?: string;
}

/** widened (A3): scene text provided by manuscript (registry, CONVENTIONS §6) */
export interface SceneText {
  sceneId: string;
  sceneOrd: number;
  /** episode_no*1000 + scene_ord */
  storyPoint: number;
  timelineId: string;
  /** scene text; mention offsets inside it are local */
  text: string;
  /** offset of the scene inside manuscript_versions.content (stored char_start = charOffset + local) */
  charOffset: number;
  povEntityId?: string | null;
  narrationMode?: NarrationMode | null;
  participantEntityIds?: string[];
}

export interface SceneSource {
  /** scenes of a manuscript version (active scenes in order) */
  getScenes(scope: NovelScope, input: { episodeId: string; manuscriptVersionId: string }): Promise<SceneText[]>;
}

export interface LinkerResult {
  mentions: MentionDraft[];
  /** surfaces that need a disambiguation / new-entity question (06 §3.10) */
  questionsNeeded: Array<{ mentionIndex: number; reason: "ambiguous" | "new_entity_candidate" | "duplicate_candidate" }>;
  linkerVersion: string;
  // ── widened (A3) ──
  /** L5 NIL: candidate entities to create in the commit (mention gets linked to it, `new_entity_candidate`) */
  newEntities?: Array<{ mentionIndex: number; entityType: string; surface: string }>;
  /** `localKey` → mention index */
  localKeys?: Record<string, number>;
  /** report-hold mention indexes (리포트 보류, no question) */
  reportHold?: number[];
}

/** widened (A3): what commitLinkerResult wrote */
export interface LinkerCommitResult {
  mentionIds: string[];
  /** local key → mention id / linked entity (null when ambiguous) */
  byLocalKey: Record<string, { mentionId: string; entityId: string | null; status: string; viaNameId: string | null }>;
  createdEntityIds: string[];
  questionIds: string[];
  identityDecisionIds: string[];
}

/** Choice options for an entity-disambiguation question (05 §3.6.2). */
export interface DisambiguationOptions {
  mentionId: string;
  surface: string;
  excerpt: string;
  options: Array<{ label: string; value: { kind: "entity"; entityId: string } | { kind: "new_entity" } | { kind: "not_entity" } }>;
}

export interface LinkingService {
  /** deterministic L0–L3 + L5–L8; L4 (LLM) only when `run` is given (06 §3.8) */
  linkMentions(
    scope: NovelScope,
    input: { manuscriptVersionId: string | null; anchor: StoryAnchor; mentions: LinkerInputMention[]; sourceKind?: MentionSourceKind; answerId?: string | null },
    run?: RunHandle,
  ): Promise<LinkerResult>;
  /** answer of a disambiguation question: confirm to entity / create new entity / reject (mention.link_decided) */
  confirmMention(
    tx: Tx,
    scope: NovelScope,
    mentionId: string,
    decision: { kind: "entity"; entityId: string } | { kind: "new_entity"; entityType: string; preferredName: string } | { kind: "not_entity" },
    actor: ActorRef,
    ctx?: { questionId?: string; answerId?: string },
  ): Promise<{ entityId: string | null }>;
  /** move mentions to another entity (mention.relinked) */
  relinkMentions(tx: Tx, scope: NovelScope, mentionIds: string[], toEntityId: string, actor: ActorRef): Promise<number>;
  buildDisambiguationOptions(scope: NovelScope, mentionId: string, tx?: Tx): Promise<DisambiguationOptions>;

  // ── widened (A3) ──
  /** manuscript registers its scene reader (extract_facts reads scene text through it) */
  registerSceneSource(source: SceneSource): void;
  /** writes a LinkerResult: NIL entities (EN1) + mentions + EN3(b) check + disambiguation / duplicate questions */
  commitLinkerResult(
    tx: Tx,
    scope: NovelScope,
    result: LinkerResult,
    actor: ActorRef,
    ctx?: { taskId?: string | null; runId?: string | null; sourceKind?: MentionSourceKind; createQuestions?: boolean },
  ): Promise<LinkerCommitResult>;
}

export type { LinkingModuleDeps } from "./module.js";
export { createLinkingModule } from "./module.js";
