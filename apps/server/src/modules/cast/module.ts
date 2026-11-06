/**
 * cast module factory (설계 추가: 캐릭터 설정 단계). Registers: novel status hook (N2 → seed from the approved
 * brief), novel goal guard (`cast_not_confirmed` before N3), task kinds draft_cast / draft_design_sheet, prompt
 * templates (agents registry), context section `cast` (agents), routes.
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { ConceptService } from "../concept/index.js";
import type { ImagingService } from "../imaging/index.js";
import type { LlmService } from "../llm/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { CastService } from "./index.js";
import type { WorldService } from "../world/index.js";
import { createCastService } from "./application/cast-service.js";
import { DRAFT_CAST_TEMPLATE_ID, DRAFT_SHEET_TEMPLATE_ID, renderCastDraftPrompt, renderSheetDraftPrompt } from "./application/prompts.js";
import { mountCastRoutes } from "./adapters/http/routes.js";

export interface CastModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  llm: LlmService;
  concept: ConceptService;
  imaging: ImagingService;
  /** 설계 추가: PlanningCastPort registration + episode numbers of the cast context */
  manuscript?: ManuscriptService;
  /** 설계 추가(world): world ontology text for the cast draft */
  world?: WorldService;
}

export function createCastModule(deps: CastModuleDeps): ServerModule<CastService> {
  const app = createCastService(deps);
  const service = app.service;

  deps.novel.onStatusChanged(app.onNovelStatusChanged);
  deps.novel.registerGoalGuard({ module: "cast", check: app.goalGuard });
  deps.orchestration.registerTaskKind(app.handlers.draftCast);
  deps.orchestration.registerTaskKind(app.handlers.draftSheet);
  deps.manuscript?.registerPlanningCastPort(app.port);
  deps.agents.registerContextSection({
    section: "cast",
    module: "cast",
    async build(scope, spec) {
      // outline participants get the full profile; first-appearance marks need the episode number
      let episodeNo: number | undefined;
      if (spec.episodeId && deps.manuscript) {
        try {
          episodeNo = (await deps.manuscript.getEpisode(scope, spec.episodeId)).episodeNo;
        } catch {
          episodeNo = undefined;
        }
      }
      const r = await service.renderCastContext(scope, { focusEntityIds: spec.episodeId ? spec.seeds.entityIds : [], episodeNo });
      return r.text ? { text: r.text, tokenEstimate: 0, refs: { entityIds: r.entityIds } } : null;
    },
  });

  const templates = [
    { id: DRAFT_CAST_TEMPLATE_ID, role: "concept_partner", kind: "draft_cast", render: (v: Parameters<typeof renderCastDraftPrompt>[0]) => renderCastDraftPrompt(v) },
    { id: DRAFT_SHEET_TEMPLATE_ID, role: "world_keeper", kind: "draft_design_sheet", render: (v: Parameters<typeof renderSheetDraftPrompt>[0]) => renderSheetDraftPrompt(v) },
  ] as const;
  for (const t of templates) {
    try {
      deps.agents.registerPromptTemplate({ id: t.id, role: t.role, kind: t.kind, version: t.id.split("@")[1]!, render: (vars: never) => t.render(vars) });
    } catch (err) {
      deps.platform.log.debug({ err, id: t.id }, "cast prompt template not registered in agents");
    }
  }

  return {
    name: "cast",
    implemented: true,
    service,
    routes: (r) => mountCastRoutes(r, service),
  };
}
