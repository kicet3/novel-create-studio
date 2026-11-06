/**
 * Test support for the concept module: scripted stubs for the hitl approval port and the model port
 * (installed through `conceptInternals(service).ports`), plus chat helpers.
 */
import { sql } from "@ncs/db/orm";
import { NotImplementedError } from "../../src/platform/index.js";
import { conceptInternals } from "../../src/modules/concept/module.js";
import type { ConceptMessage, ConceptSession } from "../../src/modules/concept/index.js";
import type { TestCore } from "../support/test-core.js";

export type Scripted = Record<string, unknown> | Error | ((input: { purpose: string; system: string; messages: unknown[] }) => Promise<Record<string, unknown>> | Record<string, unknown>);

export interface ConceptHarness {
  scope: { novelId: string };
  session(): Promise<ConceptSession>;
  messages(): Promise<ConceptMessage[]>;
  lastAgent(): Promise<ConceptMessage>;
  say(text: string): Promise<{ message: ConceptMessage; taskId: string | null }>;
  pick(optionValue: string): Promise<{ message: ConceptMessage; taskId: string | null }>;
  run(): Promise<number>;
  /** queue model outputs (consumed in call order); empty queue → the port reports "not implemented" and concept runs its deterministic commit without model output */
  script: Scripted[];
  decide(decision: "approved" | "rejected", note?: string): Promise<void>;
  brief(): Promise<any>;
}

export function installConceptStubs(t: TestCore) {
  const app = conceptInternals(t.modules.concept.service);
  const script: Scripted[] = [];
  app.ports.modelCalls = () => ({
    async call(input: any) {
      const next = script.shift();
      if (next === undefined) throw new NotImplementedError("llm.modelCalls (test)");
      if (next instanceof Error) throw next;
      const value = typeof next === "function" ? await next(input) : next;
      const parsed = input.output.kind === "object" ? input.output.schema.parse(value) : value;
      return { providerCallId: "pcl_test", reused: false, value: parsed, usage: { inputTokens: 10, outputTokens: 10 }, costMicros: 1000, modelId: "claude-test" };
    },
  });
  if (!t.modules.hitl.implemented) {
    app.ports.hitl = {
      async requestApproval(tx, scope, req) {
        const qid = t.platform.ids.next("qst");
        const aid = t.platform.ids.next("apr");
        const n = ((await tx.db.execute(sql`SELECT coalesce(max(display_no), 0) + 1 AS n FROM questions WHERE novel_id = ${scope.novelId}`)) as any).rows[0].n as number;
        await tx.db.execute(sql`INSERT INTO questions (id, novel_id, display_no, grade, question_type, topic, title, body, recommendation, rationale, blocking_basis, grade_reason, deadline_at)
          VALUES (${qid}, ${scope.novelId}, ${n}, 'blocking', 'approve_reject', 'concept_confirm', ${req.question.title}, ${req.question.body}, '{}'::jsonb, '', 'approval_gate', 'approval_gate', now() + interval '1 day')`);
        await tx.db.execute(sql`INSERT INTO approvals (id, novel_id, approval_type, subject_type, subject_id, question_id, requested_by_actor_type, requested_by_actor_id)
          VALUES (${aid}, ${scope.novelId}, ${req.approvalType}, ${req.target.type}, ${req.target.id}, ${qid}, ${req.requestedBy.type}, ${req.requestedBy.id})`);
        await tx.db.execute(sql`UPDATE questions SET approval_id = ${aid} WHERE id = ${qid}`);
        return { approvalId: aid, questionId: qid };
      },
      async cancelApproval(tx, scope, approvalId) {
        await tx.db.execute(sql`UPDATE approvals SET status = 'cancelled' WHERE novel_id = ${scope.novelId} AND id = ${approvalId}`);
      },
    };
  }
  return { app, script };
}

export async function conceptHarness(t: TestCore, novelId: string, script: Scripted[]): Promise<ConceptHarness> {
  const svc = t.modules.concept.service;
  const app = conceptInternals(svc);
  const scope = { novelId };
  const session = async (): Promise<ConceptSession> => {
    const open = await svc.getActiveSession(scope);
    if (open) return open;
    const r = (await t.testDb.db.execute(sql`SELECT id FROM concept_sessions WHERE novel_id = ${novelId} ORDER BY created_at DESC LIMIT 1`)) as any;
    return svc.getSession(scope, r.rows[0].id as string);
  };
  const sid = async () => (await session()).id;
  const webChannel = async () => {
    const s = await session();
    return ((s.workingBrief as any)?.meta?.web_channel_id as string) ?? s.activeChannelId;
  };
  return {
    scope,
    session,
    script,
    async messages() {
      return svc.listMessages(scope, await sid());
    },
    async lastAgent() {
      const ms = (await svc.listMessages(scope, await sid())).filter((m) => m.authorKind === "agent" && !m.isSuperseded);
      return ms[ms.length - 1]!;
    },
    async say(text) {
      return svc.postUserMessage(scope, await sid(), { body: text, channelId: await webChannel() }, t.owner);
    },
    async pick(optionValue) {
      return svc.postUserMessage(scope, await sid(), { body: optionValue, kind: "option_pick", optionValue, channelId: await webChannel() }, t.owner);
    },
    async run() {
      await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${novelId}'`);
      return t.modules.orchestration.service.runOnce();
    },
    async decide(decision, note) {
      const s = await session();
      const approvalId = s.pendingApprovalId!;
      if (t.modules.hitl.implemented) {
        const approval = await t.modules.hitl.service.getApproval(scope, approvalId);
        await t.modules.hitl.service.acceptAnswer(scope, {
          questionId: approval.questionId,
          channelId: await webChannel(),
          responderUserId: t.ownerId,
          approval: { decision, decisionNote: note },
          sourceKey: `test:${approvalId}`,
        });
        return;
      }
      await t.platform.uow.run(async (tx) => {
        await tx.db.execute(sql`UPDATE approvals SET status = ${decision}, decided_at = now(), decided_by_user_id = ${t.ownerId}, decision_note = ${note ?? null} WHERE id = ${approvalId}`);
        const r = (await tx.db.execute(sql`SELECT * FROM approvals WHERE id = ${approvalId}`)) as any;
        const row = r.rows[0] as Record<string, unknown>;
        const approval = { id: row.id, novelId: row.novel_id, approvalType: row.approval_type, subjectType: row.subject_type, subjectId: row.subject_id, questionId: row.question_id } as any;
        await app.onApprovalDecided({ tx, scope, approval, decision, decisionNote: note ?? null, reworkFrom: null, actor: t.owner, answerId: null });
      });
    },
    async brief() {
      return (await session()).workingBrief as any;
    },
  };
}
