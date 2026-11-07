# module `manuscript`

- **Status:** implemented (MVP-α, A4)
- **Next-phase owner:** A4 manuscript+export (writing pipeline)
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createManuscriptModule` in `module.ts`.

## Responsibilities
- Episode E1–E16, block reasons, pause; ManuscriptVersion (append-only, attribution spans 07 §7.2), char counts (FR-MAN-02)
- scene split + scene-ID retention (07 §6), rejection E10/E11, publish/unpublish E13/E14, human edit E16
- planning + writing task handlers: plan_series_bible, plan_arc, schedule_episodes, outline_episode, draft_episode, split_scenes, polish_episode, revise_episode, plan_rework, check_text_safety
- approval handlers series_bible / arc_plan / arc / episode; novel.onGoalSaved → plan_series_bible (N3)
- check gate (07 §5.3) from registered contributors; onEpisodeTransition hooks
- 설계 추가 0019 화 사이 이어짐 (`application/handoff.ts`): `summarize_episode` (continuity_editor) writes the episode's
  end state (handoff) + 3–5 line summary into episode_recaps on approval, when the text changes after the next episode
  started (older recaps → `stale_at`) and before the next outline; boot backfill once per version (`recap_backfill@1:<version>`).
  Sections `prev_handoff` (직전 화 끝 상태) / `story_so_far` (지금까지의 줄거리); outline/draft keep `recent_text` + `prev_handoff`
  under any budget; `getEpisodeEnd` gives continuity the latest N-1 text for the opening-continuity check.
  N's `outline_episode` gate defers (stays ready, re-tried next tick — `{ ok: false, defer: true }`) while a summarize_episode
  of N-1 is pending / ready / running; a failed / blocked recap does not hold it. Recap priority 800 > outline max.

## Owned tables (`@ncs/db/schema/manuscript.ts`)
- episodes
- manuscript_versions (append-only)
- episode_rejections
- scenes
- scene_participants
- episode_recaps

## Depends on (via their `index.ts` only)
- audit, novel, ontology, linking, orchestration, agents, hitl

## Registers into other modules
- task kinds ×10
- hitl approval handlers ×4
- novel goal hook
- agents context sections outline / recent_text / prev_handoff / story_so_far

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET …/episodes`
- `GET …/episodes/:episodeNo`
- `GET …/episodes/:episodeNo/versions`
- `GET …/versions/:versionId?with=spans,scenes,issues,beats`
- `POST …/episodes/:episodeNo/versions (E16)`
- `POST …/episodes/:episodeNo/revision-request (E11)`
- `POST …/episodes/:episodeNo/publish|unpublish`
- `POST …/episodes/:episodeNo/pause|resume`
- `GET …/episodes/:episodeNo/scenes`
- `POST …/planning/schedule (수동 트리거)`

## Design sections to implement
- docs/design/03 §3.2, §4.1
- docs/design/07 (전체)
- docs/design/04 §3.3
- docs/design/05 §10

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.

## Implementation notes (A4)
- `domain/`: `transitions.ts` (E1–E16 table + audit action per rule), `diff.ts` (Myers token diff → position map),
  `attribution.ts` (07 §7.2 spans, INV-MV-02/03), `scenes.ts` (scene-ID retention 07 §6.3 incl. move detection),
  `gate.ts` (GC-1…GC-6), `text.ts` (single char-count implementation, fact signature), `schemas.ts` (zod for
  OutlineData / WriterAnnotations / every LLM proposal), `synth.ts` (deterministic completion of sparse model proposals; never prose).
- `application/agent-task.ts`: registers task kinds through `agents.defineAgentTask` (model calls go through the
  llm `ModelCallPort`; there is no local stand-in model — an empty draft fails the task with `invalid_output`).
- Gate evaluation runs AFTER the check task's commit (`advanceCheckGate` → `tx.afterCommit`) because
  `orchestration.listTasks` has no `tx` (PGlite single connection); the `manuscript.scheduler` loop (30 s,
  wakes on `wake`/`task`) sweeps `checking` episodes and runs the deterministic P0 scheduler (04 §3.4).
