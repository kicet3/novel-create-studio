/**
 * hitl module factory: questions/approvals/answers/reflections, messenger inbound handler, delivery
 * hook, task kinds interpret_answer / apply_answer / grade_question, context section "constraints",
 * loops hitl.dispatcher (05 §5.1, 30 s + "question" hints) and hitl.deadlines (05 §5.5).
 */
import { DEFAULTS } from "@ncs/shared";
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { AgentsService } from "../agents/index.js";
import type { MessagingService } from "../messaging/index.js";
import type { NovelService } from "../novel/index.js";
import type { OntologyService } from "../ontology/index.js";
import type { OrchestrationService } from "../orchestration/index.js";
import type { HitlService } from "./index.js";
import { createHitlCore, type HitlCore } from "./application/hitl-service.js";
import { createHitlInboundHandler } from "./application/inbound.js";
import { registerHitlTasks } from "./application/tasks.js";
import { createAnswerConstraintsSection } from "./application/context.js";
import { mountHitlRoutes } from "./adapters/http/routes.js";

export interface HitlModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  messaging: MessagingService;
  orchestration: OrchestrationService;
  ontology: OntologyService;
  agents: AgentsService;
}

/** test seam: the concrete core behind a hitl module (commitInterpretation etc.) */
const cores = new WeakMap<object, HitlCore>();
export function hitlCoreOf(service: HitlService): HitlCore | undefined {
  return cores.get(service);
}

export function createHitlModule(deps: HitlModuleDeps): ServerModule<HitlService> {
  const core = createHitlCore(deps);
  const service = core.service;
  cores.set(service, core);

  deps.messaging.registerInboundHandler(createHitlInboundHandler(core, deps.messaging, deps.platform));
  deps.messaging.onDeliveryResult((r) => core.onDelivery(r));
  deps.agents.registerContextSection(createAnswerConstraintsSection(deps.platform));

  let applyRegistered = false;
  const register = () => {
    const r = registerHitlTasks(core, { platform: deps.platform, audit: deps.audit, agents: deps.agents, orchestration: deps.orchestration, ontology: deps.ontology }, { ...core.tasks, apply: applyRegistered });
    applyRegistered = true;
    core.tasks.interpret ||= r.interpret;
    core.tasks.grade ||= r.grade;
  };
  register();

  return {
    name: "hitl",
    implemented: true,
    service,
    routes: (r) => mountHitlRoutes(r, service, deps.messaging, deps.platform),
    loops: [
      { name: "hitl.dispatcher", intervalMs: DEFAULTS["question.dispatch_interval_seconds"] * 1000, wakeOn: ["question"], tick: async () => void (await service.runDispatcherOnce()) },
      { name: "hitl.deadlines", intervalMs: 60_000, tick: async () => void (await service.runDeadlinesOnce()) },
    ],
    async start() {
      // agents may finish wiring after construction; retry LLM kinds that were unavailable
      if (!core.tasks.interpret || !core.tasks.grade) {
        try {
          register();
        } catch {
          /* already registered */
        }
      }
    },
  };
}
