/**
 * Change proposals resolved through the chat (bug: "대화로 해결된 변경 제안이 계속 남아 있음").
 * A pending proposal must not stay pending once the conversation has settled it:
 * the user states the proposed value, states another value, agrees/declines in words, or the model
 * replaces it with a newer proposal. User-authored values are still never overwritten by the model alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@ncs/db/orm";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { reconcileProposals, yesNoAnswer, type ProposalSettlement } from "../../src/modules/concept/domain/change-proposals.js";
import { emptyWorkingBrief } from "../../src/modules/concept/domain/brief.js";
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
];

/** a conversation session whose user-edited `opposition` has one pending agent proposal ("외계 생명체") */
async function withPendingProposal(): Promise<{ h: ConceptHarness; sessionId: string; proposalId: string }> {
  const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
  const h = await conceptHarness(t, novel.id, script);
  const s = await h.session();
  for (const [p, v] of REQUIRED_SF) await svc().editWorkingBrief(h.scope, s.id, p, v, t.owner);
  await svc().switchEntryMode(h.scope, s.id, "conversation", t.owner);
  await h.run();
  script.push({
    reply_text: "대립을 바꿔 보면 어떨까요?",
    change_proposals: [{ field_path: "opposition", new_value: "외계 생명체", reason: "회사 뒤에 더 큰 적이 있으면 장기 갈등이 생깁니다." }],
  });
  await h.say("대립이 좀 약한 것 같아요");
  await h.run();
  const b = await h.brief();
  const pending = b.change_proposals.filter((p: any) => p.status === "pending");
  expect(pending).toEqual([expect.objectContaining({ field_path: "opposition", new_value: "외계 생명체" })]);
  return { h, sessionId: s.id, proposalId: pending[0].id };
}

async function auditAfter(novelId: string): Promise<any[]> {
  const page = await t.modules.audit.service.list({ novelId }, { actionPrefix: "concept_brief.change_proposal_decided", limit: 50 });
  return page.items.map((e) => e.after);
}

