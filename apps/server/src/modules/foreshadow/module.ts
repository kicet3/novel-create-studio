/** foreshadow module factory (03 §3.7, §4.7; 06 §8; 07 §1.3, §5.2). */
import { NotImplementedError, type Platform, type ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService, AgentTaskHandler } from "../agents/index.js";
import type { HitlService } from "../hitl/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { ForeshadowService } from "./index.js";
import { mountForeshadowRoutes } from "./adapters/http/routes.js";
import { createForeshadowService } from "./application/foreshadow-service.js";
import { assignedBeatsSection, beatsAnnotator, foreshadowGateContributor, foreshadowTransitionHook, setupAbandonHandler, setupDueApplier } from "./application/hooks.js";
import { checkSetupsHandler, planSetupsHandler, reviewSetupDueHandler } from "./application/tasks.js";

export interface ForeshadowModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  manuscript: ManuscriptService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  hitl: HitlService;
}

export function createForeshadowModule(deps: ForeshadowModuleDeps): ServerModule<ForeshadowService> {
  const service = createForeshadowService(deps);
  const log = deps.platform.log;

  // synchronous registrations (registries of modules built earlier)
  deps.manuscript.registerCheckGateContributor(foreshadowGateContributor(service));
  deps.manuscript.onEpisodeTransition(foreshadowTransitionHook(deps, service));
  // 03 §4.7 SC2/SC3: arc plan approved → the arc's candidate setups approved; rejected → rejected
  deps.manuscript.onArcPlanDecision?.(async ({ tx, scope, arcId, decision, actor, approvalId }) => {
    await service.applyArcPlanDecision(tx, scope, arcId, decision, actor, approvalId);
  });
  deps.manuscript.registerVersionAnnotator?.("beats", beatsAnnotator(deps));
  deps.agents.registerContextSection(assignedBeatsSection(deps, service));
  deps.hitl.registerAnswerApplier("setup_due", setupDueApplier(deps, service));
  deps.hitl.registerApprovalHandler("setup_abandon", setupAbandonHandler(service));

  const handlers: AgentTaskHandler<any, any>[] = [planSetupsHandler(deps, service), checkSetupsHandler(deps, service), reviewSetupDueHandler(deps, service)];

  return {
    name: "foreshadow",
    implemented: true,
    service,
    routes: (r) => mountForeshadowRoutes(r, service),
    async start() {
      for (const h of handlers) {
        try {
          deps.orchestration.registerTaskKind(deps.agents.defineAgentTask(h));
        } catch (err) {
          if (!(err instanceof NotImplementedError)) throw err;
          log.warn({ kind: h.kind }, "foreshadow: agents.defineAgentTask not implemented yet — task kind not registered");
        }
      }
    },
  };
}
