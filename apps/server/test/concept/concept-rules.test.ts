import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULTS } from "@ncs/shared";
import { TaskFailure } from "../../src/modules/orchestration/index.js";
import { conceptInternals } from "../../src/modules/concept/module.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { notWorld } from "../support/world.js";
import { conceptHarness, installConceptStubs, type ConceptHarness, type Scripted } from "./support.js";

let t: TestCore;
let script: Scripted[];
beforeAll(async () => {
  t = await createTestCore();
  script = installConceptStubs(t).script;
});
afterAll(() => t.close());

const svc = () => t.modules.concept.service;
const REQUIRED_SF: Array<[string, unknown]> = [
  ["category.genre_label", "SF"],
  ["age_rating", "age_12"],
  ["protagonist.starting_condition", "화성 기지의 정비공"],
  ["protagonist.desire", "지구로 돌아가기"],
  ["opposition", "기지를 봉쇄한 회사"],
  ["core_hook", "정비공만 기지의 AI와 대화할 수 있다"],
  ["ending_direction", "귀환에 성공하지만 AI를 남겨 둔다"],
];

async function readyForApproval(h: ConceptHarness) {
  const s = await h.session();
  for (const [p, v] of REQUIRED_SF) await svc().editWorkingBrief(h.scope, s.id, p, v, t.owner);
  const opts = (await h.brief()).content.logline_options as string[] | undefined;
  await svc().editWorkingBrief(h.scope, s.id, "logline", opts?.[0] ?? "화성 정비공이 지구로 돌아간다", t.owner);
}

async function approvedNovel(entryMode: "direct_input" | "conversation" = "direct_input") {
  const novel = await t.modules.novel.service.createNovel({ entryMode }, t.owner);
  const h = await conceptHarness(t, novel.id, script);
  await readyForApproval(h);
  await svc().submitForApproval(h.scope, (await h.session()).id, t.owner);
  await h.run();
  await h.decide("approved");
  return { novel, h };
}

