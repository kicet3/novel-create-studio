/**
 * Task-kind registration for manuscript's LLM tasks:
 * `orchestration.registerTaskKind(agents.defineAgentTask(handler))` — agents builds the ContextPack and
 * hands `execute` the llm ModelCallPort (04 §10.2). Tasks with no context spec get a minimal context
 * assembled from manuscript's own context sections.
 */
import type { AgentRole, TaskKind } from "@ncs/shared";
import type { z } from "zod";
import type { NovelScope, Tx } from "../../../platform/index.js";
import type { AgentTaskHandler, ContextPack, ContextSectionKind, ContextSectionProvider, ContextSpec } from "../../agents/index.js";
import type { LlmMessage, ModelCallInput, ModelCallPort, ModelCallWebSearch } from "../../llm/index.js";
import type { CommitOutcome, RunHandle, Task } from "../../orchestration/index.js";
import type { Ports } from "./support.js";

export type PipelineCall<T> = ModelCallInput<T>;

export interface PipelineLlm {
  call<T>(input: PipelineCall<T>): Promise<{ value: T | string; modelId: string; reused: boolean; webSearch?: ModelCallWebSearch }>;
  /** the agents ModelCallPort itself (repair dialogues: agents.callWithRepair) */
  port?: ModelCallPort;
}

function adaptPort(port: ModelCallPort): PipelineLlm {
  return {
    port,
    async call(input) {
      const out = await port.call(input);
      return { value: out.value, modelId: out.modelId, reused: out.reused, ...(out.webSearch ? { webSearch: out.webSearch } : {}) };
    },
  };
}

export interface PipelineHandler<I, P> {
  kind: TaskKind;
  role: AgentRole;
  promptTemplateVersion: string;
  inputSchema: z.ZodType<I>;
  allowedWrites: readonly string[];
  gate?: AgentTaskHandler<I, P>["gate"];
  /** context request; null = no ContextBuilder (deterministic task) */
  context(input: I, task: Task): Promise<Omit<ContextSpec, "maxInputTokens" | "hopPredicates" | "seeds"> & { seeds?: ContextSpec["seeds"] } | null>;
  execute(run: RunHandle, input: I, context: ContextPack, llm: PipelineLlm, task: Task): Promise<P>;
  commit(tx: Tx, run: RunHandle, input: I, proposal: P, task: Task): Promise<CommitOutcome>;
}

const EMPTY_SEEDS = { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] };

export function createTaskRegistrar(ports: Ports, sections: ContextSectionProvider[]) {
  const { agents, orchestration } = ports.deps;

  const localContext = async (scope: NovelScope, spec: ContextSpec | null, run: RunHandle): Promise<ContextPack> => {
    const parts: string[] = [];
    const dropped: ContextSectionKind[] = [];
    if (spec) {
      for (const kind of spec.sections) {
        const p = sections.find((s) => s.section === kind);
        if (!p) {
          dropped.push(kind);
          continue;
        }
        const r = await p.build(scope, spec, run);
        if (r?.text) parts.push(`## ${kind}\n${r.text}`);
      }
    }
    const messages: LlmMessage[] = parts.length ? [{ role: "user", content: parts.join("\n\n"), cacheBoundary: true }] : [];
    return { snapshotId: "", system: "", messages, handles: { entities: [], names: [] }, tokenEstimate: Math.ceil(parts.join("").length / 2), droppedSections: dropped };
  };

  return function register<I, P>(h: PipelineHandler<I, P>): void {
    const toSpec = async (input: I, task: Task): Promise<ContextSpec | null> => {
      const c = await h.context(input, task);
      return c ? { ...c, seeds: c.seeds ?? EMPTY_SEEDS, maxInputTokens: 60_000, hopPredicates: { hop2: [] } } : null;
    };
    // execute() of AgentTaskHandler has no task argument: keep it per run
    const currentTask = new Map<string, Task>();
    const agentHandler: AgentTaskHandler<I, P> = {
      kind: h.kind,
      role: h.role,
      promptTemplateVersion: h.promptTemplateVersion,
      inputSchema: h.inputSchema,
      allowedWrites: h.allowedWrites,
      gate: h.gate,
      async buildContext(run, input, builder, task) {
        const spec = await toSpec(input, task);
        if (!spec) return localContext({ novelId: run.novelId }, null, run);
        return builder.build(run, spec);
      },
      execute: (run, input, context, llm) => h.execute(run, input, context, adaptPort(llm), currentTask.get(run.runId)!),
      commit: (tx, run, input, proposal, task) => h.commit(tx, run, input, proposal, task),
    };
    const wrapped = agents.defineAgentTask(agentHandler);
    orchestration.registerTaskKind({
      ...wrapped,
      async execute(ctx) {
        currentTask.set(ctx.run.runId, ctx.task);
        try {
          return await wrapped.execute(ctx);
        } finally {
          currentTask.delete(ctx.run.runId);
        }
      },
    });
  };
}

/** system prompt = role mission from the ContextPack (agents) + task instruction */
export function promptOf(context: ContextPack, instruction: string, data: string): { system: string; messages: LlmMessage[] } {
  return {
    system: [context.system, instruction].filter(Boolean).join("\n\n"),
    messages: [...context.messages, { role: "user", content: data }],
  };
}
