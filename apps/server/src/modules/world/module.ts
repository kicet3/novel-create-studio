/**
 * world module factory (설계 추가: 세계관 온톨로지). Registers: novel status hook (N2 → build_world_ontology), task kind
 * build_world_ontology (agents.defineAgentTask), context section `world` (agents), routes.
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { ConceptService } from "../concept/index.js";
import type { LlmService } from "../llm/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { WorldService } from "./index.js";
import { createWorldService } from "./application/world-service.js";
import { mountWorldRoutes } from "./adapters/http/routes.js";

export interface WorldModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  llm: LlmService;
  concept: ConceptService;
}

export function createWorldModule(deps: WorldModuleDeps): ServerModule<WorldService> {
  const app = createWorldService(deps);
  deps.novel.onStatusChanged(app.onNovelStatusChanged);
  deps.orchestration.registerTaskKind(deps.agents.defineAgentTask(app.handler));
  deps.agents.registerContextSection({
    section: "world",
    module: "world",
    async build(scope) {
      const r = await app.service.renderWorldContext(scope);
      return r.text ? { text: r.text, tokenEstimate: 0, refs: { factVersionIds: r.factVersionIds, candidateFactVersionIds: r.candidateFactVersionIds } } : null;
    },
  });
  return {
    name: "world",
    implemented: true,
    service: app.service,
    routes: (r) => mountWorldRoutes(r, app.service),
  };
}