describe("entry modes", () => {
  it("CT-03 direct_input: form → logline candidates → submit → one approval, author user", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    // INV-CON-05: not ready yet
    const early = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/submit`);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("concept_brief_not_ready");
    for (const [p, v] of REQUIRED_SF) {
      const r = await t.http("PATCH", `/api/novels/${novel.id}/concept/sessions/${s.id}/brief`, { path: p, value: v });
      expect(r.status).toBe(200);
    }
    let b = await h.brief();
    expect(b.content.logline_options).toHaveLength(3); // 2.3: concept_partner only offers logline candidates
    expect(b.field_provenance["protagonist.desire"]).toMatchObject({ origin: "user_edited", slot_state: "confirmed" });
    await t.http("PATCH", `/api/novels/${novel.id}/concept/sessions/${s.id}/brief`, { path: "logline", value: b.content.logline_options[0] });
    const view = await t.http("GET", `/api/novels/${novel.id}/concept/session`);
    expect(view.body.canSubmit).toBe(true);
    expect((await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/submit`)).status).toBe(202);
    await h.run();
    expect((await h.session()).status).toBe("awaiting_approval");
    const briefs = (await t.http("GET", `/api/novels/${novel.id}/concept/briefs`)).body.items;
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ authorActorType: "user", entryMode: "direct_input", status: "awaiting_approval" });
    const one = await t.http("GET", `/api/novels/${novel.id}/concept/briefs/${briefs[0].id}`);
    expect(one.body.contentMd).toContain("컨셉 브리프");
    // no agent turn ran in the form path
    expect((await h.session()).agentTurnCount).toBe(0);
    // unknown field / age_19 rejected
    b = await t.http("PATCH", `/api/novels/${novel.id}/concept/sessions/${s.id}/brief`, { path: "nope", value: 1 });
    expect(b.status).toBe(422);
  });

  it("CT-02 import: extracted fields are imported/proposed, bulk confirm, source_documents, only empty required asked", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "import" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    const text = ["장르: SF", "연령 등급: 12세", "주인공: 화성 기지의 정비공", "욕망: 지구로 돌아가기", "대립: 기지를 봉쇄한 회사", "훅: 정비공만 AI와 대화할 수 있다", "", "시놉시스 본문 ".repeat(200)].join("\n");
    const r = await svc().postUserMessage(h.scope, s.id, { body: text, kind: "import_text", channelId: s.activeChannelId }, t.owner);
    expect(r.taskId).toBeTruthy();
    expect(await h.run()).toBe(1);
    let b = await h.brief();
    expect(b.field_provenance["category.genre_label"]).toMatchObject({ origin: "imported", slot_state: "proposed" });
    expect(b.content.age_rating).toBe("age_12");
    expect(b.content.source_documents).toEqual([{ concept_message_id: r.message.id, chars: text.length, kind: "synopsis" }]);
    const agent = await h.lastAgent();
    expect((agent.options as any[])[0].value).toBe("@confirm_imported");
    expect(agent.askedFieldPaths).toEqual(["ending_direction"]);
    const c = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/confirm`, { which: "imported" });
    expect(c.status).toBe(200);
    b = await h.brief();
    expect(b.field_provenance["category.genre_label"]).toMatchObject({ origin: "imported", slot_state: "confirmed" });
    expect(c.body.progress.missing.map((m: any) => m.path)).toEqual(["ending_direction", "logline"]);
  });
});

describe("approval gate (CS3–CS5, CB1–CB5, N2)", () => {
  it("CT-13 rejection → active/converging, note as system message, mentioned field re-asked", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    await readyForApproval(h);
    await svc().submitForApproval(h.scope, (await h.session()).id, t.owner);
    await h.run();
    await h.decide("rejected", "결말이 너무 비극적");
    const s = await h.session();
    expect(s).toMatchObject({ status: "active", stage: "converging", pendingApprovalId: null });
    const msgs = await h.messages();
    expect(msgs.some((m) => m.authorKind === "system" && m.body.includes("결말이 너무 비극적"))).toBe(true);
    expect((await svc().listBriefs(h.scope))[0]!.status).toBe("rejected");
    // the queued turn asks about the ending first
    await h.run();
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["ending_direction"]);
    expect((await t.modules.novel.service.getNovel(h.scope)).status).toBe("concept");
  });

  it("CS9: user keeps talking while awaiting approval → approval cancelled, brief CB4", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    await readyForApproval(h);
    await svc().submitForApproval(h.scope, (await h.session()).id, t.owner);
    await h.run();
    expect((await h.session()).status).toBe("awaiting_approval");
    await h.say("잠깐, 결말을 다시 생각해 볼게요");
    const s = await h.session();
    expect(s.status).toBe("active");
    expect(s.pendingApprovalId).toBeNull();
    expect((await svc().listBriefs(h.scope))[0]!.status).toBe("rejected");
  });

  it("messenger inbound while awaiting approval asks [예]/[아니오]; [예] runs CS9", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    await readyForApproval(h);
    await svc().submitForApproval(h.scope, (await h.session()).id, t.owner);
    await h.run();
    const s = await h.session();
    const channel = await t.modules.messaging.service.getChannel(h.scope, s.activeChannelId);
    const app = conceptInternals(svc());
    const inbound = (optionValue?: string) =>
      t.platform.uow.run((tx) =>
        app.onInbound({ kind: "concept_message", conceptSessionId: s.id, text: "계속할게요", optionValue }, { tx, scope: h.scope, channel, inboxId: "inb_test", actor: t.owner, receivedAt: new Date(), senderExternalRef: "tg_1", providerMessageRef: null }),
      );
    expect(await inbound()).toEqual({ status: "processed" });
    expect((await h.messages()).at(-1)!.body).toContain("승인 요청을 취소하고");
    expect((await h.session()).status).toBe("awaiting_approval");
    await inbound("@yes");
    expect((await h.session()).status).toBe("active");
  });

  it("CT-15 / FR-NOV-10a: pre-bible revision replaces the approved brief and re-applies M-01~M-05", async () => {
    const { h } = await approvedNovel();
    const first = (await svc().getApprovedBrief(h.scope))!;
    // INV-CON-01: revision while nothing is open is allowed; a second one is not
    const rev = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/revisions`);
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ purpose: "revision", baseBriefId: first.id, stage: "converging" });
    expect((await t.http("POST", `/api/novels/${h.scope.novelId}/concept/revisions`)).status).toBe(409);
    const b = (await h.brief()) as any;
    expect(b.content.category.genre_label).toBe("SF"); // copied with provenance
    expect(b.field_provenance["opposition"].origin).toBe("user_edited");
    await svc().editWorkingBrief(h.scope, rev.body.id, "category.genre_label", "현판", t.owner);
    await svc().editWorkingBrief(h.scope, rev.body.id, "world_rules[item_key=power_rank]", "F~S급", t.owner);
    // category change re-confirms dependants (3.7) — confirm them again and pick a logline
    await svc().confirmFields(h.scope, rev.body.id, { paths: ["core_hook"] }, t.owner);
    const view = await svc().getSessionView(h.scope, rev.body.id);
    await svc().editWorkingBrief(h.scope, rev.body.id, "logline", "화성 정비공이 회사를 무너뜨린다", t.owner);
    expect(view!.progress.missing.map((m) => m.path)).toContain("logline");
    await svc().submitForApproval(h.scope, rev.body.id, t.owner);
    await h.run();
    await h.decide("approved");
    const briefs = await svc().listBriefs(h.scope);
    expect(briefs.map((x) => x.status)).toEqual(["approved", "superseded"]);
    expect(briefs[0]!.supersedesId).toBe(first.id);
    const n = await t.modules.novel.service.getNovel(h.scope);
    expect(n.approvedConceptBriefId).toBe(briefs[0]!.id);
    expect(n.genre).toBe("현판");
    expect(n.status).toBe("onboarding");
  });
});

