import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { MVP_ALPHA_TASK_KINDS, TASK_KIND_ROLE, TaskFailure, type Task } from "../../src/modules/orchestration/index.js";
import { createLogger } from "../../src/platform/index.js";
import { fitSections } from "../../src/modules/agents/domain/context-budget.js";
import { disallowedWrites } from "../../src/modules/agents/domain/roles.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { runHandle, seedTaskRun } from "../llm/support.js";

let t: TestCore;
let novelId: string;
beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({ title: "회귀한 서고지기" }, t.owner)).id;
});
afterAll(() => t.close());

const agents = () => t.modules.agents.service;

describe("agents: roles & prompt templates", () => {
  it("defines the 8 MVP roles (+2 v1) with allowed writes", () => {
    expect(agents().roles.filter((r) => r.mvp).map((r) => r.role)).toEqual([
      "concept_partner",
      "showrunner",
      "planner",
      "world_keeper",
      "writer",
      "continuity_editor",
      "foreshadow_manager",
      "line_editor",
    ]);
    expect(agents().getRole("writer").allowedWrites).toContain("manuscript.createVersion");
    expect(disallowedWrites("concept_partner", ["concept.applySlotUpdates", "concept.submitBriefForApproval"])).toEqual(["concept.submitBriefForApproval"]);
    expect(disallowedWrites("writer", ["manuscript.createVersion(kind=draft)"])).toEqual([]);
  });

  it("has a Korean template `<role>.<kind>@0.1.0` for every MVP-α task kind (+ dedupe, reassign combos)", () => {
    for (const kind of [...MVP_ALPHA_TASK_KINDS, "dedupe_entities" as const]) {
      const id = `${TASK_KIND_ROLE[kind]}.${kind}@0.1.0`;
      expect(() => agents().getPromptTemplate(id), id).not.toThrow();
    }
    expect(agents().getPromptTemplate("line_editor.revise_episode@0.1.0")).toBeTruthy();
    expect(agents().getPromptTemplate("writer.polish_episode@0.1.0")).toBeTruthy();
  });

  it("renders vars deterministically (manuscript tags, target length, episode label)", () => {
    const pack = { snapshotId: "ctx_X", system: "SYS", messages: [{ role: "user" as const, content: "CTX" }], handles: { entities: [], names: [] }, tokenEstimate: 0, droppedSections: [] };
    const r = agents().renderPrompt("writer.draft_episode@0.1.0", { episodeNo: 3, targetChars: { min: 5000, max: 5500 }, manuscript: "본문" }, pack);
    expect(r.system).toMatch(/^SYS/);
    expect(r.system).toMatch(/제3화의 본문 초고/);
    expect(r.messages[0]!.content).toBe("CTX");
    expect(r.messages[1]!.content).toMatch(/목표 분량: 5000~5500자/);
    expect(r.messages[1]!.content).toMatch(/<manuscript>\n본문\n<\/manuscript>/);
  });

  it("GET /api/agents/roles and /api/agents/prompt-templates", async () => {
    const r = await t.http("GET", "/api/agents/roles");
    expect(r.body.items).toHaveLength(10);
    expect(r.body.items.find((x: { role: string }) => x.role === "planner").templates).toContain("planner.outline_episode@0.1.0");
    const p = await t.http("GET", "/api/agents/prompt-templates");
    expect(p.body.items.length).toBeGreaterThanOrEqual(25);
  });
});

