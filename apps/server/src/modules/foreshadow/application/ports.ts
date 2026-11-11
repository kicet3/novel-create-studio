/**
 * Narrow views of the other modules' public services used by foreshadow (tests pass stubs).
 * Only `index.ts` contracts are imported (CONVENTIONS §3).
 */
import { NotImplementedError } from "../../../platform/index.js";
import type { AgentsService } from "../../agents/index.js";
import type { AuditService } from "../../audit/index.js";
import type { HitlService } from "../../hitl/index.js";
import type { ManuscriptService } from "../../manuscript/index.js";
import type { NovelService } from "../../novel/index.js";
import type { OntologyService } from "../../ontology/index.js";
import type { OrchestrationService } from "../../orchestration/index.js";
import type { Platform } from "../../../platform/index.js";

export type ManuscriptPort = Pick<
  ManuscriptService,
  | "getEpisode"
  | "getEpisodeByNo"
  | "listEpisodes"
  | "getVersion"
  | "listScenes"
  | "registerCheckGateContributor"
  | "onEpisodeTransition"
  | "onArcPlanDecision"
  | "advanceCheckGate"
  | "requestArcPlanApproval"
  | "registerVersionAnnotator"
  | "registerEpisodeDeleteParticipant"
>;

export type OntologyPort = Pick<OntologyService, "getSetupLinkedFacts" | "getDefaultTimeline">;
export type HitlPort = Pick<HitlService, "createQuestion" | "requestApproval" | "listQuestions" | "getApproval" | "registerAnswerApplier" | "registerApprovalHandler">;
export type NovelPort = Pick<NovelService, "nextDisplayNo" | "listArcs" | "getArc" | "getNovel">;
export type OrchestrationPort = Pick<OrchestrationService, "createTask" | "listTasks" | "registerTaskKind">;
export type AgentsPort = Pick<AgentsService, "defineAgentTask" | "registerContextSection">;

export interface ForeshadowPorts {
  platform: Platform;
  audit: Pick<AuditService, "record" | "recordMany">;
  novel: NovelPort;
  ontology: OntologyPort;
  manuscript: ManuscriptPort;
  orchestration: OrchestrationPort;
  agents: AgentsPort;
  hitl: HitlPort;
}

/** Call a dependency that may still be a contracts-phase placeholder; returns `fallback` on 501. */
export async function orPlaceholder<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotImplementedError) return fallback;
    throw err;
  }
}
