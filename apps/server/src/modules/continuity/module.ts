/** continuity module factory (03 §3.6, §4.6; 06 §9; 07 §5.1, §5.3–5.6). */
import { NotImplementedError, type Platform, type ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { ForeshadowService } from "../foreshadow/index.js";
import type { HitlService } from "../hitl/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { ContinuityService } from "./index.js";
import { mountContinuityRoutes } from "./adapters/http/routes.js";
import { checkContinuityHandler } from "./application/check-continuity.js";
import { createContinuityService } from "./application/continuity-service.js";
import { continuityGateContributor, continuityTransitionHook, issuesAnnotator } from "./application/hooks.js";

export interface ContinuityModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  manuscript: ManuscriptService;
  foreshadow: ForeshadowService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  hitl: HitlService;
}

export function createContinuityModule(deps: ContinuityModuleDeps): ServerModule<ContinuityService> {
  const service = createContinuityService(deps);

  deps.manuscript.registerCheckGateContributor(continuityGateContributor(deps));
  deps.manuscript.onEpisodeTransition(continuityTransitionHook(deps, service));
  deps.manuscript.registerIssueSink?.(service.safetyIssueSink);
  deps.manuscript.registerVersionAnnotator?.("issues", issuesAnnotator(deps));
  deps.foreshadow.registerIssueSink(service.setupIssueSink);

  const handler = checkContinuityHandler(deps, service);
  return {
    name: "continuity",
    implemented: true,
    service,
    routes: (r) => mountContinuityRoutes(r, service, deps.platform.uow),
    async start() {
      try {
        deps.orchestration.registerTaskKind(deps.agents.defineAgentTask(handler));
      } catch (err) {
        if (!(err instanceof NotImplementedError)) throw err;
        deps.platform.log.warn({ kind: handler.kind }, "continuity: agents.defineAgentTask not implemented yet — task kind not registered");
      }
    },
  };
}
