/** ontology module factory: OntologyRepository + use cases, N1 participant, `ontology_integrity` health check, UI read API. */
import { novelScope, type Platform, type ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { NovelService } from "../novel/index.js";
import type { SystemService } from "../system/index.js";
import type { OntologyService } from "./index.js";
import { createOntologyService } from "./application/ontology-service.js";
import { mountOntologyRoutes } from "./adapters/http/routes.js";

export interface OntologyModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  /** health-check registry (ontology_integrity) */
  system: SystemService;
}

export function createOntologyModule(deps: OntologyModuleDeps): ServerModule<OntologyService> {
  const service = createOntologyService(deps);
  deps.novel.registerCreationParticipant({
    module: "ontology",
    order: 10,
    async onNovelCreated(ctx) {
      const r = await service.initializeNovel(ctx.tx, ctx.scope, ctx.schemaVersionId);
      ctx.outputs.mainTimelineId = r.mainTimelineId;
    },
  });
  deps.system.registerHealthCheck({
    name: "ontology_integrity",
    kind: "ontology_integrity",
    scope: "novel",
    async run(ctx) {
      if (!ctx.novelId) return { status: "pass", message: "작품이 없습니다." };
      const problems = await service.checkIntegrity(novelScope(ctx.novelId));
      if (problems.length === 0) return { status: "pass", message: "온톨로지 무결성 점검을 통과했습니다." };
      const severe = problems.some((p) => p.rule === "INV-ONT-05" || p.rule === "INV-ONT-07" || p.rule === "INV-ONT-09");
      return {
        status: severe ? "fail" : "warn",
        message: `온톨로지 무결성 문제 ${problems.length}건이 있습니다.`,
        details: { problems: problems.map((p) => ({ rule: p.rule, message: p.message, count: p.refs.length, refs: p.refs.slice(0, 20) })) },
      };
    },
  });
  return {
    name: "ontology",
    implemented: true,
    service,
    routes: (r) => mountOntologyRoutes(r, service, deps.platform.uow),
  };
}
