/**
 * cast — public API (설계 추가: 캐릭터 설정 단계; PRD 6.14 캐릭터 시트, design/06 character entities, 07 writing inputs).
 * Owns: characters, character_design_sheets, character_sheet_images (0006_cast.sql).
 *
 * Flow: concept approval (N2, novel → onboarding) seeds the protagonist + main characters of the approved brief →
 * the user edits / adds / removes characters (protagonist exactly 1, sub-protagonists 0..N, antagonist/supporting any)
 * and may ask the AI for a draft (`draft_cast`, concept_partner) → "캐스트 확정" confirms every character, creates or
 * updates the ontology character entities with approved user_input facts → the goal (N3) can be saved (novel goal
 * guard `cast_not_confirmed`) → `plan_series_bible`, outline and draft get the confirmed cast as context section
 * `cast`.
 *
 * Design sheet per character: visual spec (AI draft `draft_design_sheet`, world_keeper; user edits win), image
 * generation per view (front / side / back / expressions) through `imaging.createGeneration` (novel-scoped, budget
 * category image), one primary image per view. `referenceText()` is the text later image prompts reuse.
 *
 * Provenance: every profile / sheet field has an origin (`user` | `agent`); the agent never overwrites a `user` field.
 */
import type { CastCompleteness, CastDraftRequest, CharacterCreateRequest, CharacterPatchRequest, CharacterSheetView, DesignSheetImageRequest, DesignSheetPatchRequest, DesignSheetSpec } from "@ncs/shared";
import type { CharacterDesignSheetsRow, CharactersRow, CharacterSheetImagesRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { ImageGenerationWithAssets } from "../imaging/index.js";

export type Character = CharactersRow;
export type CharacterDesignSheet = CharacterDesignSheetsRow;
export type CharacterSheetImage = CharacterSheetImagesRow;

export interface CastState {
  items: Character[];
  confirmed: boolean;
  blockers: string[];
  counts: { protagonist: number; subProtagonist: number; other: number };
  stepRequired: boolean;
  /** the serial goal exists (novel past onboarding, or a goal row) */
  goalSet: boolean;
  /** characters not confirmed (new or edited since the last confirm) */
  pendingChanges: number;
  canImportBrief: boolean;
  draftTask: { id: string; status: string } | null;
  lastDraftError: string | null;
  /** characterId → design sheet state (thumbnail = primary front asset) */
  sheets: Map<string, { hasSheet: boolean; frontAssetId: string | null }>;
  /** 설계 추가: initial-cast completeness before the story structure */
  completeness: CastCompleteness;
  /** characters introduced by plots that still need fields or an accepted proposal (they block their plot's approval) */
  plotCompleteness: CastCompleteness;
  /** arcId → title (characters introduced by a plot) */
  arcTitles: Map<string, string>;
}

export interface DesignSheetState {
  characterId: string;
  spec: DesignSheetSpec;
  fieldOrigins: Record<string, "user" | "agent">;
  primaryImages: Partial<Record<CharacterSheetView, string>>;
  images: Array<{ link: CharacterSheetImage; generation: ImageGenerationWithAssets }>;
  referenceText: string;
  draftTask: { id: string; status: string } | null;
  updatedAt: Date | null;
}

export interface CastService {
  getCast(scope: NovelScope): Promise<CastState>;
  listCharacters(scope: NovelScope, tx?: Tx): Promise<Character[]>;
  getCharacter(scope: NovelScope, characterId: string, tx?: Tx): Promise<Character>;
  /** user add (any role; a new protagonist demotes the current one to sub_protagonist) */
  createCharacter(scope: NovelScope, input: CharacterCreateRequest, actor: ActorRef): Promise<Character>;
  /** user edit: edited fields become `user`; a confirmed character goes back to draft */
  updateCharacter(scope: NovelScope, characterId: string, patch: CharacterPatchRequest, actor: ActorRef): Promise<Character>;
  deleteCharacter(scope: NovelScope, characterId: string, actor: ActorRef): Promise<void>;
  /** accept an AI proposal as is (every filled field → `user`) */
  acceptCharacter(scope: NovelScope, characterId: string, actor: ActorRef): Promise<Character>;
  /**
   * 설계 추가 0014 (full_auto): accept complete AI proposals of a plot (`arcId`) or of the initial cast (`null`) WITHOUT
   * changing field origins (agent stays agent); proposals with empty required fields are skipped
   */
  acceptAgentProposals(scope: NovelScope, opts: { arcId: string | null }, actor: ActorRef): Promise<{ accepted: string[] }>;
  reorder(scope: NovelScope, ids: string[], actor: ActorRef): Promise<Character[]>;
  /** protagonist + main characters of the approved brief (skips names already in the cast); also run on N2 */
  importFromBrief(scope: NovelScope, actor: ActorRef, tx?: Tx): Promise<{ created: number }>;
  /** `draft_cast` task (coalesced per novel) */
  requestDraft(scope: NovelScope, input: CastDraftRequest, actor: ActorRef): Promise<{ taskId: string }>;
  /** exactly one protagonist → every character confirmed + ontology sync (`cast.confirmed`) */
  confirmCast(scope: NovelScope, actor: ActorRef): Promise<CastState>;
  isCastConfirmed(scope: NovelScope, tx?: Tx): Promise<boolean>;

  getDesignSheet(scope: NovelScope, characterId: string): Promise<DesignSheetState>;
  updateDesignSheet(scope: NovelScope, characterId: string, patch: DesignSheetPatchRequest, actor: ActorRef): Promise<DesignSheetState>;
  requestDesignSheetDraft(scope: NovelScope, characterId: string, actor: ActorRef): Promise<{ taskId: string }>;
  buildSheetPrompt(scope: NovelScope, characterId: string, view: CharacterSheetView, outfitIndex?: number): Promise<{ prompt: string; styleNotes: string; negativePrompt: string; referenceText: string }>;
  /** imaging.createGeneration with the view prompt (202 queued) + link row */
  generateSheetImage(scope: NovelScope, characterId: string, input: DesignSheetImageRequest, actor: ActorRef): Promise<{ link: CharacterSheetImage; generation: ImageGenerationWithAssets }>;
  selectPrimaryImage(scope: NovelScope, characterId: string, view: CharacterSheetView, assetId: string | null, actor: ActorRef): Promise<DesignSheetState>;
  /** reference text reused by image prompts of the character (empty sheet → profile basics only) */
  referenceText(scope: NovelScope, characterId: string): Promise<string>;
  /**
   * context section `cast` text (confirmed characters; an edited one with its last confirmed profile). With
   * `focusEntityIds` only those get the full profile (the rest one line); `episodeNo` marks characters before their
   * first appearance ("아직 등장 전") and the first-appearance episode.
   */
  renderCastContext(scope: NovelScope, opts?: { focusEntityIds?: string[]; episodeNo?: number }): Promise<{ text: string; entityIds: string[] }>;
}

export type { CastModuleDeps } from "./module.js";
export { createCastModule } from "./module.js";