describe("agents: ContextBuilder", () => {
  it("token budget keeps rank 1–3, drops 4–7 first, fails loudly when required sections overflow", () => {
    const items = [
      { section: "outline" as const, tokenEstimate: 50 },
      { section: "recent_text" as const, tokenEstimate: 40 },
      { section: "canon_1hop" as const, tokenEstimate: 30 },
    ];
    expect(fitSections(items, 10, 200)).toMatchObject({ ok: true, dropped: [] });
    expect(fitSections(items, 10, 95)).toMatchObject({ ok: true, dropped: ["recent_text"] });
    expect(fitSections(items, 10, 61)).toMatchObject({ ok: true, dropped: ["recent_text", "canon_1hop"] });
    expect(fitSections(items, 10, 30)).toMatchObject({ ok: false });
  });

  it("builds a pack from providers, assigns handles, records a snapshot (FR-AGT-04) and serves it over HTTP", async () => {
    agents().registerContextSection({
      section: "outline",
      module: "test",
      async build(_scope, spec) {
        return { text: `- 주연 ({{E!:ent_01J0000000000000000000000A}})\n- 씬1: {{E:ent_01J0000000000000000000000A}}가 {{E:ent_01J0000000000000000000000B}}를 만난다 (${spec.episodeId})`, tokenEstimate: 0, refs: { setupIds: ["stp_TEST"], versionIds: ["mnv_X"] } };
      },
    });
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const run = runHandle(novelId, taskId, runId, "writer");
    const spec = agents().defaultContextSpec("writer", { anchor: { storyPoint: 3000, timelineId: "" }, episodeId: "epi_TEST", seeds: { entityIds: [], setupIds: [], answerIds: ["ans_1"], mentionIds: [] } });
    expect(spec.maxInputTokens).toBe(40000);
    const pack = await agents().contextBuilder.build(run, spec);
    expect(pack.snapshotId).toMatch(/^ctx_/);
    expect(pack.system).toMatch(/회귀한 서고지기/);
    // 설계 추가 0025: a prose role (writer) never sees a handle — names in sentences, reference marks removed
    expect(pack.messages[0]!.content).toMatch(/- 주연\n- 씬1: 이름 없는 대상가 이름 없는 대상를 만난다 \(epi_TEST\)/);
    expect(pack.messages[0]!.content).not.toMatch(/E\d/);
    expect(pack.system).not.toMatch(/핸들/);
    expect(pack.handles.labels).toEqual(["", ""]);
    expect(pack.handles.entities).toEqual(["ent_01J0000000000000000000000A", "ent_01J0000000000000000000000B"]);
    expect(agents().resolveEntityHandle(pack, "E2")).toBe("ent_01J0000000000000000000000B");
    expect(() => agents().resolveEntityHandle(pack, "E9")).toThrow(TaskFailure);

    const snap = await agents().getContextSnapshot({ novelId }, pack.snapshotId);
    expect(snap).toMatchObject({ runId, storyPoint: 3000, entityIds: pack.handles.entities, setupIds: ["stp_TEST"], answerIds: ["ans_1"], clonedFromSnapshotId: null });
    const r = await t.http("GET", `/api/novels/${novelId}/context-snapshots/${pack.snapshotId}`);
    expect(r.status).toBe(200);
    expect(r.body.pack.messages[0].content).toMatch(/이름 없는 대상가/);

    // a task that resolves handles (spec.entityMarks: outline_episode) keeps the reference marks, still no handle inside a sentence
    const p2 = await seedTaskRun(t, novelId);
    const planner = await agents().contextBuilder.build(runHandle(novelId, p2.taskId, p2.runId, "planner"), { ...spec, sections: ["outline"], entityMarks: true });
    expect(planner.messages[0]!.content).toMatch(/- 주연 \(E1\)\n- 씬1: 이름 없는 대상가 이름 없는 대상를 만난다/);
    expect(planner.system).toMatch(/JSON의 엔티티 참조 필드에만/);

    // RU-3 clone
    const rerun = await seedTaskRun(t, novelId, { taskId });
    const clone = await agents().contextBuilder.cloneFrom(pack.snapshotId, runHandle(novelId, taskId, rerun.runId, "writer"));
    expect(clone.snapshotId).not.toBe(pack.snapshotId);
    expect(clone.messages).toEqual(pack.messages);
    const cs = await agents().getContextSnapshot({ novelId }, clone.snapshotId);
    expect(cs).toMatchObject({ runId: rerun.runId, clonedFromSnapshotId: pack.snapshotId, entityIds: pack.handles.entities });
  });

  it("fails with internal (not silently truncated) when required sections exceed the limit", async () => {
    agents().registerContextSection({ section: "assigned_beats", module: "test", build: async () => ({ text: "가".repeat(2000), tokenEstimate: 0, refs: {} }) });
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const spec = agents().defaultContextSpec("planner", { anchor: { storyPoint: 0, timelineId: "" }, maxInputTokens: 500 });
    const err = await agents().contextBuilder.build(runHandle(novelId, taskId, runId, "planner"), spec).catch((e) => e);
    expect(err).toBeInstanceOf(TaskFailure);
    expect(err.errorFamily).toBe("internal");
    expect(err.message).toMatch(/컨텍스트 상한 초과/);
  });
});

