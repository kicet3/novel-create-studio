/**
 * 설계 추가 0019: 화 사이 이어짐 — recent_text kept under a tight budget, 직전 화 끝 상태 (handoff) written on approval
 * and injected into the next outline / draft, rolling 지금까지의 줄거리 (bounded), boot backfill (idempotent),
 * continuation instructions in the prompts, stale handoff after a text change, opening-continuity issues.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { approvals, conceptBriefs, conceptSessions, questions } from "@ncs/db/schema";
import type { ApprovalType } from "@ncs/shared";
import { fitSections } from "../../src/modules/agents/domain/context-budget.js";
import { CONTINUITY_KEEP_SECTIONS } from "../../src/modules/manuscript/application/writing.js";
import { BACKFILL_CYCLE_PREFIX } from "../../src/modules/manuscript/application/handoff.js";
import { END_TAIL_MAX, END_TAIL_MIN, endTail, handoffText, normalizeRecap, storySoFarText, validateRecap } from "../../src/modules/manuscript/domain/handoff.js";
import { manuscriptTestHooks } from "../../src/modules/manuscript/module.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { completeTestCast } from "../support/cast.js";
import { SCRIPTED_RECAP, scriptPipeline } from "../support/pipeline-script.js";
import { createHarness, type Harness } from "../foreshadow/harness.js";

describe("handoff domain (pure)", () => {
  it("recent_text / prev_handoff survive a tight budget for outline and draft; other runs may drop recent_text", () => {
    const items = [
      { section: "instruction" as const, tokenEstimate: 100 },
      { section: "prev_handoff" as const, tokenEstimate: 120 },
      { section: "story_so_far" as const, tokenEstimate: 400 },
      { section: "glossary" as const, tokenEstimate: 300 },
      { section: "recent_text" as const, tokenEstimate: 900 },
    ];
    const tight = fitSections(items, 50, 1300, CONTINUITY_KEEP_SECTIONS);
    expect(tight.ok).toBe(true);
    if (!tight.ok) return;
    expect(tight.kept.map((k) => k.section)).toEqual(["instruction", "prev_handoff", "recent_text"]);
    expect(tight.dropped.sort()).toEqual(["glossary", "story_so_far"]);
    const loose = fitSections(items, 50, 1300);
    expect(loose.ok && loose.dropped).toContain("recent_text");
    // required sections alone over the limit never get cut silently
    expect(fitSections(items, 50, 900, CONTINUITY_KEEP_SECTIONS).ok).toBe(false);
  });

  it("endTail: the last scene, at least ~1,200 and at most 2,000 chars", () => {
    const text = `${"가".repeat(3000)}\n${"나".repeat(500)}`;
    const short = endTail(text, { charStart: 3001, charEnd: text.length });
    expect(short.length).toBeGreaterThanOrEqual(END_TAIL_MIN);
    expect(short.endsWith("나")).toBe(true);
    const long = endTail(`${"다".repeat(5000)}`, { charStart: 0, charEnd: 5000 });
    expect(long.length).toBe(END_TAIL_MAX);
    expect(endTail("짧은 원고", null)).toBe("짧은 원고");
  });

  it("story so far: recent 3 episodes in detail, older compressed and bounded (oldest dropped first)", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ episodeNo: i + 1, lines: [`${i + 1}화 첫 사건 ${"이".repeat(60)}`, `${i + 1}화 둘째 사건`, `${i + 1}화 셋째 사건`] }));
    const text = storySoFarText(entries, { maxChars: 1500 });
    expect(text.length).toBeLessThanOrEqual(1600);
    for (const no of [38, 39, 40]) expect(text).toContain(`${no}화 셋째 사건`); // recent: every line
    expect(text).not.toContain("37화 셋째 사건"); // older: first line only
    expect(text).toContain("- 37화: 37화 첫 사건");
    expect(text).toMatch(/- 1~\d+화: \(분량 때문에 생략\)/);
    expect(text).not.toContain("- 1화: 1화 첫 사건");
    // rolling: one more episode shifts the window
    const more = storySoFarText([...entries, { episodeNo: 41, lines: ["41화 사건"] }], { maxChars: 1500 });
    expect(more).toContain("41화 사건");
    expect(more).not.toContain("38화 셋째 사건");
    expect(storySoFarText([])).toBe("");
  });

  it("recap validation + normalization", () => {
    const content = "첫 줄.\n\n마지막 문장이다.";
    const bad = { handoff: { ...SCRIPTED_RECAP.handoff, place: "", last_line: "지어낸 문장" }, summary_lines: ["하나"] };
    const issues = validateRecap(bad, content);
    expect(issues.map((i) => i.item).sort()).toEqual(["handoff.last_line", "handoff.place", "summary_lines"]);
    const n = normalizeRecap({ ...bad, summary_lines: ["1", "2", "3", "4", "5", "6"] }, content);
    expect(n.handoff.last_line).toBe("마지막 문장이다.");
    expect(n.summary_lines).toHaveLength(5);
    expect(handoffText(3, SCRIPTED_RECAP.handoff, { stale: true })).toContain("3화 원고가 바뀌었습니다");
  });
});

// ── pipeline on the in-process core ──
let t: TestCore;
const ms = () => t.modules.manuscript.service;
const hooks = () => manuscriptTestHooks.get(ms())!;

async function drain(scope: { novelId: string }, until: () => Promise<boolean>, max = 80) {
  for (let i = 0; i < max; i++) {
    if (await until()) return;
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
    const ran = await t.modules.orchestration.service.runOnce();
    const sched = await ms().schedule(scope);
    if (!ran && !sched.createdTasks.length && !(await t.modules.orchestration.service.runOnce())) break;
  }
  if (!(await until())) {
    const tasks = await t.modules.orchestration.service.listTasks(scope, { includeCancelled: true, limit: 300 });
    throw new Error(`stalled: ${JSON.stringify(tasks.map((x) => [x.kind, x.status, x.latestRun?.errorMessage]))} unmatched: ${t.claude.unmatched.length}`);
  }
}

async function approvalFor(scope: { novelId: string }, type: ApprovalType, subjectType: "series_bible" | "arc" | "episode", subjectId: string) {
  const [existing] = await t.testDb.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.novelId, scope.novelId), eq(approvals.subjectId, subjectId), eq(approvals.approvalType, type), eq(approvals.status, "pending")));
  if (existing) return existing;
  const qid = t.platform.ids.next("qst");
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
    .values({ id: t.platform.ids.next("apr"), novelId: scope.novelId, approvalType: type, subjectType, subjectId, questionId: qid, requestedByActorType: "system", requestedByActorId: "orchestrator" })
    .returning();
  return row!;
}

async function decide(scope: { novelId: string }, type: "series_bible" | "arc_plan" | "episode", subjectId: string) {
  const subjectType = type === "series_bible" ? "series_bible" : type === "arc_plan" ? "arc" : "episode";
  const approval = await approvalFor(scope, type, subjectType, subjectId);
  await t.platform.uow.run((tx) => hooks().approvalHandlers[type]({ tx, scope, approval, decision: "approved", decisionNote: null, reworkFrom: null, actor: t.owner, answerId: null }));
}

async function writingNovel() {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title: "이어 쓰기 시험" }, t.owner);
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
  await completeTestCast(t, novel.id, "한결");
  await nv.saveGoal(scope, { totalEpisodesMin: 12, totalEpisodesMax: 12, cadenceEpisodesPerWeek: 5, reserveTargetEpisodes: 2, endingDirection: "흉터의 비밀을 밝히고 회귀를 끝낸다", notes: null }, t.owner);
  await drain(scope, async () => (await nv.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
  await decide(scope, "series_bible", (await nv.listBibles(scope)).find((b) => b.status === "awaiting_approval")!.id);
  await drain(scope, async () => (await nv.getStructure(scope))?.status === "awaiting_approval");
  const s = (await nv.getStructure(scope))!;
  expect((await t.http("POST", `/api/novels/${novel.id}/structure/decision`, { decision: "approved", expectedRevision: s.revision })).status).toBe(200);
  await drain(scope, async () => (await nv.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
  const arc = (await nv.listArcs(scope)).find((a) => a.status === "plan_awaiting_approval")!;
  await decide(scope, "arc_plan", arc.id);
  return scope;
}

const recaps = (episodeId: string) =>
  t.testDb.query<{ id: string; source_version_id: string; summary: string; handoff: any; stale_at: string | null }>(`SELECT id, source_version_id, summary, handoff, stale_at FROM episode_recaps WHERE episode_id = '${episodeId}' ORDER BY created_at`);

describe("handoff on the writing pipeline", () => {
  let scope: { novelId: string };
  beforeAll(async () => {
    t = await createTestCore();
    scriptPipeline(t.claude);
    scope = await writingNovel();
  }, 240_000);
  afterAll(() => t.close());

  it("approval of episode 1 writes its handoff + summary (summarize_episode, continuity_editor)", async () => {
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval");
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    await decide(scope, "episode", ep1.id);
    const tasks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["summarize_episode"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ agentRole: "continuity_editor", targetId: ep1.id });
    expect(tasks[0]!.priority).toBeGreaterThan(750); // above the outline's max at the default reserve (500 + 50 × 5)
    await drain(scope, async () => (await recaps(ep1.id)).length === 1);
    const [r] = await recaps(ep1.id);
    expect(r!.summary.split("\n")).toEqual(SCRIPTED_RECAP.summary_lines);
    expect(r!.handoff).toMatchObject({ place: "여관 방 거울 앞", present: ["한결"] });
    expect(r!.handoff.last_line.length).toBeGreaterThan(0);
    const end = (await ms().getEpisodeEnd(scope, 1))!;
    expect(end).toMatchObject({ stale: false, recapId: r!.id });
    expect(end.tail.length).toBeGreaterThanOrEqual(1200);
    expect(end.tail.length).toBeLessThanOrEqual(2000);
  });

  it("episode 2's outline and draft see 직전 화 끝 상태 / 직전 내용 / 지금까지의 줄거리 and the continuation rule", async () => {
    // until episode 2's continuity check ran (its scripted setup check keeps it in rework later on)
    await drain(scope, async () => t.claude.requests.some((r) => r.prompt.includes("[PREV_END] episode=1")));
    const isEp2 = (p: string) => p.includes('"episode":{"no":2');
    const outline = t.claude.requests.find((r) => r.schema && "outline" in ((r.schema.properties ?? {}) as object) && isEp2(r.prompt))!;
    const draft = t.claude.requests.find((r) => r.system.includes("아웃라인의 씬을 순서대로 본문으로 씁니다") && isEp2(r.prompt))!;
    for (const r of [outline, draft]) {
      expect(r.prompt).toContain("## 직전 화 끝 상태");
      expect(r.prompt).toContain("1화가 끝난 상태");
      expect(r.prompt).toContain("- 장소: 여관 방 거울 앞");
      expect(r.prompt).toContain("## 직전 내용");
      expect(r.prompt).toContain("1화 마지막 장면");
      expect(r.prompt).toContain("## 지금까지의 줄거리");
      expect(r.prompt).toContain(SCRIPTED_RECAP.summary_lines[0]);
    }
    expect(outline.system).toContain("첫 씬(s1)은 '직전 화 끝 상태'와 '직전 내용'의 마지막 장면에서 바로 이어집니다");
    expect(draft.system).toContain("첫 씬 첫 문단은 직전 화 마지막 장면에서 자연스럽게 이어집니다");
    expect(draft.system).toContain("요약·회상 문단으로 시작하지 않습니다");
    // the opening-continuity review of episode 2 compares against episode 1's end
    const check = t.claude.requests.find((r) => r.prompt.includes("[PREV_END] episode=1"));
    expect(check?.prompt).toContain("열린 행동·훅: 흉터가 빛난 이유를 알아내야 한다");
    expect(check?.system).toContain("kind=opening_continuity");
  });

  it("episode 1's text changes after episode 2 started → the handoff goes stale and is made again from the latest text", async () => {
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    const base = await ms().getVersion(scope, ep1.currentVersionId!);
    const edited = `${base.content}\n\n한결은 문을 열고 복도로 나섰다.`;
    await ms().saveHumanEdit(scope, 1, { content: edited, baseVersionId: base.id }, t.owner);
    const [old] = await recaps(ep1.id);
    expect(old!.stale_at).not.toBeNull();
    const end = (await ms().getEpisodeEnd(scope, 1))!;
    expect(end.stale).toBe(true);
    expect(end.tail.endsWith("한결은 문을 열고 복도로 나섰다.")).toBe(true); // latest text, not the approved one
    const latest = (await ms().getEpisodeByNo(scope, 1)).currentVersionId!;
    const queued = await t.modules.orchestration.service.listTasks(scope, { kinds: ["summarize_episode"], statuses: ["pending", "ready", "running"] });
    expect(queued.map((q) => (q.input as { manuscript_version_id?: string }).manuscript_version_id)).toContain(latest);
    await drain(scope, async () => (await recaps(ep1.id)).some((r) => r.source_version_id === latest));
    expect((await ms().getEpisodeEnd(scope, 1))!.stale).toBe(false);
  });

  it("boot backfill: approved episodes without a recap get one task per version, once", async () => {
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    await t.testDb.exec(`DELETE FROM episode_recaps WHERE novel_id = '${scope.novelId}'`);
    // episode 1 was edited (checking) — make it approved again for the backfill scope
    await t.testDb.exec(`UPDATE episodes SET status = 'approved', approved_version_id = current_version_id, approved_at = now(), approved_by_actor_type = 'user', approved_by_actor_id = '${t.ownerId}' WHERE id = '${ep1.id}'`);
    const mod = t.modules.manuscript as unknown as { start(): Promise<void> };
    const count = async () =>
      (await t.modules.orchestration.service.listTasks(scope, { kinds: ["summarize_episode"], includeCancelled: true, limit: 200 })).filter((x) =>
        String((x.input as { cycle_key?: string }).cycle_key ?? "").startsWith(BACKFILL_CYCLE_PREFIX),
      ).length;
    await mod.start();
    expect(await count()).toBe(1);
    await mod.start();
    expect(await count()).toBe(1);
    // episode 2's outline defers (stays ready, not blocked) while episode 1's recap is queued — full_auto starts N+1
    // as soon as N reaches checking, so the outline must not be leased ahead of N's handoff
    const ep2 = await ms().getEpisodeByNo(scope, 2);
    const outlineGate = t.modules.orchestration.service.getTaskKind("outline_episode")!.gate!;
    expect(await outlineGate(scope, { kind: "outline_episode", input: { episode_id: ep2.id } } as never)).toEqual({ ok: false, defer: true });
    expect(await t.modules.orchestration.service.getTaskKind("draft_episode")!.gate!(scope, { kind: "draft_episode", input: { episode_id: ep2.id } } as never)).toEqual({ ok: true });
    await drain(scope, async () => (await recaps(ep1.id)).length === 1);
    expect(await outlineGate(scope, { kind: "outline_episode", input: { episode_id: ep2.id } } as never)).toEqual({ ok: true });
    await mod.start(); // the recap exists now
    expect(await count()).toBe(1);
  });
});

describe("opening continuity check (continuity_editor)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  it("raises an opening_continuity issue for episode 2 when its first scene contradicts episode 1's end; high blocks the gate", async () => {
    const arcId = await h.createArc(1, 5, "active");
    const ep1 = await h.createEpisode(arcId, 1);
    const v1 = await h.createVersion(ep1, "한결은 다리를 다친 채 동굴 안에 쓰러져 있었다.", { scenes: [[0, 26]] });
    const ep2 = await h.createEpisode(arcId, 2);
    const text = "한결은 시장 거리를 가볍게 뛰어다녔다. 다리는 멀쩡했다.";
    const v2 = await h.createVersion(ep2, text, { scenes: [[0, text.length]] });
    h.episodeEnds.set(1, {
      episodeId: ep1,
      episodeNo: 1,
      versionId: v1.versionId,
      tail: "한결은 다리를 다친 채 동굴 안에 쓰러져 있었다.",
      recapId: null,
      recapVersionId: v1.versionId,
      handoff: { place: "동굴 안", time: "밤", present: ["한결"], physical_state: "다리를 다쳐 움직이지 못한다", emotional_state: "두렵다", open_hook: "동굴 밖 발소리", last_line: "한결은 다리를 다친 채 동굴 안에 쓰러져 있었다." },
      summaryLines: ["한결이 동굴에서 다친다."],
      stale: false,
    });
    const handler = h.reg.taskHandlers.get("check_continuity");
    const run = await h.createRun("check_continuity", "continuity_editor", "episode", ep2);
    const input = { episode_id: ep2, manuscript_version_id: v2.versionId };
    let seen = "";
    const llm = h.llm((i) => {
      seen = i.messages.at(-1)!.content;
      return {
        verdicts: [],
        issues: [
          { kind: "opening_continuity", severity: "high", scene_ord: 1, quote: "다리는 멀쩡했다.", message: "1화 끝에서 다리를 다쳤는데 2화 첫 장면에서 설명 없이 멀쩡합니다.", proposed_fix: "부상 상태로 시작하거나 회복 경위를 밝힙니다.", evidence: ["PREV_END"] },
        ],
      };
    });
    const proposal = await handler.execute(run, input, h.context, llm);
    await h.tx((tx) => handler.commit(tx, run, input, proposal, run.task));
    expect(seen).toContain(`[PREV_END] episode=1 version=${v1.versionId}`);
    expect(seen).toContain("몸 상태: 다리를 다쳐 움직이지 못한다");
    expect(seen).toContain("마지막 장면:\n한결은 다리를 다친 채");
    const [issue] = await h.continuity.listIssues(h.scope, { episodeId: ep2 });
    expect(issue).toMatchObject({ kind: "opening_continuity", severity: "high", status: "open", sceneId: v2.sceneIds[0], fixScope: "scene" });
    expect(issue!.charStart).toBe(text.indexOf("다리는 멀쩡했다."));
    const detail = await h.continuity.getIssue(h.scope, issue!.id);
    expect(detail.evidence[0]).toMatchObject({ refType: "manuscript_version", refId: v1.versionId });
    const gate = h.reg.contributors.find((c) => c.name === "continuity")!;
    const verdict = await gate.evaluate(h.scope, { id: ep2, episodeNo: 2 } as any, v2.versionId);
    expect(verdict.pass).toBe(false); // full_auto: open high issue → no auto-approval (policy open_high_issue)

    // a stale handoff (N-1 changed after it) is left out: only N-1's latest text is compared
    h.episodeEnds.set(1, { ...h.episodeEnds.get(1)!, stale: true });
    const run2 = await h.createRun("check_continuity", "continuity_editor", "episode", ep2);
    await handler.execute(run2, input, h.context, h.llm((i) => ((seen = i.messages.at(-1)!.content), { verdicts: [], issues: [] })));
    expect(seen).toContain("[PREV_END] episode=1");
    expect(seen).not.toContain("몸 상태:");

    // episode 1 has nothing to continue from: an opening issue is ignored
    const run3 = await h.createRun("check_continuity", "continuity_editor", "episode", ep1);
    const p3 = await handler.execute(run3, { episode_id: ep1, manuscript_version_id: v1.versionId }, h.context, h.llm(() => ({ verdicts: [], issues: [{ kind: "opening_continuity", severity: "high", message: "x", evidence: ["PREV_END"] }] })));
    expect(p3.drafts).toHaveLength(0);
  });
});
