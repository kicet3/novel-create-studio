/**
 * agents — public API (design/04 §2, §6.1, §9, §10.2; 11 §2 for concept_partner).
 * Owns: context_snapshots. Also owns (code, not tables): agent role definitions (8 MVP roles incl.
 * concept_partner), versioned prompt templates `<role>.<task_kind>@<semver>`, the ContextBuilder
 * (04 §9 GraphRAG over ontology), output validation helpers, and `defineAgentTask()` which turns an
 * `AgentTaskHandler` (buildContext → execute → commit) into an orchestration `TaskKindHandler`.
 *
 * Task handlers live in the module that owns the commit target and call `agents.defineAgentTask`:
 *   manuscript (planning + writing pipeline), linking (extract/link/dedupe/initial ontology),
 *   continuity (check_continuity), foreshadow (plan_setups/check_setups/review_setup_due),
 *   hitl (interpret/apply/grade), concept (concept_turn/import_concept/check_concept_brief).
 * Modules that own data needed in prompts register a `ContextSectionProvider` (no import cycles).
 */
import type { z } from "zod";
import type { AgentRole, TaskKind } from "@ncs/shared";
import type { ContextSnapshotsRow } from "@ncs/db/schema";
import type { NovelScope, Tx } from "../../platform/index.js";
import type { LlmMessage, ModelCallPort } from "../llm/index.js";
import type { StoryAnchor } from "../ontology/index.js";
import type { CommitOutcome, RunHandle, Task, TaskKindHandler } from "../orchestration/index.js";

export type ContextSnapshot = ContextSnapshotsRow;

export interface AgentRoleDefinition {
  role: AgentRole;
  /** Korean label (labels.ko.ts agent_role) */
  label: string;
  /** one-paragraph mission used at the top of every system prompt */
  mission: string;
  /** write APIs this role's commits may call (04 §2.3) — runtime guard */
  allowedWrites: readonly string[];
  /** default context layer (04 §9.4) */
  contextLayer: "canon" | "reader" | "pov";
  mvp: boolean;
}

export interface PromptTemplate<V = Record<string, unknown>> {
  /** `<role>.<task_kind>@<semver>`, e.g. "writer.draft_episode@0.1.0" */
  id: string;
  role: AgentRole;
  kind: TaskKind;
  version: string;
  render(vars: V, context: ContextPack): { system: string; messages: LlmMessage[] };
}

/** 04 §9.5 */
export type ContextSectionKind =
  | "instruction"
  | "constraints"
  | "assigned_beats"
  | "outline"
  | "entity_cards"
  | "pov_names"
  | "knowledge"
  | "canon_1hop"
  | "glossary"
  | "canon_2hop"
  | "candidates"
  | "unresolved_surfaces"
  | "recent_text"
  /** 설계 추가: confirmed cast profiles + design sheets (module cast) */
  | "cast"
  /** 설계 추가: story structure — ending, current part / plot, this episode's plan (module manuscript) */
  | "story_plan"
  /** 설계 추가: world ontology — approved world facts + flagged candidates (module world) */
  | "world";

export interface ContextSpec {
  anchor: StoryAnchor;
  seeds: { entityIds: string[]; setupIds: string[]; answerIds: string[]; mentionIds: string[] };
  sections: ContextSectionKind[];
  maxInputTokens: number;
  hopPredicates: { hop2: string[] | "all" };
  /** episode/version the run works on (section providers use it) */
  episodeId?: string;
  manuscriptVersionId?: string;
  /** 설계 추가: plot (arc) the run plans (plan_arc → story_plan section) */
  arcId?: string;
}

export interface ContextSectionResult {
  text: string;
  tokenEstimate: number;
  /** ids used, recorded in the snapshot (FR-AGT-04) */
  refs: {
    factVersionIds?: string[];
    entityIds?: string[];
    setupIds?: string[];
    answerIds?: string[];
    versionIds?: string[];
    // additions (A2) — map 1:1 to context_snapshots columns
    candidateFactVersionIds?: string[];
    /** fact ids (not versions) of constraint facts */
    constraintFactIds?: string[];
    entityNameIds?: string[];
    conceptMessageIds?: string[];
    recapIds?: string[];
    questionIds?: string[];
  };
}

