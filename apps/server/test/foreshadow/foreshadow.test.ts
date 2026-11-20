import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../../src/platform/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(() => h.close());

/** the beat row id of a setup's beat (ids are generated, so scripted model outputs look them up) */
const beatId = async (setupId: string, kind: string) => (await h.foreshadow.getSetup(h.scope, setupId)).beats.find((b) => b.kind === kind)!.id;
/** scripted check_setups output: the given beat is found in scene 1 with this verbatim quote */
const foundLlm = (beat_id: string, quote: string) => h.llm(() => ({ findings: [{ beat_id, found: true, quote, scene_ord: 1, contradiction: "none" }], unplanned: [] }));

const actionsOf = async (targetId?: string) => (await h.audit.list(h.scope, targetId ? { targetIds: [targetId], limit: 200 } : { limit: 500 })).items.map((e) => e.action);

describe("foreshadow registrations", () => {
  it("registers task kinds, gate contributors, hooks, context section and hitl handlers", () => {
    expect([...h.reg.taskHandlers.keys()].sort()).toEqual(["check_continuity", "check_setups", "plan_setups", "review_setup_due"]);
    expect(h.reg.contributors.map((c) => c.name).sort()).toEqual(["continuity", "foreshadow"]);
    expect(h.reg.hooks.length).toBe(2);
    expect(h.reg.contextSections.map((s) => s.section)).toEqual(["assigned_beats"]);
    expect([...h.reg.appliers.keys()]).toEqual(["setup_due"]);
    expect([...h.reg.approvalHandlers.keys()]).toEqual(["setup_abandon"]);
  });
});