describe("change proposals settled in the chat", () => {
  it("the user states the proposed value in their own words → proposal accepted, not pending", async () => {
    const { h, proposalId } = await withPendingProposal();
    const m = await h.say("대립은 외계 생명체로 할게요");
    script.push({
      reply_text: "좋습니다, 외계 생명체로 바꿨습니다.",
      slot_updates: [{ field_path: "opposition", new_value: "외계 생명체", origin_claim: "user_stated", evidence_message_id: m.message.id, evidence_quote: "대립은 외계 생명체로 할게요", key_phrase: "외계 생명체" }],
    });
    await h.run();
    const b = await h.brief();
    expect(b.content.opposition).toBe("외계 생명체");
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "accepted", resolution: "applied_in_chat" });
    expect(b.change_proposals.filter((p: any) => p.status === "pending")).toEqual([]);
    expect((await h.lastAgent()).body).not.toContain("바꾸자는 제안");
    expect(await auditAfter(h.scope.novelId)).toContainEqual(expect.objectContaining({ path: "opposition", decision: "accepted", via: "chat" }));
  });

  it("the user settles the field on a different value → proposal superseded", async () => {
    const { h, proposalId } = await withPendingProposal();
    const m = await h.say("아니요, 대립은 기지를 장악한 반란군으로 할게요");
    script.push({
      reply_text: "반란군으로 정했습니다.",
      slot_updates: [{ field_path: "opposition", new_value: "기지를 장악한 반란군", origin_claim: "user_stated", evidence_message_id: m.message.id, evidence_quote: "대립은 기지를 장악한 반란군으로 할게요", key_phrase: "기지를 장악한 반란군" }],
    });
    await h.run();
    const b = await h.brief();
    expect(b.content.opposition).toBe("기지를 장악한 반란군");
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "superseded", resolution: "field_changed" });
    expect(await auditAfter(h.scope.novelId)).toContainEqual(expect.objectContaining({ path: "opposition", decision: "superseded" }));
  });

  it("answering the proposal question in words (model decision) accepts or keeps the value", async () => {
    // accept
    const a = await withPendingProposal();
    const ma = await a.h.say("네 그 제안대로 바꿔 주세요");
    script.push({ reply_text: "바꿨습니다.", proposal_decisions: [{ proposal_id: a.proposalId, decision: "accepted", evidence_message_id: ma.message.id, evidence_quote: "그 제안대로 바꿔 주세요" }] });
    await a.h.run();
    let b = await a.h.brief();
    expect(b.content.opposition).toBe("외계 생명체");
    expect(b.field_provenance.opposition).toMatchObject({ origin: "agent_proposed_accepted", slot_state: "confirmed" });
    expect(b.change_proposals.find((p: any) => p.id === a.proposalId)).toMatchObject({ status: "accepted" });
    // reject
    const r = await withPendingProposal();
    const mr = await r.h.say("아니요 지금 그대로 둘래요");
    script.push({ reply_text: "그대로 두겠습니다.", proposal_decisions: [{ proposal_id: r.proposalId, decision: "rejected", evidence_message_id: mr.message.id, evidence_quote: "지금 그대로 둘래요" }] });
    await r.h.run();
    b = await r.h.brief();
    expect(b.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(b.change_proposals.find((p: any) => p.id === r.proposalId)).toMatchObject({ status: "rejected" });
  });

  it("a model decision without the user's quote changes nothing (INV-CON-03)", async () => {
    const { h, proposalId } = await withPendingProposal();
    const m = await h.say("음 다른 얘기 먼저 할게요");
    script.push({ reply_text: "네.", proposal_decisions: [{ proposal_id: proposalId, decision: "accepted", evidence_message_id: m.message.id, evidence_quote: "바꿔 주세요" }] });
    await h.run();
    const b = await h.brief();
    expect(b.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "pending" });
  });

  it("without model output, a yes/no text reply to the proposal question decides it (and is never stored as the field value)", async () => {
    const a = await withPendingProposal();
    expect((await a.h.lastAgent()).body).toContain("바꾸자는 제안");
    await a.h.say("네 바꿔 주세요");
    await a.h.run(); // empty script → deterministic commit
    let b = await a.h.brief();
    expect(b.content.opposition).toBe("외계 생명체");
    expect(b.change_proposals.find((p: any) => p.id === a.proposalId)).toMatchObject({ status: "accepted" });

    const r = await withPendingProposal();
    await r.h.say("아니요, 그대로 둘게요");
    await r.h.run();
    b = await r.h.brief();
    expect(b.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(b.change_proposals.find((p: any) => p.id === r.proposalId)).toMatchObject({ status: "rejected" });
  });

  it("a newer proposal for the same field replaces the old one instead of piling up", async () => {
    const { h, proposalId } = await withPendingProposal();
    script.push({ reply_text: "다른 안도 있어요.", change_proposals: [{ field_path: "opposition", new_value: "기지 AI의 폭주", reason: "더 가까운 적" }] });
    await h.say("다른 안은 없을까요?");
    await h.run();
    const b = await h.brief();
    const pending = b.change_proposals.filter((p: any) => p.status === "pending");
    expect(pending).toEqual([expect.objectContaining({ field_path: "opposition", new_value: "기지 AI의 폭주" })]);
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "superseded", resolution: "replaced" });
  });

  it("the model sees the pending proposals (id + value) in the turn prompt", async () => {
    const { h, proposalId } = await withPendingProposal();
    let system = "";
    script.push((input) => {
      system = input.system;
      return { reply_text: "네." };
    });
    await h.say("계속해요");
    await h.run();
    expect(system).toContain(proposalId);
    expect(system).toContain("외계 생명체");
  });
});

/**
 * Bug: "변경 제안을 수락해도 채팅에 입력만 되고 AI에게 전달 안 됨". The [수락]/[거절] buttons wrote a user
 * message and the brief but never started a turn, so the partner only noticed the decision with the
 * user's next message (or never answered it).
 */
