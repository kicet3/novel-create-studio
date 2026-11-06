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

## 전체 구성 저장 (설계 추가 0008)

- 테이블 `story_structures`(작품당 1행, `revision`으로 개정, 상태 `draft → awaiting_approval → approved`)와 `story_parts`(ord 1..4 고정 4행). 플롯 = `arcs`(`part_id`, `core_event`, `involved_character_ids`, `change_text`, `setup_plan`, `plan_flags`).
- 전이표 `STRUCTURE_TRANSITIONS` ST1–ST5(`domain/structure.ts`). 승인된 구성을 사용자가 고치거나(결말·부), AI가 다시 만들거나, 목표 `ending_change`가 승인되면 ST4로 draft가 되고 `pending_changes`(ending / partIds / goalEndingChanged / regenerated)에 이유를 남깁니다. 승인 대기 중 편집은 ST5(대기 승인 취소).
- `saveStructureProposal`(agent)은 user 출처 필드를 덮어쓰지 않습니다. 사용자가 범위를 바꾼 부는 AI 플롯 개요를 그 범위에 맞춰 다시 나눕니다.
- 부 범위 편집은 이웃 부의 경계를 같이 옮기고(연속 1..total 유지), 진행 중 플롯이 범위 밖으로 나가면 422 `part_range_locked`.
- 분량 프로필 하한: `minChars < 3000`이면 422 `length_min_too_low`(DDL `length_profiles_ck_min_floor`도 같은 값).
- 생성·승인·플롯 생성은 manuscript(`plan_structure`, `story_structure` 승인 처리기)가 맡습니다.
