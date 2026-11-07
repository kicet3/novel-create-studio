/**
 * Composition of server modules (02 §3.3 M-4: dependencies only point "down" this list).
 * Module agents implement their factory inside `modules/<name>/`; this file should rarely change
 * (only when a module needs a NEW dependency — coordinate, keep the order acyclic).
 */
import type { Platform, ServerModule } from "../platform/index.js";
import type { Runtime } from "../runtime/index.js";
import type { DbConnection } from "@ncs/db";
import { createAuditModule, type AuditService } from "../modules/audit/index.js";
import { createSystemModule, type SystemService } from "../modules/system/index.js";
import { createNovelModule, type NovelService } from "../modules/novel/index.js";
import { createBudgetModule, type BudgetService } from "../modules/budget/index.js";
import { createLlmModule, type LlmAdapter, type LlmService } from "../modules/llm/index.js";
import { createOntologyModule, type OntologyService } from "../modules/ontology/index.js";
import { createOrchestrationModule, type OrchestrationService } from "../modules/orchestration/index.js";
import { createAgentsModule, type AgentsService } from "../modules/agents/index.js";
import { createMessagingModule, type MessagingService } from "../modules/messaging/index.js";
import { createHitlModule, type HitlService } from "../modules/hitl/index.js";
import { createLinkingModule, type LinkingService } from "../modules/linking/index.js";
import { createManuscriptModule, type ManuscriptService } from "../modules/manuscript/index.js";
import { createForeshadowModule, type ForeshadowService } from "../modules/foreshadow/index.js";
import { createContinuityModule, type ContinuityService } from "../modules/continuity/index.js";
import { createConceptModule, type ConceptService } from "../modules/concept/index.js";
import { createExportModule, type ExportService } from "../modules/export/index.js";
import { createImagingModule, type ImagingService } from "../modules/imaging/index.js";
import { createCastModule, type CastService } from "../modules/cast/index.js";
import { createWorldModule, type WorldService } from "../modules/world/index.js";
import { createAutopilotModule, type AutopilotService } from "../modules/autopilot/index.js";
import { createRevisionModule, type RevisionService } from "../modules/revision/index.js";
import { createPublicationModule, type PublicDbConnector, type PublicationService } from "../modules/publication/index.js";

export interface Modules {
  audit: ServerModule<AuditService>;
  system: ServerModule<SystemService>;
  novel: ServerModule<NovelService>;
  budget: ServerModule<BudgetService>;
  llm: ServerModule<LlmService>;
  ontology: ServerModule<OntologyService>;
  orchestration: ServerModule<OrchestrationService>;
  agents: ServerModule<AgentsService>;
  messaging: ServerModule<MessagingService>;
  hitl: ServerModule<HitlService>;
  linking: ServerModule<LinkingService>;
  manuscript: ServerModule<ManuscriptService>;
  foreshadow: ServerModule<ForeshadowService>;
  continuity: ServerModule<ContinuityService>;
  concept: ServerModule<ConceptService>;
  export: ServerModule<ExportService>;
  /** 설계 추가 0021: 공개 사이트 정적 스냅숏(공개된 화만) */
  publication: ServerModule<PublicationService>;
  imaging: ServerModule<ImagingService>;
  cast: ServerModule<CastService>;
  world: ServerModule<WorldService>;
  /** 설계 추가 0018: 화별 수정 대화 */
  revision: ServerModule<RevisionService>;
  /** 설계 추가 0014: 완전 자율 진행 (last: reads every module) */
  autopilot: ServerModule<AutopilotService>;
}

export interface BuildModulesOptions {
  platform: Platform;
  runtime: Runtime;
  databaseMode: "embedded" | "external";
  database?: DbConnection;
  /** extra LLM adapters (test seam; production uses only the built-in provider adapters) */
  llmAdapters?: LlmAdapter[];
  /** public site DB connector (test seam; production: postgres.js to the user's Supabase) */
  publicDbConnector?: PublicDbConnector;
}

