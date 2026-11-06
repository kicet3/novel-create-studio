/**
 * End-to-end manuscript pipeline on the in-process core (PGlite; the real Claude adapter against the scripted
 * Messages API mock, responses in support/pipeline-script.ts):
 * goal saved (N3) → plan_series_bible → bible approved → schedule_episodes → plan_arc → arc plan approved →
 * outline → draft → split_scenes → check_text_safety → gate → polish → awaiting_approval → approved (E9)
 * → publish (E13) / unpublish (E14), human edit (E16), rejection (E10 → plan_rework → E12), export.
 *
 * Approval decisions call manuscript's registered approval handlers directly with a real `approvals`
 * row (the hitl module's own question flow is tested by hitl).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { approvals, conceptBriefs, conceptSessions, questions } from "@ncs/db/schema";
import type { ApprovalType } from "@ncs/shared";
import { manuscriptTestHooks } from "../../src/modules/manuscript/module.js";
import { stripTxtHeading } from "../../src/modules/export/domain/render.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { confirmTestCast } from "../support/cast.js";
import { POLISHED_SCENE_1, POLISHED_SCENE_2, SCRIPTED_BIBLE, SCRIPTED_DRAFT, scriptPipeline } from "../support/pipeline-script.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  scriptPipeline(t.claude);
});
afterAll(() => t.close());

const ms = () => t.modules.manuscript.service;
const hooks = () => manuscriptTestHooks.get(ms())!;

async function drain(scope: { novelId: string }, until?: () => Promise<boolean>, max = 60) {
  for (let i = 0; i < max; i++) {
    if (until && (await until())) return;
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
    const ran = await t.modules.orchestration.service.runOnce();
    const sched = await ms().schedule(scope);
    if (!ran && !sched.createdTasks.length && !until) return;
    if (!ran && !sched.createdTasks.length && until && !(await until())) {
      // nothing runnable — let a promoted pending task or deferred gate catch up once more
      if (!(await t.modules.orchestration.service.runOnce())) break;
    }
  }
  if (until && !(await until())) {
    const tasks = await t.modules.orchestration.service.listTasks(scope, { includeCancelled: true, limit: 200 });
    const unscripted = t.claude.unmatched.map((r) => `${r.system.slice(0, 60)} | ${Object.keys((r.schema?.properties ?? {}) as object).join(",")}`);
    throw new Error(`pipeline stalled: ${JSON.stringify(tasks.map((x) => [x.kind, x.status, x.latestRun?.errorMessage]))} unscripted model calls: ${JSON.stringify(unscripted)}`);
  }
}

/** arc plan approval normally waits for plan_setups (foreshadow); if that task failed, request it directly */
async function arcPlanAwaiting(scope: { novelId: string }) {
  const arcs = await t.modules.novel.service.listArcs(scope);
  if (arcs.some((a) => a.status === "plan_awaiting_approval")) return true;
  const arc = arcs.find((a) => a.status === "planned");
  if (!arc || !(await ms().listEpisodes(scope, { arcId: arc.id })).length) return false;
  const setups = await t.modules.orchestration.service.listTasks(scope, { kinds: ["plan_setups"], targetId: arc.id });
  if (setups.length && setups.every((x) => x.status === "failed")) {
    await t.platform.uow.run((tx) => ms().requestArcPlanApproval(tx, scope, arc.id, t.owner));
    return true;
  }
  return false;
}