/** Sections whose data lives outside ontology are provided by their owners (manuscript: outline/recent_text, foreshadow: assigned_beats, hitl: answers→constraints). */
export interface ContextSectionProvider {
  section: ContextSectionKind;
  module: string;
  build(scope: NovelScope, spec: ContextSpec, run: RunHandle): Promise<ContextSectionResult | null>;
}

export interface ContextPack {
  snapshotId: string;
  system: string;
  messages: LlmMessage[];
  /** resolution table (04 §9.6): `entities[i]` is the entity id behind handle `E${i+1}`, `names[i]` the entity_name id behind `N${i+1}` */
  handles: { entities: string[]; names: string[] };
  tokenEstimate: number;
  droppedSections: ContextSectionKind[];
  /** sections that made it into the pack (debug / tests) */
  sections?: Array<{ section: ContextSectionKind; module: string; tokenEstimate: number }>;
}

export interface ContextBuilder {
  build(run: RunHandle, spec: ContextSpec): Promise<ContextPack>;
  /** RU-3: rerun after reclaim reuses the original snapshot */
  cloneFrom(snapshotId: string, run: RunHandle): Promise<ContextPack>;
}

/** 04 §10.2 handler shape (execute gets the ModelCallPort; commit runs in the engine's transaction). */
export interface AgentTaskHandler<I, P> {
  readonly kind: TaskKind;
  readonly role: AgentRole;
  readonly promptTemplateVersion: string;
  readonly inputSchema: z.ZodType<I>;
  readonly allowedWrites: readonly string[];
  gate?: TaskKindHandler<I>["gate"];
  buildContext(run: RunHandle, input: I, builder: ContextBuilder, task: Task): Promise<ContextPack>;
  execute(run: RunHandle, input: I, context: ContextPack, llm: ModelCallPort): Promise<P>;
  commit(tx: Tx, run: RunHandle, input: I, proposal: P, task: Task): Promise<CommitOutcome>;
}

export interface AgentsService {
  readonly roles: readonly AgentRoleDefinition[];
  getRole(role: AgentRole): AgentRoleDefinition;
  registerPromptTemplate(t: PromptTemplate<any>): void;
  getPromptTemplate(id: string): PromptTemplate<any>;
  registerContextSection(provider: ContextSectionProvider): void;
  readonly contextBuilder: ContextBuilder;
  /** adapt to orchestration (`orchestration.registerTaskKind(agents.defineAgentTask(h))`) */
  defineAgentTask<I, P>(handler: AgentTaskHandler<I, P>): TaskKindHandler<I, { context: ContextPack; proposal: P }>;
  getContextSnapshot(scope: NovelScope, snapshotId: string): Promise<ContextSnapshot>;

  // ── additions (A2) ──
  listPromptTemplates(): PromptTemplate<any>[];
  /** template.render(vars, pack) by id (throws when the id is unknown) */
  renderPrompt(templateId: string, vars: Record<string, unknown>, pack: ContextPack): { system: string; messages: LlmMessage[] };
  /** 04 §9.6: `E3` → entity id from the pack; out of range → TaskFailure(invalid_output) */
  resolveEntityHandle(pack: ContextPack, handle: string): string;
  /** a ContextSpec with role defaults (sections per role, context.max_input_tokens.<role>, hop2 predicates) */
  defaultContextSpec(role: AgentRole, partial: Partial<ContextSpec> & { anchor: StoryAnchor }): ContextSpec;
  /** stored rendered pack of a snapshot (debug), null when missing */
  getContextPack(scope: NovelScope, snapshotId: string): Promise<ContextPack | null>;
}

export type { AgentsModuleDeps } from "./module.js";
export { createAgentsModule } from "./module.js";
