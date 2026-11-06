# module `ontology`

- **Status:** implemented (MVP-α)
- **Next-phase owner:** A3 ontology+linking
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createOntologyModule` in `module.ts`.

## Responsibilities
- OntologyRepository (06 §11.4) — only path to ontology tables
- base@1 schema data, schema validator (CR-09~11), timelines (main only in MVP-α)
- entities/names (normalization 06 §3.4), facts bitemporal (ADR-007), promotion E9/E13/E14, bible approval facts (INV-BIB-03)
- identity decisions merge/split/revert (FR-ONT-16)
- health check `ontology_integrity`; UI read APIs (08 §9.5)

## Owned tables (`@ncs/db/schema/ontology.ts`)
- ontology_schema_versions
- timelines
- entities
- entity_names
- narrative_frames
- mentions
- facts
- fact_versions
- fact_cardinality_slots
- schema_change_proposals
- glossary_terms
- identity_decisions
- identity_decision_moves
- entity_distinct_pairs

## Depends on (via their `index.ts` only)
- audit, novel, system

## Registers into other modules
- N1 participant (order 10)
- health check ontology_integrity
- (agents reads ontology directly through OntologyRepository — no section provider needed)

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/entities`
- `GET …/entities/:entityId`
- `GET …/entities/:entityId/mentions`
- `GET …/entities/:entityId/facts`
- `POST …/entities`
- `POST …/entities/:entityId/names`
- `GET …/timelines`
- `GET …/schema`
- `GET …/identity-decisions`
- `GET …/identity-decisions/:id/impact`
- `POST …/identity-decisions/:id/revert`

## Design sections to implement
- docs/design/06 (전체)
- docs/design/03 §5
- docs/design/04 §9.8
- docs/design/08 §9.5

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Implementation notes (A3)
- `application/ontology-service.ts` composes PgOntologyRepository (`adapters/db/*`): `reads.ts` (Q1–Q9, name functions, cards), `entities.ts` (EN/NM/MN), `fact-writes.ts` (F1–F11, SL-1..4, promotion, bible approval), `identity.ts` (merge/split/relink/confirm_distinct + revert, restoration data in `identity_decisions.evidence.applied`), `integrity.ts` (`ontology_integrity`, schema proposals).
- `domain/`: `base-schema.ts` (`base@1` data + zod defs), `normalize.ts` (normalized/jamo/translit keys, edit distance), `facts.ts` (slot keys, classification), `schema-validator.ts` (CR-05/09/10/11), `transitions.ts`.
- Reads accept an optional trailing `tx` — always pass it inside a transaction (PGlite has one connection).
- Status/promotion changes create a FactVersion with `change_reason=canon_change` (no dedicated enum value yet).
- 설계 추가 (world, 0012): `updateEntity` (summary / disambiguator, audit `entity.updated`), `reviseCandidateFact` (value edit of a
  candidate → new version, `user_edit`), `approveCandidateFacts` (F3 for explicit fact ids — `PromotionTarget.factIds`, same
  06 §6.4 gate), `getFactsByIds`. World candidates carry `equivalence_check = {status: "review", source: "world_ontology"}` so
  EN3(b) never activates them before the author's review; the bible's `build_initial_ontology` reuses them by type + name.