describe("plan_setups → check_setups → E9 → E13 (07 §1.3, §5.2)", () => {
  let arcId: string;
  let ep1: string;
  let setupId: string;

  it("plan_setups proposes, validates SP-1..4 (with one repair) and commits setups + beats", async () => {
    arcId = await h.createArc(1, 3);
    const plan = h.reg.taskHandlers.get("plan_setups");
    const plan_ = (plantNo: number) => ({
      new_setups: [
        {
          key: "N1",
          title: "낡은 은반지의 문양",
          description: "주인공이 물려받은 은반지의 문양이 사라진 가문의 표식이라는 사실.",
          importance: "medium",
          due_kind: "arc",
          beats: [
            { kind: "plant", planned_episode_no: plantNo, note: "단서를 처음 보여 줍니다." },
            { kind: "reinforce", planned_episode_no: 2, note: "단서를 다시 상기시킵니다." },
            { kind: "payoff", planned_episode_no: 3, note: "단서의 의미를 밝힙니다." },
          ],
          entity_ids: [],
          fact_ids: [],
        },
      ],
      existing_setup_beats: [],
      rationale: "아크 범위 안에서 설치·강화·회수를 고르게 배치했습니다.",
    });
    let n = 0;
    const llm = h.llm((input) => {
      n++;
      expect(input.messages.map((m) => m.content).join("\n")).toMatch(/\[ARC\] id=\S+ from=1 to=3/);
      return plan_(n === 1 ? 9 : 1); // first answer violates SP-1 (episode 9 is outside 1..3) → repair
    });
    const run = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
    const proposal = await plan.execute(run, { arc_id: arcId }, h.context, llm);
    expect(n).toBe(2);
    expect(llm.inputs[1]!.purpose).toBe("repair");
    expect(llm.inputs[1]!.messages.at(-1)!.content).toContain("SP-1");
    const outcome: any = await h.tx((tx) => plan.commit(tx, run, { arc_id: arcId }, proposal, run.task));
    expect(outcome.kind).toBe("done");
    expect(h.calls.requestArcPlanApproval).toEqual([arcId]);

    const setups = await h.foreshadow.listSetups(h.scope);
    expect(setups).toHaveLength(1);
    const s = setups[0]!;
    setupId = s.id;
    expect(s).toMatchObject({ displayNo: 1, narrativeStatus: "planned", canonStatus: "candidate", dueKind: "arc", dueArcId: arcId, plannedArcId: arcId, effectiveDueEpisodeNo: 3 });
    expect(s.beats.map((b) => [b.kind, b.plannedEpisodeNo, b.status])).toEqual([
      ["plant", 1, "planned"],
      ["reinforce", 2, "planned"],
      ["payoff", 3, "planned"],
    ]);
    expect(await actionsOf(s.id)).toEqual(expect.arrayContaining(["setup.created", "setup.beat_planned"]));
    const byNo = await h.foreshadow.getSetup(h.scope, "S-01");
    expect(byNo.id).toBe(s.id);
  });

  it("fails the plan when the repair is still invalid", async () => {
    const plan = h.reg.taskHandlers.get("plan_setups");
    const run = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
    const llm = h.llm(() => ({ new_setups: [{ title: "x", description: "y", importance: "low", due_kind: "arc", beats: [{ kind: "payoff", planned_episode_no: 2 }] }] }));
    await expect(plan.execute(run, { arc_id: arcId }, h.context, llm)).rejects.toMatchObject({ name: "TaskFailure", errorFamily: "invalid_output", retryable: false });
  });

  it("assigned_beats context section lists this episode's beats", async () => {
    const section = h.reg.contextSections[0];
    const r = await section.build(h.scope, { anchor: { storyPoint: 1000, timelineId: h.timelineId }, seeds: {}, sections: [], maxInputTokens: 1000, hopPredicates: { hop2: [] } }, null);
    expect(r.text).toContain("S-01");
    expect(r.text).toContain("plant");
    expect(r.refs.setupIds).toEqual([setupId]);
  });

  it("check_setups detects the planted beat (gate passes) and E9 confirms it (S2, SC2)", async () => {
    await h.testDb.exec(`UPDATE arcs SET status = 'active' WHERE id = '${arcId}'`); // arc plan approved (AR2)
    ep1 = await h.createEpisode(arcId, 1);
    const { versionId, sceneIds } = await h.createVersion(ep1, "은반지가 달빛에 빛났다. 서윤은 반지의 문양을 오래 바라보았다.\n두 번째 씬.", { scenes: [[0, 34], [34, 41]] });
    const gate = h.reg.contributors.find((c) => c.name === "foreshadow")!;
    const ep = (await h.testDb.query<any>(`SELECT id, episode_no AS "episodeNo" FROM episodes WHERE id = '${ep1}'`))[0];
    expect((await gate.evaluate(h.scope, ep, versionId)).pending).toBe(true); // not checked yet

    const check = h.reg.taskHandlers.get("check_setups");
    const run = await h.createRun("check_setups", "foreshadow_manager", "episode", ep1);
    const proposal = await check.execute(run, { episode_id: ep1, manuscript_version_id: versionId }, h.context, foundLlm(await beatId(setupId, "plant"), "은반지가 달빛에 빛났다."));
    expect(proposal.results).toHaveLength(1);
    expect(proposal.results[0]).toMatchObject({ kind: "plant", found: true, span: { sceneId: sceneIds[0], charStart: 0 } });
    expect(await h.tx((tx) => check.commit(tx, run, { episode_id: ep1 }, proposal, run.task))).toMatchObject({ kind: "done" });
    expect(h.calls.advanceCheckGate).toContain(ep1);

    const s = await h.foreshadow.getSetup(h.scope, setupId);
    const plant = s.beats.find((b) => b.kind === "plant")!;
    expect(plant).toMatchObject({ status: "detected", canonStatus: "candidate", manuscriptVersionId: versionId, sceneId: sceneIds[0], detectedByRunId: run.runId });
    expect(await gate.evaluate(h.scope, ep, versionId)).toMatchObject({ pass: true, pending: false });

    await h.fireTransition(ep1, "awaiting_approval", "approved");
    const after = await h.foreshadow.getSetup(h.scope, setupId);
    expect(after).toMatchObject({ narrativeStatus: "planted", canonStatus: "approved" });
    expect(after.beats.find((b) => b.kind === "plant")).toMatchObject({ status: "confirmed", canonStatus: "approved" });
    expect(after.beats.find((b) => b.kind === "plant")!.confirmedAt).not.toBeNull();
    expect(await actionsOf()).toEqual(expect.arrayContaining(["setup.beat_detected", "setup.beat_confirmed", "setup.canon_status_changed", "setup.narrative_status_changed"]));
  });

  it("E13 locks the setup planted in the published episode (SC4) and E14 reverts it (SC5)", async () => {
    await h.fireTransition(ep1, "approved", "published");
    let s = await h.foreshadow.getSetup(h.scope, setupId);
    expect(s.canonStatus).toBe("published_locked");
    expect(s.beats.find((b) => b.kind === "plant")!.canonStatus).toBe("published_locked");
    await h.fireTransition(ep1, "published", "approved");
    s = await h.foreshadow.getSetup(h.scope, setupId);
    expect(s.canonStatus).toBe("approved");
    expect(s.beats.find((b) => b.kind === "plant")!.canonStatus).toBe("approved");
  });

  it("a missing beat opens a setup_missing issue that blocks both gates; a rewrite that adds it resolves the issue", async () => {
    const ep2 = await h.createEpisode(arcId, 2);
    const v1 = await h.createVersion(ep2, "아무 일도 없었다.");
    const check = h.reg.taskHandlers.get("check_setups");
    const run1 = await h.createRun("check_setups", "foreshadow_manager", "episode", ep2);
    const notFound = h.llm((input) => ({ findings: [...input.messages.at(-1)!.content.matchAll(/\[BEAT\] id=(sbt_\w+)/g)].map((m) => ({ beat_id: m[1], found: false })) }));
    const p1 = await check.execute(run1, { episode_id: ep2, manuscript_version_id: v1.versionId }, h.context, notFound);
    await h.tx((tx) => check.commit(tx, run1, { episode_id: ep2 }, p1, run1.task));

    const ep = (await h.testDb.query<any>(`SELECT id, episode_no AS "episodeNo" FROM episodes WHERE id = '${ep2}'`))[0];
    const fsGate = h.reg.contributors.find((c) => c.name === "foreshadow")!;
    const ciGate = h.reg.contributors.find((c) => c.name === "continuity")!;
    expect(await fsGate.evaluate(h.scope, ep, v1.versionId)).toMatchObject({ pass: false, pending: false, fixScope: "scene" });
    const ci = await ciGate.evaluate(h.scope, ep, v1.versionId);
    expect(ci.pass).toBe(false);
    expect(ci.blockers).toHaveLength(1);
    const [issue] = await h.continuity.listIssues(h.scope, { episodeId: ep2 });
    expect(issue).toMatchObject({ kind: "setup_missing", severity: "high", status: "open", detector: "foreshadow_manager" });
    const detail = await h.continuity.getIssue(h.scope, issue!.id);
    expect(detail.evidence.map((e) => e.refType).sort()).toEqual(["setup", "setup_beat"]);
    expect((await h.foreshadow.missingBeats(h.scope, ep2, v1.versionId)).length).toBe(1);

    // E4 rewrite → C2 (fixing); new version contains the beat → missing→detected, issue C3 resolved
    await h.fireTransition(ep2, "checking", "drafting");
    expect((await h.continuity.getIssue(h.scope, issue!.id)).status).toBe("fixing");
    const v2 = await h.createVersion(ep2, "서윤은 은반지를 다시 끼며 그 문양을 떠올렸다.");
    const run2 = await h.createRun("check_setups", "foreshadow_manager", "episode", ep2);
    const p2 = await check.execute(run2, { episode_id: ep2, manuscript_version_id: v2.versionId }, h.context, foundLlm(await beatId(setupId, "reinforce"), "서윤은 은반지를 다시 끼며 그 문양을 떠올렸다."));
    await h.tx((tx) => check.commit(tx, run2, { episode_id: ep2 }, p2, run2.task));
    const resolved = await h.continuity.getIssue(h.scope, issue!.id);
    expect(resolved).toMatchObject({ status: "resolved", resolutionKind: "rewritten" });
    expect(await fsGate.evaluate(h.scope, ep, v2.versionId)).toMatchObject({ pass: true });
    expect((await ciGate.evaluate(h.scope, ep, v2.versionId)).pass).toBe(true);
    const beat = (await h.foreshadow.getSetup(h.scope, setupId)).beats.find((b) => b.kind === "reinforce")!;
    expect(beat).toMatchObject({ status: "detected", manuscriptVersionId: v2.versionId });
  });
});

