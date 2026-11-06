/** Shared helpers for orchestration + budget tests (owned by A1). */
import { z } from "zod";
import { eq, sql } from "@ncs/db/orm";
import { conceptSessions, goals, providerProfiles } from "@ncs/db/schema";
import { buildGoal } from "@ncs/test-kit";
import type { CostCategory } from "@ncs/shared";
import { createWorkerPool } from "../../src/runtime/worker-pool.js";
import { createOrchestrationEngine, type EngineOptions } from "../../src/modules/orchestration/application/engine.js";
import type { RunHandle, TaskKindHandler } from "../../src/modules/orchestration/index.js";
import type { TestCore } from "../support/test-core.js";

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** an isolated engine on the core's platform/DB (own handler registry + active-run registry) */
export function makeEngine(t: TestCore, options: EngineOptions = {}, poolSize = 8) {
  return createOrchestrationEngine({
    platform: t.platform,
    audit: t.modules.audit.service,
    novel: t.modules.novel.service,
    budget: t.modules.budget.service,
    pool: createWorkerPool(poolSize),
    options,
  });
}

/** novel + goal row (so non-concept task kinds can be created, INV-GOL-01) */
export async function novelWithGoal(t: TestCore) {
  const novel = await t.modules.novel.service.createNovel({}, t.owner);
  const goal = buildGoal(novel.id, { id: t.platform.ids.next("gol") });
  await t.testDb.db.insert(goals).values(goal);
  return { novel, scope: { novelId: novel.id }, goalId: goal.id };
}

export async function conceptSessionId(t: TestCore, novelId: string): Promise<string> {
  const [s] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novelId));
  return s!.id;
}

export async function providerProfileId(t: TestCore): Promise<string> {
  const [p] = await t.testDb.db.select().from(providerProfiles).limit(1);
  if (p) return p.id;
  const id = t.platform.ids.next("prv");
  await t.testDb.exec(
    `INSERT INTO provider_profiles (id, provider_kind, provider, version_no, models, price_source_url, verified_at) VALUES ('${id}', 'llm', 'anthropic', 1, '[]', 'https://example.invalid', now())`,
  );
  return id;
}

/** a handler of `kind` with a zod input schema; override hooks per test */
export function handler<P = unknown>(kind: TaskKindHandler["kind"], role: TaskKindHandler["role"], impl: Partial<TaskKindHandler<{ n?: number }, P>> = {}): TaskKindHandler<{ n?: number }, P> {
  return {
    kind,
    role,
    promptTemplateVersion: `${role}.${kind}@0.0.0-test`,
    inputSchema: z.object({ n: z.number().optional() }).passthrough(),
    execute: async () => ({}) as P,
    commit: async () => ({ kind: "done", outputRefs: [] }),
    ...impl,
  };
}

/**
 * Simulates what llm.ModelCallPort does around one provider call, against the real budget service:
 * reserve (P1) → provider_calls(prepared→sent) → attachToCall → [respond → settle].
 * `stopAfter: "sent"` leaves the call in flight (crash simulation).
 */
export async function simulateCall(
  t: TestCore,
  run: Pick<RunHandle, "novelId" | "runId">,
  o: { maxCostMicros: number; actualMicros?: number; seq?: number; stopAfter?: "sent"; category?: CostCategory; isRerun?: boolean },
) {
  const scope = { novelId: run.novelId };
  const budget = t.modules.budget.service;
  const prv = await providerProfileId(t);
  const meta = { provider: "anthropic", modelId: "claude-test-model", providerProfileId: prv, providerProfileVersion: 1, isRerun: o.isRerun ?? false };
  const pclId = t.platform.ids.next("pcl");
  const reserved = await t.platform.uow.run(async (tx) => {
    const r = await budget.reserve(tx, scope, { runId: run.runId, category: o.category ?? "text", maxCostMicros: o.maxCostMicros });
    if (!r.ok) return r;
    await tx.db.execute(
      sql.raw(`INSERT INTO provider_calls (id, novel_id, run_id, seq, provider_kind, provider, model_id, idempotency_key, request_hash, max_output_tokens, max_cost_micros, reservation_id, status, sent_at)
       VALUES ('${pclId}', '${run.novelId}', '${run.runId}', ${o.seq ?? 1}, 'llm', 'anthropic', 'claude-test-model', 'idem:${pclId}', 'hash:${o.seq ?? 1}', 1000, ${o.maxCostMicros}, '${r.reservationId}', 'sent', now())`),
    );
    const a = await budget.attachToCall(tx, scope, r.reservationId, pclId, meta);
    if (!a.attached) throw new Error("not attached");
    return r;
  });
  if (!reserved.ok) return { ok: false as const, refusal: reserved, pclId };
  if (o.stopAfter === "sent") return { ok: true as const, pclId, reservationId: reserved.reservationId, meta, costEventId: null as string | null, overrunMicros: 0 };
  const settled = await t.platform.uow.run(async (tx) => {
    await tx.db.execute(sql.raw(`UPDATE provider_calls SET status='responded', response='{"ok":true}', responded_at=now() WHERE id='${pclId}'`));
    return budget.settle(tx, scope, {
      providerCallId: pclId,
      reservationId: reserved.reservationId,
      category: o.category ?? "text",
      basis: "measured",
      amountMicros: o.actualMicros ?? o.maxCostMicros,
      usage: { inputTokens: 100, outputTokens: 50 },
      ...meta,
      isRerun: o.isRerun ?? false,
    });
  });
  return { ok: true as const, pclId, reservationId: reserved.reservationId, meta, ...settled };
}
