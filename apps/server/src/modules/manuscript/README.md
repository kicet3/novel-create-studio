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
- agents context sections outline / recent_text

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
