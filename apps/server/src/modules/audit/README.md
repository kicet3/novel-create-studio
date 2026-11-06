# module `audit`

- **Status:** implemented
- **Next-phase owner:** (done — contracts phase)
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createAuditModule` in `module.ts`.

## Responsibilities
- `activity_log` append in the caller's transaction (`record`, `recordMany`), secret masking of before/after/details
- post-commit in-process publish (`subscribe`) for UI refresh hints (ADR-017); business logic must not consume it
- timeline queries (novel / install level) with filters and seq cursors

## Owned tables (`@ncs/db/schema/audit.ts`)
- activity_log (append-only trigger)

## Depends on (via their `index.ts` only)
- platform

## Registers into other modules
- —

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET /api/novels/:novelId/activity`
- `GET /api/activity`

## Design sections to implement
- docs/design/03 §6 (주체 모델, ActivityLog, 이벤트 이름)
- docs/design/02 §5.1–5.2 (커밋 후 처리)
- docs/design/08 §9.7 (감사 타임라인 API)

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