/** an approvals row (+ its question) usable as FK target — the hitl module's own if it created one */
async function approvalFor(scope: { novelId: string }, type: ApprovalType, subjectType: "series_bible" | "arc" | "episode", subjectId: string): Promise<typeof approvals.$inferSelect> {
  const [existing] = await t.testDb.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.novelId, scope.novelId), eq(approvals.subjectId, subjectId), eq(approvals.approvalType, type), eq(approvals.status, "pending")));
  if (existing) return existing;
  const qid = t.platform.ids.next("qst");
  const aid = t.platform.ids.next("apr");
  await t.testDb.db.insert(questions).values({
    id: qid,
    novelId: scope.novelId,
    displayNo: Math.floor(Math.random() * 1e6) + 1000,
    grade: "informational",
    questionType: "approve_reject",
    topic: "approval_gate",
    title: "test approval",
    body: "test",
    rationale: "test",
    blockingBasis: "approval_gate",
    gradeReason: "test",
  });
  const [row] = await t.testDb.db
    .insert(approvals)
    .values({ id: aid, novelId: scope.novelId, approvalType: type, subjectType, subjectId, questionId: qid, requestedByActorType: "system", requestedByActorId: "orchestrator" })
    .returning();
  return row!;
}

async function decide(scope: { novelId: string }, type: "series_bible" | "arc_plan" | "episode", subjectId: string, decision: "approved" | "rejected", extra: { note?: string; reworkFrom?: "outline" | "draft" | "polish" } = {}) {
  const subjectType = type === "series_bible" ? "series_bible" : type === "arc_plan" ? "arc" : "episode";
  const approval = await approvalFor(scope, type, subjectType, subjectId);
  await t.platform.uow.run((tx) =>
    hooks().approvalHandlers[type]({ tx, scope, approval, decision, decisionNote: extra.note ?? null, reworkFrom: extra.reworkFrom ?? null, actor: t.owner, answerId: null }),
  );
  return approval;
}

async function planningNovel() {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title: "회귀자의 흉터" }, t.owner);
  const scope = { novelId: novel.id };
  const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novel.id));
  const briefId = t.platform.ids.next("cbf");
  await t.testDb.db.insert(conceptBriefs).values({
    id: briefId,
    novelId: novel.id,
    sessionId: session!.id,
    versionNo: 1,
    authorActorType: "user",
    authorActorId: t.ownerId,
    entryMode: "conversation",
    questionSetVersion: "common@1",
    content: { logline: "회귀한 검사가 흉터의 비밀을 쫓는다" },
    contentMd: "# 브리프",
  } as typeof conceptBriefs.$inferInsert);
  await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "회귀 판타지", ageRating: "age_15", category: {} }, t.owner));
  await confirmTestCast(t, novel.id, "한결");
  await nv.saveGoal(scope, { totalEpisodesMin: 12, totalEpisodesMax: 12, cadenceEpisodesPerWeek: 5, reserveTargetEpisodes: 2, endingDirection: "흉터의 비밀을 밝히고 회귀를 끝낸다", notes: null }, t.owner);
  return { novel, scope };
}

