# module `novel`

- **Status:** implemented
- **Next-phase owner:** (done — contracts phase)
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createNovelModule` in `module.ts`.

## Responsibilities
- owner user (INV-USR-01)
- N1 creation transaction with creation participants (INV-NOV-06)
- novel_status N2–N6, settings, autonomy (INV-NOV-02/04), pause/resume flags
- Goal (N3, revisions, optimistic check), SeriesBible versions/transitions (INV-BIB-01), Arcs (INV-ARC-01, arc_status table), LengthProfile, NotificationPolicy, display-number counters
- hooks: `registerCreationParticipant`, `onStatusChanged`, `onGoalSaved`

## Owned tables (`@ncs/db/schema/novel.ts`)
- users
- novels
- goals
- series_bibles
- arcs
- length_profiles
- notification_policies
- novel_counters

## Depends on (via their `index.ts` only)
- audit

## Registers into other modules
- —

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET /api/me`
- `GET /api/length-profiles`
- `GET|POST /api/novels`
- `GET|PATCH /api/novels/:novelId`
- `PUT …/autonomy`
- `POST …/pause, …/resume, …/status`
- `GET|PUT …/goal`
- `GET …/bibles, …/bibles/approved, …/bibles/:bibleId`
- `GET|POST …/arcs, GET|PATCH …/arcs/:arcId, POST …/arcs/:arcId/pause|resume`
- `GET|PATCH …/length-profile`
- `GET|PATCH …/notification-policy`

## Design sections to implement
- docs/design/03 §3.1, §4.11, §4.12
- docs/design/11 §5.8 (M-01~M-05)
- docs/design/08 §9.8 (작품 설정)

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Goal guards (설계 추가)
`registerGoalGuard({ module, check })` runs inside `saveGoal` before the FIRST goal insert while the novel is `onboarding` (N3).
`cast` registers one: 422 `cast_not_confirmed` until the cast (exactly one protagonist, all characters confirmed) is confirmed.
