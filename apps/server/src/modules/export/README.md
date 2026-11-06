# module `export`

- **Status:** implemented (MVP-α, A4) — synchronous TXT/Markdown, local_disk storage, `export.created` audit
- **Next-phase owner:** A4 manuscript+export
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createExportModule` in `module.ts`.

## Responsibilities
- TXT / Markdown export of episode / arc / novel with version selection (07 §3.8)
- files via StorageProvider `novels/<novelId>/exports/…`, export.created audit

## Owned tables (`@ncs/db/schema/export.ts`)
- export_jobs

## Depends on (via their `index.ts` only)
- audit, novel, manuscript

## Registers into other modules
- —

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `POST …/exports`
- `GET …/exports`
- `GET …/exports/:exportId`
- `GET …/exports/:exportId/download`

## Design sections to implement
- docs/design/07 §3.8
- docs/design/08 §2.3

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
