/**
 * concept module factory (design/11). Registers: N1 participant (order 50), task kinds concept_turn /
 * import_concept / check_concept_brief, hitl approval handler `concept_brief`, messaging inbound handler
 * `concept_message`, prompt templates (agents registry when available), idle sweeper loop.
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { HitlService } from "../hitl/index.js";
import type { LlmService } from "../llm/index.js";
import type { MessagingService } from "../messaging/index.js";
import type { NovelService } from "../novel/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { BudgetService } from "../budget/index.js";
import type { ConceptService } from "./index.js";
import { createConceptApp, type ConceptApp } from "./application/concept-app.js";
import { renderTurnPrompt, renderImportPrompt, renderCheckPrompt, renderTitlesPrompt } from "./application/prompts.js";
import { mountConceptRoutes } from "./adapters/http/routes.js";

export interface ConceptModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  llm: LlmService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  messaging: MessagingService;
  hitl: HitlService;
}

/** test hook: internals of a created concept module keyed by its service object */
const INTERNALS = new WeakMap<object, ConceptApp>();
export function conceptInternals(service: ConceptService): ConceptApp {
  const app = INTERNALS.get(service);
  if (!app) throw new Error("not a concept module service");
  return app;
}

export function createConceptModule(deps: ConceptModuleDeps): ServerModule<ConceptService> {
  const app = createConceptApp(deps);
  const service = app.service;
  INTERNALS.set(service, app);

  deps.novel.registerCreationParticipant({
    module: "concept",
    order: 50,
    async onNovelCreated(ctx) {
      if (!ctx.outputs.webChannelId) throw new Error("concept participant requires the web channel (messaging, order 20)");
      const s = await service.startInitialSession(
        ctx.tx,
        ctx.scope,
        { entryMode: ctx.entryMode, activeChannelId: ctx.outputs.webChannelId, createdByUserId: ctx.ownerUserId },
        ctx.actor,
      );
      ctx.outputs.conceptSessionId = s.id;
    },
  });

  deps.orchestration.registerTaskKind(app.handlers.turn);
  deps.orchestration.registerTaskKind(app.handlers.import);
  deps.orchestration.registerTaskKind(app.handlers.check);
  deps.hitl.registerApprovalHandler("concept_brief", app.onApprovalDecided);
  deps.messaging.registerInboundHandler({ kinds: ["concept_message"], handle: app.onInbound });

  // prompt templates live here (concept-specific structured context, 11 §2.6); expose them in the agents registry
  const templates = [
    { id: app.templates.TURN_TEMPLATE_ID, role: "concept_partner", kind: "concept_turn", render: (v: Parameters<typeof renderTurnPrompt>[0]) => renderTurnPrompt(v) },
    { id: app.templates.IMPORT_TEMPLATE_ID, role: "concept_partner", kind: "import_concept", render: (v: { brief: Parameters<typeof renderImportPrompt>[0]; text: string }) => renderImportPrompt(v.brief, v.text) },
    { id: app.templates.TITLES_TEMPLATE_ID, role: "concept_partner", kind: "concept_turn", render: (v: Parameters<typeof renderTitlesPrompt>[0]) => renderTitlesPrompt(v) },
    { id: app.templates.CHECK_TEMPLATE_ID, role: "continuity_editor", kind: "check_concept_brief", render: (v: { brief: Parameters<typeof renderCheckPrompt>[0] }) => renderCheckPrompt(v.brief) },
  ] as const;
  for (const t of templates) {
    try {
      deps.agents.registerPromptTemplate({ id: t.id, role: t.role, kind: t.kind, version: t.id.split("@")[1]!, render: (vars: never) => t.render(vars) });
    } catch (err) {
      deps.platform.log.debug({ err, id: t.id }, "concept prompt template not registered in agents");
    }
  }

  return {
    name: "concept",
    implemented: true,
    service,
    routes: (r) => mountConceptRoutes(r, service),
    loops: [
      {
        name: "concept.idle_sweeper",
        intervalMs: 3_600_000,
        runOnStart: false,
        async tick() {
          await service.sweepIdle();
        },
      },
    ],
  };
}