describe("manuscript pipeline (MVP-α)", () => {
  let scope: { novelId: string };
  let novelId: string;

  it("N3 creates plan_series_bible; the bible goes to approval", async () => {
    const r = await planningNovel();
    scope = r.scope;
    novelId = r.novel.id;
    const tasks = await t.modules.orchestration.service.listTasks(scope, {});
    expect(tasks.map((x) => x.kind)).toContain("plan_series_bible");
    await drain(scope, async () => (await t.modules.novel.service.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
    const [bible] = await t.modules.novel.service.listBibles(scope);
    expect(bible!.logline).toBe(SCRIPTED_BIBLE.logline);
    expect(bible!.contentMd).toContain("기획서");
    expect(bible!.contentMd).toContain(SCRIPTED_BIBLE.synopsis);
  });

  it("bible approval → schedule_episodes → plan_arc → planned episodes → arc plan approval", async () => {
    const bible = (await t.modules.novel.service.listBibles(scope)).find((b) => b.status === "awaiting_approval")!;
    await decide(scope, "series_bible", bible.id, "approved");
    expect((await t.modules.novel.service.getApprovedBible(scope))?.id).toBe(bible.id);
    await drain(scope, () => arcPlanAwaiting(scope));
    const [arc] = await t.modules.novel.service.listArcs(scope);
    const eps = await ms().listEpisodes(scope, { arcId: arc!.id });
    expect([arc!.plannedEpisodeFrom, arc!.plannedEpisodeTo]).toEqual([1, 3]); // the scripted bible's first arc has 3 episodes
    expect(eps.length).toBe(3);
    expect(eps.map((e) => e.title)).toEqual(["다시 뜬 눈", "기록관", "첫 단서"]);
    expect(eps.every((e) => e.status === "planned")).toBe(true);
    const setupsBefore = await t.testDb.query<{ canon_status: string }>(`SELECT canon_status FROM setups WHERE novel_id = '${scope.novelId}' AND planned_arc_id = '${arc!.id}'`);
    expect(setupsBefore.length).toBeGreaterThan(0);
    expect(setupsBefore.every((x) => x.canon_status === "candidate")).toBe(true);
    await decide(scope, "arc_plan", arc!.id, "approved");
    expect((await t.modules.novel.service.getArc(scope, arc!.id)).status).toBe("active");
    // 03 §4.7 SC2: the approved plan's setups become canon (INV-SU-03 protection applies from here)
    const setupsAfter = await t.testDb.query<{ canon_status: string }>(`SELECT canon_status FROM setups WHERE novel_id = '${scope.novelId}' AND planned_arc_id = '${arc!.id}'`);
    expect(setupsAfter.every((x) => x.canon_status === "approved")).toBe(true);
  });

  it("episode 1 runs outline → draft → checks → polish → awaiting_approval → approved", async () => {
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 80);
    let ep = await ms().getEpisodeByNo(scope, 1);
    expect(ep.outlineVersionId).toBeTruthy();
    expect(ep.blockReasons).toContain("approval");
    const versions = await ms().listVersions(scope, ep.id);
    const kinds = versions.map((v) => `${v.kind}:${v.stage}`);
    expect(kinds).toContain("outline:outlining");
    expect(kinds).toContain("draft:drafting");
    expect(versions.some((v) => v.kind === "revision" && v.agentRole === "line_editor")).toBe(true);
    const draft = versions.find((v) => v.kind === "draft")!;
    expect((await ms().getVersion(scope, draft.id)).content).toBe(SCRIPTED_DRAFT);
    const current = await ms().getVersion(scope, ep.currentVersionId!);
    // the polished scenes replaced the drafted ones, the separator line between them is kept
    expect(current.content).toContain(POLISHED_SCENE_1);
    expect(current.content).toContain(POLISHED_SCENE_2);
    expect(current.charCountWithSpaces).toBe(ms().countChars(current.content, "with_spaces"));
    expect((current.attributionSpans as Array<{ end: number }>).at(-1)!.end).toBe(current.content.length);
    const scenes = await ms().listScenes(scope, ep.id);
    expect(scenes.length).toBe(2);
    expect(scenes[0]!.storyPoint).toBe(1001);
    expect(scenes.at(-1)!.charEnd).toBe(current.content.length);

    await decide(scope, "episode", ep.id, "approved");
    ep = await ms().getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("approved");
    expect(ep.blockReasons).not.toContain("approval");
    const final = await ms().getVersion(scope, ep.approvedVersionId!);
    expect(final.kind).toBe("final");
    expect(final.contentHash).toBe(current.contentHash);
    expect(final.authorActorType).toBe("system");
    expect((await t.modules.novel.service.getNovel(scope)).status).toBe("serializing"); // N4 (assumption)
    const reserve = await ms().reserveSummary(scope);
    expect(reserve.approvedOnly).toBe(1);

    const actions = (await t.modules.audit.service.list(scope, { targetIds: [ep.id], limit: 200 })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["episode.created", "episode.status_changed", "episode.approved", "scene.resegmented"]));
  });

  it("HTTP: episode detail, versions, scenes, version detail", async () => {
    const d = await t.http("GET", `/api/novels/${novelId}/episodes/1`);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("approved");
    expect(d.body.currentVersion.contentPreview.length).toBeGreaterThan(0);
    expect(d.body.length.basis).toBe("with_spaces");
    const vs = await t.http("GET", `/api/novels/${novelId}/episodes/1/versions`);
    expect(vs.body.items[0].content).toBeUndefined();
    const v = await t.http("GET", `/api/novels/${novelId}/versions/${d.body.approvedVersionId}?with=spans,scenes,lines,issues`);
    expect(v.status).toBe(200);
    expect(Array.isArray(v.body.attributionSpans)).toBe(true);
    expect(Array.isArray(v.body.lines)).toBe(true);
    expect((await t.http("GET", `/api/novels/${novelId}/episodes/1/scenes`)).body.items.length).toBeGreaterThan(0);
    expect((await t.http("GET", `/api/novels/${novelId}/episodes/999`)).status).toBe(404);
    expect((await t.http("GET", `/api/novels/${novelId}/episodes`)).body.items.length).toBeGreaterThan(0);
  });

  it("publish (E13) and unpublish (E14) with confirmation", async () => {
    const pub = await t.http("POST", `/api/novels/${novelId}/episodes/1/publish`, {});
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("published");
    expect(pub.body.publishedVersionId).toBe(pub.body.approvedVersionId); // INV-EP-03
    const edit = await t.http("POST", `/api/novels/${novelId}/episodes/1/versions`, { content: "x", baseVersionId: pub.body.currentVersionId });
    expect(edit.status).toBe(422); // INV-EP-04
    expect((await t.http("POST", `/api/novels/${novelId}/episodes/1/unpublish`, { reason: "오타" })).status).toBe(400);
    const un = await t.http("POST", `/api/novels/${novelId}/episodes/1/unpublish`, { reason: "오타 정정", confirmedNotPublishedExternally: true });
    expect(un.status).toBe(200);
    expect(un.body.status).toBe("approved");
    expect(un.body.publishedVersionId).toBeNull();
  });

  it("exports TXT/Markdown with body counts equal to the app", async () => {
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    const r = await t.http("POST", `/api/novels/${novelId}/exports`, { scopeKind: "novel", format: "txt" });
    expect(r.status).toBe(201);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.excluded.length).toBeGreaterThan(0);
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const job = await t.modules.export.service.openDownload(scope, r.body.id);
    expect(job.fileName).toMatch(/^회귀자의 흉터_all_\d{8}-\d{4}\.txt$/);
    const file = readFileSync(job.path, "utf8");
    const approved = await ms().getVersion(scope, ep1.approvedVersionId!);
    expect(ms().countChars(stripTxtHeading(file).trimEnd(), "with_spaces")).toBe(ms().countChars(approved.content.trim(), "with_spaces"));
    const srv = t.core.app.listen(0, "127.0.0.1");
    await new Promise((ok) => srv.once("listening", ok));
    try {
      const res = await fetch(`http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}/api/novels/${novelId}/exports/${r.body.id}/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
      expect(await res.text()).toBe(file);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
    const md = await t.http("POST", `/api/novels/${novelId}/exports`, { scopeKind: "episode", targetId: ep1.id, format: "markdown", versionSelection: "current" });
    expect(md.status).toBe(201);
    expect(readFileSync((await t.modules.export.service.openDownload(scope, md.body.id)).path, "utf8").startsWith("## 1화")).toBe(true);
    expect((await t.http("GET", `/api/novels/${novelId}/exports`)).body.items.length).toBe(2);
    expect((await t.http("POST", `/api/novels/${novelId}/exports`, { scopeKind: "novel", targetId: ep1.id, format: "txt" })).status).toBe(400);
    const actions = (await t.modules.audit.service.list(scope, { actionPrefix: "export." })).items;
    expect(actions).toHaveLength(2);
  });

  it("revision request on an approved episode (E11) → plan_rework → E12 → back to approval", async () => {
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    const r = await t.http("POST", `/api/novels/${novelId}/episodes/1/revision-request`, { decisionNote: "마지막 장면을 더 긴장감 있게", reworkFrom: "polish" });
    expect(r.status).toBe(201);
    let ep = await ms().getEpisode(scope, ep1.id);
    expect(ep.status).toBe("revising");
    expect(ep.rejectionCount).toBe(1);
    await drain(scope, async () => (await ms().getEpisode(scope, ep1.id)).status === "awaiting_approval", 60);
    ep = await ms().getEpisode(scope, ep1.id);
    expect(ep.lastReworkFrom).toBe("polish");
  });
});

describe("manuscript direct edit (E16) and rejection (E10)", () => {
  it("human edit in awaiting_approval re-enters checking; rejection runs plan_rework → E12", async () => {
    const { scope } = await planningNovel();
    await drain(scope, async () => (await t.modules.novel.service.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
    await decide(scope, "series_bible", (await t.modules.novel.service.listBibles(scope))[0]!.id, "approved");
    await drain(scope, () => arcPlanAwaiting(scope));
    await decide(scope, "arc_plan", (await t.modules.novel.service.listArcs(scope))[0]!.id, "approved");
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 80);
    let ep = await ms().getEpisodeByNo(scope, 1);
    const before = await ms().getVersion(scope, ep.currentVersionId!);
    const oldScenes = await ms().listScenes(scope, ep.id);

    // stale base → 409
    await expect(ms().saveHumanEdit(scope, 1, { content: "다른 내용", baseVersionId: ep.outlineVersionId! }, t.owner)).rejects.toMatchObject({ status: 409 });
    const edited = before.content.replace(/^(.{10})/su, "$1(작가 수정)");
    const human = await ms().saveHumanEdit(scope, 1, { content: edited, baseVersionId: before.id }, t.owner);
    expect(human.isHumanEdit).toBe(true);
    expect((human.attributionSpans as Array<{ actorType: string }>).some((s) => s.actorType === "user")).toBe(true);
    ep = await ms().getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("checking");
    expect(ep.autoRewriteCount).toBe(0);
    expect(ep.rejectionCount).toBe(0);
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 60);
    const newScenes = await ms().listScenes(scope, ep.id);
    expect(newScenes[0]!.id).toBe(oldScenes[0]!.id); // INV-SC-01: small edit keeps the scene id

    // rejection (E10) with rework_from=draft → plan_rework → E12 → revise_episode → checking …
    ep = await ms().getEpisodeByNo(scope, 1);
    await decide(scope, "episode", ep.id, "rejected", { note: "전개가 너무 느립니다", reworkFrom: "draft" });
    ep = await ms().getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("revising");
    expect(ep.rejectionCount).toBe(1);
    expect(ep.lastReworkFrom).toBe("draft");
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 80);
    const versions = await ms().listVersions(scope, ep.id);
    const rejectionAudit = (await t.modules.audit.service.list(scope, { targetIds: [ep.id], actionPrefix: "episode.rejected" })).items;
    expect(rejectionAudit).toHaveLength(1);
    // the human-written span survives the agent rewrite (PR-08)
    const latest = await ms().getVersion(scope, (await ms().getEpisodeByNo(scope, 1)).currentVersionId!);
    expect(latest.content).toContain("(작가 수정)");
    expect(versions.length).toBeGreaterThan(5);
  });

  it("rejects invalid transitions and unconfirmed unpublish", async () => {
    const { scope } = await planningNovel();
    await expect(ms().unpublishEpisode(scope, "epi_00000000000000000000000000", { reason: "x", confirmedNotPublishedExternally: false as unknown as true }, t.owner)).rejects.toMatchObject({ status: 422 });
    await expect(ms().getEpisodeByNo(scope, 1)).rejects.toMatchObject({ status: 404 });
  });
});