describe("due changes, setup_due question and abandonment (FR-FOR-04, FR-FOR-06)", () => {
  let arcId: string;
  let setupId: string;
  it("changeDue appends a SetupDueChange, cancels payoff beats past the due and enforces INV-SU-03", async () => {
    arcId = await h.createArc(10, 20, "active");
    const agent = actors.agent("foreshadow_manager", (await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId)).runId);
    const s = await h.tx((tx) => h.foreshadow.createSetup(tx, h.scope, { title: "봉인된 편지", description: "어머니의 편지", importance: "high", dueKind: "episode", dueEpisodeNo: 12, plannedArcId: arcId }, agent));
    setupId = s.id;
    await h.tx((tx) => h.foreshadow.planBeats(tx, h.scope, s.id, [{ kind: "plant", plannedEpisodeNo: 10 }, { kind: "payoff", plannedEpisodeNo: 12 }], agent));
    await expect(h.tx((tx) => h.foreshadow.createSetup(tx, h.scope, { title: "x", description: "y", importance: "low", dueKind: "episode" }, agent))).rejects.toMatchObject({ code: "setup_due_episode_required" });
    await expect(h.tx((tx) => h.foreshadow.createSetup(tx, h.scope, { title: "x", description: "y", importance: "low", dueKind: "arc", dueArcId: arcId, links: [{ type: "entity", id: "윤서" }] }, agent))).rejects.toMatchObject({ code: "setup_link_id" });

    // approve + plant so canon is locked
    await h.tx((tx) => h.foreshadow.applyArcPlanDecision(tx, h.scope, arcId, "approved", actors.system("orchestrator")));
    expect((await h.foreshadow.getSetup(h.scope, s.id)).canonStatus).toBe("approved");
    // INV-SU-03: agent cannot change an approved setup's due without a question/approval
    await expect(h.tx((tx) => h.foreshadow.changeDue(tx, h.scope, s.id, { dueKind: "episode", dueEpisodeNo: 11, reason: "앞당김" }, agent))).rejects.toMatchObject({ code: "setup_due_question_required" });
    await expect(h.tx((tx) => h.foreshadow.updateSetup(tx, h.scope, s.id, { title: "새 제목" }, agent))).rejects.toMatchObject({ code: "setup_canon_change_required" });
    // user may move it directly; payoff at 12 > 11 is released (B6)
    const after = await h.tx((tx) => h.foreshadow.changeDue(tx, h.scope, s.id, { dueKind: "episode", dueEpisodeNo: 11, reason: "앞당김" }, h.owner));
    expect(after.dueEpisodeNo).toBe(11);
    const detail = await h.foreshadow.getSetup(h.scope, s.id);
    expect(detail.dueChanges).toHaveLength(1);
    expect(detail.dueChanges[0]).toMatchObject({ fromDueEpisodeNo: 12, toDueEpisodeNo: 11, changedByActorType: "user" });
    expect(detail.beats.find((b) => b.kind === "payoff")!.status).toBe("cancelled");
    expect(await actionsOf(s.id)).toContain("setup.due_changed");
  });

  it("E9 past the due schedules review_setup_due; the task creates a setup_due question", async () => {
    // simulate planted state: confirm the plant beat via check + E9 on episode 10
    const ep10 = await h.createEpisode(arcId, 10);
    const v = await h.createVersion(ep10, "봉인된 편지가 서랍 깊은 곳에 있었다.");
    const check = h.reg.taskHandlers.get("check_setups");
    const run = await h.createRun("check_setups", "foreshadow_manager", "episode", ep10);
    const p = await check.execute(run, { episode_id: ep10, manuscript_version_id: v.versionId }, h.context, foundLlm(await beatId(setupId, "plant"), "봉인된 편지가 서랍 깊은 곳에 있었다."));
    await h.tx((tx) => check.commit(tx, run, { episode_id: ep10 }, p, run.task));
    await h.fireTransition(ep10, "awaiting_approval", "approved");
    expect((await h.foreshadow.getSetup(h.scope, setupId)).narrativeStatus).toBe("planted");

    const ep12 = await h.createEpisode(arcId, 12);
    await h.createVersion(ep12, "편지 이야기는 없었다.");
    h.calls.createTask.length = 0;
    await h.fireTransition(ep12, "awaiting_approval", "approved");
    // S-01 (due ep 3) is overdue too — one review task per overdue setup
    expect(h.calls.createTask.filter((t) => t.kind === "review_setup_due").length).toBe(2);
    const review = h.calls.createTask.find((t) => t.kind === "review_setup_due" && t.targetId === setupId);
    expect(review).toMatchObject({ targetType: "setup", targetId: setupId, input: { setup_id: setupId, as_of_episode_no: 12 } });

    const handler = h.reg.taskHandlers.get("review_setup_due");
    const rrun = await h.createRun("review_setup_due", "foreshadow_manager", "setup", setupId);
    const proposal = await handler.execute(rrun, review.input, h.context, h.llm(() => ({ recommendation: "extend", extend_to_episode_no: 15, rationale: "회수 장면을 준비할 시간이 더 필요합니다." })));
    expect(proposal.review.recommendation).toBe("extend");
    const outcome: any = await h.tx((tx) => handler.commit(tx, rrun, review.input, proposal, rrun.task));
    expect(outcome.kind).toBe("done");
    expect(outcome.outputRefs[0].refType).toBe("question");
    const q = h.calls.createQuestion.at(-1)!;
    expect(q.draft).toMatchObject({ topic: "setup_due", questionType: "single_choice", proposedBlockingBasis: "setup_due_high", links: [{ type: "setup", id: setupId }] });
    expect(q.draft.options.map((o: any) => o.value.kind)).toEqual(["extend", "assign", "abandon"]);
    expect(q.draft.recommendation.defaultAction).toBe("apply");

    const listOverdue = await h.foreshadow.listSetups(h.scope, { overdueOnly: true });
    expect(listOverdue.map((s) => s.id)).toContain(setupId);
  });

  it("setup_due answer: extend changes the due with the question id; abandon requests an approval; approval → S5", async () => {
    const applier = h.reg.appliers.get("setup_due")!;
    const questionId = await h.createQuestion("setup_due");
    const r1 = await h.tx((tx) =>
      applier({ tx, scope: h.scope, question: { id: questionId } as any, answer: { id: "ans_x", payload: { selected_idx: [0] } } as any, actor: h.owner, selectedOptions: [{ idx: 0, label: "연장", value: { kind: "extend", to_due_episode_no: 15, setup_id: setupId } }] }),
    );
    expect(r1.status).toBe("applied");
    const s = await h.foreshadow.getSetup(h.scope, setupId);
    expect(s.dueEpisodeNo).toBe(15);
    expect(s.dueChanges.at(-1)).toMatchObject({ toDueEpisodeNo: 15, questionId });

    const r2 = await h.tx((tx) => applier({ tx, scope: h.scope, question: { id: questionId } as any, answer: { id: "ans_y", payload: { selected_idx: [2] } } as any, actor: h.owner, selectedOptions: [{ idx: 2, label: "폐기", value: { kind: "abandon", setup_id: setupId } }] }));
    expect(r2.status).toBe("applied");
    const { approvalId } = h.calls.requestApproval.at(-1)!;
    expect(h.calls.requestApproval.at(-1)!.req).toMatchObject({ approvalType: "setup_abandon", target: { type: "setup", id: setupId } });
    // not abandoned before the decision
    expect((await h.foreshadow.getSetup(h.scope, setupId)).narrativeStatus).toBe("planted");
    // hitl decides (approval row approved) → handler in the same tx
    await h.testDb.exec(`UPDATE approvals SET status = 'approved', decided_at = now() WHERE id = '${approvalId}'`);
    const handler = h.reg.approvalHandlers.get("setup_abandon")!;
    const approval = (await h.testDb.query<any>(`SELECT id, subject_type AS "subjectType", subject_id AS "subjectId" FROM approvals WHERE id = '${approvalId}'`))[0];
    await h.tx((tx) => handler({ tx, scope: h.scope, approval, decision: "approved", decisionNote: "더 이상 쓰지 않습니다", reworkFrom: null, actor: h.owner, answerId: null }));
    const done = await h.foreshadow.getSetup(h.scope, setupId);
    expect(done).toMatchObject({ narrativeStatus: "abandoned", abandonApprovalId: approvalId, abandonedReason: "더 이상 쓰지 않습니다" });
    expect(await actionsOf(setupId)).toContain("setup.abandoned");
    // terminal
    await expect(h.tx((tx) => h.foreshadow.changeDue(tx, h.scope, setupId, { dueKind: "episode", dueEpisodeNo: 20, reason: "x" }, h.owner))).rejects.toMatchObject({ code: "setup_terminal" });
  });

  it("S5 refuses an approval that is not an approved setup_abandon of this setup", async () => {
    const agent = actors.agent("foreshadow_manager", (await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId)).runId);
    const s = await h.tx((tx) => h.foreshadow.createSetup(tx, h.scope, { title: "검은 깃털", description: "까마귀", importance: "low", dueKind: "arc", dueArcId: arcId, plannedArcId: arcId }, agent));
    const pending = await h.createApproval("setup_abandon", "setup", s.id, "pending");
    await expect(h.tx((tx) => h.foreshadow.transitionNarrative(tx, h.scope, s.id, "abandoned", h.owner, "사유", { approvalId: pending }))).rejects.toMatchObject({ code: "setup_abandon_approval_invalid" });
  });

  it("report() returns R1–R5", async () => {
    const r = await h.foreshadow.report(h.scope);
    expect(r.asOfEpisodeNo).toBe(12);
    expect(r.r1Unresolved.map((x) => x.displayLabel)).toContain("S-01");
    expect(r.r5Metrics.abandonRate.numerator).toBeGreaterThanOrEqual(0);
  });
});

