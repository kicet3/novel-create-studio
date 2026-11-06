# module `hitl`

- **Status:** implemented (MVP-α)
- **Next-phase owner:** A6 hitl+messaging
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createHitlModule` in `module.ts`.

## Responsibilities
- Question Q1–Q8, grading (05 §4), dispatcher (quiet hours, daily cap, digest, deadlines, reminders)
- Approval A1–A5 (1:1 with question, ADR-014) and decision dispatch to registered handlers
- acceptAnswer CAS / late / duplicate, AnswerSession, interpretation (interpret_answer), reflections + notices (G-5)
- web inbox read side

## Owned tables (`@ncs/db/schema/hitl.ts`)
- questions
- question_options
- question_links
- question_deliveries
- answers
- answer_interpretations
- answer_reflections
- answer_reflection_items
- approvals
- digest_batches
- answer_sessions

## Depends on (via their `index.ts` only)
- audit, novel, messaging, orchestration, ontology, agents

## Registers into other modules
- task kinds interpret_answer, apply_answer, grade_question
- messaging inbound handler (answer_*, session_step)
- loops hitl.dispatcher, hitl.deadlines

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/inbox/summary`
- `GET …/questions`
- `GET …/questions/:questionId`
- `POST …/questions/:questionId/open`
- `POST …/questions/:questionId/answers`
- `GET …/approvals`
- `GET …/approvals/:approvalId`
- `POST …/approvals/:approvalId/decision`

## Layout
- `domain/` transitions (Q1–Q8, A1–A5, QD, AS, DG, IT, RF, AN), grading (G1–G4, U1–U7, topic catalogue), drafts/answers/interpretation zod, schedule (quiet hours, deadlines, reminders)
- `application/hitl-service.ts` core (create/publish/accept/decide/reflect/dispatch/deadlines), `inbound.ts` messenger handler (+AnswerSession), `tasks.ts` (interpret_answer, grade_question via agents.defineAgentTask; apply_answer deterministic), `context.ts` (agents section "constraints")
- `adapters/db/hitl-repository.ts`, `adapters/http/routes.ts` (+ `POST …/answers/:answerId/late-resolution`)
- Extra contract methods: `inboxSummary`, `resolveLateAnswer`, `runDispatcherOnce`, `runDeadlinesOnce`; QuestionDraft `notice`, `allowFreeText`, `gradeHints`; ApprovalRequest `payload`.
- Presentation metadata (preview, allow_free_text, origin_task_id) is stored inside `questions.recommendation` jsonb until a dedicated column exists.

## Design sections to implement
- docs/design/05 §2–§8, §10
- docs/design/03 §3.4, §4.4–4.5

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
