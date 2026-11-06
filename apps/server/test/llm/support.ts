/** llm/agents test helpers: seed task+wake+run rows, a RunHandle, and a minimal SQL-backed budget stub. */
import { sql } from "@ncs/db/orm";
import type { AgentRole } from "@ncs/shared";
import type { BudgetService } from "../../src/modules/budget/index.js";
import type { RunHandle } from "../../src/modules/orchestration/index.js";
import type { TestCore } from "../support/test-core.js";

let displayNo = 1000;

export async function seedTaskRun(t: TestCore, novelId: string, opts: { taskId?: string; role?: AgentRole } = {}): Promise<{ taskId: string; runId: string }> {
  const ids = t.platform.ids;
  const taskId = opts.taskId ?? ids.next("tsk");
  if (!opts.taskId) {
    await t.testDb.query(
      `INSERT INTO tasks (id, novel_id, display_no, kind, agent_role, target_type, target_id, status, created_by_actor_type, created_by_actor_id)
       VALUES ($1, $2, $3, 'concept_turn', 'concept_partner', 'concept_session', 'cns_TEST', 'running', 'system', 'orchestrator')`,
      [taskId, novelId, displayNo++],
    );
  }
  const wakeId = ids.next("wak");
  await t.testDb.query(`INSERT INTO wake_requests (id, novel_id, task_id, reason, idempotency_key, status) VALUES ($1, $2, $3, 'task_created', $4, 'claimed')`, [
    wakeId,
    novelId,
    taskId,
    `test:${wakeId}`,
  ]);
  const runId = ids.next("run");
  await t.testDb.query(
    `INSERT INTO runs (id, novel_id, task_id, wake_request_id, agent_role, status, prompt_template_version, started_at) VALUES ($1, $2, $3, $4, $5, 'running', 'test@0', now())`,
    [runId, novelId, taskId, wakeId, opts.role ?? "concept_partner"],
  );
  return { taskId, runId };
}

export function runHandle(novelId: string, taskId: string, runId: string, role: AgentRole = "writer", over: Partial<RunHandle> = {}): RunHandle {
  return { novelId, runId, taskId, role, signal: new AbortController().signal, attempt: 1, checkpoint: async () => {}, ...over };
}

export interface StubBudget extends BudgetService {
  calls: string[];
  denyNext?: "hard_limit" | "unpriced";
}

/** Implements just the run-side budget API with raw SQL so provider_calls FKs hold. */
export function stubBudget(t: TestCore): StubBudget {
  const ids = t.platform.ids;
  const b: Partial<StubBudget> & { calls: string[] } = {
    calls: [],
    async reserve(tx, scope, r) {
      b.calls.push(`reserve:${r.maxCostMicros}`);
      if (b.denyNext) {
        const reason = b.denyNext;
        b.denyNext = undefined;
        return { ok: false, reason, policyId: "bgp_TEST" };
      }
      const id = ids.next("rsv");
      await tx.db.execute(
        sql.raw(`INSERT INTO budget_reservations (id, novel_id, run_id, category, amount_micros, status) VALUES ('${id}', '${scope.novelId}', '${r.runId}', '${r.category}', ${r.maxCostMicros ?? 0}, 'active')`),
      );
      return { ok: true, reservationId: id };
    },
    async attachToCall(tx, scope, rsv, pcl) {
      b.calls.push("attach");
      await tx.db.execute(sql.raw(`UPDATE budget_reservations SET provider_call_id='${pcl}' WHERE id='${rsv}' AND novel_id='${scope.novelId}'`));
      return { attached: true };
    },
    async settle(tx, scope, s) {
      b.calls.push(`settle:${s.amountMicros}:${s.basis}:${s.isRerun}`);
      const id = ids.next("cst");
      await tx.db.execute(
        sql.raw(`INSERT INTO cost_events (id, novel_id, idempotency_key, provider_call_id, run_id, category, provider, model_id, provider_profile_id, provider_profile_version, cost_basis, amount_micros, input_tokens, output_tokens)
         VALUES ('${id}', '${scope.novelId}', 'pcl:${s.providerCallId}', '${s.providerCallId}', (SELECT run_id FROM provider_calls WHERE id='${s.providerCallId}'), 'text', '${s.provider}', '${s.modelId}', '${s.providerProfileId}', ${s.providerProfileVersion}, '${s.basis}', ${s.amountMicros}, ${s.usage.inputTokens}, ${s.usage.outputTokens})`),
      );
      await tx.db.execute(sql.raw(`UPDATE budget_reservations SET status='settled', settled_cost_event_id='${id}', settled_at=now() WHERE id='${s.reservationId}'`));
      return { costEventId: id, overrunMicros: 0 };
    },
    async release(tx, _scope, rsv) {
      b.calls.push("release");
      await tx.db.execute(sql.raw(`UPDATE budget_reservations SET status='released', settled_at=now() WHERE id='${rsv}'`));
    },
    async closeUnknown(tx, _scope, pcl, rsv) {
      b.calls.push("closeUnknown");
      await tx.db.execute(sql.raw(`UPDATE budget_reservations SET status='unknown_closed', settled_at=now() WHERE id='${rsv}'`));
      return { costEventId: `cst_unknown_${pcl}` };
    },
    async listCostEvents() {
      return [];
    },
  };
  return b as StubBudget;
}
