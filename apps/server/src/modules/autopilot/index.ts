/**
 * autopilot — public API (설계 추가 0014: 완전 자율 진행). Owns no table: settings / state / kill switch live on
 * `novels` (module novel), decisions are approvals / answers (module hitl) with provenance "자동 승인" / "자동 응답".
 *
 * When a novel is at autonomy level `full_auto` the loop `autopilot.tick` (30 s + "autopilot" / "task" / "question" /
 * "wake" hints) keeps the novel moving without the author:
 *  1. kill switch / pause / budget (monthly warning → halt, daily cap → throttle until local midnight)
 *  2. front steps: concept confirm (opt-in) → world candidates → cast fill + confirm → goal
 *  3. pending approvals: decided by `domain/policy.ts` (episode, arc_plan, series_bible, story_structure (opt-in),
 *     concept_brief (opt-in)); always-human types and ineligible ones are handed to the author (inbox + messenger) and
 *     only that branch waits
 *  4. open questions: low-sensitivity choice questions answered with the recommendation after N minutes
 *  5. scheduled publishing (publish_policy=scheduled)
 *  6. status summary (banner "완전 자율 진행 중 · 다음: …")
 * The scheduler (manuscript) reads the same novel row for the kill switch / throttle / daily episode cap.
 */
import type { AutopilotView } from "@ncs/shared";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export interface AutopilotService {
  getView(scope: NovelScope): Promise<AutopilotView>;
  /** one pass for one novel (tests / CLI); the loop calls it for every full_auto novel */
  tick(scope: NovelScope): Promise<AutopilotTickResult>;
  /** one pass over every full_auto novel */
  runOnce(): Promise<number>;
  halt(scope: NovelScope, input: { alsoPauseTasks?: boolean; reason?: string }, actor: ActorRef): Promise<AutopilotView>;
  resume(scope: NovelScope, actor: ActorRef): Promise<AutopilotView>;
}

export interface AutopilotTickResult {
  skipped: string | null;
  steps: string[];
  decided: string[];
  answered: string[];
  published: string[];
  gates: string[];
}

export type { AutopilotModuleDeps } from "./module.js";
export { createAutopilotModule } from "./module.js";
