/** AgentsService: roles, prompt templates, context section registry, ContextBuilder, defineAgentTask (04 §6.1, §10.2). */
import type { AgentRole } from "@ncs/shared";
import { NotFoundError, NotImplementedError, type NovelScope, type Platform } from "../../../platform/index.js";
import type { LlmService } from "../../llm/index.js";
import type { NovelService } from "../../novel/index.js";
import type { OntologyService } from "../../ontology/index.js";
import { TASK_KIND_ROLE, TaskFailure, type OrchestrationService, type RunHandle, type Task, type TaskKindHandler } from "../../orchestration/index.js";
import type { AgentTaskHandler, AgentsService, ContextPack, ContextSectionKind, ContextSectionProvider, ContextSpec, PromptTemplate } from "../index.js";
import { maxInputTokensFor, parseHandle } from "../domain/context-budget.js";
import { AGENT_ROLES, disallowedWrites, hop2Predicates, roleDefinition } from "../domain/roles.js";
import { PROMPT_TEMPLATE_DATA, buildTemplate } from "../domain/prompt-templates.js";
import { snapshotRepo } from "../adapters/db/snapshot-repository.js";
import { createContextBuilder } from "./context-builder.js";
import { priorFailureFeedback, withRetryFeedback, type PriorFailureFeedback } from "./retry-feedback.js";

export interface AgentsServiceDeps {
  platform: Platform;
  novel: NovelService;
  llm: LlmService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
}

/** run stop reasons after which a rerun clones the original snapshot (RU-3) */
const CLONE_AFTER_STOP = new Set(["lease_lost", "paused", "superseded", "budget_blocked"]);

/** default sections per role (04 §9.5 / 9.3); handlers can override in their spec */
export const DEFAULT_SECTIONS: Readonly<Record<AgentRole, ContextSectionKind[]>> = {
  concept_partner: ["instruction", "constraints", "recent_text"],
  showrunner: ["instruction", "constraints", "outline", "entity_cards", "recent_text"],
  planner: ["instruction", "constraints", "story_plan", "assigned_beats", "outline", "cast", "entity_cards", "canon_1hop", "glossary", "candidates", "recent_text"],
  world_keeper: ["instruction", "constraints", "entity_cards", "canon_1hop", "candidates", "unresolved_surfaces", "recent_text"],
  writer: ["instruction", "constraints", "story_plan", "assigned_beats", "outline", "cast", "entity_cards", "pov_names", "knowledge", "canon_1hop", "glossary", "canon_2hop", "recent_text"],
  continuity_editor: ["instruction", "constraints", "story_plan", "outline", "entity_cards", "knowledge", "canon_1hop", "canon_2hop", "candidates", "recent_text"],
  foreshadow_manager: ["instruction", "constraints", "assigned_beats", "outline", "entity_cards", "canon_1hop", "recent_text"],
  line_editor: ["instruction", "constraints", "story_plan", "outline", "entity_cards", "pov_names", "knowledge", "recent_text"],
  scene_director: ["instruction", "constraints", "entity_cards", "pov_names", "recent_text"],
  visual_producer: ["instruction", "constraints"],
};

