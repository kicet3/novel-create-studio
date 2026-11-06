import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs, type Scripted } from "./support.js";

let t: TestCore;
let script: Scripted[];
beforeAll(async () => {
  t = await createTestCore();
  script = installConceptStubs(t).script;
});
afterAll(() => t.close());

const prov = (b: any, path: string) => b.field_provenance[path];

describe("concept conversation (CT-01, deterministic fallback, no LLM key)", () => {
  it("completes a web conversation → brief approval → N2 + goal form defaults", async () => {
    const novel = await t.modules.novel.service.createNovel({ title: "임시 제목" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const first = (await h.messages())[0]!;
    expect(first.authorKind).toBe("system");
    expect(first.askedFieldPaths).toEqual(["seed_notes"]);

    // opening → seed (user_stated) → diverging
    const r1 = await h.say("회귀한 짐꾼이 S급 배신자에게 복수");
    expect(r1.taskId).toBeTruthy();
    expect(await h.run()).toBe(1);
    let s = await h.session();
    expect(s.stage).toBe("diverging");
    expect(s.agentTurnCount).toBe(1);
    let b = await h.brief();
    expect(b.content.seed_notes).toBe("회귀한 짐꾼이 S급 배신자에게 복수");
    expect(prov(b, "seed_notes")).toMatchObject({ origin: "user_stated", slot_state: "confirmed", evidence_message_ids: [r1.message.id] });
    let agent = await h.lastAgent();
    expect(agent.askedFieldPaths).toEqual(["category.genre_label"]);
    expect((agent.options as any[]).map((o) => o.idx)).toEqual(expect.arrayContaining([900, 901, 904, 905, 903]));
    // user message got its slot diff (concept_messages.slot_updates)
    const userMsg = (await h.messages()).find((m) => m.id === r1.message.id)!;
    expect((userMsg.slotUpdates as any[])[0]).toMatchObject({ field_path: "seed_notes", origin: "user_stated" });

    // CQ-02 (seed chip) → CQ-16
    await h.pick("현판");
    await h.run();
    b = await h.brief();
    expect(b.content.category.genre_label).toBe("현판");
    expect(prov(b, "category.genre_label").origin).toBe("user_stated");
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["age_rating"]);

    // CT-10 (a): 19금 → not stored, 15세 안내
    await h.say("19금으로 해 줘");
    await h.run();
    b = await h.brief();
    expect(b.content.age_rating).toBeUndefined();
    expect((await h.lastAgent()).body).toContain("15세 이용가까지만");
    await h.pick("age_15");
    await h.run();
    expect((await h.brief()).content.age_rating).toBe("age_15");

    const answers: Array<[string, string]> = [
      ["protagonist.starting_condition", "회귀 전 S급 헌터에게 배신당해 죽은 F급 짐꾼"],
      ["protagonist.desire", "배신자에게 복수"],
      ["opposition", "S급 길드장과 그의 길드"],
      ["core_hook", "짐꾼만 볼 수 있는 던전의 균열"],
    ];
    for (const [path, text] of answers) {
      expect((await h.lastAgent()).askedFieldPaths).toEqual([path]);
      await h.say(text);
      await h.run();
    }
    // 현판 → CQ-10d 조건부 필수
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["world_rules[item_key=power_rank]"]);
    await h.pick("F~S급");
    await h.run();
    s = await h.session();
    expect(s.stage).toBe("converging");
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["ending_direction"]);
    await h.say("복수를 끝내고 새 길드를 세운다");
    await h.run();
    // converging done → proposal to move (R8: only the user moves to confirming)
    agent = await h.lastAgent();
    expect((agent.options as any[]).some((o) => o.value === "@to_confirming")).toBe(true);
    expect((await h.session()).stage).toBe("converging");
    await h.pick("@to_confirming");
    await h.run();
    s = await h.session();
    expect(s.stage).toBe("confirming");
    agent = await h.lastAgent();
    expect(agent.askedFieldPaths).toEqual(["logline"]);
    const loglineOpts = (agent.options as any[]).filter((o) => o.source === "agent");
    expect(loglineOpts).toHaveLength(3);
    // pick candidate 1 → agent_proposed_accepted (CT-22)
    await t.modules.concept.service.postUserMessage(h.scope, s.id, { body: "1", kind: "option_pick", pickedIdx: 1, channelId: s.activeChannelId }, t.owner);
    await h.run();
    b = await h.brief();
    expect(b.content.logline).toBe(loglineOpts[0].value);
    expect(prov(b, "logline")).toMatchObject({ origin: "agent_proposed_accepted", slot_state: "confirmed" });

    // view: everything required confirmed
    const view = await t.http("GET", `/api/novels/${novel.id}/concept/session`);
    expect(view.status).toBe(200);
    expect(view.body.canSubmit).toBe(true);
    expect(view.body.progress.missing).toEqual([]);
    expect(view.body.fieldBadges["seed_notes"].originLabel).toBe("내가 말함");

    // CS3 via [승인 요청] → check_concept_brief → CB1 + approval
    const sub = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/submit`);
    expect(sub.status).toBe(202);
    await h.run();
    s = await h.session();
    expect(s.status).toBe("awaiting_approval");
    expect(s.pendingApprovalId).toMatch(/^apr_/);
    const briefs = await t.modules.concept.service.listBriefs(h.scope);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ status: "awaiting_approval", versionNo: 1, authorActorType: "user", authorActorId: t.ownerId, approvalId: s.pendingApprovalId });
    expect((briefs[0]!.content as any).contribution_summary.filled_count).toBeGreaterThan(5);

    // A2 → CB2 + CS4 + N2 (M-01~M-05)
    await h.decide("approved");
    s = await h.session();
    expect(s.status).toBe("approved");
    const n = await t.modules.novel.service.getNovel(h.scope);
    expect(n.status).toBe("onboarding");
    expect(n.genre).toBe("현판");
    expect(n.ageRating).toBe("age_15");
    expect(n.approvedConceptBriefId).toBe(briefs[0]!.id);
    expect((await t.modules.concept.service.getApprovedBrief(h.scope))!.status).toBe("approved");
    const defaults = await t.http("GET", `/api/novels/${novel.id}/concept/goal-defaults`);
    expect(defaults.body).toMatchObject({ endingDirection: "복수를 끝내고 새 길드를 세운다", suggestMultiTimeline: false });
    // audit trail
    const actions = (await t.modules.audit.service.list(h.scope, { limit: 200 })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["concept_session.stage_changed", "concept_brief.version_created", "concept_brief.status_changed", "concept_session.status_changed", "novel.status_changed"]));
  });
});