describe("payoff contradiction (CR-15) with pinned planted facts", () => {
  it("pins linked fact versions on plant detection and opens setup_contradiction on a contradicting payoff (R4)", async () => {
    const arcId = await h.createArc(30, 32, "active");
    const ent = await h.createEntity();
    const fact = await h.createFact(ent, "secret_heir", true, { text: "하인 도윤은 왕의 숨은 아들이다" });
    h.ontology.linkedFacts = [fact];
    const agent = actors.agent("foreshadow_manager", (await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId)).runId);
    const s = await h.tx((tx) =>
      h.foreshadow.createSetup(tx, h.scope, { title: "숨은 왕자", description: "도윤의 출생 비밀", importance: "high", dueKind: "arc", dueArcId: arcId, plannedArcId: arcId, links: [{ type: "fact", id: fact.factId }, { type: "entity", id: ent }] }, agent),
    );
    await h.tx((tx) => h.foreshadow.planBeats(tx, h.scope, s.id, [{ kind: "plant", plannedEpisodeNo: 30 }, { kind: "payoff", plannedEpisodeNo: 31 }], agent));
    const check = h.reg.taskHandlers.get("check_setups");

    const ep30 = await h.createEpisode(arcId, 30);
    const v30 = await h.createVersion(ep30, "도윤의 목덜미에 왕가의 문장이 희미하게 보였다.");
    const r30 = await h.createRun("check_setups", "foreshadow_manager", "episode", ep30);
    const p30 = await check.execute(r30, { episode_id: ep30, manuscript_version_id: v30.versionId }, h.context, foundLlm(await beatId(s.id, "plant"), "도윤의 목덜미에 왕가의 문장이 희미하게 보였다."));
    await h.tx((tx) => check.commit(tx, r30, { episode_id: ep30 }, p30, r30.task));
    const pinned = await h.foreshadow.getSetup(h.scope, s.id);
    expect(pinned.links.find((l) => l.type === "fact")).toMatchObject({ id: fact.factId, pinnedFactVersionId: fact.factVersionId });
    expect(pinned.links.find((l) => l.type === "entity")).toMatchObject({ id: ent, pinnedFactVersionId: null });
    await h.fireTransition(ep30, "awaiting_approval", "approved");
    expect((await h.foreshadow.getSetup(h.scope, s.id)).narrativeStatus).toBe("planted");

    const ep31 = await h.createEpisode(arcId, 31);
    const v31 = await h.createVersion(ep31, "도윤은 사실 평범한 농부의 아들이었다고 밝혀졌다.");
    const r31 = await h.createRun("check_setups", "foreshadow_manager", "episode", ep31);
    const llm = h.llm((input) => {
      const prompt = input.messages.at(-1)!.content;
      expect(prompt).toContain("[PLANTED]");
      expect(prompt).toContain("하인 도윤은 왕의 숨은 아들이다");
      expect(prompt).toContain("설치 장면: 도윤의 목덜미에");
      const id = /\[BEAT\] id=(sbt_\w+) kind=payoff/.exec(prompt)![1];
      return { findings: [{ beat_id: id, found: true, quote: "평범한 농부의 아들", contradiction: "contradiction", contradiction_note: "설치된 출생 비밀과 반대입니다." }] };
    });
    const p31 = await check.execute(r31, { episode_id: ep31, manuscript_version_id: v31.versionId }, h.context, llm);
    await h.tx((tx) => check.commit(tx, r31, { episode_id: ep31 }, p31, r31.task));
    const [issue] = await h.continuity.listIssues(h.scope, { episodeId: ep31 });
    expect(issue).toMatchObject({ kind: "setup_contradiction", severity: "high", status: "open", charStart: 7 });
    const ev = (await h.continuity.getIssue(h.scope, issue!.id)).evidence;
    expect(ev.map((e) => e.refType).sort()).toEqual(["fact", "setup", "setup_beat"]);
    expect(ev.find((e) => e.refType === "fact")!.factVersionId).toBe(fact.factVersionId);
    const report = await h.foreshadow.report(h.scope);
    expect(report.r4ContradictionCandidates).toEqual([expect.objectContaining({ setupId: s.id, issueId: issue!.id, severity: "high" })]);
  });
});

