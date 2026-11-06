# module `concept`

- **Status:** implemented (MVP-α, A7)
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createConceptModule` in `module.ts`.

## Layout
- `domain/` (pure): `title.ts` (cleanTitle, suggestion normalization, title material check), `transitions.ts` (CS3–CS9, CB2–CB8, CS2 stage table), `brief.ts` (working brief model, paths, provenance, hash), `question-set.ts` (`common@1` CQ-01~21 + 10a~d, required/conditional slots, field dependencies, value coercion), `slot-guard.ts` (INV-CON-03/04, conflicts 4.4, flips, dependencies), `next-question.ts` (3.5 selection, reserved buttons 900–907, logline/summary fallbacks), `checks.ts` (X-9 + CS3 blockers INV-CON-05/10/11/12/15), `turn.ts` (commit planners for turn / import / form edit), `proposal.ts` (zod: ConceptTurnProposal, import, check), `render.ts`.
- `application/concept-app.ts`: use cases, task handlers, approval handler, inbound handler, idle sweep. `prompts.ts`: templates `concept_partner.concept_turn@0.1.0`, `concept_partner.import_concept@0.1.0`, `continuity_editor.check_concept_brief@0.1.0`.
- `adapters/db/repository.ts`, `adapters/http/routes.ts`.

## Behaviour notes
- The code decides which slot to ask (3.5); the model only phrases it and proposes slot updates. With an empty model proposal (or the llm module as a placeholder) the deterministic commit still runs the whole conversation: answers to the asked slot become `user_stated` (quote = message), seed chips → `user_stated`, model candidates → `agent_proposed_accepted`.
- CQ-01 (opening question) is a deterministic **system** message created with the session (no model call).
- Working brief jsonb = `{content, field_provenance, change_proposals, checks, meta}`; `ConceptBrief.content` = content + `field_provenance` + `contribution_summary` + `checks`.
- Titles (설계 추가): novels are created without a title (`제목 미정`, title_source=provisional). Every turn may return `working_title` (preview, title_source=auto) and `title_suggestions` (3–5, cleaned/deduped by `domain/title.ts`; fewer than 3 usable → ignored), stored in `meta.title_suggestions` while the title is not user-confirmed. "다른 추천 받기" = `concept_turn` with `input.titles=true` (cycle_key `titles:<sessionId>`, template `concept_partner.suggest_titles@0.1.0`, zod `TitleSuggestions`): no reply message, no turn count, cost added to the session; pending/failed state in `meta.title_refresh`. Choosing/editing a title = brief `title` (user_edited) → novel title_source=user, kept by approval (N2). On a messenger channel the turn reply lists the new suggestions as text.
- Turn reservation estimate for INV-CON-09: `TURN_RESERVE_MICROS` (0.15 USD, assumption) + `concept.check_reserve_usd`.

## Registers into other modules
- N1 participant (order 50) · task kinds ×3 (registered directly with orchestration, not via `agents.defineAgentTask`) · hitl approval handler `concept_brief` · messaging inbound handler `concept_message` · prompt templates (agents registry) · loop `concept.idle_sweeper` (hourly)

## HTTP endpoints (`…` = `/api/novels/:novelId`, DTOs in `@ncs/shared` dto/concept.ts)
- `GET …/concept/session` → SessionView | null · `GET …/concept/sessions/:sessionId` → SessionView
- `GET …/concept/sessions/:sessionId/messages?afterSeq&limit` → `{items, nextCursor, latestSeq}` · `POST …/messages` `{body, kind?, optionValue?, pickedIdx?}` → 201 `{message, taskId}`
- `PATCH …/concept/sessions/:sessionId/brief` `{path, value}` → SessionView
- `POST …/concept/sessions/:sessionId/{pause,resume}` · `POST …/abandon` `{restart?}` → `{abandoned, session|null}` · `POST …/submit` → 202 `{taskId}` · `POST …/extend` `{turns?: true, budgetMicros?}` · `POST …/entry-mode` `{mode}`
- `POST …/concept/sessions/:sessionId/confirm` `{which: "imported"|"delegated"} | {paths}` → SessionView
- `POST …/concept/sessions/:sessionId/change-proposals/:proposalId` `{decision}` → SessionView
- `POST …/concept/sessions/:sessionId/title-suggestions` → 202 `{taskId}` ("다른 추천 받기"; 422 `concept_title_no_material` / `concept_llm_disabled` / `concept_budget_limit`) · `POST …/title` `{title}` → SessionView (추천 고르기·고쳐 쓰기·직접 입력; closed session → novel title only). SessionView has `titleSuggestions {items[{title, reason}], generatedAt, refreshing, error, canRefresh}`.
- `POST …/concept/revisions` → 201 session · `GET …/concept/briefs` · `GET …/concept/briefs/approved` · `GET …/concept/briefs/:briefId`
- `GET …/concept/goal-defaults` → goal form initial values (M-06~M-08, M-22) | null

## Tests
`apps/server/test/concept/*.test.ts` (domain unit + PGlite integration; scripted model port + real Anthropic adapter against the scripted Claude mock).
