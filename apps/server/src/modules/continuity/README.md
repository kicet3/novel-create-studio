# module `continuity`

- **Status:** implemented (MVP-α)
- **Next-phase owner:** A5 continuity+foreshadow
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createContinuityModule` in `module.ts`.

## Responsibilities
- ContinuityIssue lifecycle (03 §4.6) + evidence, display no CI-n
- task kind check_continuity (deterministic CR rules via ontology + LLM review), character knowledge / identity leak checks
- check-gate contributor (open high issues, fix_scope → E4/E5)

## Owned tables (`@ncs/db/schema/continuity.ts`)
- continuity_issues
- continuity_issue_evidence

## Depends on (via their `index.ts` only)
- audit, novel, ontology, manuscript, foreshadow, orchestration, agents, hitl

## Registers into other modules
- task kind check_continuity
- manuscript gate contributor

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/continuity-issues`
- `GET …/continuity-issues/:issueId`
- `POST …/continuity-issues/:issueId/transition`

## Design sections to implement
- docs/design/03 §3.6, §4.6
- docs/design/06 §9
- docs/design/07 §5.1, §5.3–5.6

## Implementation notes (A5)
- domain/: `transitions.ts` (C2–C8 + INV-CI-03/04/05), `rules.ts` (CR catalog, dedupe hash, severity adjustment, ContinuityReview zod, reconcile plan)
- application/: `continuity-service.ts` (open/transition/reconcile, SetupIssueSink for foreshadow, safety sink for manuscript), `check-continuity.ts` (task kind), `hooks.ts` (gate contributor, E4/E5 → C2, E6/E9 stale cleanup, `issues` annotator)
- Dedupe hash = rule id + evidence fact/name/answer ids + resolved entity ids (mention ids excluded: they change per version).
- Re-check reconciliation: reproduced → re-link (fixing → open = C4); not reproduced → C3 (rewritten) / C5 (human_edited) / C8 (scene vanished); same-version open issues are left alone.

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