export function buildModules({ platform, runtime, databaseMode, database, llmAdapters, publicDbConnector }: BuildModulesOptions): Modules {
  const audit = createAuditModule({ platform });
  const a = audit.service;
  const system = createSystemModule({ platform, audit: a, databaseMode, database });
  const novel = createNovelModule({ platform, audit: a });
  const n = novel.service;
  system.service.setNovelLister(async () => (await n.listNovels()).map((x) => x.id));
  const budget = createBudgetModule({ platform, audit: a, novel: n });
  const llm = createLlmModule({ platform, audit: a, novel: n, budget: budget.service, system: system.service, adapters: llmAdapters });
  const ontology = createOntologyModule({ platform, audit: a, novel: n, system: system.service });
  const orchestration = createOrchestrationModule({ platform, audit: a, novel: n, budget: budget.service, pool: runtime.pool, llm: llm.service });
  const o = orchestration.service;
  const agents = createAgentsModule({ platform, audit: a, novel: n, llm: llm.service, ontology: ontology.service, orchestration: o });
  const messaging = createMessagingModule({ platform, audit: a, novel: n, system: system.service });
  const hitl = createHitlModule({
    platform,
    audit: a,
    novel: n,
    messaging: messaging.service,
    orchestration: o,
    ontology: ontology.service,
    agents: agents.service,
  });
  // budget_resume approvals (budget is built before hitl)
  budget.service.connectApprovals(hitl.service);
  // ending_change approvals (novel is built before hitl)
  n.connectApprovals(hitl.service);
  const linking = createLinkingModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    llm: llm.service,
    agents: agents.service,
    orchestration: o,
    hitl: hitl.service,
  });
  const manuscript = createManuscriptModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    linking: linking.service,
    orchestration: o,
    agents: agents.service,
    hitl: hitl.service,
    messaging: messaging.service,
  });
  const foreshadow = createForeshadowModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    manuscript: manuscript.service,
    orchestration: o,
    agents: agents.service,
    hitl: hitl.service,
  });
  const continuity = createContinuityModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    manuscript: manuscript.service,
    foreshadow: foreshadow.service,
    orchestration: o,
    agents: agents.service,
    hitl: hitl.service,
    linking: linking.service,
  });
  const concept = createConceptModule({
    platform,
    audit: a,
    novel: n,
    budget: budget.service,
    llm: llm.service,
    orchestration: o,
    agents: agents.service,
    messaging: messaging.service,
    hitl: hitl.service,
  });
  const exportModule = createExportModule({ platform, audit: a, novel: n, manuscript: manuscript.service });
  const publication = createPublicationModule({ platform, audit: a, novel: n, manuscript: manuscript.service, secrets: system.service.secrets, publicDbConnector });
  const imaging = createImagingModule({ platform, audit: a, novel: n, budget: budget.service, llm: llm.service });
  // 설계 추가: 세계관 온톨로지 (N2 → build_world_ontology); before cast so the cast draft can read it
  const world = createWorldModule({ platform, audit: a, novel: n, ontology: ontology.service, orchestration: o, agents: agents.service, llm: llm.service, concept: concept.service });
  const cast = createCastModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    orchestration: o,
    agents: agents.service,
    llm: llm.service,
    concept: concept.service,
    imaging: imaging.service,
    manuscript: manuscript.service,
    world: world.service,
  });
  const revision = createRevisionModule({
    platform,
    audit: a,
    novel: n,
    ontology: ontology.service,
    orchestration: o,
    agents: agents.service,
    hitl: hitl.service,
    messaging: messaging.service,
    manuscript: manuscript.service,
    foreshadow: foreshadow.service,
    linking: linking.service,
  });
  const autopilot = createAutopilotModule({
    platform,
    audit: a,
    novel: n,
    budget: budget.service,
    orchestration: o,
    messaging: messaging.service,
    hitl: hitl.service,
    manuscript: manuscript.service,
    continuity: continuity.service,
    concept: concept.service,
    world: world.service,
    cast: cast.service,
  });
  return {
    audit,
    system,
    novel,
    budget,
    llm,
    ontology,
    orchestration,
    agents,
    messaging,
    hitl,
    linking,
    manuscript,
    foreshadow,
    continuity,
    concept,
    export: exportModule,
    publication,
    imaging,
    cast,
    world,
    revision,
    autopilot,
  };
}

/** modules in build (= dependency) order */
export function moduleList(m: Modules): ServerModule<unknown>[] {
  return Object.values(m) as ServerModule<unknown>[];
}
