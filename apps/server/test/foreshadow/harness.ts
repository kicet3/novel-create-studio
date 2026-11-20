/**
 * Test harness for foreshadow + continuity: real platform/audit/novel over a fresh PGlite DB, the two
 * modules under test built with in-memory stubs of manuscript / ontology / hitl / orchestration /
 * agents; model output comes from a scripted ModelCallPort per test (`h.llm(responder)`). Rows of foreign tables (arcs, episodes,
 * versions, scenes, runs, questions, approvals) are seeded with SQL so every FK holds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@ncs/db/testing";
import { and, asc, eq, sql } from "@ncs/db/orm";
import { episodes, goals, manuscriptVersions, ontologySchemaVersions, scenes, timelines } from "@ncs/db/schema";
import { parseInstallConfig } from "@ncs/shared";
import { buildGoal, FakeClock } from "@ncs/test-kit";
import { createLogger, createPlatform, type ActorRef, type Db, type NovelScope, type Platform, type Tx } from "../../src/platform/index.js";
import { createAuditModule, type AuditService } from "../../src/modules/audit/index.js";
import { createNovelModule, type NovelService } from "../../src/modules/novel/index.js";
import type { ContextPack } from "../../src/modules/agents/index.js";
import type { ModelCallInput, ModelCallPort } from "../../src/modules/llm/index.js";
import type { CheckGateContributor, EpisodeTransitionContext, ManuscriptIssueSink } from "../../src/modules/manuscript/index.js";
import type { FactAtAnchor } from "../../src/modules/ontology/index.js";
import type { RunHandle } from "../../src/modules/orchestration/index.js";
import { createForeshadowModule, type ForeshadowService } from "../../src/modules/foreshadow/index.js";
import { createContinuityModule, type ContinuityService } from "../../src/modules/continuity/index.js";
import type { AnswerApplier, ApprovalHandler } from "../../src/modules/hitl/index.js";

export interface Harness {
  testDb: TestDb;
  platform: Platform;
  clock: FakeClock;
  audit: AuditService;
  novel: NovelService;
  scope: NovelScope;
  owner: ActorRef & { type: "user" };
  timelineId: string;
  goalId: string;
  foreshadow: ForeshadowService;
  continuity: ContinuityService;
  /** registrations captured from the modules */
  reg: {
    contributors: CheckGateContributor[];
    hooks: Array<(ctx: EpisodeTransitionContext) => Promise<void>>;
    taskHandlers: Map<string, any>;
    appliers: Map<string, AnswerApplier>;
    approvalHandlers: Map<string, ApprovalHandler>;
    contextSections: any[];
    safetySinks: ManuscriptIssueSink[];
  };
  calls: { advanceCheckGate: string[]; requestArcPlanApproval: string[]; createTask: any[]; createQuestion: any[]; requestApproval: any[] };
  ontology: { linkedFacts: FactAtAnchor[]; mentions: any[]; leaks: any[]; violations: any[]; canon: FactAtAnchor[]; constraints: FactAtAnchor[]; storyTokens: string[] };
  /** 설계 추가 0019: manuscript.getEpisodeEnd stub (episode no → end) */
  episodeEnds: Map<number, import("../../src/modules/manuscript/index.js").EpisodeEnd>;
  run(tx: Tx): <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  createArc(from: number, to: number, status?: string): Promise<string>;
  createEpisode(arcId: string, no: number): Promise<string>;
  createVersion(episodeId: string, content: string, opts?: { isHumanEdit?: boolean; scenes?: Array<[number, number]>; typedSpans?: Array<[number, number]> }): Promise<{ versionId: string; sceneIds: string[] }>;
  createRun(kind: string, role: string, targetType: string, targetId: string): Promise<RunHandle & { task: any }>;
  createQuestion(topic?: string, tx?: Tx): Promise<string>;
  createApproval(type: string, subjectType: string, subjectId: string, status?: string, tx?: Tx): Promise<string>;
  fireTransition(episodeId: string, from: string, to: string, actor?: ActorRef): Promise<void>;
  createEntity(): Promise<string>;
  /** real facts + fact_versions rows (evidence FKs) returned as FactAtAnchor */
  createFact(subjectEntityId: string, predicate: string, value: unknown, opts?: { canonStatus?: string; factKind?: string; text?: string }): Promise<FactAtAnchor>;
  llm(responder: (input: ModelCallInput<unknown>) => unknown): ModelCallPort & { inputs: ModelCallInput<unknown>[] };
  context: ContextPack;
  close(): Promise<void>;
}

