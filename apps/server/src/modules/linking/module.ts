/** linking module factory: linker service, task kinds ×4, hitl answer appliers + identity_change approval handler. */
import { actors, type NovelScope, type Platform, type ServerModule, type Tx } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { HitlService } from "../hitl/index.js";
import type { LlmService } from "../llm/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { LinkingService, SceneSource } from "./index.js";
import { commitLinkerResult } from "./application/commit.js";
import { buildDisambiguationOptions, confirmMention, disambiguationApplier, duplicateApplier, identityChangeApprovalHandler, relinkMentions } from "./application/decisions.js";
import { runLinker } from "./application/linker.js";
import { buildInitialOntologyHandler, dedupeHandler, defineTask, extractFactsHandler, linkMentionsHandler, type TaskDeps } from "./application/tasks.js";
import { openBacklogQuestions, resolveEntitiesHandler } from "./application/backlog.js";
import { agentSettings } from "./application/commit.js";
import { mountLinkingRoutes } from "./adapters/http/routes.js";

/** 설계 추가 0015: cycle key of the one-time backlog cleanup enqueued at boot (after migration 0015) */
export const BOOT_BACKLOG_CYCLE = "entity_backlog@1";

export interface LinkingModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  llm: LlmService;
  agents: AgentsService;
  orchestration: OrchestrationService;
  /** creates disambiguation questions; registers the entity_disambiguation / duplicate_entity answer appliers */
  hitl: HitlService;
}

function tryRegister(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // placeholder modules throw NotImplementedError for non-register methods; duplicate registration is a bug
    if ((err as { code?: string }).code !== "not_implemented") throw err;
  }
}

export function createLinkingModule(deps: LinkingModuleDeps): ServerModule<LinkingService> {
  const sceneSources: SceneSource[] = [];
  const d = { ontology: deps.ontology, hitl: deps.hitl, novel: deps.novel };
  const service: LinkingService = {
    linkMentions: (scope, input, run) => runLinker({ ontology: deps.ontology, llm: deps.llm }, scope, input, run),
    confirmMention: (tx, scope, mentionId, decision, actor, ctx) => confirmMention(d, tx, scope, mentionId, decision, actor, ctx),
    relinkMentions: (tx, scope, ids, to, actor) => relinkMentions(d, tx, scope, ids, to, actor),
    buildDisambiguationOptions: (scope, mentionId, tx) => buildDisambiguationOptions(d, scope, mentionId, tx),
    registerSceneSource: (src) => void sceneSources.push(src),
    commitLinkerResult: (tx, scope, result, actor, ctx) => commitLinkerResult(d, tx, scope, result, actor, ctx),
  };

  const log = deps.platform.log.child({ module: "linking" });
  const taskDeps: TaskDeps = { ontology: deps.ontology, llm: deps.llm, hitl: deps.hitl, novel: deps.novel, agents: deps.agents, orchestration: deps.orchestration, sceneSources, log, audit: deps.audit };
  deps.orchestration.registerTaskKind(defineTask(taskDeps, extractFactsHandler(taskDeps)));
  deps.orchestration.registerTaskKind(defineTask(taskDeps, linkMentionsHandler(taskDeps)));
  deps.orchestration.registerTaskKind(defineTask(taskDeps, buildInitialOntologyHandler(taskDeps)));
  deps.orchestration.registerTaskKind(dedupeHandler(taskDeps));
  deps.orchestration.registerTaskKind(defineTask(taskDeps, resolveEntitiesHandler({ ontology: deps.ontology, hitl: deps.hitl, novel: deps.novel, audit: deps.audit, log })));

  /** open world_keeper entity questions (+ their interpretation children) */
  async function openBacklog(scope: NovelScope): Promise<number> {
    try {
      // interpretation_confirm children count only when their root is an entity question (interpret_answer is world_keeper too)
      return (await openBacklogQuestions(deps.hitl, scope)).length;
    } catch (err) {
      if ((err as { code?: string }).code === "not_implemented") return 0;
      throw err;
    }
  }
  /** 설계 추가 0015: resolve_entities task (manual: a fresh cycle key; an active one is returned as is) */
  async function enqueueBacklog(tx: Tx, scope: NovelScope, cycleKey: string, reason: string) {
    const active = (await deps.orchestration.listTasks(scope, { kinds: ["resolve_entities"], statuses: ["pending", "ready", "running", "blocked"] }, tx))[0];
    if (active) return { taskId: active.id, created: false };
    return deps.orchestration.createTask(tx, scope, { kind: "resolve_entities", targetType: "novel", targetId: scope.novelId, input: { reason }, cycleKey, createdBy: actors.system("orchestrator"), priority: 650 });
  }
  const backlog = {
    openBacklog,
    async request(scope: NovelScope, actor: { type: "user"; id: string }) {
      const open = await openBacklog(scope);
      const r = await deps.platform.uow.run((tx) => enqueueBacklog(tx, scope, `entity_backlog:${deps.platform.clock.date().getTime()}`, `manual:${actor.id}`));
      deps.platform.workSignal.notify("wake", scope.novelId);
      return { ...r, openQuestions: open };
    },
  };

  tryRegister(() => deps.hitl.registerAnswerApplier("entity_disambiguation", disambiguationApplier(d)));
  tryRegister(() => deps.hitl.registerAnswerApplier("duplicate_entity", duplicateApplier(d)));
  tryRegister(() => deps.hitl.registerApprovalHandler("identity_change", identityChangeApprovalHandler(d)));

  return {
    name: "linking",
    implemented: true,
    service,
    routes: (r) => mountLinkingRoutes(r, backlog),
    // 설계 추가 0015: once per novel (cycle key entity_backlog@1, any status): the existing backlog is cleaned by the agent
    async start() {
      let novels: Awaited<ReturnType<NovelService["listNovels"]>> = [];
      try {
        novels = await deps.novel.listNovels();
      } catch {
        return;
      }
      for (const n of novels) {
        const scope = { novelId: n.id };
        try {
          if (!(await agentSettings(deps.novel, scope)).enabled) continue;
          if ((await openBacklog(scope)) === 0) continue;
          const done = (await deps.orchestration.listTasks(scope, { kinds: ["resolve_entities"], includeCancelled: true, limit: 200 })).some((t) => (t.input as { cycle_key?: string } | null)?.cycle_key === BOOT_BACKLOG_CYCLE);
          if (done) continue;
          await deps.platform.uow.run((tx) => enqueueBacklog(tx, scope, BOOT_BACKLOG_CYCLE, "boot"));
        } catch (err) {
          log.warn({ err: (err as Error).message, novelId: n.id }, "entity backlog task not enqueued");
        }
      }
    },
  };
}
