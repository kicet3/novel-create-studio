/**
 * GET /api/novels/:novelId/agents/overview — read-only agent overview ("에이전트 현황": roster, stages, gates).
 * GET /api/novels/:novelId/agents/timeline?hours=6 — runs overlapping the last `hours` hours (swimlanes).
 * Aggregates orchestration tables (tasks, runs) plus optional llm read ports (role bindings, live usage
 * and model of running runs). Never returns prompts, task inputs, provider responses, run error messages or credentials.
 */
import type { z } from "zod";
import { agentsTimelineQuerySchema, type AgentRole } from "@ncs/shared";
import { NotImplementedError, type ApiRouters, type Clock, type NovelScope, type UnitOfWork } from "../../../../platform/index.js";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import type { NovelService } from "../../../novel/index.js";
import { buildAgentsOverview, buildAgentsTimeline, startOfLocalDay, type LiveRunInfo } from "../../domain/agents-overview.js";
import { overviewRepo } from "../db/overview-repository.js";

/** Narrow read port onto the llm module (structurally satisfied by LlmService). */
export interface AgentsOverviewLlmPort {
  listBindings?(scope: NovelScope): Promise<Array<{ agentRole: AgentRole; modelId: string }>>;
  listProviderCalls?(scope: NovelScope, runId: string): Promise<Array<{ seq: number; provider: string; modelId: string }>>;
  runUsage?(scope: NovelScope, runId: string): Promise<{ inputTokens: number; outputTokens: number; costMicros: number }>;
}

export interface AgentsOverviewDeps {
  uow: UnitOfWork;
  clock: Clock;
  novel: Pick<NovelService, "getNovel">;
  llm?: AgentsOverviewLlmPort;
}

const RUN_LIMIT = 400;

async function soft<T>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotImplementedError) return fallback;
    throw err;
  }
}

async function liveRunInfo(llm: AgentsOverviewLlmPort | undefined, scope: NovelScope, runIds: string[]): Promise<Map<string, LiveRunInfo>> {
  // few: bounded by run.max_concurrent_per_novel
  const live = new Map<string, LiveRunInfo>();
  await Promise.all(
    [...new Set(runIds)].map(async (runId) => {
      const [calls, u] = await Promise.all([
        soft(llm?.listProviderCalls ? () => llm.listProviderCalls!(scope, runId) : undefined, []),
        soft(llm?.runUsage ? () => llm.runUsage!(scope, runId) : undefined, null),
      ]);
      const last = calls.reduce<(typeof calls)[number] | null>((a, c) => (!a || c.seq > a.seq ? c : a), null);
      live.set(runId, {
        model: last ? { provider: last.provider, modelId: last.modelId } : null,
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        costMicros: u?.costMicros ?? 0,
      });
    }),
  );
  return live;
}

export async function loadAgentsOverview(deps: AgentsOverviewDeps, scope: NovelScope) {
  const { uow, llm } = deps;
  const db = uow.db;
  const now = deps.clock.date();
  const novel = await deps.novel.getNovel(scope);
  const timezone = novel.timezone || "Asia/Seoul";
  const todayStart = startOfLocalDay(now, timezone);

  const [counts, open, failed, usage, bindings] = await Promise.all([
    overviewRepo.taskCounts(db, scope),
    overviewRepo.openTasks(db, scope),
    overviewRepo.latestFailures(db, scope),
    overviewRepo.roleUsage(db, scope, todayStart),
    soft(llm?.listBindings ? () => llm.listBindings!(scope) : undefined, []),
  ]);
  const runningIds = open.filter((t) => t.status === "running" && t.leaseRunId).map((t) => t.leaseRunId!);
  const [runHeartbeats, live] = await Promise.all([overviewRepo.runHeartbeats(db, scope, runningIds), liveRunInfo(llm, scope, runningIds)]);

  return buildAgentsOverview({
    now,
    todayStart,
    timezone,
    paused: novel.pausedAt !== null,
    counts,
    open,
    failed,
    runHeartbeats,
    usage,
    live,
    bindings: new Map(bindings.map((b) => [b.agentRole, b.modelId])),
  });
}

export async function loadAgentsTimeline(deps: AgentsOverviewDeps, scope: NovelScope, hours: number) {
  const now = deps.clock.date();
  const since = new Date(now.getTime() - hours * 3_600_000);
  const novel = await deps.novel.getNovel(scope);
  const runs = await overviewRepo.windowRuns(deps.uow.db, scope, since, RUN_LIMIT);
  const live = await liveRunInfo(
    deps.llm,
    scope,
    runs.filter((r) => r.status === "running" && r.finishedAt === null).map((r) => r.id),
  );
  return buildAgentsTimeline({ now, since, timezone: novel.timezone || "Asia/Seoul", runs, runLimit: RUN_LIMIT, live });
}

export function mountAgentsOverviewRoute({ novel }: ApiRouters, deps: AgentsOverviewDeps): void {
  novel.get("/agents/overview", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await loadAgentsOverview(deps, scopeOf(res)));
  });
  novel.get("/agents/timeline", validate({ query: agentsTimelineQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof agentsTimelineQuerySchema> }>(res);
    res.set("Cache-Control", "no-store");
    res.json(await loadAgentsTimeline(deps, scopeOf(res), query.hours));
  });
}
