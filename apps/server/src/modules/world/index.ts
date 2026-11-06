/**
 * world — public API (설계 추가: 컨셉 승인 뒤 세계관 온톨로지 생성).
 * Owns: world_ontology_items (0012_world_ontology.sql). Entities / facts stay in the ontology module (written only
 * through OntologyService, as candidates until the author approves them).
 *
 * Flow: concept approval (N2) → task `build_world_ontology` (world_keeper, web search per novel setting, coalesced per
 * novel) → candidates grouped by kind (faction / place / system / object / history / relation / constraint) with
 * provenance (agent run, task, web sources) → review on the 세계관 온톨로지 page (approve all / approve / edit /
 * reject) → approved items are canon (entities active, facts approved). "다시 생성" keeps approved, user-made and
 * user-edited items. Context: section `world` (agents) and `renderWorldContext` for the cast draft.
 */
import type { WorldItemDto, WorldOntologyView, WorldReviewResult } from "@ncs/shared";
import type { WorldOntologyItemsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export type WorldOntologyItem = WorldOntologyItemsRow;

export interface WorldItemPatch {
  name?: string;
  summary?: string | null;
  statement?: string;
  predicate?: string;
}

export interface WorldService {
  getView(scope: NovelScope): Promise<WorldOntologyView>;
  /** [세계관 생성] / [다시 생성]: 422 concept_not_approved before the brief is approved; an active task is reused */
  requestGeneration(scope: NovelScope, actor: ActorRef, instructions?: string): Promise<{ taskId: string; created: boolean }>;
  approveItem(scope: NovelScope, itemId: string, actor: ActorRef): Promise<WorldReviewResult>;
  /** entity items first, then relations; items that cannot be promoted stay pending with a reason */
  approveAll(scope: NovelScope, actor: ActorRef): Promise<WorldReviewResult>;
  /** pending only; an entity takes its pending relations with it */
  rejectItem(scope: NovelScope, itemId: string, actor: ActorRef, reason?: string): Promise<WorldReviewResult>;
  /** pending only; marks the item user-edited (다시 생성 keeps it) */
  editItem(scope: NovelScope, itemId: string, patch: WorldItemPatch, actor: ActorRef): Promise<WorldItemDto>;
  /** approved world items + pending candidates flagged 미확정 (cast draft prompt; also context section `world`) */
  renderWorldContext(scope: NovelScope): Promise<{ text: string; factVersionIds: string[]; candidateFactVersionIds: string[] }>;
}

export type { WorldModuleDeps } from "./module.js";
export { createWorldModule } from "./module.js";
