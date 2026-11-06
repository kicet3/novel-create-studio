# module `orchestration`

- **Status:** implemented (application/engine.ts) — MVP-α
- **Next-phase owner:** A1 orchestration+budget
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createOrchestrationModule` in `module.ts`.

## Responsibilities
- task-kind registry (`registerTaskKind`) — contract final
- Task/TaskDependency/WakeRequest/Run lifecycle T1–T12, R1–R7 with CAS lease + fencing (04 §5)
- dispatcher, wake coalescing (§4.2), concurrency caps (`run.max_concurrent_*`), budget gating via budget.reserve (T8)
- orphan reclaim on boot (§11), pause/resume (§12), reassign (§2.2), provider circuit breaker (§7.3)
- retry/backoff per error_family (§7.2)
- interruptions (server stop / crash / lease loss): run R7 `interrupted`, task T10 → ready + `reclaim` wake, no attempt
  used (audit `details.cause` = shutdown | lease_lost | orphan); a proposal finished during the shutdown grace is still
  committed; crash-loop guard `task.max_interruptions` (10 consecutive, counter `task.input.interrupted_runs`, reset by
  T5/T12) → T6 failed

## Owned tables (`@ncs/db/schema/orchestration.ts`)
- tasks
- task_dependencies
- wake_requests
- runs

## Depends on (via their `index.ts` only)
- audit, novel, budget, runtime pool

## Registers into other modules
- loops `orchestration.dispatcher` (5 s + wake/task hints), `orchestration.reclaimer` (60 s); per-run lease renew timer
- budget: `registerRunInfoResolver`, `registerActiveRunProbe`, `onReservationClosed` (T9 reservation-wait), `onResumed` (T9 budget)
- novel: `onGoalSaved` (INV-GOL-02 wakes for plan_arc/outline_episode/schedule_episodes)
- `start()`: startup reclaim of every queued/running run + stale reservation sweep (04 §11.1)

## Notes for handler authors
- `RunHandle.checkpoint()` reads outside transactions — never call it inside `uow.run`.
- `RunHandle.runChain` / `rerunOfRunId`: previous runs to reuse recorded responses from (RU-2).
- `registerRunRecovery(hook)`: provider_calls owner (llm) closes `sent` → unknown / `prepared` → abandoned on reclaim.
- `runOnce()` ignores the coalesce window (tests/CLI); background ticks honour WC-3 (10 s).

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/tasks`
- `GET …/tasks/:taskId`
- `GET …/tasks/:taskId/runs`
- `POST …/tasks/:taskId/retry|cancel|pause|resume`
- `POST …/tasks/:taskId/reassign` `{toRole}`

## Design sections to implement
- docs/design/04 §1–§8, §11–§13
- docs/design/03 §4.2–4.3, INV-TSK-*

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
