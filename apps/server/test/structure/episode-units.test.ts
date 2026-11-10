/**
 * 설계 추가 0023 — 에피소드 묶음 "제목 (1)(2)" on the in-process core (scripted Messages API):
 *  - unit title mode (new novels): plan_arc's story_episodes → 「묶음 제목 (n)」 titles, unit DTO fields (episodes,
 *    structure, reader TOC), the outline prompt says "이 화는 「X」 에피소드의 n/N화"
 *  - per_episode mode (setting off): the old per-episode titles, no units
 *  - [제목 정리] on a plot with mixed states (published / approved / planned): proposal → before → after; the inbox
 *    approval renames only unpublished 화; a published 화 needs an explicit include + confirmation; the novel switches
 *    to the unit mode
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { eq } from "@ncs/db/orm";
import { episodes } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { SCRIPTED_ARC_PLAN, scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "./harness.js";

let t: TestCore;
const STORY_EPISODES = [
  { title: "흉터의 기억 (1)", from: 1, to: 2 },
  { title: "첫 단서", from: 3, to: 3 },
];
const RETITLE = {
  story_episodes: [
    { title: "회귀의 아침", from: 1, to: 2 },
    { title: "계약의 흔적", from: 3, to: 3 },
  ],
  rationale: "1~2화는 회귀 직후 하루, 3화는 단서를 푸는 독립 사건입니다.",
};

/** a re-plan of a running plot (written 화 in the data): the planner regroups 1~3 under a new title */
const REPLAN_STORY_EPISODES = [{ title: "새 묶음", from: 1, to: 3 }];

beforeAll(async () => {
  t = await createTestCore();
  t.claude.reply(
    {
      times: Infinity,
      when: (r) => !!r.schema && "story_episodes" in ((r.schema.properties ?? {}) as object) && "goal_text" in ((r.schema.properties ?? {}) as object) && r.prompt.includes('"writtenEpisodes"'),
      json: { ...SCRIPTED_ARC_PLAN, story_episodes: REPLAN_STORY_EPISODES },
    },
    // plan_arc: story episodes (ignored in the per_episode mode)
    { times: Infinity, when: { schemaHas: ["goal_text", "episodes", "story_episodes"] }, json: { ...SCRIPTED_ARC_PLAN, story_episodes: STORY_EPISODES } },
    // 제목 정리 proposal
    { times: Infinity, when: { schemaHas: ["story_episodes", "rationale"] }, json: RETITLE },
  );
  scriptPipeline(t.claude);
});
afterAll(() => t.close());

const ms = () => t.modules.manuscript.service;
type EpisodeItem = dto.EpisodeDto;
const listEpisodes = async (scope: Scope): Promise<EpisodeItem[]> => z.object({ items: z.array(dto.episodeDtoSchema) }).parse((await t.http("GET", `/api/novels/${scope.novelId}/episodes`)).body).items;

async function plannedNovel(title: string, mode?: dto.EpisodeTitleMode) {
  const { scope } = await planningNovel(t, { title });
  if (mode) expect((await t.http("PATCH", `/api/novels/${scope.novelId}`, { episodeTitleMode: mode })).status).toBe(200);
  await bibleApproved(t, scope);
  await approveStructure(t, scope);
  await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
  const r = await decideApproval(t, scope, "arc_plan", "approved");
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const arc = (await t.modules.novel.service.listArcs(scope)).find((a) => a.plannedEpisodeFrom === 1)!;
  return { scope, arc };
}