describe("change proposals decided with the buttons reach the partner", () => {
  const decideHttp = (novelId: string, sessionId: string, proposalId: string, decision: "accepted" | "rejected") =>
    t.http("POST", `/api/novels/${novelId}/concept/sessions/${sessionId}/change-proposals/${encodeURIComponent(proposalId)}`, { decision });

  it("accepting applies the value once and starts a turn that answers the decision", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    const res = await decideHttp(h.scope.novelId, sessionId, proposalId, "accepted");
    expect(res.status).toBe(200);
    expect(res.body.workingBrief.content.opposition).toBe("외계 생명체");
    expect(res.body.session.inFlightTaskId).toMatch(/^tsk_/); // the web opens the live reply stream right away
    const decisionMsg = (await h.messages()).filter((m) => m.authorKind === "user").at(-1)!;
    expect(decisionMsg.body).toContain("수락");
    expect(decisionMsg.body).toContain("외계 생명체");
    let newMessages = "";
    script.push((input) => {
      newMessages = JSON.stringify(input.messages);
      // a model echoing the decision as a proposal_decision / slot update must not re-apply it
      return {
        reply_text: "좋아요, 대립은 외계 생명체로 갑니다. 다음으로 결말 방향을 정해 볼까요?",
        proposal_decisions: [{ proposal_id: proposalId, decision: "rejected", evidence_message_id: decisionMsg.id, evidence_quote: decisionMsg.body }],
        change_proposals: [{ field_path: "opposition", new_value: "외계 생명체", reason: "같은 제안" }],
      };
    });
    await h.run();
    expect(newMessages).toContain(decisionMsg.id);
    const agent = await h.lastAgent();
    expect(agent.runId).toMatch(/^run_/);
    expect(agent.respondsToSeq).toBe(decisionMsg.seq);
    const b = await h.brief();
    expect(b.content.opposition).toBe("외계 생명체");
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "accepted", resolution: "button" });
    expect(b.change_proposals.filter((p: any) => p.status === "pending")).toEqual([]);
    expect(b.meta.processed_seq).toBeGreaterThanOrEqual(decisionMsg.seq);
    expect((await auditAfter(h.scope.novelId)).filter((a) => a.proposal_id === proposalId)).toHaveLength(1);
    expect((await h.session()).inFlightTaskId).toBeNull();
  });

  it("rejecting keeps the value, starts a turn, and the same proposal is not raised again", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    const res = await decideHttp(h.scope.novelId, sessionId, proposalId, "rejected");
    expect(res.status).toBe(200);
    expect(res.body.workingBrief.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(res.body.session.inFlightTaskId).toMatch(/^tsk_/);
    script.push({ reply_text: "알겠어요, 회사로 유지할게요.", change_proposals: [{ field_path: "opposition", new_value: "외계 생명체", reason: "다시 제안" }] });
    await h.run();
    const decisionMsg = (await h.messages()).filter((m) => m.authorKind === "user").at(-1)!;
    expect(decisionMsg.body).toContain("거절");
    expect((await h.lastAgent()).respondsToSeq).toBe(decisionMsg.seq);
    expect(script).toHaveLength(0); // the model was called for the decision
    const b = await h.brief();
    expect(b.content.opposition).toBe("기지를 봉쇄한 회사");
    expect(b.change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "rejected", resolution: "button" });
    expect(b.change_proposals.filter((p: any) => p.status === "pending")).toEqual([]);
  });

  it("a decision made while a turn is queued is picked up by that turn (no 409, no second turn)", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    const sent = await h.say("결말은 아직 고민 중이에요");
    expect(sent.taskId).toBeTruthy();
    const res = await decideHttp(h.scope.novelId, sessionId, proposalId, "accepted");
    expect(res.status).toBe(200);
    expect(res.body.workingBrief.content.opposition).toBe("외계 생명체");
    expect(res.body.session.inFlightTaskId).toBe(sent.taskId); // no second concurrent turn
    const decisionMsg = (await h.messages()).filter((m) => m.authorKind === "user").at(-1)!;
    let newMessages = "";
    script.push((input) => {
      newMessages = JSON.stringify(input.messages);
      return { reply_text: "네." };
    });
    await h.run();
    expect(newMessages).toContain(sent.message.id);
    expect(newMessages).toContain(decisionMsg.id);
    expect((await h.lastAgent()).respondsToSeq).toBe(decisionMsg.seq);
    expect((await h.session()).inFlightTaskId).toBeNull();
  });

  it("a decision made while the model is answering is queued and answered by a follow-up turn", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    await h.say("결말은 아직 고민 중이에요");
    let during: { status: number; body: any } | null = null;
    script.push(
      async () => {
        during = await decideHttp(h.scope.novelId, sessionId, proposalId, "accepted"); // the user clicks while the reply streams
        return { reply_text: "결말은 천천히 정해요." };
      },
      { reply_text: "네." },
    );
    await h.run(); // the running turn commits superseded → follow-up turn
    expect(during!.status).toBe(200);
    expect(during!.body.workingBrief.content.opposition).toBe("외계 생명체");
    const decisionMsg = (await h.messages()).filter((m) => m.authorKind === "user").at(-1)!;
    expect(decisionMsg.body).toContain("수락");
    await h.run();
    expect(script).toHaveLength(0); // both turns called the model
    const agents = (await h.messages()).filter((m) => m.authorKind === "agent");
    expect(agents.at(-2)!.isSuperseded).toBe(true);
    expect(agents.at(-1)!.respondsToSeq).toBe(decisionMsg.seq);
    expect((await h.brief()).meta.processed_seq).toBeGreaterThanOrEqual(decisionMsg.seq);
    expect((await h.brief()).change_proposals.find((p: any) => p.id === proposalId)).toMatchObject({ status: "accepted", resolution: "button" });
    expect((await h.session()).inFlightTaskId).toBeNull();
  });

  it("a decision made while an import runs gets its own turn after the import", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    const s = await h.session();
    const imp = await svc().postUserMessage(h.scope, sessionId, { body: "시놉시스: 화성 기지 이야기", kind: "import_text", channelId: s.activeChannelId! }, t.owner);
    expect(imp.taskId).toBeTruthy();
    const res = await decideHttp(h.scope.novelId, sessionId, proposalId, "rejected");
    expect(res.status).toBe(200);
    expect(res.body.session.inFlightTaskId).toBe(imp.taskId);
    const decisionMsg = (await h.messages()).filter((m) => m.authorKind === "user").at(-1)!;
    await h.run(); // import (no model output → deterministic) → follow-up concept_turn
    await h.run();
    expect((await h.lastAgent()).respondsToSeq).toBe(decisionMsg.seq);
    expect((await h.brief()).meta.processed_seq).toBeGreaterThanOrEqual(decisionMsg.seq);
  });

  it("the import follow-up never starts a second turn beside one a message already queued", async () => {
    const { h, sessionId } = await withPendingProposal();
    const s = await h.session();
    const imp = await svc().postUserMessage(h.scope, sessionId, { body: "시놉시스: 화성 기지 이야기", kind: "import_text", channelId: s.activeChannelId! }, t.owner);
    expect(imp.taskId).toBeTruthy();
    const sent = await h.say("결말은 아직 고민 중이에요"); // messenger-style: no in-flight lock → its own turn
    expect(sent.taskId).toBeTruthy();
    script.push({ reply_text: "네." }, { reply_text: "네." });
    await h.run();
    await h.run();
    const followups = (await t.testDb.db.execute(sql`SELECT id FROM tasks WHERE novel_id = ${h.scope.novelId} AND input->>'cycle_key' LIKE 'import-followup:%'`)) as any;
    expect(followups.rows).toHaveLength(0);
    script.length = 0;
    expect((await h.session()).inFlightTaskId).toBeNull();
  });

  it("a web button decision answers on the web even when the last chat was on a messenger", async () => {
    const { h, sessionId, proposalId } = await withPendingProposal();
    const s = await h.session();
    const web = (s.workingBrief as any).meta.web_channel_id as string;
    const bot = t.platform.ids.next("bot");
    const other = t.platform.ids.next("chn");
    await t.testDb.exec(`INSERT INTO messenger_bots (id, kind, label, token_secret_id, receive_mode) VALUES ('${bot}', 'telegram', 'tg', 'sec_x', 'polling')`);
    await t.testDb.exec(
      `INSERT INTO channels (id, novel_id, kind, label, status, bot_id, allowed_user_refs) VALUES ('${other}', '${h.scope.novelId}', 'telegram', 'tg', 'active', '${bot}', '{}')`,
    );
    await t.testDb.exec(`UPDATE concept_sessions SET active_channel_id = '${other}' WHERE id = '${sessionId}'`);
    const res = await decideHttp(h.scope.novelId, sessionId, proposalId, "accepted");
    expect(res.status).toBe(200);
    expect(res.body.session.activeChannelId).toBe(web);
    script.push({ reply_text: "네, 외계 생명체로 갑니다." });
    await h.run();
    const agent = await h.lastAgent();
    expect(agent.channelId).toBe(web);
    expect(agent.outboxId ?? null).toBeNull(); // not pushed to the other chat
  });
});

