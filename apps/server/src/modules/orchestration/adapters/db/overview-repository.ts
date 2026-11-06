/** Read-only queries for the agent overview (orchestration tables only: tasks, runs). */
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "@ncs/db/orm";
import { runs, tasks } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { FailedTaskRow, OpenTaskRow, RoleUsageRow, RunSpanRow, TaskCountRow } from "../../domain/agents-overview.js";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Upper bound on one run's duration used to narrow run reads by created_at (runs still open are read separately). */
export const MAX_RUN_SPAN_MS = 12 * 3_600_000;

export const overviewRepo = {
  /** non-cancelled tasks grouped by (kind, role, status, block reason) — tasks_status_idx (novel_id, status) */
  async taskCounts(db: Db, scope: NovelScope): Promise<TaskCountRow[]> {
    const rows = await db
      .select({
        kind: tasks.kind,
        agentRole: tasks.agentRole,
        status: tasks.status,
        blockReason: tasks.blockReason,
        blockedRefType: tasks.blockedRefType,
        n: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.novelId, scope.novelId), ne(tasks.status, "cancelled")))
      .groupBy(tasks.kind, tasks.agentRole, tasks.status, tasks.blockReason, tasks.blockedRefType);
    return rows.map((r) => ({ ...r, n: num(r.n) }));
  },

  /** running + blocked tasks (detail for the roster) */
  async openTasks(db: Db, scope: NovelScope, limit = 300): Promise<OpenTaskRow[]> {
    return db
      .select({
        id: tasks.id,
        displayNo: tasks.displayNo,
        kind: tasks.kind,
        agentRole: tasks.agentRole,
        status: tasks.status,
        blockReason: tasks.blockReason,
        blockedRefType: tasks.blockedRefType,
        blockedRefId: tasks.blockedRefId,
        leaseRunId: tasks.leaseRunId,
        leaseExpiresAt: tasks.leaseExpiresAt,
        attemptCount: tasks.attemptCount,
        maxAttempts: tasks.maxAttempts,
        startedAt: tasks.startedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.novelId, scope.novelId), inArray(tasks.status, ["running", "blocked"])))
      .orderBy(desc(tasks.priority), tasks.displayNo)
      .limit(limit);
  },

  /** most recent failed task per role, with the error of its latest run; `updatedAt` = that run's finish (engine clock) when known */
  async latestFailures(db: Db, scope: NovelScope): Promise<FailedTaskRow[]> {
    const failed = await db
      .select({ id: tasks.id, displayNo: tasks.displayNo, kind: tasks.kind, agentRole: tasks.agentRole, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(and(eq(tasks.novelId, scope.novelId), eq(tasks.status, "failed")))
      .orderBy(desc(tasks.updatedAt))
      .limit(200);
    const perRole = new Map<string, (typeof failed)[number]>();
    for (const f of failed) if (!perRole.has(f.agentRole)) perRole.set(f.agentRole, f);
    const picked = [...perRole.values()];
    if (!picked.length) return [];
    const runRows = await db
      .select({ taskId: runs.taskId, errorFamily: runs.errorFamily, errorMessage: runs.errorMessage, finishedAt: runs.finishedAt, createdAt: runs.createdAt })
      .from(runs)
      .where(and(eq(runs.novelId, scope.novelId), inArray(runs.taskId, picked.map((p) => p.id))))
      .orderBy(desc(runs.createdAt));
    const latest = new Map<string, (typeof runRows)[number]>();
    for (const r of runRows) if (!latest.has(r.taskId)) latest.set(r.taskId, r);
    return picked.map((p) => {
      const r = latest.get(p.id);
      return { ...p, updatedAt: r?.finishedAt ?? p.updatedAt, errorFamily: r?.errorFamily ?? null, errorMessage: r?.errorMessage ?? null };
    });
  },

  /** started/heartbeat of the given runs (the leases of running tasks; primary key lookups) */
  async runHeartbeats(db: Db, scope: NovelScope, runIds: string[]): Promise<Map<string, { startedAt: Date | null; heartbeatAt: Date | null }>> {
    if (!runIds.length) return new Map();
    const rows = await db
      .select({ id: runs.id, startedAt: runs.startedAt, heartbeatAt: runs.heartbeatAt })
      .from(runs)
      .where(and(eq(runs.novelId, scope.novelId), inArray(runs.id, runIds)));
    return new Map(rows.map((r) => [r.id, { startedAt: r.startedAt, heartbeatAt: r.heartbeatAt }]));
  },

  /**
   * Runs overlapping the window, newest first; returns up to limit+1.
   * Two index-friendly reads merged: runs created since `since − MAX_RUN_SPAN_MS` (runs_novel_created_idx,
   * 0013) and runs still queued/running whatever their age (runs_running_idx). A run that started more
   * than MAX_RUN_SPAN_MS before the window and already finished inside it is not shown.
   */
  async windowRuns(db: Db, scope: NovelScope, since: Date, limit: number): Promise<RunSpanRow[]> {
    const cols = {
      id: runs.id,
      taskId: runs.taskId,
      taskDisplayNo: tasks.displayNo,
      kind: tasks.kind,
      role: runs.agentRole,
      status: runs.status,
      stopReason: runs.stopReason,
      errorFamily: runs.errorFamily,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      heartbeatAt: runs.heartbeatAt,
      finishedAt: runs.finishedAt,
      taskAttemptCount: tasks.attemptCount,
      maxAttempts: tasks.maxAttempts,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      costMicros: runs.costMicros,
      modelsUsed: runs.modelsUsed,
    };
    const join = and(eq(tasks.novelId, runs.novelId), eq(tasks.id, runs.taskId));
    const [recent, open] = await Promise.all([
      db
        .select(cols)
        .from(runs)
        .innerJoin(tasks, join)
        .where(
          and(
            eq(runs.novelId, scope.novelId),
            gte(runs.createdAt, new Date(since.getTime() - MAX_RUN_SPAN_MS)),
            or(isNull(runs.finishedAt), gte(runs.finishedAt, since)),
          ),
        )
        .orderBy(desc(runs.createdAt))
        .limit(limit + 1),
      db
        .select(cols)
        .from(runs)
        .innerJoin(tasks, join)
        .where(and(inArray(runs.status, ["queued", "running"]), eq(runs.novelId, scope.novelId)))
        .orderBy(desc(runs.createdAt))
        .limit(limit + 1),
    ]);
    const byId = new Map<string, (typeof recent)[number]>();
    for (const r of [...recent, ...open]) byId.set(r.id, r);
    return [...byId.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, limit + 1)
      .map((r) => ({ ...r, inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), costMicros: num(r.costMicros) }));
  },

  /**
   * Per role: usage of runs finished since `todayStart` (usage is copied to runs.* at finish) and the latest
   * activity — both read only runs created since `todayStart − MAX_RUN_SPAN_MS` (runs_novel_created_idx).
   */
  async roleUsage(db: Db, scope: NovelScope, todayStart: Date): Promise<RoleUsageRow[]> {
    const today = sql`${runs.finishedAt} >= ${todayStart}`;
    const rows = await db
      .select({
        agentRole: runs.agentRole,
        runs: sql<number>`count(*) filter (where ${today})::int`,
        inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}) filter (where ${today}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}) filter (where ${today}), 0)::bigint`,
        costMicros: sql<number>`coalesce(sum(${runs.costMicros}) filter (where ${today}), 0)::bigint`,
        lastActiveAt: sql<string | Date | null>`max(coalesce(${runs.finishedAt}, ${runs.heartbeatAt}, ${runs.startedAt}, ${runs.createdAt}))`,
      })
      .from(runs)
      .where(and(eq(runs.novelId, scope.novelId), gte(runs.createdAt, new Date(todayStart.getTime() - MAX_RUN_SPAN_MS))))
      .groupBy(runs.agentRole);
    return rows.map((r) => ({
      agentRole: r.agentRole,
      runs: num(r.runs),
      inputTokens: num(r.inputTokens),
      outputTokens: num(r.outputTokens),
      costMicros: num(r.costMicros),
      lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt) : null,
    }));
  },
};
