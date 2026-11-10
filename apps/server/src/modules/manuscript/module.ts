/** Factory of `manuscript` (07 writing pipeline, 03 §4.1 E1–E16). */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { HitlService } from "../hitl/index.js";
import type { LinkingService } from "../linking/index.js";
import type { MessagingService } from "../messaging/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { ManuscriptService } from "./index.js";
import { mountManuscriptRoutes } from "./adapters/http/routes.js";
import { mountReaderRoutes } from "./adapters/http/reader-routes.js";
import { createTaskRegistrar } from "./application/agent-task.js";
import { createContextSections } from "./application/context-sections.js";
import { createHandoff } from "./application/handoff.js";
import { createManuscriptService } from "./application/manuscript-service.js";
import { createPendingCanon } from "./application/pending-canon.js";
import { createPlanning } from "./application/planning.js";
import { createStructure } from "./application/structure.js";
import { createPorts, createRegistries } from "./application/support.js";
import { createWriting } from "./application/writing.js";
import { createEpisodeUnits } from "./application/episode-units.js";

export interface ManuscriptModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  linking: LinkingService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  hitl: HitlService;
  /** 설계 추가: web channel of the structure decision (hitl.acceptAnswer); optional for older compositions */
  messaging?: MessagingService;
}

/** test seam: approval handlers / scheduler of a built module (tests only; other modules use index.ts) */
export const manuscriptTestHooks = new WeakMap<
  ManuscriptService,
  { approvalHandlers: ReturnType<typeof createPlanning>["approvalHandlers"] & ReturnType<typeof createStructure>["approvalHandlers"] & { episode_titles: ReturnType<typeof createEpisodeUnits>["decideRetitle"] } }
>();

export function createManuscriptModule(deps: ManuscriptModuleDeps): ServerModule<ManuscriptService> {
  const reg = createRegistries();
  const ports = createPorts(deps, reg);
  const { service, internals } = createManuscriptService(ports);
  const getService = () => service;
  const structure = createStructure(internals, getService);
  const handoff = createHandoff(ports);
  // 설계 추가 0023: 에피소드 묶음 (story episodes, "제목 (1)(2)") + [제목 정리]
  const units = createEpisodeUnits(ports);
  const planning = createPlanning(internals, getService, structure, handoff, units);
  const writing = createWriting(internals, getService);
  service.requestArcPlanApproval = planning.requestArcPlanApproval;
  service.schedule = planning.schedule;
  service.getEpisodeEnd = handoff.getEpisodeEnd;
  // 설계 추가(미확정 사실 선행 집필): provisional facts of earlier episodes waiting for approval
  const pending = createPendingCanon(ports);
  service.listPendingPriorFacts = pending.listPendingPriorFacts;
  Object.assign(service, structure.service);
  service.listEpisodeUnits = units.listUnits;
  service.withUnitInfo = units.withUnitInfo;
  service.getEpisodeUnitContext = units.unitContext;
  service.proposeRetitle = units.proposeRetitle;
  service.getRetitle = units.getRetitle;
  service.applyRetitle = units.applyRetitle;

  // registrations (CONVENTIONS §6): context sections, task kinds, approval handlers, N3 hook
  const sections = [...createContextSections(ports), ...handoff.sections, structure.section, pending.section];
  for (const s of sections) deps.agents.registerContextSection(s);
  const register = createTaskRegistrar(ports, sections);
  for (const h of [...planning.handlers, ...structure.handlers, ...writing.handlers]) register(h);
  // 설계 추가 0019: summarize_episode (continuity_editor) + its triggers on episode transitions
  deps.orchestration.registerTaskKind(deps.agents.defineAgentTask(handoff.handler));
  reg.transitionHooks.push((ctx) => handoff.onTransition(ctx));
  const approvalHandlers = { ...planning.approvalHandlers, ...structure.approvalHandlers, episode_titles: units.decideRetitle };
  for (const [type, handler] of Object.entries(approvalHandlers)) {
    deps.hitl.registerApprovalHandler(type as keyof typeof approvalHandlers, handler);
  }
  deps.novel.onGoalSaved((ctx) => planning.onGoalSaved(ctx));
  // scene texts for extract_facts / link_mentions (linking registry, CONVENTIONS §6)
  deps.linking.registerSceneSource({
    async getScenes(scope, { episodeId, manuscriptVersionId }) {
      const version = await service.getVersion(scope, manuscriptVersionId);
      const scenes = await service.listScenes(scope, episodeId, { versionId: manuscriptVersionId });
      return scenes.map((sc) => ({
        sceneId: sc.id,
        sceneOrd: sc.ord,
        storyPoint: sc.storyPoint,
        timelineId: sc.timelineId,
        text: version.content.slice(sc.charStart, sc.charEnd),
        charOffset: sc.charStart,
        povEntityId: sc.povEntityId,
        narrationMode: sc.narrationMode,
        participantEntityIds: [],
      }));
    },
  });
  manuscriptTestHooks.set(service, { approvalHandlers });

  const tick = async (signal: AbortSignal) => {
    for (const n of await deps.novel.listNovels()) {
      if (signal.aborted) return;
      if (n.status !== "planning" && n.status !== "serializing") continue;
      await planning.schedule({ novelId: n.id }).catch((err) => deps.platform.log.warn({ err, novelId: n.id }, "manuscript scheduler tick failed"));
    }
  };

  return {
    name: "manuscript",
    implemented: true,
    service,
    routes: (r) => {
      mountManuscriptRoutes(r, service, deps.novel);
      // 읽기(reader): read-only text + TOC
      mountReaderRoutes(r, { service, novel: deps.novel, db: deps.platform.uow.db });
    },
    loops: [{ name: "manuscript.scheduler", intervalMs: 30_000, wakeOn: ["wake", "task"], tick }],
    // 설계 추가 0019: approved episodes without a handoff / summary of their latest text get one (once per version)
    async start() {
      await handoff.backfillAll();
    },
  };
}
