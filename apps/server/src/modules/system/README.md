# module `system`

- **Status:** implemented (BackupService: JSON / pg_dump engine, scheduler loop `system.backups`, `backup_location` check; restore = `ncs restore`)
- **Next-phase owner:** (done — contracts phase); backups → ops/CLI agent (MA-6)
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createSystemModule` in `module.ts`.

## Responsibilities
- SecretProvider `local_encrypted` (AES-256-GCM, key file `<home>/secrets/master.key`)
- health-check registry + runner + latest results (`health_check_results`), `system.health_check_failed` audit
- install info
- MA-6: BackupService (pg_dump 미포함 → S-7), restore via CLI

## Owned tables (`@ncs/db/schema/system.ts`)
- secrets
- health_check_results
- backup_records
- app_migrations (written by @ncs/db runner)

## Depends on (via their `index.ts` only)
- audit

## Registers into other modules
- health checks `database`, `storage`; loop `system.health_checks`

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET /api/system/info`
- `GET /api/system/health-checks`
- `POST /api/system/health-checks/run`
- `GET /api/novels/:novelId/health-checks`
- `GET /api/system/secrets`
- `PUT /api/system/secrets/:secretId`
- `DELETE /api/system/secrets/:secretId`

## Design sections to implement
- docs/design/02 §3.2, §7.4, §8
- docs/design/08 §5.4–5.6, §8.3

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