describe("agents: defineAgentTask", () => {
  it("rejects a role that differs from TASK_KIND_ROLE", () => {
    expect(() =>
      agents().defineAgentTask({
        kind: "draft_episode",
        role: "planner",
        promptTemplateVersion: "planner.draft_episode@0.1.0",
        inputSchema: z.object({}),
        allowedWrites: [],
        buildContext: async () => ({}) as never,
        execute: async () => ({}),
        commit: async () => ({ kind: "done", outputRefs: [] }),
      }),
    ).toThrow(/TASK_KIND_ROLE/);
  });

  it("buildContext → execute (scripted Claude response, zod-validated) → commit through the adapted TaskKindHandler", async () => {
    const Outline = z.object({ title: z.string(), scenes: z.array(z.object({ ord: z.number().int(), summary: z.string() })).min(3) });
    const committed: unknown[] = [];
    const handler = agents().defineAgentTask({
      kind: "outline_episode",
      role: "planner",
      promptTemplateVersion: "planner.outline_episode@0.1.0",
      inputSchema: z.object({ episode_no: z.number() }),
      allowedWrites: ["manuscript.createVersion(kind=outline)"],
      buildContext: (run, input, builder) => builder.build(run, agents().defaultContextSpec("planner", { anchor: { storyPoint: input.episode_no * 1000, timelineId: "" } })),
      async execute(run, input, pack, llm) {
        const { system, messages } = agents().renderPrompt("planner.outline_episode@0.1.0", { episodeNo: input.episode_no }, pack);
        const out = await llm.call({ run, purpose: "outline", system, messages, output: { kind: "object", schemaName: "outline_episode", schema: Outline } });
        return out.value as z.infer<typeof Outline>;
      },
      async commit(_tx, _run, _input, proposal) {
        committed.push(proposal);
        return { kind: "done", outputRefs: [] };
      },
    });
    expect(handler.promptTemplateVersion).toBe("planner.outline_episode@0.1.0");
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const run = runHandle(novelId, taskId, runId, "planner");
    const scripted = { title: "4화: 무너진 다리", scenes: [{ ord: 1, summary: "다리가 무너진다" }, { ord: 2, summary: "생존자를 찾는다" }, { ord: 3, summary: "배신이 드러난다" }] };
    t.claude.reply({ when: { schemaHas: ["title", "scenes"] }, json: scripted });
    const ctx = { scope: { novelId }, task: { id: taskId, attemptCount: 1 } as Task, input: { episode_no: 4 }, run, log: createLogger("silent") };
    const p = await handler.execute(ctx);
    expect(p.context.snapshotId).toMatch(/^ctx_/);
    expect(p.proposal).toEqual(scripted);
    // the rendered template reached the model
    expect(t.claude.requests).toHaveLength(1);
    const outcome = await t.platform.uow.run((tx) => handler.commit(tx, ctx, p));
    expect(outcome).toEqual({ kind: "done", outputRefs: [] });
    expect(committed).toHaveLength(1);
  });
});
