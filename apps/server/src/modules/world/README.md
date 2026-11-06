# module `world` (설계 추가: 세계관 온톨로지 생성)

- **Status:** implemented
- **Public API:** `index.ts`. Factory `createWorldModule` in `module.ts`.

## Responsibilities
- After the concept brief is approved (N2, novel `concept → onboarding`) enqueue `build_world_ontology`
  (world_keeper, `world_keeper.build_world_ontology@0.1.0`, target novel, cycle key `world` → one active task per novel,
  no goal needed — 0012 `tasks_ck_1`).
- The task reads the approved brief, the confirmed cast (context section `cast`) and the existing world items, asks the
  model (web search on when the novel allows it, `webSearch: true`) for factions, places, systems & power rules, key
  objects / concepts, history, relations and constraint rules, and writes them into the ontology as **candidates**:
  entities `status=candidate` (`equivalence_check = {status: "review", source: "world_ontology"}` so no promotion path
  activates them before review), facts `canon_status=candidate`, `source_kind=system_derived`, source `task:<id>`,
  fact versions carry the run. Mapping: faction → organization, place → place (+ `located_in`), system → ability
  (`ability_cost`, `ability_limit`) or rule (`rule_statement`), object → item, history → event (+ `occurred_at`,
  `participated_in`), constraint → rule + `rule_statement`; relations only base@1 predicates with valid domain/range.
- Review: approve (EN3 + F3 through `ontology.approveCandidateFacts`), approve all (entities first), edit (name /
  summary / statement / relation predicate; marks the item user-edited), reject (F4 + EN5; an entity takes its
  pending relations with it).
- "다시 생성": same-name entities are reused; approved, user-made and user-edited items are never changed; untouched AI
  candidates are refreshed when proposed again and superseded (facts rejected, entity retired) when not.
- Context: section `world` (approved facts, candidates flagged `[미확정 후보]`, ≤ 6000 chars) used by
  `plan_series_bible` and `plan_structure`; `renderWorldContext` for the cast draft (`draft_cast`).
- The bible's `build_initial_ontology` reuses a world entity with the same type + name instead of opening a duplicate.

## Owned tables
- world_ontology_items (kind, status pending/approved/rejected/superseded, origin agent/user, user_edited, entity_id,
  fact_ids, task_id, run_id, sources jsonb, note, from_brief, held_reason)

## Depends on
- novel (status hook), ontology, orchestration, agents, llm (provider calls for the web search summary), concept

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/world-ontology` → `worldOntologyViewSchema` (generation state, counts, groups by kind)
- `POST …/world-ontology/generate` `{instructions?}` → 202 `{taskId, created}` (422 `concept_not_approved`)
- `POST …/world-ontology/approve-all` · `POST …/world-ontology/items/:itemId/approve` → `worldReviewResultSchema`
- `POST …/world-ontology/items/:itemId/reject` `{reason?}` · `PATCH …/world-ontology/items/:itemId` `{name?, summary?, statement?, predicate?}`
