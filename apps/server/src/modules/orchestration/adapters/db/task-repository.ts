/** orchestration tables only: tasks, task_dependencies, wake_requests, runs. */
import { and, asc, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql, type SQL } from "@ncs/db/orm";
import { runs, taskDependencies, tasks, wakeRequests } from "@ncs/db/schema";
import { repairRoundsOf } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Run, Task, TaskFilter, TaskWithLatestRun } from "../../index.js";

export type Wake = typeof wakeRequests.$inferSelect;

export const taskRepo = {
  async insertTask(db: Db, row: typeof tasks.$inferInsert): Promise<Task> {
    const [t] = await db.insert(tasks).values(row).returning();
    return t!;
  },
  async insertDeps(db: Db, scope: NovelScope, taskId: string, dependsOn: string[]): Promise<void> {
    if (!dependsOn.length) return;
    await db
      .insert(taskDependencies)
      .values([...new Set(dependsOn)].map((d) => ({ novelId: scope.novelId, taskId, dependsOnTaskId: d })))
      .onConflictDoNothing();
  },
  async getTask(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Task | null> {
    const q = db.select().from(tasks).where(and(eq(tasks.novelId, scope.novelId), eq(tasks.id, id)));
    const [t] = forUpdate ? await q.for("update") : await q;
    return t ?? null;
  },
  async getTasks(db: Db, scope: NovelScope, ids: string[]): Promise<Task[]> {
    if (!ids.length) return [];
    return db.select().from(tasks).where(and(eq(tasks.novelId, scope.novelId), inArray(tasks.id, ids)));
  },
  /** TC-2: unfinished task with the same (kind, target, input.cycle_key) */
  async findActive(db: Db, scope: NovelScope, kind: Task["kind"], targetType: Task["targetType"], targetId: string, cycleKey: string | null): Promise<Task | null> {
    const [t] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.novelId, scope.novelId),
          eq(tasks.kind, kind),
          eq(tasks.targetType, targetType),
          eq(tasks.targetId, targetId),
          notInArray(tasks.status, ["done", "failed", "cancelled"]),
          sql`(${tasks.input} ->> 'cycle_key') IS NOT DISTINCT FROM ${cycleKey}`,
        ),
      )
      .limit(1);
    return t ?? null;
  },
  /** CAS update: returns null when the row did not match (status / lease guards) */
  async updateTask(
    db: Db,
    scope: NovelScope,
    id: string,
    patch: Partial<typeof tasks.$inferInsert>,
    guard: { statuses?: Task["status"][]; leaseRunId?: string } = {},
  ): Promise<Task | null> {
    const conds: SQL[] = [eq(tasks.novelId, scope.novelId), eq(tasks.id, id)];
    if (guard.statuses) conds.push(inArray(tasks.status, guard.statuses));
    if (guard.leaseRunId) conds.push(eq(tasks.leaseRunId, guard.leaseRunId));
    const [t] = await db.update(tasks).set({ ...patch, updatedAt: sql`now()` }).where(and(...conds)).returning();
    return t ?? null;
  },
  /**
   * T3 (04 §5.1, INV-TSK-03): ONE conditional UPDATE. 0 rows → lease not acquired.
   * Pause of novel/arc is checked by the engine through the novel service (no foreign tables here).
   */
  async acquireLease(db: Db, scope: NovelScope, taskId: string, runId: string, now: Date, expiresAt: Date): Promise<Task | null> {
    const [t] = await db
      .update(tasks)
      .set({ status: "running", leaseRunId: runId, leaseExpiresAt: expiresAt, startedAt: sql`coalesce(${tasks.startedAt}, ${now})`, updatedAt: sql`now()` })
      .where(
        and(
          eq(tasks.novelId, scope.novelId),
          eq(tasks.id, taskId),
          eq(tasks.status, "ready"),
          isNull(tasks.pausedAt),
          or(isNull(tasks.notBeforeAt), lte(tasks.notBeforeAt, now)),
          or(isNull(tasks.leaseRunId), sql`${tasks.leaseExpiresAt} < ${now}`),
        ),
      )
      .returning();
    return t ?? null;
  },
  /** 04 §5.2 renew: task lease + run heartbeat (same tx). false → lease lost */
  async renewLease(db: Db, scope: NovelScope, taskId: string, runId: string, now: Date, expiresAt: Date): Promise<boolean> {
    const rows = await db
      .update(tasks)
      .set({ leaseExpiresAt: expiresAt, updatedAt: sql`now()` })
      .where(and(eq(tasks.novelId, scope.novelId), eq(tasks.id, taskId), eq(tasks.leaseRunId, runId), eq(tasks.status, "running")))
      .returning({ id: tasks.id });
    if (rows.length !== 1) return false;
    await db
      .update(runs)
      .set({ heartbeatAt: now, updatedAt: sql`now()` })
      .where(and(eq(runs.novelId, scope.novelId), eq(runs.id, runId), eq(runs.status, "running")));
    return true;
  },
  async list(db: Db, scope: NovelScope, f: TaskFilter): Promise<TaskWithLatestRun[]> {
    const conds: SQL[] = [eq(tasks.novelId, scope.novelId)];
    if (f.statuses?.length) conds.push(inArray(tasks.status, f.statuses));
    else if (!f.includeCancelled) conds.push(ne(tasks.status, "cancelled"));
    if (f.kinds?.length) conds.push(inArray(tasks.kind, f.kinds));
    if (f.agentRole) conds.push(eq(tasks.agentRole, f.agentRole));
    if (f.arcId) conds.push(eq(tasks.arcId, f.arcId));
    if (f.episodeId) conds.push(eq(tasks.episodeId, f.episodeId));
    if (f.targetType) conds.push(eq(tasks.targetType, f.targetType));
    if (f.targetId) conds.push(eq(tasks.targetId, f.targetId));
    const rows = await db.select().from(tasks).where(and(...conds)).orderBy(desc(tasks.createdAt), desc(tasks.displayNo)).limit(f.limit ?? 500);
    return taskRepo.attachLatestRuns(db, scope, rows);
  },
  async attachLatestRuns(db: Db, scope: NovelScope, rows: Task[]): Promise<TaskWithLatestRun[]> {
    if (!rows.length) return [];
    const latest = await db
      .selectDistinctOn([runs.taskId])
      .from(runs)
      .where(and(eq(runs.novelId, scope.novelId), inArray(runs.taskId, rows.map((r) => r.id))))
      .orderBy(runs.taskId, desc(runs.createdAt), desc(runs.id));
    const byTask = new Map(latest.map((r) => [r.taskId, r]));
    return rows.map((t) => {
      const r = byTask.get(t.id);
      return {
        ...t,
        latestRun: r
          ? { id: r.id, status: r.status, stopReason: r.stopReason, errorFamily: r.errorFamily, errorMessage: r.errorMessage, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt, finishedAt: r.finishedAt, costMicros: r.costMicros, repairRounds: repairRoundsOf(r.outputSummary) }
          : null,
      };
    });
  },
  // dependencies
  /** pending tasks (install-wide) with the status of their dependencies */
  async pendingWithDeps(db: Db, limit: number) {
    return db
      .select({
        task: tasks,
        total: sql<number>`(SELECT count(*)::int FROM task_dependencies d WHERE d.novel_id = "tasks"."novel_id" AND d.task_id = "tasks"."id")`,
        done: sql<number>`(SELECT count(*)::int FROM task_dependencies d JOIN tasks p ON p.novel_id = d.novel_id AND p.id = d.depends_on_task_id
                            WHERE d.novel_id = "tasks"."novel_id" AND d.task_id = "tasks"."id" AND p.status = 'done')`,
        cancelled: sql<number>`(SELECT count(*)::int FROM task_dependencies d JOIN tasks p ON p.novel_id = d.novel_id AND p.id = d.depends_on_task_id
                            WHERE d.novel_id = "tasks"."novel_id" AND d.task_id = "tasks"."id" AND p.status = 'cancelled')`,
      })
      .from(tasks)
      .where(eq(tasks.status, "pending"))
      .orderBy(asc(tasks.createdAt))
      .limit(limit);
  },
  async depsOf(db: Db, scope: NovelScope, taskId: string): Promise<Task[]> {
    return db
      .select({ t: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, and(eq(tasks.novelId, taskDependencies.novelId), eq(tasks.id, taskDependencies.dependsOnTaskId)))
      .where(and(eq(taskDependencies.novelId, scope.novelId), eq(taskDependencies.taskId, taskId)))
      .then((rows) => rows.map((r) => r.t));
  },
  async dependentsOf(db: Db, scope: NovelScope, taskId: string): Promise<Task[]> {
    return db
      .select({ t: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, and(eq(tasks.novelId, taskDependencies.novelId), eq(tasks.id, taskDependencies.taskId)))
      .where(and(eq(taskDependencies.novelId, scope.novelId), eq(taskDependencies.dependsOnTaskId, taskId)))
      .then((rows) => rows.map((r) => r.t));
  },
  async replaceDependency(db: Db, scope: NovelScope, taskId: string, fromId: string, toId: string): Promise<void> {
    await db
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.novelId, scope.novelId), eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, fromId)));
    if (toId !== taskId) await taskRepo.insertDeps(db, scope, taskId, [toId]);
  },
  /** ready tasks (install-wide) ordered by priority, then age */
  async readyTasks(db: Db, now: Date, kinds: string[], limit: number): Promise<Task[]> {
    if (!kinds.length || limit <= 0) return [];
    return db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "ready"),
          isNull(tasks.pausedAt),
          or(isNull(tasks.notBeforeAt), lte(tasks.notBeforeAt, now)),
          inArray(tasks.kind, kinds as Task["kind"][]),
        ),
      )
      .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.displayNo))
      .limit(limit);
  },
  async blockedByRef(db: Db, scope: NovelScope, refType: string, refId: string, reasons?: Task["blockReason"][]): Promise<Task[]> {
    const conds: SQL[] = [eq(tasks.novelId, scope.novelId), eq(tasks.status, "blocked"), sql`${tasks.blockedRefType} = ${refType}`, eq(tasks.blockedRefId, refId)];
    if (reasons?.length) conds.push(inArray(tasks.blockReason, reasons as NonNullable<Task["blockReason"]>[]));
    return db.select().from(tasks).where(and(...conds)).for("update");
  },
  async blockedByReason(db: Db, scope: NovelScope | null, reason: NonNullable<Task["blockReason"]>, limit = 200): Promise<Task[]> {
    const conds: SQL[] = [eq(tasks.status, "blocked"), eq(tasks.blockReason, reason)];
    if (scope) conds.push(eq(tasks.novelId, scope.novelId));
    return db.select().from(tasks).where(and(...conds)).limit(limit);
  },
  async runningWriterOnEpisode(db: Db, scope: NovelScope, episodeId: string, kinds: readonly Task["kind"][], exceptTaskId: string): Promise<boolean> {
    const [r] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(eq(tasks.novelId, scope.novelId), eq(tasks.episodeId, episodeId), eq(tasks.status, "running"), inArray(tasks.kind, [...kinds]), ne(tasks.id, exceptTaskId)),
      )
      .limit(1);
    return !!r;
  },
  async activeByKinds(db: Db, scope: NovelScope, kinds: Task["kind"][]): Promise<Task[]> {
    return db
      .select()
      .from(tasks)
      .where(and(eq(tasks.novelId, scope.novelId), inArray(tasks.kind, kinds), inArray(tasks.status, ["pending", "ready", "blocked"])));
  },
  async readyByRoles(db: Db, scope: NovelScope, roles: Task["agentRole"][]): Promise<Task[]> {
    if (!roles.length) return [];
    return db
      .select()
      .from(tasks)
      .where(and(eq(tasks.novelId, scope.novelId), eq(tasks.status, "ready"), inArray(tasks.agentRole, roles)))
      .for("update");
  },
  async novelsWithReadyTasks(db: Db): Promise<string[]> {
    const rows = await db.selectDistinct({ id: tasks.novelId }).from(tasks).where(eq(tasks.status, "ready"));
    return rows.map((r) => r.id);
  },

  // wakes
  async findWakeByKey(db: Db, scope: NovelScope, key: string): Promise<Wake | null> {
    const [w] = await db.select().from(wakeRequests).where(and(eq(wakeRequests.novelId, scope.novelId), eq(wakeRequests.idempotencyKey, key)));
    return w ?? null;
  },
  /** INSERT … ON CONFLICT (novel_id, idempotency_key) DO NOTHING → null when duplicate */
  async insertWake(db: Db, row: typeof wakeRequests.$inferInsert): Promise<Wake | null> {
    const [w] = await db.insert(wakeRequests).values(row).onConflictDoNothing().returning();
    return w ?? null;
  },
  async pendingWakesForTask(db: Db, scope: NovelScope, taskId: string, forUpdate = false): Promise<Wake[]> {
    const q = db
      .select()
      .from(wakeRequests)
      .where(and(eq(wakeRequests.novelId, scope.novelId), eq(wakeRequests.taskId, taskId), eq(wakeRequests.status, "pending")))
      .orderBy(asc(wakeRequests.createdAt), asc(wakeRequests.id));
    return forUpdate ? q.for("update", { skipLocked: true }) : q;
  },
  /** pending wakes (install-wide) for the given tasks — WC-3 evaluation */
  async pendingWakesFor(db: Db, taskIds: string[]): Promise<Wake[]> {
    if (!taskIds.length) return [];
    return db.select().from(wakeRequests).where(and(eq(wakeRequests.status, "pending"), inArray(wakeRequests.taskId, taskIds)));
  },
  /** W4 candidates: pending wakes whose task is not ready (install-wide) */
  async discardableWakes(db: Db, limit = 500): Promise<Wake[]> {
    return db
      .select({ w: wakeRequests })
      .from(wakeRequests)
      .innerJoin(tasks, and(eq(tasks.novelId, wakeRequests.novelId), eq(tasks.id, wakeRequests.taskId)))
      .where(and(eq(wakeRequests.status, "pending"), inArray(tasks.status, ["done", "failed", "cancelled"])))
      .limit(limit)
      .then((rows) => rows.map((r) => r.w));
  },
  async updateWake(db: Db, scope: NovelScope, id: string, patch: Partial<typeof wakeRequests.$inferInsert>, fromStatus?: Wake["status"]): Promise<boolean> {
    const conds: SQL[] = [eq(wakeRequests.novelId, scope.novelId), eq(wakeRequests.id, id)];
    if (fromStatus) conds.push(eq(wakeRequests.status, fromStatus));
    const rows = await db.update(wakeRequests).set({ ...patch, updatedAt: sql`now()` }).where(and(...conds)).returning({ id: wakeRequests.id });
    return rows.length === 1;
  },

  // runs
  async insertRun(db: Db, row: typeof runs.$inferInsert): Promise<Run> {
    const [r] = await db.insert(runs).values(row).returning();
    return r!;
  },
  async getRun(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Run | null> {
    const q = db.select().from(runs).where(and(eq(runs.novelId, scope.novelId), eq(runs.id, id)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  /** LR-4 CAS on the expected run status */
  async updateRun(db: Db, scope: NovelScope, id: string, patch: Partial<typeof runs.$inferInsert>, fromStatuses?: Run["status"][]): Promise<Run | null> {
    const conds: SQL[] = [eq(runs.novelId, scope.novelId), eq(runs.id, id)];
    if (fromStatuses) conds.push(inArray(runs.status, fromStatuses));
    const [r] = await db.update(runs).set({ ...patch, updatedAt: sql`now()` }).where(and(...conds)).returning();
    return r ?? null;
  },
  async listRuns(db: Db, scope: NovelScope, taskId: string): Promise<Run[]> {
    return db.select().from(runs).where(and(eq(runs.novelId, scope.novelId), eq(runs.taskId, taskId))).orderBy(desc(runs.createdAt), desc(runs.id));
  },
  async latestRun(db: Db, scope: NovelScope, taskId: string): Promise<Run | null> {
    const [r] = await db.select().from(runs).where(and(eq(runs.novelId, scope.novelId), eq(runs.taskId, taskId))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
    return r ?? null;
  },
  /** previous runs of the rerun chain (newest first) */
  async runChain(db: Db, scope: NovelScope, runId: string | null, max = 20): Promise<string[]> {
    const out: string[] = [];
    let cur = runId;
    while (cur && out.length < max) {
      out.push(cur);
      const r = await taskRepo.getRun(db, scope, cur);
      cur = r?.rerunOfRunId ?? null;
    }
    return out;
  },
  /** 11.2 candidates: (startup) every queued/running run; (periodic) running runs whose task lease expired */
  async orphanCandidates(db: Db, startup: boolean, now: Date, limit = 200): Promise<Array<{ run: Run; task: Task | null }>> {
    if (startup) {
      const rows = await db
        .select({ run: runs, task: tasks })
        .from(runs)
        .leftJoin(tasks, and(eq(tasks.novelId, runs.novelId), eq(tasks.id, runs.taskId)))
        .where(inArray(runs.status, ["queued", "running"]))
        .limit(limit);
      return rows;
    }
    return db
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, and(eq(tasks.novelId, runs.novelId), eq(tasks.leaseRunId, runs.id)))
      .where(and(eq(runs.status, "running"), sql`${tasks.leaseExpiresAt} < ${now}`))
      .limit(limit);
  },
  async countActiveRuns(db: Db, scope?: NovelScope): Promise<number> {
    const conds: SQL[] = [inArray(runs.status, ["queued", "running"])];
    if (scope) conds.push(eq(runs.novelId, scope.novelId));
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(runs).where(and(...conds));
    return r?.n ?? 0;
  },
};
