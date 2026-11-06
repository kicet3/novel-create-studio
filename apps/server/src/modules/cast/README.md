# module `cast` (캐릭터 설정 단계, 설계 추가)

- **Status:** implemented
- **Public API:** `index.ts` (`CastService`, row types). Factory `createCastModule` in `module.ts`.
- **Owns:** `characters`, `character_design_sheets`, `character_sheet_images` (`packages/db/src/migrations/0006_cast.sql`, drizzle `schema/cast.ts`).
- **Depends on:** `novel` (status hook, goal guard, approved brief id), `concept` (`getBrief`), `ontology` (entities, names, facts),
  `orchestration` (task kinds), `agents` (prompt templates, context section), `llm` (`modelCalls`), `imaging` (`createGeneration`, `getGeneration`), `audit`.

## Flow
1. **N2** (concept approval, novel `concept → onboarding`): `novel.onStatusChanged` seeds the cast from the approved brief —
   `protagonist` → 주인공, `main_characters[]` → 서브 주인공/적대자/조연 by `role_label`, `relation_to_protagonist` → relationship.
   Brief values count as the user's (origin `user`); a nameless protagonist gets `이름 미정` (origin `agent`, confirm refused until renamed).
2. The user edits / adds / removes characters. Roles: `protagonist` (exactly 1 to confirm; a new protagonist demotes the current one to
   `sub_protagonist`; DB partial unique index), `sub_protagonist` (0..N), `antagonist`, `supporting` (any count). Any user edit puts a
   confirmed character back to `draft`.
3. **AI 초안** `draft_cast` (role `concept_partner`, template `concept_partner.draft_cast@0.1.0`, target novel, cycle `cast:<novelId>`,
   no goal needed): proposes characters from the brief + current cast. Commit: existing characters get only fields whose origin is not
   `user` (`agentWritable`); confirmed characters are never touched; new characters are inserted with `proposed=true`, origin `agent`;
   requested sub-protagonist count caps new sub-protagonists; relationships resolved by name. `POST …/accept` turns every filled field into `user`.
4. **캐스트 확정** (`cast.confirmed`): blockers = no characters / not exactly one protagonist / duplicate or placeholder names. Every
   character → `confirmed`; ontology sync per character: `character` entity (active, `conceptCharacterKey` = brief key or `chr_` id,
   aliases as `alias` names) or new names on an existing entity; approved `user_input` facts sourced `{character, chr_…}` for values changed
   since the last sync — `age` (only plain numbers), `gender`, `personality`, relationships whose label maps to a base@1 predicate
   (`ally_of`, `enemy_of`, `sibling_of`, `loves`, `spouse_of`; others stay in the cast only — whole-word keywords, so 적극적·정치적·
   정신적·목적 are not "적" and 형사 is not "형"). A changed or removed value withdraws its previous fact first (`ontology.withdrawFacts`:
   approved → retracted, F9), so the new value takes the slot; a value counts as synced only when its fact came back approved
   (`ontology_sync.values` / `fieldFacts`; a held candidate is withdrawn and retried on the next confirm). A rename adds the new
   `true_name`, makes it the preferred name (`ontology.setPreferredName`) and retires the cast's own former true name (names found in
   the manuscript stay). `ontology_sync.confirmed` keeps the role + profile as confirmed.
5. **Goal guard**: `novel.registerGoalGuard` → the first `saveGoal` (onboarding → planning, N3) fails with 422 `cast_not_confirmed`
   until the cast is confirmed, so `plan_series_bible` never starts without a cast.
6. **Context section `cast`** (agents registry, rank 3): confirmed characters with role, key, profile, relationships and the design sheet
   look (`{{E:<entity>}}` handles). A character edited after confirmation is rendered from `ontology_sync.confirmed` (its last confirmed
   profile) until the cast is confirmed again; never-confirmed characters are left out; the heading counts what is rendered. Used by `plan_series_bible` (manuscript spec `sections: ["cast"]`), planner/writer defaults and the
   writing pipeline (`WRITING_SECTIONS`). `build_initial_ontology` reuses a cast character entity with the same name instead of opening
   a duplicate question.

## Design sheet
- Spec (`designSheetSpecSchema`): face, hair, eyes, build, height, outfits[], colorPalette[{name, hex}], distinguishingMarks, artStyle, avoid;
  per-field origin like the profile. AI draft `draft_design_sheet` (role `world_keeper`, `world_keeper.draft_design_sheet@0.1.0`, target character).
- `referenceText()` = stable Korean description reused by every image prompt of the character.
- Images: `POST …/design-sheet/images {view, provider, modelId, …}` builds the view prompt (front / side / back turnaround, expressions 3×2)
  + style notes (artStyle) + avoid, calls `imaging.createGeneration` novel-scoped (budget category `image`, ledger row), and links the
  generation (`character_sheet_images`). `PUT …/primary {view, assetId}` selects one asset per view (must be a succeeded image of that
  character and view); the primary front image is the cast list thumbnail. Deleting a generation in the image tab removes the link (FK cascade).

## HTTP (`…` = `/api/novels/:novelId`, DTOs `packages/shared/src/dto/cast.ts`)
- `GET …/cast` → CastView `{items, confirmed, blockers, counts, stepRequired, goalSet, pendingChanges, canImportBrief, draftTask, lastDraftError}`
  (`thumbnailUrl` / `hasDesignSheet` only count primary images whose file still exists)
- `POST …/cast/characters` → 201 · `PATCH|DELETE …/cast/characters/:characterId` · `POST …/cast/characters/:characterId/accept`
- `PUT …/cast/order {ids}` · `POST …/cast/import-brief` · `POST …/cast/draft {subProtagonistCount?, includeAntagonist, instructions?}` → 202 `{taskId}`
- `POST …/cast/confirm` (422 `cast_invalid` with the first blocker)
- `GET|PATCH …/cast/characters/:characterId/design-sheet` · `POST …/design-sheet/draft` → 202 · `GET …/design-sheet/prompt?view&outfitIndex`
- `POST …/design-sheet/images` → 202 (generation queued) · `PUT …/design-sheet/primary {view, assetId|null}`
- Mutations before concept approval → 422 `concept_not_approved`; archived novel → 422 `novel_archived`.

## Audit actions
`character.created|updated|deleted|reordered`, `cast.draft_requested|draft_applied|confirmed`,
`design_sheet.updated|draft_requested|image_requested|image_selected` (target `character` or `novel`).

## Not done / limits
- Deleting a character keeps its ontology entity (merge/retire it in the ontology screen).
- Facts synced before `ontology_sync.fieldFacts` existed are matched among the character's own `factIds` (same predicate / object) when they change.
- Image generations are not reused as model references (text reference only); no image-to-image consistency.