- Widened contract: `requestRevision`, `advanceCheckGate`, `requestArcPlanApproval`, `schedule`,
  `registerIssueSink`, `registerPlannedBeatSource`, `registerVersionAnnotator`, `getVersionDetail`;
  `CheckGateVerdict.blockers[].sceneId`.
- Extra endpoint: `GET …/reserve`, `GET …/versions/:id?with=…,lines`.

## 전체 구성 → 플롯 → 화 (설계 추가 0008)

흐름: 기획서 승인 → (초기 캐스트 완성도 충족 시) `plan_structure` 자동 생성 → 4부 + 구조화된 결말 → `story_structure` 승인(사용자만, full_auto 포함) → 부마다 플롯(arcs, status planned, 화 0개) 생성 → `schedule_episodes`가 다음 플롯에 `plan_arc` → 플롯 세부(핵심 사건·변화·떡밥·등장 인물) + 화 계획(`plan_summary`·`planned_scene_count`·`target_chars`) + 신규 인물 제안 → `arc_plan` 승인(autonomy 규칙, 신규 인물 완성도 게이트 422 `plot_cast_incomplete`) → outline → draft.

- 구성 재승인: 결말 변경이면 화가 있는 진행 플롯에 `ending_changed`, 바뀐 부의 플롯에 `part_changed` 확인 표시. planned / plan_awaiting 플롯은 바로 `plan_arc {replan:true}`로 다시 계획하고, active 플롯은 사용자가 `POST …/arcs/:arcId/replan` 또는 `acknowledge-flags`로 결정합니다. 표시가 있는 플롯에는 새 아웃라인을 만들지 않습니다.
- 컨텍스트 섹션 `story_plan`(rank 2, 버리지 않음): 결말, 현재 부 목표·부 끝 인물 상태, 현재 플롯, 이번 화 계획. outline / draft / revise / polish / check_continuity / plan_arc에 들어갑니다.
- 캐스트는 `registerPlanningCastPort`로 완성도·로스터·첫 등장·플롯 인물 제안/확정·빈 항목 채우기를 제공합니다(cast가 manuscript보다 나중에 만들어짐).
- 분량: 프로필 `minChars`(기본 5000)는 목표치 — 초고가 짧으면 아웃라인 기준으로 최대 2회 이어쓰기(`draft_continue`, 한 번에 200자 미만 늘면 중단). 절대 하한 3,000자(`EPISODE_HARD_MIN_CHARS`, 작품 count_basis): 다듬기·수정이 씬을 줄여 하한 밑으로 가면 원래 씬 유지(전체가 줄면 새 버전 없음), 하한 미달 화는 full_auto 자동 승인·arc 단위 승인을 하지 않고 "분량 미달" 개별 승인을 요청, 사용자가 아닌 주체의 승인·공개는 422 `length_below_floor`. 화 목록·상세·구성 화면에 `lengthBelowFloor`.
- 분량 맞추기(설계 추가 0017): 초고·수정본이 `[minChars, maxChars × 1.03]`(`length.adjust_tolerance_ratio`)을 벗어나면 `adjust_length`(writer) 작업이 씬별로 줄이기/늘리기 패스를 돌려 범위 중간을 노립니다(최대 `length.adjust_max_rounds`=2회, 범위에 가까워지지 않으면 중단). 다듬기 뒤에도 벗어나면 1회 더. 프롬프트는 "현재 N자, 결과는 min~max자 사이"를 씁니다. 다듬기는 최대 분량을 넘겨 씬을 늘리지 않고, 수정은 원문+새 글(두 벌)·1.6배 넘게 불어난 씬을 받지 않습니다. 범위 밖인 화의 승인 요청 payload에 `lengthOutOfRange` — full_auto는 자동 승인하지 않고 작가에게 넘깁니다(gate `length_out_of_range`).
