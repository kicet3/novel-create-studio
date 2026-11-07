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
- `POST …/linking/resolve-backlog` — 설계 추가 0015: `resolve_entities` task (엔티티 질문 백로그 정리; an active one is returned). UI reads mentions via ontology.

## Design sections to implement
- docs/design/06 §2.2, §3.4–3.10, §12
- docs/design/07 §4

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Implementation notes (A3)
- `application/linker.ts` L1–L8 (`runLinker`), `commit.ts` (NIL entities, mentions, EN3(b), questions), `decisions.ts` (confirm/relink, answer appliers, identity_change approval), `tasks.ts` (4 task kinds).
- `extract_facts` = P3b + P3c in one task, then creates `link_mentions` → `check_continuity`/`check_setups`.
- Scene text comes from `registerSceneSource()` (manuscript) or `input.scenes`; without a source extraction is skipped.
- 설계 추가(수정 반영): after the candidate facts are written, registered `FactReconciler`s (revision) reconcile the facts of earlier versions of the episode in the same commit (only when scenes were read).
- Without a model run L4 is the deterministic `ruleJudge`. Model schemas: `linking_l4_choice`, `linking_extraction`, `linking_initial_ontology`.

## 엔티티 판정 에이전트 (설계 추가 0015)
- Novel setting `novels.entity_agent_resolution` (default on) + `entity_agent_min_confidence` (default 0.75); off = the old path.
- `domain/salience.ts`: pronouns / generic address (coreference only, never asked), common nouns (ignored), generic places (hint).
- `application/resolver.ts`: one `world_keeper` call per batch (`purpose resolve_entities`, schema `linking_entity_resolution`,
  repair dialogue "엔티티 판정 검증"); model errors keep the deterministic / old path.
- `application/agent-resolution.ts`: extract_facts plan → link / alias / create / ignore / hold / ask; below the threshold
  only contested (≥ 2 active named candidates) surfaces are asked; audit `mention.agent_resolved`.
- Memory: resolved surfaces become active aliases (`rememberAlias`; the linker links a single safe exact candidate without
  L4); "not an entity" goes to `glossary_terms` (category `non_entity`).
- Exact names: the commit re-checks NIL names in its tx (no parallel duplicates); dedupe / bible merge identical names.
- Questions: 누구 only for persons, typed "새 {유형}" option, resolver recommendation, one open question per surface;
  `entity_disambiguation` / `duplicate_entity` are sensitivity `normal`.
- `application/backlog.ts` (`resolve_entities`): open world_keeper questions → `hitl.agentResolveQuestion`
  (resolution_source `agent_resolved`) / cancel ("에이전트가 정리…") / `agentCloseInterpretation`; low confidence stays
  open. Enqueued once per novel at boot (cycle `entity_backlog@1`) and from the inbox button "에이전트가 정리".