describe("caps and lifecycle (3.8, 3.9, INV-CON-09)", () => {
  it("budget cap pauses (budget_limit) without a task; messages do not resume; form mode resumes LLM-free", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    let s = await h.session();
    await t.testDb.exec(`UPDATE concept_sessions SET spent_micros = budget_limit_micros - 300000 WHERE id = '${s.id}'`);
    const r = await h.say("떠오른 장면이 있어요");
    expect(r.taskId).toBeNull();
    s = await h.session();
    expect(s).toMatchObject({ status: "paused", pauseReason: "budget_limit" });
    const notice = (await h.messages()).at(-1)!;
    expect((notice.options as any[]).map((o) => o.idx)).toEqual([906, 907, 902]);
    expect((await h.say("계속해요")).taskId).toBeNull();
    expect((await h.session()).status).toBe("paused");
    await expect(svc().resumeSession(h.scope, s.id, t.owner)).rejects.toMatchObject({ code: "concept_budget_limit" });
    const sw = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/entry-mode`, { mode: "direct_input" });
    expect(sw.body).toMatchObject({ status: "active", llmDisabled: true, entryMode: "direct_input" });
    // raising the limit re-enables turns
    const ex = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/extend`, { budgetMicros: 20_000_000 });
    expect(ex.status).toBe(200);
    const actions = (await t.modules.audit.service.list(h.scope, { limit: 100 })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["concept_session.paused", "concept_session.resumed", "concept_session.entry_mode_changed", "concept_session.limit_extended"]));
  });

  it("turn cap is a hidden safety ceiling → limit card with remaining fields and how to continue; extensions capped (CT-08, 설계 변경)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    const ceiling = DEFAULTS["concept.max_turns"];
    const step = DEFAULTS["concept.turn_extension"];
    expect(s.turnLimit).toBe(ceiling);
    expect(ceiling).toBeGreaterThanOrEqual(200);
    // the view exposes the ceiling for the hidden warning only (softWarning = ceiling − remaining)
    const view = (await svc().getSessionView(h.scope, s.id))!;
    expect(view.turns).toMatchObject({ limit: ceiling, softWarning: ceiling - DEFAULTS["concept.turn_soft_warning_remaining"], extension: step, extensionsLeft: DEFAULTS["concept.max_turn_extensions"] });
    expect(view.progress.missing.length).toBeGreaterThan(0);
    await t.testDb.exec(`UPDATE concept_sessions SET agent_turn_count = turn_limit WHERE id = '${s.id}'`);
    expect((await h.say("안녕하세요")).taskId).toBeNull();
    const card = (await h.messages()).at(-1)!;
    expect(card.body).toContain(`안전 상한(${ceiling}턴)`);
    expect(card.body).toContain("진행 방식 바꾸기");
    expect(card.body).toContain(view.progress.missing[0]!.label);
    expect((card.options as any[]).map((o) => o.value)).toEqual(expect.arrayContaining(["@delegate_all", "@form_mode", "@extend_turns", "@later"]));
    const r = await h.pick("@extend_turns");
    expect(r.taskId).toBeTruthy();
    expect((await h.session()).turnLimit).toBe(ceiling + step);
    for (let i = 1; i < DEFAULTS["concept.max_turn_extensions"]; i++) await svc().extendLimit(h.scope, s.id, { turns: 1 }, t.owner);
    expect((await h.session()).turnLimit).toBe(ceiling + step * DEFAULTS["concept.max_turn_extensions"]);
    await expect(svc().extendLimit(h.scope, s.id, { turns: 1 }, t.owner)).rejects.toMatchObject({ code: "turn_extension_exhausted" });
  });

  it("at the turn cap [전부 맡기기] runs one closing turn instead of repeating the cap notice (review fix)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    await t.testDb.exec(`UPDATE concept_sessions SET agent_turn_count = turn_limit WHERE id = '${s.id}'`);
    expect((await h.say("안녕하세요")).taskId).toBeNull();
    const before = (await h.messages()).length;
    // the escape the cap notice offers is not a dead end
    const r = await h.pick("@delegate_all");
    expect(r.taskId).toBeTruthy();
    const after = await h.messages();
    expect(after.slice(before).some((m) => m.authorKind !== "user" && /안전 상한/.test(m.body ?? ""))).toBe(false);
    // past the one grace turn the notice stops offering it (no endless loop)
    await t.testDb.exec(`UPDATE concept_sessions SET agent_turn_count = turn_limit + 1, in_flight_task_id = NULL WHERE id = '${s.id}'`);
    await t.testDb.exec(`UPDATE tasks SET status = 'cancelled' WHERE id = '${r.taskId}'`);
    expect((await h.say("계속")).taskId).toBeNull();
    const card = (await h.messages()).at(-1)!;
    expect(card.body).toContain("안전 상한");
    expect((card.options as any[]).map((o) => o.value)).not.toContain("@delegate_all");
    expect((card.options as any[]).map((o) => o.value)).toContain("@form_mode");
  });

  it("pause/resume/abandon/restart (CS6–CS8)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    expect((await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/pause`, {})).body).toMatchObject({ status: "paused", pauseReason: "user" });
    // CS7 by message (user/idle)
    await h.say("다시 할게요");
    expect((await h.session()).status).toBe("active");
    const r = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/abandon`, { restart: true });
    expect(r.status).toBe(200);
    expect(r.body.abandoned.status).toBe("abandoned");
    expect(r.body.session.status).toBe("active");
    expect((await svc().getActiveSession(h.scope))!.id).toBe(r.body.session.id);
    // old messages are kept
    expect((await svc().listMessages(h.scope, s.id)).length).toBeGreaterThan(1);
  });

  it("idle sweep: reminder once after 48h, paused(idle) after 14 days", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    await t.testDb.exec(`UPDATE concept_sessions SET last_user_message_at = now() - interval '3 days' WHERE id = '${s.id}'`);
    await svc().sweepIdle();
    expect((await h.session()).remindedAt).not.toBeNull();
    const n1 = (await h.messages()).length;
    await svc().sweepIdle();
    expect((await h.messages()).length).toBe(n1);
    await t.testDb.exec(`UPDATE concept_sessions SET last_user_message_at = now() - interval '15 days' WHERE id = '${s.id}'`);
    await svc().sweepIdle();
    expect(await h.session()).toMatchObject({ status: "paused", pauseReason: "idle" });
  });
});

describe("turn execution with a model (scripted port)", () => {
  it("CT-05/06: model output cannot overwrite user fields; weakness notes are shown in converging", async () => {
    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    for (const [p, v] of REQUIRED_SF.slice(0, 6)) await svc().editWorkingBrief(h.scope, s.id, p, v, t.owner);
    await svc().switchEntryMode(h.scope, s.id, "conversation", t.owner);
    await h.run(); // resume turn (summary + next question)
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["ending_direction"]);
    script.push({
      reply_text: "결말 방향을 정해 볼까요?",
      questions: [{ slot_key: "ending_direction", ask_text: "결말은 어느 방향입니까?", options: [{ label: "귀환", value: "지구로 귀환", is_recommended: true }] }],
      slot_updates: [{ field_path: "opposition", new_value: "외계 생명체", origin_claim: "user_stated", evidence_message_id: null, evidence_quote: "외계", key_phrase: "외계" }],
      weakness_notes: ["대립이 1아크 뒤에 끝나면 장기 연재 갈등이 약합니다."],
    });
    await h.say("대립은 그대로 두고 싶어요. 그런데 회사는 사실 외계 생명체가 운영해요");
    await h.run();
    const b = await h.brief();
    expect(b.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(b.change_proposals[0]).toMatchObject({ field_path: "opposition", status: "pending" });
    const agent = await h.lastAgent();
    expect(agent.body).toContain("[약점]");
    expect(agent.runId).toMatch(/^run_/);
    // accept → value changes with agent_proposed_accepted
    const v = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/change-proposals/${b.change_proposals[0].id}`, { decision: "rejected" });
    expect(v.status).toBe(200);
    expect(v.body.workingBrief.content.opposition).toBe("기지를 봉쇄한 회사");
    expect((await h.session()).spentMicros).toBeGreaterThan(0);
    // the decision goes to the partner as a turn (bug: the button only wrote a chat line)
    expect(v.body.session.inFlightTaskId).toBeTruthy();
    await h.run();
    expect((await h.session()).inFlightTaskId).toBeNull();
  });

  it("CT-14: a failed attempt is retried without duplicate messages; last failure leaves a retry notice (X-8)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    script.push(new TaskFailure("provider_unavailable", "temporary"));
    const r = await h.say("우주 정거장 이야기");
    await h.run();
    expect((await h.messages()).filter((m) => m.authorKind === "agent")).toHaveLength(0);
    await h.run();
    const agents = (await h.messages()).filter((m) => m.authorKind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.respondsToSeq).toBe(r.message.seq);
    // exhausted attempts → system notice with [다시 시도], session stays active
    script.push(new TaskFailure("provider_unavailable", "a"), new TaskFailure("provider_unavailable", "b"), new TaskFailure("provider_unavailable", "c"));
    await h.say("장르는 SF");
    for (let i = 0; i < 3; i++) await h.run();
    const last = (await h.messages()).at(-1)!;
    expect(last.authorKind).toBe("system");
    expect((last.options as any[]).map((o) => o.value)).toContain("@retry");
    expect((await h.session()).status).toBe("active");
    script.length = 0;
  });

  it("X-7: a message arriving during the model call supersedes the reply and queues a new turn", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    await h.say("첫 메시지");
    script.push(async () => {
      await h.say("하나 더 말할게요");
      return {};
    });
    await h.run();
    const agents = (await h.messages()).filter((m) => m.authorKind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.isSuperseded).toBe(true);
    expect((await h.session()).agentTurnCount).toBe(0);
    await h.run();
    const live = (await h.messages()).filter((m) => m.authorKind === "agent" && !m.isSuperseded);
    expect(live).toHaveLength(1);
    expect((await h.session()).agentTurnCount).toBe(1);
  });
});