describe("unit title mode (default for new novels)", () => {
  let scope: Scope;
  let arcId: string;
  beforeAll(async () => {
    ({ scope, arc: { id: arcId } } = await plannedNovel("묶음 제목 작품"));
  });

  it("new novels default to the story-episode title mode", async () => {
    expect(dto.novelDtoSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}`)).body).episodeTitleMode).toBe("unit");
  });

  it("plan_arc story episodes become 「제목 (n)」 titles; a single-화 묶음 has no number; DTOs carry the unit fields", async () => {
    const eps = (await listEpisodes(scope)).filter((e) => e.arcId === arcId);
    expect(eps.map((e) => [e.episodeNo, e.title, e.unitTitle, e.unitPartNo, e.unitPartCount])).toEqual([
      [1, "흉터의 기억 (1)", "흉터의 기억", 1, 2],
      [2, "흉터의 기억 (2)", "흉터의 기억", 2, 2],
      [3, "첫 단서", "첫 단서", 1, 1],
    ]);
    const detail = (await t.http("GET", `/api/novels/${scope.novelId}/episodes/2`)).body;
    expect(detail).toMatchObject({ title: "흉터의 기억 (2)", unitTitle: "흉터의 기억", unitPartNo: 2, unitPartCount: 2 });
    const units = dto.episodeUnitListSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/episode-units?arcId=${arcId}`)).body).items;
    expect(units.map((u) => [u.title, u.episodeNos, u.partCount])).toEqual([
      ["흉터의 기억", [1, 2], 2],
      ["첫 단서", [3], 1],
    ]);
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view.episodes.find((e) => e.episodeNo === 1)).toMatchObject({ unitTitle: "흉터의 기억", unitPartNo: 1, unitPartCount: 2 });
    expect(view.units?.map((u) => u.title)).toEqual(expect.arrayContaining(["흉터의 기억", "첫 단서"]));
    expect(view.episodeTitleMode).toBe("unit");
  });

  it("reader TOC groups by unit (data only)", async () => {
    const toc = dto.readerTocDtoSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/reader/toc`)).body);
    expect(toc.units?.map((u) => [u.title, u.episodeNos])).toEqual([
      ["흉터의 기억", [1, 2]],
      ["첫 단서", [3]],
    ]);
    expect(toc.episodes[1]).toMatchObject({ episodeNo: 2, title: "흉터의 기억 (2)", unitTitle: "흉터의 기억", unitPartNo: 2, unitPartCount: 2 });
  });

  it("the outline prompt tells the planner where the 화 sits in its story episode", async () => {
    await drain(t, scope, async () => (await ms().getEpisodeByNo(scope, 1)).status !== "planned" && (await ms().getEpisodeByNo(scope, 1)).status !== "outlining");
    const outline = t.claude.requests.find((r) => r.schema && "outline" in ((r.schema.properties ?? {}) as object) && r.prompt.includes("흉터의 기억"));
    expect(outline, "outline request").toBeTruthy();
    expect(outline!.system).toContain("이 화는 「흉터의 기억」 에피소드의 1/2화입니다");
    expect(outline!.system).toContain("클리프행어");
  });
});

describe("per_episode title mode (setting off → old behaviour)", () => {
  it("keeps the planner's per-episode titles and creates no units", async () => {
    const { scope, arc } = await plannedNovel("화별 제목 작품", "per_episode");
    const eps = (await listEpisodes(scope)).filter((e) => e.arcId === arc.id);
    expect(eps.map((e) => e.title)).toEqual(["다시 뜬 눈", "기록관", "첫 단서"]);
    expect(eps.every((e) => e.unitId === null && e.unitTitle === null && e.unitPartNo === null)).toBe(true);
    expect(dto.episodeUnitListSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/episode-units`)).body).items).toEqual([]);
  });
});

