/**
 * autopilot module factory (설계 추가 0014: 완전 자율). Registers the hitl auto decider and the loop
 * `autopilot.tick` (30 s + "autopilot" / "task" / "question" / "wake" hints). Built last (it reads every module).
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { BudgetService } from "../budget/index.js";
import type { CastService } from "../cast/index.js";
import type { ConceptService } from "../concept/index.js";
import type { ContinuityService } from "../continuity/index.js";
import type { HitlService } from "../hitl/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { MessagingService } from "../messaging/index.js";
import type { NovelService } from "../novel/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { WorldService } from "../world/index.js";
import type { AutopilotService } from "./index.js";
import { createAutopilotService } from "./application/autopilot-service.js";
import { mountAutopilotRoutes } from "./adapters/http/routes.js";

export interface AutopilotModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  orchestration: OrchestrationService;
  messaging: MessagingService;
  hitl: HitlService;
  manuscript: ManuscriptService;
  continuity: ContinuityService;
  concept: ConceptService;
  world: WorldService;
  cast: CastService;
}

export const AUTOPILOT_TICK_MS = 30_000;

export function createAutopilotModule(deps: AutopilotModuleDeps): ServerModule<AutopilotService> {
  const { service, decider } = createAutopilotService(deps);
  deps.hitl.registerAutoDecider(decider);
  return {
    name: "autopilot",
    implemented: true,
    service,
    routes: (r) => mountAutopilotRoutes(r, service, deps.novel),
    loops: [{ name: "autopilot.tick", intervalMs: AUTOPILOT_TICK_MS, wakeOn: ["autopilot", "question", "task"], tick: async () => void (await service.runOnce()) }],
  };
}