describe("real llm module path (Claude adapter → scripted Messages API)", () => {
  it("a turn runs through llm.modelCalls with the scripted ConceptTurnProposal", async () => {
    const app = conceptInternals(svc());
    const saved = app.ports.modelCalls;
    app.ports.modelCalls = () => t.modules.llm.service.modelCalls;
    try {
      const novel = await t.modules.novel.service.createNovel({}, t.owner);
      const h = await conceptHarness(t, novel.id, script);
      // an empty proposal: the code decides which slot to ask (3.5), the model only phrases it
      t.claude.reply({ when: { prompt: "회귀한 짐꾼 이야기", schemaHas: ["reply_text", "slot_updates"] }, json: { reply_text: "좋아요. 먼저 장르를 정해 볼까요?", slot_updates: [] } });
      await h.say("회귀한 짐꾼 이야기");
      await h.run();
      // (earlier novels' concept approval queued build_world_ontology, unscripted here)
      expect(notWorld(t.claude.unmatched)).toHaveLength(0);
      expect(notWorld(t.claude.requests)).toHaveLength(1);
      const agent = await h.lastAgent();
      expect(agent).toBeTruthy();
      expect(agent.askedFieldPaths).toEqual(["category.genre_label"]);
      expect((await h.brief()).content.seed_notes).toBe("회귀한 짐꾼 이야기");
    } finally {
      app.ports.modelCalls = saved;
    }
  });
});
