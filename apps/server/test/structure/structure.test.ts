/**
 * 설계 추가 0008 — 전체 구성(1~4부 + 결말) → 플롯 → 화, on the in-process core (PGlite, real Claude adapter against the
 * scripted Messages API; responses in support/pipeline-script.ts and below):
 * cast completeness gate (422 cast_incomplete) → draft_cast fill_missing → plan_structure → user edit / reject /
 * regenerate (user fields kept) → user-only approval → plots per part → plan_arc with episode plans → ending change
 * re-approval (flags, auto re-plan) → goal ending change → plot characters gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, hooks, planningNovel, structureAwaiting, type Scope } from "./harness.js";

let t: TestCore;
const FILL = {
  age: "AI 나이",
  appearance: "AI 외형",
  personality: "AI 성격",
  background: "AI 과거사",
  desire: "AI 목표",
  weakness: "AI 약점",
  motivation: "AI 동기",
  speech_sample: "\"AI 말투\"",
  arc_start: "AI 시작",
  arc_end: "AI 끝",
  story_role: "",
};
beforeAll(async () => {
  t = await createTestCore();
  t.claude.reply({
    times: Infinity,
    when: { schemaHas: ["characters"], prompt: "빈 필수 항목 채우기" },
    json: (r: ClaudeRequest) => {
      const id = /existing_id: (chr_[0-9A-HJKMNP-TV-Z]{26})/.exec(r.prompt)?.[1] ?? "";
      return { characters: [{ existing_id: id, role: "protagonist", name: "", aliases: [], gender: "", notes: "", relationships: [], ...FILL }] };
    },
  });
  scriptPipeline(t.claude);
});
afterAll(() => t.close());

const nv = () => t.modules.novel.service;
const ms = () => t.modules.manuscript.service;
const tasksOf = (scope: Scope, kind: dto.TaskKind) => t.modules.orchestration.service.listTasks(scope, { kinds: [kind], includeCancelled: true, limit: 100 });

describe("cast completeness gate and fill_missing", () => {
  let scope: Scope;
  it("blocks the structure with 422 cast_incomplete naming the character and the missing fields", async () => {
    ({ scope } = await planningNovel(t, { complete: false }));
    await bibleApproved(t, scope);
    expect(await tasksOf(scope, "plan_structure")).toHaveLength(0); // bible approved, cast incomplete → no auto structure
    const g = await t.http("POST", `/api/novels/${scope.novelId}/structure/generate`, {});
    expect(g.status).toBe(422);
    expect(g.body.error.code).toBe("cast_incomplete");
    expect(g.body.error.message).toContain("한결");
    expect(g.body.error.message).toContain("동기");
    expect(g.body.error.details.items[0].missing.map((m: { field: string }) => m.field)).toEqual(expect.arrayContaining(["motivation", "speechSample", "arcEnd"]));
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view).toMatchObject({ structure: null, gate: { canGenerate: false } });
    expect(view.gate.reasons[0]).toContain("캐릭터 설정을 보완하세요");
    const castView = dto.castViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/cast`)).body);
    expect(castView.completeness.complete).toBe(false);
  });

  it("fill_missing writes only empty fields (user values kept); the filled character must be accepted and confirmed", async () => {
    const hero = (await t.modules.cast.service.listCharacters(scope)).find((c) => c.role === "protagonist")!;
    expect((await t.http("PATCH", `/api/novels/${scope.novelId}/cast/characters/${hero.id}`, { age: "30세" })).status).toBe(200);
    await t.modules.cast.service.confirmCast(scope, t.owner);
    const r = await t.http("POST", `/api/novels/${scope.novelId}/cast/draft`, { fillMissing: true });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await drain(t, scope, async () => (await tasksOf(scope, "draft_cast")).every((x) => x.status === "done"));
    const filled = await t.modules.cast.service.getCharacter(scope, hero.id);
    expect(filled).toMatchObject({ age: "30세", motivation: "AI 동기", speechSample: "\"AI 말투\"", arcEnd: "AI 끝", status: "draft", proposed: false }); // the author's character is not turned into an AI proposal
    expect(filled.fieldOrigins).toMatchObject({ age: "user", motivation: "agent" });
    const prompt = t.claude.requests.find((x) => x.prompt.includes("빈 필수 항목 채우기"))!.prompt;
    expect(prompt).toContain("동기");
    const line = prompt.split("\n").find((l) => l.includes(`existing_id: ${hero.id}`))!;
    expect(line).not.toContain("나이"); // a user-filled field is not asked again
    let cast = dto.castViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/cast`)).body);
    expect(cast.completeness.complete).toBe(false); // AI values count only once accepted + confirmed
    expect(cast.completeness.items[0]!.unconfirmed).toBe(true);
    expect((await t.http("POST", `/api/novels/${scope.novelId}/cast/characters/${hero.id}/accept`)).status).toBe(200);
    cast = dto.castViewSchema.parse((await t.http("POST", `/api/novels/${scope.novelId}/cast/confirm`)).body);
    expect(cast.completeness).toMatchObject({ complete: true, items: [] });
    const again = await t.http("POST", `/api/novels/${scope.novelId}/cast/draft`, { fillMissing: true });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("nothing_to_fill");
  });

  it("generate → plan_structure → awaiting_approval with 4 parts and a structured ending", async () => {
    const r = await t.http("POST", `/api/novels/${scope.novelId}/structure/generate`, { scope: "all" });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const again = await t.http("POST", `/api/novels/${scope.novelId}/structure/generate`, {});
    expect(again.body.taskId).toBe(r.body.taskId); // running task reused
    const s = await structureAwaiting(t, scope);
    expect(s.parts.map((p) => [p.ord, p.plannedEpisodeFrom, p.plannedEpisodeTo])).toEqual([[1, 1, 3], [2, 4, 6], [3, 7, 9], [4, 10, 12]]);
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view.structure!.ending.protagonistChange.to).toBe("동료에게 등을 맡기는 검사");
    expect(view.structure!.ending.characterFinalStates).toHaveLength(1);
  });
});

describe("structure edit, rejection, user-only approval, plots and re-approval", () => {
  let scope: Scope;
  it("bible approval with a complete cast creates plan_structure automatically; plan_arc is gated until approval", async () => {
    ({ scope } = await planningNovel(t, { title: "구성 작품" }));
    await bibleApproved(t, scope);
    expect(await tasksOf(scope, "plan_structure")).toHaveLength(1);
    expect(await tasksOf(scope, "schedule_episodes")).toHaveLength(0);
    await structureAwaiting(t, scope);
    // plan_arc gate: structure not approved → approval block
    const gate = t.modules.orchestration.service.getTaskKind("plan_arc")!.gate!;
    const g = await gate(scope, { input: { arc_id: "arc_x" } } as never);
    expect(g).toMatchObject({ ok: false, blockReason: "approval" });
  });

  it("a user edit while awaiting approval → draft (ST5), field origin user; reject → regenerate keeps the user title", async () => {
    let s = (await nv().getStructure(scope))!;
    const part1 = s.parts.find((p) => p.ord === 1)!;
    const stale = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/parts/${part1.id}`, { expectedRevision: s.revision + 5, title: "x" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("revision_conflict");
    const bad = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/parts/${part1.id}`, { expectedRevision: s.revision, plannedEpisodeFrom: 2 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("part_range_invalid");
    const r = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/parts/${part1.id}`, { expectedRevision: s.revision, title: "작가의 1부", plannedEpisodeTo: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = dto.storyStructureDtoSchema.parse(r.body);
    expect(d.status).toBe("draft");
    expect(d.parts[0]).toMatchObject({ title: "작가의 1부", plannedEpisodeTo: 4, fieldOrigins: { title: "user", plannedEpisodeTo: "user" } });
    expect(d.parts[1]!.plannedEpisodeFrom).toBe(5); // the neighbour boundary moved with it
    const pending = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=story_structure`);
    expect(pending.body.items).toHaveLength(0); // ST5 cancelled the pending approval
    // reject from draft: the decision endpoint requests the approval first, then decides it
    s = (await nv().getStructure(scope))!;
    expect((await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "rejected", expectedRevision: s.revision })).status).toBe(400); // note required
    const rej = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "rejected", note: "2부 갈등을 더 키워 주세요", expectedRevision: s.revision });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.structure.status).toBe("draft");
    const regen = (await tasksOf(scope, "plan_structure")).find((x) => (x.input as { rejection_note?: string }).rejection_note === "2부 갈등을 더 키워 주세요");
    expect(regen).toBeTruthy();
    s = await structureAwaiting(t, scope);
    const p1 = s.parts.find((p) => p.ord === 1)!;
    expect(p1.title).toBe("작가의 1부"); // user field kept by the agent proposal
    expect(p1.plannedEpisodeTo).toBe(4);
    expect(s.parts.find((p) => p.ord === 2)!.title).toBe("계약자");
    const prompt = t.claude.requests.filter((x) => x.system.includes("작품 전체 구성(1~4부와 결말)")).at(-1)!.prompt;
    expect(prompt).toContain("2부 갈등을 더 키워 주세요");
  });

  it("an agent cannot decide the structure (structure_user_only); the user approval creates the plots per part", async () => {
    const s = (await nv().getStructure(scope))!;
    const approval = await t.modules.hitl.service.getApproval(scope, s.approvalId!);
    await expect(
      t.platform.uow.run((tx) =>
        hooks(t).approvalHandlers.story_structure({ tx, scope, approval, decision: "approved", decisionNote: null, reworkFrom: null, actor: { type: "agent", id: "planner", runId: "run_x" } as never, answerId: null }),
      ),
    ).rejects.toMatchObject({ code: "structure_user_only" });
    const view = await approveStructure(t, scope);
    expect(view.structure.status).toBe("approved");
    const plots = view.plots as dto.StructurePlotDto[];
    expect(plots.map((p) => [p.plannedEpisodeFrom, p.plannedEpisodeTo])).toEqual([[1, 4], [5, 6], [7, 9], [10, 12]]);
    expect(plots.every((p) => p.partId && p.status === "planned" && p.planningStage === "outline")).toBe(true);
    expect(view.structure.parts.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(plots.map((p) => p.partId)));
    const cast = await t.modules.cast.service.listCharacters(scope);
    expect(cast.find((c) => c.role === "protagonist")!.firstAppearanceEpisodeNo).toBe(1); // structure first_appearances
    const again = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: view.structure.revision });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("structure_not_pending");
  });

  it("schedule → plan_arc for the first plot → episode plans (summary, scene count, target ≥ minChars)", async () => {
    await drain(t, scope, async () => (await ms().listEpisodes(scope)).length > 0);
    const arcs = await nv().listArcs(scope);
    const first = arcs.find((a) => a.plannedEpisodeFrom === 1)!;
    const eps = await ms().listEpisodes(scope, { arcId: first.id });
    expect(eps.map((e) => e.episodeNo)).toEqual([1, 2, 3, 4]);
    expect(eps.every((e) => (e.targetChars ?? 0) >= 5000 && e.plannedSceneCount !== null)).toBe(true);
    expect(first.changeText).toBe("한결이 회귀를 현실로 받아들인다.");
    const planPrompt = t.claude.requests.filter((x) => x.system.includes("이번 플롯(큰 사건)")).at(-1)!;
    expect(planPrompt.prompt).toContain("[결말]");
    expect(planPrompt.prompt).toContain("[현재 부] 1부 「작가의 1부」");
    expect(planPrompt.prompt).toContain("[현재 플롯]");
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view.plots.find((p) => p.id === first.id)!.planningStage).toBe("episodes_planned");
    expect(view.episodes.filter((e) => e.arcId === first.id)).toHaveLength(4);
  });

  it("approved ending edit → re-approval flags running plots, re-plans planned ones; flagged plots get no new outline", async () => {
    await drain(t, scope, async () => (await nv().listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    const first = (await nv().listArcs(scope)).find((a) => a.plannedEpisodeFrom === 1)!;
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
    expect((await nv().getArc(scope, first.id)).status).toBe("active");
    // second plot planned with episodes (manual replan on a planned plot)
    const second = (await nv().listArcs(scope)).find((a) => a.plannedEpisodeFrom === 5)!;
    const rp = await t.http("POST", `/api/novels/${scope.novelId}/arcs/${second.id}/replan`, { note: "먼저 계획" });
    expect(rp.status, JSON.stringify(rp.body)).toBe(202);
    await drain(t, scope, async () => (await ms().listEpisodes(scope, { arcId: second.id })).length > 0);

    let s = (await nv().getStructure(scope))!;
    const r = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/ending`, { expectedRevision: s.revision, ending: { conflictResolution: "한결은 계약을 끊는 대신 스스로 계약자가 된다." } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "draft", pendingChanges: { ending: true }, endingFieldOrigins: { conflictResolution: "user" } });
    const planArcsBefore = (await tasksOf(scope, "plan_arc")).length;
    await t.modules.manuscript.service.schedule(scope);
    expect((await tasksOf(scope, "plan_arc")).length).toBe(planArcsBefore); // no new plot planning while the structure waits

    s = (await nv().getStructure(scope))!;
    const ok = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: s.revision });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const a1 = await nv().getArc(scope, first.id);
    expect(a1.planFlags).toEqual(["ending_changed"]);
    const a2 = await nv().getArc(scope, second.id);
    expect(a2.planFlags).toEqual([]); // auto re-planned
    expect((await tasksOf(scope, "plan_arc")).some((x) => x.targetId === second.id && (x.input as { replan?: boolean }).replan && x.status !== "done")).toBe(true);
    const audit = (await t.modules.audit.service.list(scope, { actionPrefix: "arc.plan_" })).items.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["arc.plan_flagged", "arc.plan_flags_cleared"]));
    // flagged plot: the scheduler creates no new outline for it
    const outlinesBefore = (await tasksOf(scope, "outline_episode")).length;
    await t.modules.manuscript.service.schedule(scope);
    expect((await tasksOf(scope, "outline_episode")).length).toBe(outlinesBefore);
    const ack = await t.http("POST", `/api/novels/${scope.novelId}/arcs/${first.id}/acknowledge-flags`);
    expect(ack.status).toBe(200);
    expect(dto.arcDtoSchema.parse(ack.body).planFlags).toEqual([]);
  });

  it("a goal ending_change approval reopens the approved structure (goalEndingChanged)", async () => {
    const goal = (await nv().getGoal(scope))!;
    const saved = await t.http("PUT", `/api/novels/${scope.novelId}/goal`, {
      totalEpisodesMin: goal.totalEpisodesMin,
      totalEpisodesMax: goal.totalEpisodesMax,
      cadenceEpisodesPerWeek: goal.cadenceEpisodesPerWeek,
      reserveTargetEpisodes: goal.reserveTargetEpisodes,
      endingDirection: "흉터의 계약을 이어받는다",
      notes: null,
      expectedRevision: goal.revision,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await decideApproval(t, scope, "ending_change", "approved")).status).toBeLessThan(300);
    const s = (await nv().getStructure(scope))!;
    expect(s.status).toBe("draft");
    expect(s.pendingChanges).toMatchObject({ goalEndingChanged: true });
  });
});

describe("length profile floor (3,000 chars)", () => {
  it("defaults stay 5000/5500; min under 3000 is refused (400 zod, 422 server)", async () => {
    const { scope } = await planningNovel(t, { title: "분량 작품" });
    const p = await t.http("GET", `/api/novels/${scope.novelId}/length-profile`);
    expect(p.body).toMatchObject({ minChars: 5000, maxChars: 5500 });
    const low = await t.http("PATCH", `/api/novels/${scope.novelId}/length-profile`, { minChars: 2999 });
    expect(low.status).toBe(400);
    expect(JSON.stringify(low.body)).toContain("3,000자");
    await expect(nv().updateLengthProfile(scope, { minChars: 2000 }, t.owner)).rejects.toMatchObject({ code: "length_min_too_low" });
    const ok = await t.http("PATCH", `/api/novels/${scope.novelId}/length-profile`, { minChars: 3000 });
    expect(ok.status).toBe(200);
    expect(ok.body.minChars).toBe(3000);
  });
});
