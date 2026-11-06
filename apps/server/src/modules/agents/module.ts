/** agents module factory (04 §2, §6.1, §9, §10.2). */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { LlmService } from "../llm/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { AgentsService } from "./index.js";
import { createAgentsService } from "./application/agents-service.js";
import { mountAgentsRoutes } from "./adapters/http/routes.js";

export interface AgentsModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  llm: LlmService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
}

export function createAgentsModule(deps: AgentsModuleDeps): ServerModule<AgentsService> {
  const service = createAgentsService(deps);
  return { name: "agents", implemented: true, service, routes: (r) => mountAgentsRoutes(r, service) };
}