describe("change proposals settled by a form edit", () => {
  it("editing the field to the proposed value accepts it; to another value supersedes it", async () => {
    const a = await withPendingProposal();
    await svc().editWorkingBrief(a.h.scope, a.sessionId, "opposition", "외계 생명체", t.owner);
    expect((await a.h.brief()).change_proposals.find((p: any) => p.id === a.proposalId)).toMatchObject({ status: "accepted", resolution: "form_edit" });
    const b = await withPendingProposal();
    await svc().editWorkingBrief(b.h.scope, b.sessionId, "opposition", "기지를 장악한 반란군", t.owner);
    expect((await b.h.brief()).change_proposals.find((p: any) => p.id === b.proposalId)).toMatchObject({ status: "superseded", resolution: "field_changed" });
  });
});

describe("legacy proposals (stored before base_value / one-per-field)", () => {
  it("a pile of pending proposals for one field collapses to the newest", () => {
    const b = emptyWorkingBrief();
    b.content.opposition = "기지를 봉쇄한 회사";
    const mk = (id: string, v: string) => ({ id, field_path: "opposition", new_value: v, reason: "", status: "pending" as const, run_id: null });
    b.change_proposals.push(mk("p1", "외계 생명체"), mk("p2", "기지 AI의 폭주"));
    const out: ProposalSettlement[] = [];
    reconcileProposals(b, { existing: new Set(["p1", "p2"]), changed: new Set(), messageId: null, acceptedResolution: "applied_in_chat" }, out);
    expect(b.change_proposals.map((p) => [p.id, p.status])).toEqual([["p1", "superseded"], ["p2", "pending"]]);
    expect(out).toEqual([expect.objectContaining({ id: "p1", resolution: "replaced" })]);
  });
});