describe("plan_setups: no entity handle in setup text (설계 추가 0026)", () => {
  const HANDLE = /(?<![A-Za-z0-9_])E\d{1,3}(?![A-Za-z0-9_])/;
  const planOf = (description: string, note: string, extra: Record<string, unknown> = {}) => ({
    new_setups: [
      {
        key: "N1",
        title: "깨진 인장",
        description,
        importance: "medium",
        due_kind: "arc",
        beats: [
          { kind: "plant", planned_episode_no: 41, note },
          { kind: "payoff", planned_episode_no: 43, note: "인장의 주인을 밝힙니다." },
        ],
        entity_ids: [],
        fact_ids: [],
        ...extra,
      },
    ],
    existing_setup_beats: [],
    rationale: "아크 범위 안에 배치했습니다.",
  });

  it("a handle in a description / beat note goes back for repair and the stored text is the repaired one", async () => {
    const arcId = await h.createArc(41, 43);
    const plan = h.reg.taskHandlers.get("plan_setups");
    let n = 0;
    const llm = h.llm(() => (++n === 1 ? planOf("E1의 인장이 깨진 이유.", "E1이 인장을 줍습니다.") : planOf("서윤의 인장이 깨진 이유.", "서윤이 인장을 줍습니다.")));
    const run = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
    // this pack's labels are other entities: the token is never rewritten with them
    const context = { ...h.context, handles: { entities: ["ent_x"], names: [], labels: ["확정 캐스트에서 확인되는 규칙"] } };
    const proposal = await plan.execute(run, { arc_id: arcId }, context, llm);
    expect(n).toBe(2);
    expect(llm.inputs[0]!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다"); // P7
    const critique = llm.inputs[1]!.messages.at(-1)!.content;
    expect(critique).toContain("떡밥 문장 new_setups[0].description");
    expect(critique).toContain("떡밥 문장 new_setups[0].beats[0].note");
    expect(critique).toContain("'E1'");
    expect(JSON.stringify(proposal.plan)).not.toMatch(HANDLE);
    expect(proposal.plan.new_setups[0].description).toBe("서윤의 인장이 깨진 이유.");
    expect(await h.tx((tx) => plan.commit(tx, run, { arc_id: arcId }, proposal, run.task))).toMatchObject({ kind: "done" });
    const stored = (await h.foreshadow.listSetups(h.scope)).find((s) => s.title === "깨진 인장")!;
    expect(JSON.stringify([stored.title, stored.description, stored.beats.map((b) => b.plannedNote)])).not.toMatch(HANDLE);
  });

  it("fails (retryable, with the symbol named) when the handle survives the repair rounds; nothing is proposed", async () => {
    const arcId = await h.createArc(51, 53);
    const plan = h.reg.taskHandlers.get("plan_setups");
    const before = (await h.foreshadow.listSetups(h.scope)).length;
    const leaking = planOf("E7이 숨긴 인장.", "단서를 보여 줍니다.");
    leaking.new_setups[0]!.beats = [
      { kind: "plant", planned_episode_no: 51, note: "단서를 보여 줍니다." },
      { kind: "payoff", planned_episode_no: 53, note: "인장의 주인을 밝힙니다." },
    ];
    const llm = h.llm(() => leaking);
    const run = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
    await expect(plan.execute(run, { arc_id: arcId }, h.context, llm)).rejects.toMatchObject({ name: "TaskFailure", errorFamily: "invalid_output", retryable: true, message: expect.stringMatching(/떡밥 문장 검사 실패.*'E7'/) });
    expect(llm.inputs.length).toBeGreaterThan(1);
    expect((await h.foreshadow.listSetups(h.scope)).length).toBe(before);
  });

  it("only a story token of the novel is story text (never a label of the run's pack); id reference fields are not scanned", async () => {
    const arcId = await h.createArc(61, 63);
    const plan = h.reg.taskHandlers.get("plan_setups");
    const ok = planOf("E3 구역의 봉인이 풀린 이유.", "E3 구역 입구의 인장을 보여 줍니다.");
    ok.new_setups[0]!.beats = [
      { kind: "plant", planned_episode_no: 61, note: "E3 구역 입구의 인장을 보여 줍니다." },
      { kind: "payoff", planned_episode_no: 63, note: "인장의 주인을 밝힙니다." },
    ];
    const llm = h.llm(() => ok);
    const run = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
    // the pack's labels include names agents derived from stored text ("E12 일행"): they exempt nothing
    const context = { ...h.context, handles: { entities: ["ent_x", "ent_y"], names: [], labels: ["E3 구역", "E12 일행"] } };
    await expect(plan.execute(run, { arc_id: arcId }, context, llm)).rejects.toMatchObject({ errorFamily: "invalid_output", message: expect.stringContaining("'E3'") });
    // a person named an entity "E3 구역" → E3 is a story token of the novel
    h.ontology.storyTokens = ["E3"];
    try {
      const llm1 = h.llm(() => ok);
      const proposal = await plan.execute(await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId), { arc_id: arcId }, context, llm1);
      expect(llm1.inputs).toHaveLength(1);
      expect(proposal.plan.new_setups[0].description).toBe("E3 구역의 봉인이 풀린 이유.");
      const llm2 = h.llm(() => ({ ...ok, new_setups: [{ ...ok.new_setups[0]!, description: "E12가 숨긴 봉인." }] }));
      const run2 = await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId);
      await expect(plan.execute(run2, { arc_id: arcId }, context, llm2)).rejects.toMatchObject({ errorFamily: "invalid_output", message: expect.stringContaining("'E12'") });
      // the plan's own rationale is not stored anywhere: a handle in it is dropped, the plan stands
      const llm3 = h.llm(() => ({ ...ok, rationale: "E7의 동선에 맞춰 배치했습니다." }));
      const p3 = await plan.execute(await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId), { arc_id: arcId }, context, llm3);
      expect(llm3.inputs).toHaveLength(1);
      expect(p3.plan.rationale).toBeUndefined();
    } finally {
      h.ontology.storyTokens = [];
    }
  });

  it("check_setups / review_setup_due: a diagnostic note that names someone by a handle is not stored", async () => {
    const arcId = await h.createArc(71, 80, "active");
    const agent = actors.agent("foreshadow_manager", (await h.createRun("plan_setups", "foreshadow_manager", "arc", arcId)).runId);
    const s = await h.tx((tx) => h.foreshadow.createSetup(tx, h.scope, { title: "사라진 열쇠", description: "창고 열쇠의 행방", importance: "medium", dueKind: "episode", dueEpisodeNo: 72, plannedArcId: arcId }, agent));
    await h.tx((tx) => h.foreshadow.planBeats(tx, h.scope, s.id, [{ kind: "plant", plannedEpisodeNo: 71 }, { kind: "payoff", plannedEpisodeNo: 72 }], agent));
    await h.tx((tx) => h.foreshadow.applyArcPlanDecision(tx, h.scope, arcId, "approved", actors.system("orchestrator")));

    const ep = await h.createEpisode(arcId, 71);
    const v = await h.createVersion(ep, "아무 일도 없었다.");
    const check = h.reg.taskHandlers.get("check_setups");
    const run = await h.createRun("check_setups", "foreshadow_manager", "episode", ep);
    const llm = h.llm((input) => ({
      findings: [...input.messages.at(-1)!.content.matchAll(/\[BEAT\] id=(sbt_\w+)/g)].map((m) => ({ beat_id: m[1], found: false, note: "E7이 열쇠를 줍는 장면이 없습니다." })),
      unplanned: [{ kind: "plant", quote: "아무 일도 없었다.", note: "E7의 흔적" }],
    }));
    const p = await check.execute(run, { episode_id: ep, manuscript_version_id: v.versionId }, h.context, llm);
    expect(llm.inputs[0]!.system).toContain("'E숫자' 기호를 쓰지 말고"); // P7
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ found: false, note: null });
    expect(p.unplanned[0]).toMatchObject({ quote: "아무 일도 없었다." });
    expect(p.unplanned[0].note).toBeUndefined();
    // a clean note is kept
    const run2 = await h.createRun("check_setups", "foreshadow_manager", "episode", ep);
    const clean = h.llm((input) => ({ findings: [...input.messages.at(-1)!.content.matchAll(/\[BEAT\] id=(sbt_\w+)/g)].map((m) => ({ beat_id: m[1], found: false, note: "열쇠를 줍는 장면이 없습니다." })) }));
    const p2 = await check.execute(run2, { episode_id: ep, manuscript_version_id: v.versionId }, h.context, clean);
    expect(p2.results[0].note).toBe("열쇠를 줍는 장면이 없습니다.");

    const handler = h.reg.taskHandlers.get("review_setup_due");
    const rrun = await h.createRun("review_setup_due", "foreshadow_manager", "setup", s.id);
    const input = { setup_id: s.id, as_of_episode_no: 75 };
    const rllm = h.llm(() => ({ recommendation: "extend", extend_to_episode_no: 78, rationale: "E7의 동선이 아직 정리되지 않았습니다.", body: "E7이 열쇠를 숨긴 채 72화가 지났습니다." }));
    const proposal = await handler.execute(rrun, input, h.context, rllm);
    expect(rllm.inputs[0]!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다"); // P7
    expect(proposal.review).toMatchObject({ recommendation: "extend", extend_to_episode_no: 78, rationale: "" });
    expect(proposal.review.body).toBeUndefined();
    await h.tx((tx) => handler.commit(tx, rrun, input, proposal, rrun.task));
    const q = h.calls.createQuestion.at(-1)!;
    expect(q.draft.body).toContain("회수되지 않았습니다");
    expect(JSON.stringify([q.draft.title, q.draft.body, q.draft.rationale, q.draft.recommendation.rationale])).not.toMatch(HANDLE);
  });
});
