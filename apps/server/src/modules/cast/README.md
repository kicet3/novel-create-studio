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

## 전체 구성 전 필수 항목 (설계 추가 0008)

- 새 필드: `appearance`(외형 요약), `motivation`, `speech_sample`, `arc_start`/`arc_end`(변화 아크), `story_role`(조연·적대자 역할), `first_appearance_episode_no`, `introduced_arc_id`(플롯에서 새로 등장).
- 완성도(`castCompleteness`, 순수): 주인공·서브 주인공 = 나이·외형·성격(장점·결점)·목표·동기·두려움·과거사·말투 예시·관계(서브는 주인공과의 관계, 양방향)·변화 아크 시작/끝, 조연·적대자 = 역할·목표·주인공과의 관계. 초기 인물은 확정(confirmed)된 값만, 플롯 신규 인물은 AI 제안을 수락(proposed=false)해야 인정합니다. `GET …/cast`의 `completeness`, 구성 생성·승인 게이트(422 `cast_incomplete`)에 쓰입니다.
- `POST …/cast/draft {fillMissing:true, characterIds?}`: `draft_cast`가 지금 비어 있는 필수 항목만 채웁니다(값이 있는 항목·user 항목은 그대로). 확정 인물도 빈 항목이 채워지면 draft + proposed로 돌아갑니다.
- `cast` 컨텍스트: 아웃라인 등장 인물(엔티티 seed)은 전체 프로필, 나머지는 한 줄. 첫 등장 화보다 앞선 화에서는 "(아직 등장 전 — N화 첫 등장 예정 …)" 표시.
- `PlanningCastPort`(manuscript 등록부): 플롯 신규 인물 제안(`proposed`, `introduced_arc_id`), arc_plan 승인/AR4 때 그 인물들만 온톨로지 동기화·확정, 첫 등장 화(빈 값만) 기록.

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

- 설계 추가 (world, 0012): the AI cast draft (`draft_cast`) prompt carries the world ontology (`world.renderWorldContext`: approved world items + candidates flagged `[미확정 후보]`).
