# module `budget`

- **Status:** implemented (application/budget-service.ts) — MVP-α
- **Next-phase owner:** A1 orchestration+budget
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createBudgetModule` in `module.ts`.

## Responsibilities
- BudgetPolicy per novel/category, windows, warning/hard stop → novel.pause(budget_hard_limit)
- reserve / attachToCall / settle / release / closeUnknown (INV-COST-01~04, G-6)
- resume after hard stop (approval `budget_resume` via hitl handler)
- cost queries for home/settings

## Owned tables (`@ncs/db/schema/budget.ts`)
- budget_policies
- budget_reservations
- cost_events (append-only)

## Depends on (via their `index.ts` only)
- audit, novel

## Registers into other modules
- N1 participant (order 30)
- hitl approval handler `budget_resume` via `connectApprovals(hitl.service)` (composition must call it after hitl is built)
- loop `budget.reservation_sweeper` (stale unattached reservations, 02 §7.2)

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/budget`
- `PATCH …/budget/policies/:category`
- `POST …/budget/policies/:category/resume`
- `GET …/budget/cost-events`

## Design sections to implement
- docs/design/03 §7
- docs/design/04 §8, §13 BudgetApi
- docs/design/00 §7.1

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Direct spend (no run)
`checkDirectSpend(tx, scope, {category, amountMicros, pendingMicros})` admits a spend outside the run engine under the
per-novel lock (INV-COST-02 with the caller's in-flight estimates as reserved); `recordDirectCost(tx, scope, {...})` writes an
idempotent `cost_events` row without run / provider call and re-evaluates warning / hard stop. Used by module `imaging`.
