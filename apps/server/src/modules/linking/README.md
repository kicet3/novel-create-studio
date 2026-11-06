# module `linking`

- **Status:** implemented (MVP-α)
- **Next-phase owner:** A3 ontology+linking
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createLinkingModule` in `module.ts`.

## Responsibilities
- linker L0–L8 (06 §3.8), confidence/thresholds (00 §7.5)
- task kinds extract_facts, link_mentions, dedupe_entities, build_initial_ontology
- disambiguation questions via hitl + answer appliers (entity_disambiguation, duplicate_entity)
- golden-set seeds G01~G22 runner hooks (test-kit)

## Owned tables (`@ncs/db/schema/linking.ts`)
- (none — writes through ontology.writeMentions)

## Depends on (via their `index.ts` only)
- audit, novel, ontology, llm, agents, orchestration, hitl

## Registers into other modules
- task kinds ×4
- hitl answer appliers

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `(none; UI reads mentions via ontology)`

## Design sections to implement
- docs/design/06 §2.2, §3.4–3.10, §12
- docs/design/07 §4

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Implementation notes (A3)
- `application/linker.ts` L1–L8 (`runLinker`), `commit.ts` (NIL entities, mentions, EN3(b), questions), `decisions.ts` (confirm/relink, answer appliers, identity_change approval), `tasks.ts` (4 task kinds).
- `extract_facts` = P3b + P3c in one task, then creates `link_mentions` → `check_continuity`/`check_setups`.
- Scene text comes from `registerSceneSource()` (manuscript) or `input.scenes`; without a source extraction is skipped.
- Without a model run L4 is the deterministic `ruleJudge`. Model schemas: `linking_l4_choice`, `linking_extraction`, `linking_initial_ontology`.
