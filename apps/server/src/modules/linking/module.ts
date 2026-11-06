/** linking module factory: linker service, task kinds ×4, hitl answer appliers + identity_change approval handler. */
import type { Platform, ServerModule } from "../../platform/index.js";
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
  const d = { ontology: deps.ontology, hitl: deps.hitl };
  const service: LinkingService = {
    linkMentions: (scope, input, run) => runLinker({ ontology: deps.ontology, llm: deps.llm }, scope, input, run),
    confirmMention: (tx, scope, mentionId, decision, actor, ctx) => confirmMention(d, tx, scope, mentionId, decision, actor, ctx),
    relinkMentions: (tx, scope, ids, to, actor) => relinkMentions(d, tx, scope, ids, to, actor),
    buildDisambiguationOptions: (scope, mentionId, tx) => buildDisambiguationOptions(d, scope, mentionId, tx),
    registerSceneSource: (src) => void sceneSources.push(src),
    commitLinkerResult: (tx, scope, result, actor, ctx) => commitLinkerResult(d, tx, scope, result, actor, ctx),
  };

  const taskDeps: TaskDeps = { ontology: deps.ontology, llm: deps.llm, hitl: deps.hitl, novel: deps.novel, agents: deps.agents, orchestration: deps.orchestration, sceneSources };
  deps.orchestration.registerTaskKind(defineTask(taskDeps, extractFactsHandler(taskDeps)));
  deps.orchestration.registerTaskKind(defineTask(taskDeps, linkMentionsHandler(taskDeps)));
  deps.orchestration.registerTaskKind(defineTask(taskDeps, buildInitialOntologyHandler(taskDeps)));
  deps.orchestration.registerTaskKind(dedupeHandler(taskDeps));

  tryRegister(() => deps.hitl.registerAnswerApplier("entity_disambiguation", disambiguationApplier(d)));
  tryRegister(() => deps.hitl.registerAnswerApplier("duplicate_entity", duplicateApplier(d)));
  tryRegister(() => deps.hitl.registerApprovalHandler("identity_change", identityChangeApprovalHandler(d)));

  return { name: "linking", implemented: true, service };
}