export function createAgentsService(deps: AgentsServiceDeps): AgentsService {
  const { platform } = deps;
  const log = platform.log.child({ module: "agents" });
  const templates = new Map<string, PromptTemplate<any>>();
  for (const d of PROMPT_TEMPLATE_DATA) templates.set(`${d.role}.${d.kind}@${d.version}`, buildTemplate(d));
  const providers = new Map<ContextSectionKind, ContextSectionProvider[]>();
  const builder = createContextBuilder({ platform, novel: deps.novel, ontology: deps.ontology, providers: () => providers });

  /** RU-3: reuse the snapshot of the latest prior run of the task when that run was interrupted at a safe point */
  async function cloneSource(scope: NovelScope, task: Task, run: RunHandle): Promise<string | null> {
    if (run.attempt <= 1 && task.attemptCount <= 1) return null;
    let runs;
    try {
      runs = await deps.orchestration.listRuns(scope, task.id);
    } catch (err) {
      if (err instanceof NotImplementedError) return null;
      throw err;
    }
    const prior = runs.filter((r) => r.id !== run.runId).sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))[0];
    if (!prior || !(prior.status === "interrupted" || (prior.stopReason && CLONE_AFTER_STOP.has(prior.stopReason)))) return null;
    if (prior.contextSnapshotId) return prior.contextSnapshotId;
    const [snap] = await snapshotRepo.latestForRuns(platform.uow.db, scope, [prior.id]);
    return snap?.id ?? null;
  }

  async function retryFeedback(scope: NovelScope, task: Task, run: RunHandle): Promise<PriorFailureFeedback | null> {
    try {
      return priorFailureFeedback(await deps.orchestration.listRuns(scope, task.id), run.runId);
    } catch (err) {
      if (!(err instanceof NotImplementedError)) log.warn({ err, taskId: task.id }, "previous failure feedback unavailable");
      return null;
    }
  }

  const service: AgentsService = {
    roles: AGENT_ROLES,
    getRole: (role) => roleDefinition(role),

    registerPromptTemplate(t) {
      templates.set(t.id, t);
    },
    getPromptTemplate(id) {
      const t = templates.get(id);
      if (!t) throw new NotFoundError("프롬프트 템플릿", id);
      return t;
    },
    listPromptTemplates: () => [...templates.values()],
    renderPrompt(id, vars, pack) {
      return service.getPromptTemplate(id).render(vars, pack);
    },

    registerContextSection(provider) {
      const list = providers.get(provider.section) ?? [];
      list.push(provider);
      providers.set(provider.section, list);
    },

    contextBuilder: builder,

    resolveEntityHandle(pack: ContextPack, handle: string): string {
      const h = parseHandle(handle);
      const id = h?.kind === "E" ? pack.handles.entities[h.index] : h?.kind === "N" ? pack.handles.names[h.index] : undefined;
      if (!id) throw new TaskFailure("invalid_output", `컨텍스트에 없는 핸들입니다: ${handle}`);
      return id;
    },

    defaultContextSpec(role, partial): ContextSpec {
      return {
        seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
        sections: DEFAULT_SECTIONS[role],
        maxInputTokens: maxInputTokensFor(role),
        hopPredicates: { hop2: hop2Predicates(role) },
        ...partial,
        anchor: partial.anchor,
      };
    },

    async getContextSnapshot(scope, snapshotId) {
      const s = await snapshotRepo.get(platform.uow.db, scope, snapshotId);
      if (!s) throw new NotFoundError("컨텍스트 스냅숏", snapshotId);
      return s;
    },
    getContextPack: (scope, snapshotId) => builder.loadPack(scope, snapshotId),

    defineAgentTask<I, P>(h: AgentTaskHandler<I, P>): TaskKindHandler<I, { context: ContextPack; proposal: P }> {
      const expected = TASK_KIND_ROLE[h.kind];
      if (expected && expected !== h.role) throw new Error(`defineAgentTask(${h.kind}): role ${h.role} != TASK_KIND_ROLE ${expected}`);
      const bad = disallowedWrites(h.role, h.allowedWrites);
      if (bad.length) log.warn({ kind: h.kind, role: h.role, writes: bad }, "handler declares writes not allowed for its role (04 §2.3)");
      if (!templates.has(h.promptTemplateVersion) && !h.promptTemplateVersion.startsWith("code.")) {
        log.warn({ kind: h.kind, template: h.promptTemplateVersion }, "prompt template not registered in agents");
      }
      return {
        kind: h.kind,
        role: h.role,
        promptTemplateVersion: h.promptTemplateVersion,
        inputSchema: h.inputSchema,
        gate: h.gate,
        async execute(ctx) {
          const src = await cloneSource(ctx.scope, ctx.task, ctx.run);
          let context: ContextPack | null = null;
          if (src) {
            try {
              context = await builder.cloneFrom(src, ctx.run);
            } catch (err) {
              ctx.log.warn({ err, snapshotId: src }, "snapshot clone failed — rebuilding context");
            }
          }
          if (!context) context = await h.buildContext(ctx.run, ctx.input, builder, ctx.task);
          await ctx.run.checkpoint();
          // retry after invalid_output: tell the producer what failed instead of repeating the identical prompt
          let llm = deps.llm.modelCalls;
          if (ctx.run.attempt > 1) {
            const fb = await retryFeedback(ctx.scope, ctx.task, ctx.run);
            if (fb) {
              ctx.log.info({ fromRunId: fb.fromRunId, purpose: fb.purpose }, "retry after invalid_output: previous failure feedback added to the prompt");
              llm = withRetryFeedback(llm, fb);
            }
          }
          const proposal = await h.execute(ctx.run, ctx.input, context, llm);
          return { context, proposal };
        },
        async commit(tx, ctx, p) {
          return h.commit(tx, ctx.run, ctx.input, p.proposal, ctx.task);
        },
      };
    },
  };
  return service;
}