describe("[제목 정리] on a plot with mixed states", () => {
  let scope: Scope;
  let arcId: string;
  const base = () => `/api/novels/${scope.novelId}/arcs/${arcId}/retitle`;

  /** runs tasks (no scheduler) until the proposal is pending */
  async function proposal() {
    expect((await t.http("POST", base())).status).toBe(202);
    for (let i = 0; i < 30; i++) {
      const v = dto.retitleProposalViewSchema.parse((await t.http("GET", base())).body);
      if (v.proposal) return v.proposal;
      await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
      await t.modules.orchestration.service.runOnce();
    }
    throw new Error("no retitle proposal");
  }

  beforeAll(async () => {
    ({ scope, arc: { id: arcId } } = await plannedNovel("제목 정리 작품", "per_episode"));
    // 1화 published, 2화 approved, 3화 still planned (the live novel had 1 published, 2–5 approved, 6–11 drafted)
    const eps = await ms().listEpisodes(scope, { arcId });
    const by = { approvedAt: new Date(), approvedByActorType: "user" as const, approvedByActorId: t.ownerId };
    await t.platform.uow.run(async (tx) => {
      const v1 = await ms().saveVersion(tx, scope, eps[0]!.id, { kind: "final", content: "1화 본문.", author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, approvedVersionId: v1.id, currentVersionId: v1.id, publishedVersionId: v1.id, publishedAt: new Date(), publishedByActorType: "user", publishedByActorId: t.ownerId }).where(eq(episodes.id, eps[0]!.id));
      const v2 = await ms().saveVersion(tx, scope, eps[1]!.id, { kind: "final", content: "2화 본문.", author: t.owner });
      await tx.db.update(episodes).set({ status: "approved", ...by, approvedVersionId: v2.id, currentVersionId: v2.id }).where(eq(episodes.id, eps[1]!.id));
    });
  });

  it("proposes story episodes with before → after; a kept published 화 leaves the 묶음 (no lone (2))", async () => {
    const p = await proposal();
    expect(p.units).toEqual([
      { title: "회귀의 아침", from: 1, to: 2 },
      { title: "계약의 흔적", from: 3, to: 3 },
    ]);
    expect(p.items.map((i) => [i.episodeNo, i.status, i.before, i.after, i.willRename, i.excluded])).toEqual([
      [1, "published", "다시 뜬 눈", "회귀의 아침 (1)", false, true],
      [2, "approved", "기록관", "회귀의 아침", true, false],
      [3, "planned", "첫 단서", "계약의 흔적", true, false],
    ]);
    // nothing changed yet
    expect((await listEpisodes(scope)).filter((e) => e.arcId === arcId).map((e) => e.title)).toEqual(["다시 뜬 눈", "기록관", "첫 단서"]);
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view.plots.find((x) => x.id === arcId)!.retitleApprovalId).toBe(p.approvalId);
  });

  it("the retitle task has its own cycle key: a re-plan request is not swallowed by it (and vice versa)", async () => {
    const tasks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["plan_arc"], targetId: arcId, limit: 20 });
    const retitle = tasks.filter((x) => (x.input as { retitle?: boolean }).retitle);
    expect(retitle.length).toBeGreaterThan(0);
    expect(retitle.every((x) => (x.input as { cycle_key?: string }).cycle_key === "retitle")).toBe(true);
  });

  it("including a published 화 needs the confirmation (422)", async () => {
    const v = dto.retitleProposalViewSchema.parse((await t.http("GET", base())).body);
    const r = await t.http("POST", `${base()}/apply`, { approvalId: v.proposal!.approvalId, includePublishedEpisodeNos: [1] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("published_rename_confirmation_required");
  });

  it("the inbox approval renames unpublished 화 only; the kept published 화 stays out of the 묶음; the novel switches to the unit mode", async () => {
    const r = await decideApproval(t, scope, "episode_titles", "approved");
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const eps = (await listEpisodes(scope)).filter((e) => e.arcId === arcId);
    expect(eps.map((e) => [e.title, e.unitTitle, e.unitPartNo, e.unitPartCount])).toEqual([
      ["다시 뜬 눈", null, null, null],
      ["회귀의 아침", "회귀의 아침", 1, 1],
      ["계약의 흔적", "계약의 흔적", 1, 1],
    ]);
    expect(dto.novelDtoSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}`)).body).episodeTitleMode).toBe("unit");
    const audit = await t.testDb.pg.query<{ details: { keptPublished: number[]; renamed: unknown[] } }>(`SELECT details FROM activity_log WHERE novel_id = $1 AND action = 'episode.retitled'`, [scope.novelId]);
    expect(audit.rows.at(-1)!.details).toMatchObject({ keptPublished: [1] });
    expect(audit.rows.at(-1)!.details.renamed).toHaveLength(2);
  });

  it("a published 화 is renamed only when the author includes it and confirms (the 묶음 is renumbered from it)", async () => {
    const p = await proposal();
    expect(p.items[0]).toMatchObject({ episodeNo: 1, published: true, willRename: false, excluded: true });
    expect(p.items.slice(1).every((i) => i.unchanged)).toBe(true);
    const r = await t.http("POST", `${base()}/apply`, { approvalId: p.approvalId, includePublishedEpisodeNos: [1], confirmPublishedRename: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(dto.retitleApplyResultSchema.parse(r.body)).toMatchObject({
      applied: true,
      renamed: [
        { episodeNo: 1, before: "다시 뜬 눈", after: "회귀의 아침 (1)" },
        { episodeNo: 2, before: "회귀의 아침", after: "회귀의 아침 (2)" },
      ],
      keptPublished: [],
      episodeTitleMode: "unit",
    });
    expect((await ms().getEpisodeByNo(scope, 1)).title).toBe("회귀의 아침 (1)");
    expect(dto.retitleProposalViewSchema.parse((await t.http("GET", base())).body).proposal).toBeNull();
  });

  it("a rejected proposal changes nothing", async () => {
    const p = await proposal();
    const r = await t.http("POST", `${base()}/apply`, { approvalId: p.approvalId, reject: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(dto.retitleApplyResultSchema.parse(r.body)).toMatchObject({ applied: false, renamed: [] });
    expect((await listEpisodes(scope)).filter((e) => e.arcId === arcId).map((e) => e.title)).toEqual(["회귀의 아침 (1)", "회귀의 아침 (2)", "계약의 흔적"]);
  });
});

describe("re-plan in the 묶음 mode keeps the 묶음 of written 화", () => {
  it("drafted 화 keep their title, 묶음 and part; only the planned tail gets the new 묶음", async () => {
    const { scope, arc } = await plannedNovel("재계획 묶음 작품");
    const eps = await ms().listEpisodes(scope, { arcId: arc.id });
    await t.testDb.exec(`UPDATE episodes SET status = 'drafting' WHERE novel_id = '${scope.novelId}' AND episode_no IN (1, 2)`);
    expect(eps.map((e) => e.title)).toEqual(["흉터의 기억 (1)", "흉터의 기억 (2)", "첫 단서"]);
    const rp = await t.http("POST", `/api/novels/${scope.novelId}/arcs/${arc.id}/replan`, { note: "3화를 다시 계획해 주세요" });
    expect(rp.status, JSON.stringify(rp.body)).toBe(202);
    // a 제목 정리 request while the re-plan runs is a task of its own (own cycle key — neither is swallowed)
    const rt = await t.http("POST", `/api/novels/${scope.novelId}/arcs/${arc.id}/retitle`);
    expect(rt.status).toBe(202);
    expect(rt.body.taskId).not.toBe(rp.body.taskId);
    const pendingReplan = async () =>
      (await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["arc_plan"] })).find((a) => (a.payload as { replan?: unknown })?.replan) ?? null;
    await drain(t, scope, async () => !!(await pendingReplan()));
    // the planner saw the written 화 and was asked to keep them in place
    expect(t.claude.requests.some((r) => r.prompt.includes('"writtenEpisodes"'))).toBe(true);
    expect(t.claude.requests.some((r) => r.prompt.includes("이미 쓴 화라 제목"))).toBe(true);
    const ok = await t.http("POST", `/api/novels/${scope.novelId}/approvals/${(await pendingReplan())!.id}/decision`, { decision: "approved" });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    const after = (await listEpisodes(scope)).filter((e) => e.arcId === arc.id);
    expect(after.map((e) => [e.episodeNo, e.title, e.unitTitle, e.unitPartNo, e.unitPartCount])).toEqual([
      [1, "흉터의 기억 (1)", "흉터의 기억", 1, 2],
      [2, "흉터의 기억 (2)", "흉터의 기억", 2, 2],
      [3, "새 묶음", "새 묶음", 1, 1],
    ]);
  });
});