describe("yesNoAnswer", () => {
  it.each([
    ["네 바꿔 주세요", "accepted"],
    ["좋아요", "accepted"],
    ["제안 그대로 할게요", "accepted"],
    ["그 제안대로 해 주세요", "accepted"],
    ["아니요, 그대로 둘게요", "rejected"],
    ["바꾸지 마세요", "rejected"],
    ["지금 값 유지", "rejected"],
    ["대립은 반란군이 좋겠어요 그런데 회사도 남겨 두고 싶고 나중에 정할게요 일단 다음으로 가요", null],
    ["음 다른 얘기 먼저 할게요", null],
    // a question back or a word that merely starts with a yes-syllable is not an answer
    ["예를 들면 어떤 건데요", null],
    ["네? 무슨 제안이요?", null],
    ["응원해요", null],
    ["동의하기 어렵네요", null],
    ["좋아하는 건 회사 쪽이에요", null],
    ["아니면 둘 다 넣을까요?", null],
    ["아니 근데 이유가 뭐예요?", null],
    ["넵!", "accepted"],
    ["네 좋아요", "accepted"],
    ["좋아요 바꿔요", "accepted"],
    ["그걸로 바꿔 줄래요?", "accepted"],
  ])("%s → %s", (text, want) => expect(yesNoAnswer(text)).toBe(want));
});
