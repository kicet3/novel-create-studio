/** continuity module factory (03 §3.6, §4.6; 06 §9; 07 §5.1, §5.3–5.6). */
import { NotImplementedError, type Platform, type ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { ForeshadowService } from "../foreshadow/index.js";
import type { HitlService } from "../hitl/index.js";
import type { LinkingService } from "../linking/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { ContinuityService } from "./index.js";
import { mountContinuityRoutes } from "./adapters/http/routes.js";
import { checkContinuityHandler } from "./application/check-continuity.js";
import { createContinuityService } from "./application/continuity-service.js";
import { continuityGateContributor, continuityTransitionHook, issuesAnnotator } from "./application/hooks.js";
import { createPendingDependents } from "./application/pending-dependents.js";

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
  /** 설계 추가(미확정 사실 선행 집필): extract_facts commit hook (pending facts of an earlier episode changed) */
  linking?: Pick<LinkingService, "registerFactReconciler">;
}

export function createContinuityModule(deps: ContinuityModuleDeps): ServerModule<ContinuityService> {
  const service = createContinuityService(deps);

  deps.manuscript.registerCheckGateContributor(continuityGateContributor(deps));
  const pending = createPendingDependents(deps, service);
  deps.manuscript.onEpisodeTransition(continuityTransitionHook(deps, service, pending));
  deps.linking?.registerFactReconciler(pending.reconciler);
  deps.manuscript.registerIssueSink?.(service.safetyIssueSink);
  deps.manuscript.registerVersionAnnotator?.("issues", issuesAnnotator(deps));
  // 설계 추가(화 삭제): issues about a deleted manuscript go with it
  deps.manuscript.registerEpisodeDeleteParticipant?.({
    name: "issues",
    count: (scope, ctx, tx) => service.countEpisodeIssues(scope, ctx, tx),
    async purge(tx, scope, ctx, actor) {
      const r = await service.purgeEpisodeIssues(tx, scope, ctx, actor);
      return { count: r.deleted, questionIds: r.questionIds };
    },
  });
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
