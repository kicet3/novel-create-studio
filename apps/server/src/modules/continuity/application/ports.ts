/** Narrow views of other modules' public services used by continuity (tests pass stubs). */
import { NotImplementedError, type Platform } from "../../../platform/index.js";
import type { AgentsService } from "../../agents/index.js";
import type { AuditService } from "../../audit/index.js";
import type { ForeshadowService } from "../../foreshadow/index.js";
import type { HitlService } from "../../hitl/index.js";
import type { ManuscriptService } from "../../manuscript/index.js";
import type { NovelService } from "../../novel/index.js";
import type { OntologyService } from "../../ontology/index.js";
import type { OrchestrationService } from "../../orchestration/index.js";

export type ContinuityManuscriptPort = Pick<
  ManuscriptService,
  | "getEpisode"
  | "getVersion"
  | "listScenes"
  | "registerCheckGateContributor"
  | "onEpisodeTransition"
  | "advanceCheckGate"
  | "registerIssueSink"
  | "registerVersionAnnotator"
  | "getEpisodeEnd"
>;
export type ContinuityOntologyPort = Pick<
  OntologyService,
  "listMentions" | "findIdentityLeaks" | "findSchemaViolations" | "getCanonAt" | "getConstraints" | "knowledgeOf" | "resolveEntityIds"
>;

export interface ContinuityPorts {
  platform: Platform;
  audit: Pick<AuditService, "record" | "recordMany">;
  novel: Pick<NovelService, "nextDisplayNo">;
  ontology: ContinuityOntologyPort;
  manuscript: ContinuityManuscriptPort;
  foreshadow: Pick<ForeshadowService, "registerIssueSink">;
  orchestration: Pick<OrchestrationService, "registerTaskKind">;
  agents: Pick<AgentsService, "defineAgentTask">;
  hitl: Pick<HitlService, "getApproval">;
}

export async function orPlaceholder<T>(fn: () => Promise<T>, fallback: T, onSkip?: () => void): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotImplementedError) {
      onSkip?.();
      return fallback;
    }
    throw err;
  }
}
