# module `foreshadow`

- **Status:** implemented (MVP-α)
- **Next-phase owner:** A5 continuity+foreshadow
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createForeshadowModule` in `module.ts`.

## Responsibilities
- Setup narrative × canon status (03 §4.7), beats, due changes, links
- task kinds plan_setups, check_setups, review_setup_due
- check-gate contributor (missing beats), E9 beat confirmation hook, assigned_beats context section
- SetupReport R1–R5 + metrics (06 §8)

## Owned tables (`@ncs/db/schema/foreshadow.ts`)
- setups
- setup_beats
- setup_due_changes
- setup_links

## Depends on (via their `index.ts` only)
- audit, novel, ontology, manuscript, orchestration, agents, hitl

## Registers into other modules
- task kinds ×3
- manuscript gate contributor + transition hook
- agents context section

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/setups`
- `GET …/setups/:setupNo`
- `GET …/setups/report`

## Design sections to implement
- docs/design/03 §3.7, §4.7
- docs/design/06 §8
- docs/design/07 §1.3, §5.2

## Implementation notes (A5)
- domain/: `transitions.ts` (S2–S5, SC2–SC6, beat B1–B6, combination table), `plan.ts` (SetupPlan zod + SP-1..4), `check.ts` (SetupCheckReport / SetupDueReview zod, quote locator), `report.ts` (R1–R5, `computeSetupMetrics`)
- application/: `foreshadow-service.ts`, `tasks.ts` (plan_setups / check_setups / review_setup_due as agents `AgentTaskHandler`s), `hooks.ts` (gate contributor, E9/E13/E14/B4 hook, `assigned_beats`, `setup_due` applier, `setup_abandon` approval handler, `beats` annotator), `prompts.ts` (prompts)
- `SetupIssueSink` registry: continuity registers here; check_setups opens setup_missing / setup_contradiction through it.
- Fact pins (`setup_links.pinned_fact_version_id`) are written when the plant beat is DETECTED (check_setups commit), not at E9 — ontology reads cannot run inside the E9 transaction.
- SC2 also happens lazily at E9 when the setup is still `candidate` but its arc is active (no arc_plan hook reaches foreshadow yet).

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