const q = (s: string) => s.replace(/'/g, "''");

export async function createHarness(): Promise<Harness> {
  const testDb = await createTestDb();
  const home = mkdtempSync(join(tmpdir(), "ncs-fs-test-"));
  const clock = new FakeClock("2026-11-01T00:00:00.000Z");
  const platform = createPlatform({
    config: parseInstallConfig({ home, logging: { level: "silent" } }),
    appVersion: "test",
    db: testDb.db as unknown as Db,
    log: createLogger("silent"),
    clock,
  });
  const audit = createAuditModule({ platform }).service;
  const novelMod = createNovelModule({ platform, audit });
  await novelMod.start!();
  const ownerRow = (await novelMod.service.getOwnerUser())!;
  const owner = { type: "user" as const, id: ownerRow.id };
  // stand-in for the ontology N1 participant (schema v1 + main timeline)
  const timelineId = platform.ids.next("tln");
  novelMod.service.registerCreationParticipant({
    module: "ontology",
    order: 10,
    async onNovelCreated(ctx: any) {
      await ctx.tx.db.insert(ontologySchemaVersions).values({ id: ctx.schemaVersionId, novelId: ctx.scope.novelId, versionNo: 1, baseSchemaKey: "base@1" });
      await ctx.tx.db.insert(timelines).values({ id: timelineId, novelId: ctx.scope.novelId, kind: "main", label: "본편", isDefault: true });
    },
  });
  const n = await novelMod.service.createNovel({ title: "떡밥 시험" }, owner);
  const scope = { novelId: n.id };
  const goal = buildGoal(n.id, { id: platform.ids.next("gol") });
  await testDb.db.insert(goals).values(goal as any);

  const reg: Harness["reg"] = {
    contributors: [],
    hooks: [],
    taskHandlers: new Map(),
    appliers: new Map(),
    approvalHandlers: new Map(),
    contextSections: [],
    safetySinks: [],
  };
  const calls: Harness["calls"] = { advanceCheckGate: [], requestArcPlanApproval: [], createTask: [], createQuestion: [], requestApproval: [] };
  const ont: Harness["ontology"] = { linkedFacts: [], mentions: [], leaks: [], violations: [], canon: [], constraints: [], storyTokens: [] };
  const db = () => testDb.db as unknown as Db;
  const episodeEnds: Harness["episodeEnds"] = new Map();

  /** raw SQL inside the caller's transaction when given (PGlite has one connection) */
  async function exec(text: string, tx?: Tx): Promise<any[]> {
    if (tx) {
      const r = (await tx.db.execute(sql.raw(text))) as any;
      return Array.isArray(r) ? r : (r.rows ?? []);
    }
    return testDb.query(text);
  }
  let qNo = 0;
  async function createQuestion(topic = "setup_due", tx?: Tx): Promise<string> {
    const id = platform.ids.next("qst");
    await exec(
      `INSERT INTO questions (id, novel_id, display_no, grade, question_type, topic, title, body, rationale, blocking_basis, grade_reason)
       VALUES ('${id}', '${n.id}', ${++qNo + 1000}, 'informational', 'single_choice', '${topic}', '질문', '본문', '근거', 'none', '시험')`,
      tx,
    );
    return id;
  }
  async function createApproval(type: string, subjectType: string, subjectId: string, status = "approved", tx?: Tx): Promise<string> {
    const qid = await createQuestion("approval_gate", tx);
    const id = platform.ids.next("apr");
    await exec(
      `INSERT INTO approvals (id, novel_id, approval_type, status, subject_type, subject_id, question_id, requested_by_actor_type, requested_by_actor_id, decided_at, decided_by_user_id)
       VALUES ('${id}', '${n.id}', '${type}', '${status}', '${subjectType}', '${subjectId}', '${qid}', 'system', 'orchestrator', ${status === "pending" ? "NULL" : "now()"}, ${status === "pending" ? "NULL" : `'${owner.id}'`})`,
      tx,
    );
    return id;
  }

  const manuscript = {
    async getEpisode(_s: NovelScope, id: string, tx?: Tx) {
      const [e] = await (tx?.db ?? db()).select().from(episodes).where(eq(episodes.id, id));
      if (!e) throw new Error(`episode ${id} missing`);
      return e;
    },
    async getEpisodeByNo(_s: NovelScope, no: number, tx?: Tx) {
      const [e] = await (tx?.db ?? db()).select().from(episodes).where(and(eq(episodes.novelId, n.id), eq(episodes.episodeNo, no)));
      if (!e) throw new Error(`episode ${no} missing`);
      return e;
    },
    async listEpisodes(_s: NovelScope, f: { statuses?: string[] } = {}) {
      const rows = await db().select().from(episodes).where(eq(episodes.novelId, n.id)).orderBy(asc(episodes.episodeNo));
      return f.statuses ? rows.filter((r) => f.statuses!.includes(r.status)) : rows;
    },
    async getVersion(_s: NovelScope, id: string, tx?: Tx) {
      const [v] = await (tx?.db ?? db()).select().from(manuscriptVersions).where(eq(manuscriptVersions.id, id));
      if (!v) throw new Error(`version ${id} missing`);
      return v;
    },
    async listScenes(_s: NovelScope, episodeId: string, opts: { versionId?: string } = {}) {
      const rows = await db().select().from(scenes).where(eq(scenes.episodeId, episodeId)).orderBy(asc(scenes.ord));
      return rows.filter((r) => r.status === "active" && (!opts.versionId || r.manuscriptVersionId === opts.versionId));
    },
    registerCheckGateContributor: (c: CheckGateContributor) => void reg.contributors.push(c),
    onEpisodeTransition: (h: any) => void reg.hooks.push(h),
    async advanceCheckGate(_tx: Tx, _s: NovelScope, episodeId: string) {
      calls.advanceCheckGate.push(episodeId);
      return { kind: "wait", reason: "test" };
    },
    async requestArcPlanApproval(_tx: Tx, _s: NovelScope, arcId: string) {
      calls.requestArcPlanApproval.push(arcId);
      return { approvalId: null };
    },
    registerVersionAnnotator: () => undefined,
    registerIssueSink: (s: ManuscriptIssueSink) => void reg.safetySinks.push(s),
    async getEpisodeEnd(_s: NovelScope, no: number) {
      return episodeEnds.get(no) ?? null;
    },
  };
  const ontology = {
    async getSetupLinkedFacts(_s: NovelScope, ids: string[]) {
      return ont.linkedFacts.filter((f) => ids.includes(f.factId));
    },
    async getDefaultTimeline() {
      return { id: timelineId } as any;
    },
    // 설계 추가 0026 (P1): story tokens — in the real ontology, tokens inside names a person gave an entity
    async storyHandleTokens() {
      return new Set(ont.storyTokens);
    },
    async listMentions() {
      return ont.mentions;
    },
    async findIdentityLeaks() {
      return ont.leaks;
    },
    async findSchemaViolations(_s: NovelScope, ids?: string[]) {
      return ids ? ont.violations.filter((v) => ids.includes(v.factId)) : ont.violations;
    },
    async getCanonAt(_s: NovelScope, ids: string[]) {
      return ont.canon.filter((f) => ids.includes(f.subjectEntityId));
    },
    async getConstraints() {
      return ont.constraints;
    },
    async knowledgeOf() {
      return [];
    },
    async resolveEntityIds(_s: NovelScope, ids: string[]) {
      return new Map(ids.map((i) => [i, i]));
    },
  };
  const hitl = {
    async createQuestion(_tx: Tx, _s: NovelScope, draft: any, ctx: any) {
      const questionId = await createQuestion(draft.topic, _tx);
      calls.createQuestion.push({ draft, ctx, questionId });
      return { questionId, grade: "non_blocking", displayNo: qNo };
    },
    async requestApproval(_tx: Tx, _s: NovelScope, req: any) {
      const approvalId = await createApproval(req.approvalType, req.target.type, req.target.id, "pending", _tx);
      calls.requestApproval.push({ req, approvalId });
      return { approvalId, questionId: "qst_x" };
    },
    async listQuestions() {
      return [];
    },
    async getApproval(_s: NovelScope, id: string, tx?: Tx) {
      const rows = await exec(`SELECT id, approval_type AS "approvalType", status, subject_type AS "subjectType", subject_id AS "subjectId", decided_at AS "decidedAt" FROM approvals WHERE id = '${id}'`, tx);
      if (!rows[0]) throw new Error("approval missing");
      return rows[0];
    },
    registerAnswerApplier: (t: string, a: AnswerApplier) => void reg.appliers.set(t, a),
    registerApprovalHandler: (t: string, h: ApprovalHandler) => void reg.approvalHandlers.set(t, h),
  };
  const orchestration = {
    async createTask(_tx: Tx, _s: NovelScope, input: any) {
      calls.createTask.push(input);
      return { taskId: `tsk_${calls.createTask.length}`, created: true };
    },
    async listTasks() {
      return [];
    },
    registerTaskKind: (h: any) => void reg.taskHandlers.set(h.kind, h),
  };
  const agents = {
    defineAgentTask: (h: any) => h, // the tests drive AgentTaskHandlers directly
    registerContextSection: (p: any) => void reg.contextSections.push(p),
  };

  const fs = createForeshadowModule({ platform, audit, novel: novelMod.service, ontology: ontology as any, manuscript: manuscript as any, orchestration: orchestration as any, agents: agents as any, hitl: hitl as any });
  const ci = createContinuityModule({ platform, audit, novel: novelMod.service, ontology: ontology as any, manuscript: manuscript as any, foreshadow: fs.service, orchestration: orchestration as any, agents: agents as any, hitl: hitl as any });
  await fs.start!();
  await ci.start!();

  let arcOrd = 0;
  const h: Harness = {
    episodeEnds,
    testDb,
    platform,
    clock,
    audit,
    novel: novelMod.service,
    scope,
    owner,
    timelineId,
    goalId: goal.id,
    foreshadow: fs.service,
    continuity: ci.service,
    reg,
    calls,
    ontology: ont,
    run: () => (fn) => platform.uow.run(fn),
    tx: (fn) => platform.uow.run(fn),
    async createArc(from, to, status = "planned") {
      const arc = await novelMod.service.createArc(undefined, scope, { ord: ++arcOrd, title: `아크 ${arcOrd}`, goalText: "목표", conflictText: "갈등", endCondition: "결말", plannedEpisodeFrom: from, plannedEpisodeTo: to }, owner);
      if (status !== "planned") await testDb.exec(`UPDATE arcs SET status = '${status}' WHERE id = '${arc.id}'`);
      return arc.id;
    },
    async createEpisode(arcId, no) {
      const id = platform.ids.next("epi");
      await testDb.exec(`INSERT INTO episodes (id, novel_id, arc_id, episode_no, status, primary_timeline_id) VALUES ('${id}', '${n.id}', '${arcId}', ${no}, 'checking', '${timelineId}')`);
      return id;
    },
    async createVersion(episodeId, content, opts = {}) {
      const [{ c }] = (await testDb.query<{ c: number }>(`SELECT count(*)::int AS c FROM manuscript_versions WHERE episode_id = $1`, [episodeId])) as [{ c: number }];
      const versionId = platform.ids.next("mnv");
      await testDb.exec(
        `INSERT INTO manuscript_versions (id, novel_id, episode_id, version_no, kind, stage, content, char_count_with_spaces, char_count_without_spaces, content_hash, author_actor_type, author_actor_id, is_human_edit, attribution_spans)
         VALUES ('${versionId}', '${n.id}', '${episodeId}', ${Number(c) + 1}, 'draft', 'drafting', '${q(content)}', ${content.length}, ${content.replace(/\s/g, "").length}, 'h${c}', 'user', '${owner.id}', ${opts.isHumanEdit ? "true" : "false"}, '${JSON.stringify((opts.typedSpans ?? []).map(([start, end]) => ({ start, end, actorType: "user", actorId: owner.id, originVersionId: versionId })))}'::jsonb)`,
      );
      await testDb.exec(`UPDATE episodes SET current_version_id = '${versionId}' WHERE id = '${episodeId}'`);
      const [ep] = await testDb.query<{ episode_no: number }>(`SELECT episode_no FROM episodes WHERE id = $1`, [episodeId]);
      const spans = opts.scenes ?? [[0, content.length]];
      // scene ids are retained across versions: reuse the episode's scene rows by ord
      const existing = await testDb.query<{ id: string; ord: number }>(`SELECT id, ord FROM scenes WHERE episode_id = $1`, [episodeId]);
      const sceneIds: string[] = [];
      for (let i = 0; i < spans.length; i++) {
        const [a, b] = spans[i]!;
        const ex = existing.find((x) => x.ord === i + 1);
        if (ex) {
          await testDb.exec(`UPDATE scenes SET manuscript_version_id = '${versionId}', char_start = ${a}, char_end = ${b}, status = 'active' WHERE id = '${ex.id}'`);
          sceneIds.push(ex.id);
        } else {
          const sid = platform.ids.next("scn");
          await testDb.exec(
            `INSERT INTO scenes (id, novel_id, episode_id, ord, manuscript_version_id, char_start, char_end, story_point, timeline_id, summary)
             VALUES ('${sid}', '${n.id}', '${episodeId}', ${i + 1}, '${versionId}', ${a}, ${b}, ${ep!.episode_no * 1000 + i + 1}, '${timelineId}', '씬 ${i + 1}')`,
          );
          sceneIds.push(sid);
        }
      }
      for (const ex of existing) if (ex.ord > spans.length) await testDb.exec(`UPDATE scenes SET status = 'retired' WHERE id = '${ex.id}'`);
      return { versionId, sceneIds };
    },
    async createRun(kind, role, targetType, targetId) {
      const taskId = platform.ids.next("tsk");
      const [{ m }] = (await testDb.query<{ m: number }>(`SELECT coalesce(max(display_no), 0)::int AS m FROM tasks WHERE novel_id = $1`, [n.id])) as [{ m: number }];
      await testDb.exec(
        `INSERT INTO tasks (id, novel_id, display_no, kind, agent_role, target_type, target_id, goal_id, status, created_by_actor_type, created_by_actor_id)
         VALUES ('${taskId}', '${n.id}', ${Number(m) + 1}, '${kind}', '${role}', '${targetType}', '${targetId}', '${goal.id}', 'running', 'system', 'orchestrator')`,
      );
      const wakeId = platform.ids.next("wak");
      await testDb.exec(`INSERT INTO wake_requests (id, novel_id, task_id, reason, idempotency_key) VALUES ('${wakeId}', '${n.id}', '${taskId}', 'task_created', '${wakeId}')`);
      const runId = platform.ids.next("run");
      await testDb.exec(
        `INSERT INTO runs (id, novel_id, task_id, wake_request_id, agent_role, status, prompt_template_version) VALUES ('${runId}', '${n.id}', '${taskId}', '${wakeId}', '${role}', 'running', 'test@0')`,
      );
      const [task] = await testDb.query<any>(`SELECT id FROM tasks WHERE id = $1`, [taskId]);
      return { novelId: n.id, runId, taskId, role: role as any, signal: new AbortController().signal, attempt: 1, checkpoint: async () => {}, task };
    },
    createQuestion,
    createApproval,
    async createEntity() {
      const id = platform.ids.next("ent");
      await testDb.exec(`INSERT INTO entities (id, novel_id, entity_type, status, created_by_actor_type, created_by_actor_id) VALUES ('${id}', '${n.id}', 'character', 'candidate', 'system', 'orchestrator')`);
      return id;
    },
    async createFact(subjectEntityId, predicate, value, opts = {}) {
      const factId = platform.ids.next("fct");
      const fvId = platform.ids.next("fcv");
      const canon = opts.canonStatus ?? "approved";
      const kind = opts.factKind ?? "attribute";
      const [sv] = await testDb.query<{ id: string }>(`SELECT id FROM ontology_schema_versions WHERE novel_id = $1`, [n.id]);
      await testDb.exec(
        `INSERT INTO facts (id, novel_id, fact_kind, subject_entity_id, predicate, value, slot_key, timeline_id, story_range, source_kind, source_ref_type, source_ref_id, schema_version_id, canon_status)
         VALUES ('${factId}', '${n.id}', '${kind}', '${subjectEntityId}', '${predicate}', '${q(JSON.stringify(value))}'::jsonb, '${subjectEntityId}:${predicate}', '${timelineId}', '[0,)', 'user_input', 'novel', '${n.id}', '${sv!.id}', '${canon}')`,
      );
      await testDb.exec(
        `INSERT INTO fact_versions (id, novel_id, fact_id, version_no, content, canon_status, recorded_by_actor_type, recorded_by_actor_id, change_reason)
         VALUES ('${fvId}', '${n.id}', '${factId}', 1, '{}'::jsonb, '${canon}', 'system', 'orchestrator', 'extracted')`,
      );
      return {
        factId,
        factVersionId: fvId,
        canonStatus: canon as any,
        factKind: kind as any,
        predicate,
        subjectEntityId,
        value,
        text: opts.text ?? `${predicate}=${JSON.stringify(value)}`,
        storyRange: { from: 0, to: null },
        timelineId,
      };
    },
    async fireTransition(episodeId, from, to, actor = owner) {
      await platform.uow.run(async (tx) => {
        if (to === "approved" && from !== "published") {
          await tx.db
            .update(episodes)
            .set({ status: "approved" as any, approvedAt: clock.date(), approvedVersionId: (await manuscript.getEpisode(scope, episodeId, tx)).currentVersionId, approvedByActorType: "user", approvedByActorId: owner.id })
            .where(eq(episodes.id, episodeId));
        } else if (to === "published") {
          const e = await manuscript.getEpisode(scope, episodeId, tx);
          await tx.db.update(episodes).set({ status: "published" as any, publishedAt: clock.date(), publishedVersionId: e.approvedVersionId, publishedByActorType: "user", publishedByActorId: owner.id }).where(eq(episodes.id, episodeId));
        } else {
          await tx.db.update(episodes).set({ status: to as any, publishedAt: null, publishedVersionId: null, publishedByActorType: null, publishedByActorId: null }).where(eq(episodes.id, episodeId));
        }
        const episode = await manuscript.getEpisode(scope, episodeId, tx);
        for (const hook of reg.hooks) await hook({ tx, scope, episode, from: from as any, to: to as any, ruleId: "E9", actor });
      });
    },
    llm(responder) {
      const inputs: ModelCallInput<unknown>[] = [];
      return {
        inputs,
        async call<T>(input: ModelCallInput<T>) {
          inputs.push(input as ModelCallInput<unknown>);
          const value = responder(input as ModelCallInput<unknown>);
          const parsed = input.output.kind === "object" ? input.output.schema.parse(value) : value;
          return { providerCallId: "pcl_test", reused: false, value: parsed as T, usage: { inputTokens: 1, outputTokens: 1 }, costMicros: 0, modelId: "claude-test" };
        },
      };
    },
    context: { snapshotId: "ctx_test", system: "", messages: [], handles: { entities: [], names: [] }, tokenEstimate: 0, droppedSections: [] },
    async close() {
      await testDb.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
  return h;
}
