import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "@ncs/db/orm";
import { answerReflectionItems, answerReflections, answers, approvals, digestBatches, messengerOutbox, questionDeliveries, questions } from "@ncs/db/schema";
import { actors, type NovelScope } from "../../src/platform/index.js";
import type { QuestionDraft } from "../../src/modules/hitl/index.js";
import { hitlCoreOf } from "../../src/modules/hitl/module.js";
import { bindChat, CHAT, createTgEnv, flushOutbox, type TgEnv } from "../messaging/setup.js";

let env: TgEnv;
beforeAll(async () => {
  env = await createTgEnv();
});
afterAll(() => env.t.close());

const hitl = () => env.t.modules.hitl.service;
const agent = actors.agent("writer", "run_00000000000000000000000000");

function draft(over: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    topic: "creative_choice",
    questionType: "single_choice",
    title: "조연 이름을 고르세요",
    body: "12화에 나올 조연의 이름입니다.",
    options: [
      { label: "윤서", value: { kind: "choice", key: "a" }, isRecommended: true },
      { label: "하린", value: { kind: "choice", key: "b" } },
    ],
    links: [{ type: "novel", id: "nov_placeholder" }],
    ...over,
  };
}

async function newNovel(bind = true) {
  const n = await env.t.modules.novel.service.createNovel({ title: "질문 테스트" }, env.t.owner);
  const scope: NovelScope = { novelId: n.id };
  const bound = bind ? await bindChat(env, n.id, CHAT + Math.floor(Math.random() * 100000)) : null;
  return { scope, novel: n, channel: bound?.channel ?? null, chatId: bound ? Number((bound.channel.externalChatRef as { chatId: string }).chatId) : 0 };
}

const create = (scope: NovelScope, d: QuestionDraft) =>
  env.t.platform.uow.run((tx) => hitl().createQuestion(tx, scope, { ...d, links: d.links.map((l) => (l.id === "nov_placeholder" ? { ...l, id: scope.novelId } : l)) }, { createdBy: env.t.owner }));

const q = async (scope: NovelScope, id: string) => (await env.t.testDb.db.select().from(questions).where(and(eq(questions.novelId, scope.novelId), eq(questions.id, id))))[0]!;

describe("questions: create, grade, dispatch", () => {
  it("Q1 grades + stores, and blocking questions fan out to web + telegram at once (D3)", async () => {
    const { scope, channel } = await newNovel();
    const r = await create(scope, draft({ topic: "character_fate", gradeHints: { majorCharacterFate: true } }));
    expect(r.grade).toBe("blocking");
    let row = await q(scope, r.questionId);
    expect(row).toMatchObject({ status: "pending", blockingBasis: "major_character_fate", displayNo: 1 });
    expect(row.deadlineAt).not.toBeNull();
    await hitl().runDispatcherOnce();
    row = await q(scope, r.questionId);
    expect(row.status).toBe("open");
    const dels = await env.t.testDb.db.select().from(questionDeliveries).where(eq(questionDeliveries.questionId, r.questionId));
    expect(dels.map((d) => d.state).sort()).toEqual(["pending", "posted"]);
    await flushOutbox(env);
    const tg = (await env.t.testDb.db.select().from(questionDeliveries).where(and(eq(questionDeliveries.questionId, r.questionId), eq(questionDeliveries.channelId, channel!.id))))[0]!;
    expect(tg.state).toBe("posted"); // QD2 after OB3
    const msg = env.fake.sent().find((c) => String(c.params.text).includes("조연 이름을 고르세요"))!;
    expect(msg.params.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toContain(`v1|a|${r.questionId}|0`);
    const actions = (await env.t.modules.audit.service.list(scope, { targetIds: [r.questionId] })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["question.created", "question.sent"]));
  });

  it("rejects drafts without links (INV-Q-05) with 422", async () => {
    const { scope } = await newNovel(false);
    await expect(env.t.platform.uow.run((tx) => hitl().createQuestion(tx, scope, { ...draft(), links: [] }, { createdBy: agent }))).rejects.toMatchObject({ status: 422 });
  });

  it("non-blocking questions go into a digest, flushed after the window (D3/DG2) within the daily cap", async () => {
    const { scope } = await newNovel();
    const a = await create(scope, draft());
    const b = await create(scope, draft({ title: "두 번째" }));
    expect(a.grade).toBe("non_blocking");
    await hitl().runDispatcherOnce();
    expect((await q(scope, a.questionId)).status).toBe("pending");
    const [batch] = await env.t.testDb.db.select().from(digestBatches).where(eq(digestBatches.novelId, scope.novelId));
    expect(batch!.questionIds).toEqual([a.questionId, b.questionId]);
    env.clock.advance(16 * 60_000);
    await hitl().runDispatcherOnce();
    expect((await q(scope, a.questionId)).status).toBe("open");
    const [sent] = await env.t.testDb.db.select().from(digestBatches).where(eq(digestBatches.id, batch!.id));
    expect(sent!.status).toBe("sent");
    const out = await env.t.testDb.db.select().from(messengerOutbox).where(and(eq(messengerOutbox.novelId, scope.novelId), eq(messengerOutbox.kind, "digest")));
    expect(out).toHaveLength(1);
  });

  it("daily cap holds extra non-blocking questions for later (D5)", async () => {
    const { scope } = await newNovel(false);
    await env.t.modules.novel.service.updateNotificationPolicy(scope, { dailyCapNonBlocking: 1 }, env.t.owner);
    const a = await create(scope, draft({ title: "상한 1" }));
    const b = await create(scope, draft({ title: "상한 2" }));
    await hitl().runDispatcherOnce();
    expect((await q(scope, a.questionId)).digestBatchId).not.toBeNull();
    expect((await q(scope, b.questionId)).digestBatchId).toBeNull();
    expect((await q(scope, b.questionId)).status).toBe("pending");
  });

  it("quiet hours keep blocking questions web-only, then fan out when they end (D4)", async () => {
    const { scope, channel } = await newNovel();
    env.clock.set("2026-11-05T15:30:00.000Z"); // 00:30 KST
    const r = await create(scope, draft({ topic: "direction", links: [{ type: "goal", id: "gol_x" }] }));
    await hitl().runDispatcherOnce();
    expect((await q(scope, r.questionId)).status).toBe("open");
    let dels = await env.t.testDb.db.select().from(questionDeliveries).where(eq(questionDeliveries.questionId, r.questionId));
    expect(dels.map((d) => d.channelId)).not.toContain(channel!.id);
    env.clock.set("2026-11-05T23:30:00.000Z"); // 08:30 KST
    await hitl().runDispatcherOnce();
    dels = await env.t.testDb.db.select().from(questionDeliveries).where(eq(questionDeliveries.questionId, r.questionId));
    expect(dels.map((d) => d.channelId)).toContain(channel!.id);
  });
});

describe("answers: CAS, late, duplicate, telegram replay", () => {
  it("web answer is accepted once; different later answer is late; same payload is duplicate", async () => {
    const { scope, novel } = await newNovel(false);
    const r = await create(scope, draft({ topic: "character_fate", gradeHints: { majorCharacterFate: true } }));
    await hitl().runDispatcherOnce();
    const a1 = await env.t.http("POST", `/api/novels/${novel.id}/questions/${r.questionId}/answers`, { optionIds: ["0"], requestId: "req-00000001" });
    expect(a1.status).toBe(201);
    expect(a1.body.disposition).toBe("accepted");
    const replay = await env.t.http("POST", `/api/novels/${novel.id}/questions/${r.questionId}/answers`, { optionIds: ["0"], requestId: "req-00000001" });
    expect(replay.body).toEqual(a1.body); // idempotent replay
    const dup = await env.t.http("POST", `/api/novels/${novel.id}/questions/${r.questionId}/answers`, { optionIds: ["0"], requestId: "req-00000002" });
    expect(dup.body.disposition).toBe("duplicate");
    const late = await env.t.http("POST", `/api/novels/${novel.id}/questions/${r.questionId}/answers`, { optionIds: ["1"], requestId: "req-00000003" });
    expect(late.body.disposition).toBe("late");

    const row = await q(scope, r.questionId);
    expect(row).toMatchObject({ status: "resolved", acceptedAnswerId: a1.body.answerId, resolutionSource: "user_answer" });
    const [refl] = await env.t.testDb.db.select().from(answerReflections).where(eq(answerReflections.questionId, r.questionId));
    expect(refl!.status).toBe("applied");
    expect(refl!.notifiedAt).not.toBeNull(); // blocking → notice (web)
    const items = await env.t.testDb.db.select().from(answerReflectionItems).where(eq(answerReflectionItems.reflectionId, refl!.id));
    expect(items.length).toBeGreaterThan(0);
    const all = await env.t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId));
    expect(all.map((a) => a.disposition).sort()).toEqual(["accepted", "duplicate", "late"]);
    expect(all.find((a) => a.disposition === "late")!.lateResolution).toBe("pending_user_choice");
    const conflict = (await hitl().listQuestions(scope, { topics: ["late_answer_conflict"] }))[0]!;
    expect(conflict.grade).toBe("non_blocking");
    const actions = (await env.t.modules.audit.service.list(scope, { targetIds: [r.questionId] })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["question.answered", "answer_reflection.recorded", "question.resolved", "question.late_answer_received"]));

    // the user dismisses the late answer through the conflict question
    await hitl().runDispatcherOnce();
    env.clock.advance(16 * 60_000);
    await hitl().runDispatcherOnce();
    const c = await env.t.http("POST", `/api/novels/${novel.id}/questions/${conflict.id}/answers`, { optionIds: ["1"], requestId: "req-00000004" });
    expect(c.body.disposition).toBe("accepted");
    const lateRow = (await env.t.testDb.db.select().from(answers).where(eq(answers.id, late.body.answerId)))[0]!;
    expect(lateRow.lateResolution).toBe("dismissed");

    const view = await env.t.http("GET", `/api/novels/${novel.id}/questions/${r.questionId}`);
    expect(view.body).toMatchObject({ displayNo: "Q-1", status: "resolved", reflection: { status: "applied" } });
    expect(view.body.answers).toHaveLength(3);
    const summary = await env.t.http("GET", `/api/novels/${novel.id}/inbox/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toHaveProperty("blocking");
  });

  it("telegram button: same update replayed and second click → applied exactly once", async () => {
    const { scope, chatId } = await newNovel();
    const r = await create(scope, draft({ topic: "character_fate", gradeHints: { majorCharacterFate: true }, title: "버튼 질문" }));
    await hitl().runDispatcherOnce();
    await flushOutbox(env);
    const msg = env.fake.sent().find((c) => String(c.params.text).includes("버튼 질문"))!;
    const msgId = env.fake.nextMessageId - 1;
    const data = `v1|a|${r.questionId}|1`;
    const click = env.fake.callbackUpdate(chatId, data, msgId);
    const click2 = env.fake.callbackUpdate(chatId, data, msgId); // second press: new update/callback id
    env.fake.updateBatches.push([click], [click, click2]);
    await env.t.modules.messaging.service.pollOnce();
    await env.t.modules.messaging.service.pollOnce(); // replays `click`
    await env.t.modules.messaging.service.processInboxOnce();
    const rows = await env.t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId));
    expect(rows.filter((a) => a.disposition === "accepted")).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((a) => a.disposition).sort()).toEqual(["accepted", "duplicate"]);
    expect((await q(scope, r.questionId)).status).toBe("resolved");
    expect(msg).toBeTruthy();
    // processing the inbox again changes nothing (rows are processed)
    await env.t.modules.messaging.service.processInboxOnce();
    expect(await env.t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId))).toHaveLength(2);
    // answered message is edited and reflection notice sent to telegram
    await flushOutbox(env);
    expect(env.fake.sent("editMessageText").some((c) => String(c.params.text).includes("선택: 하린"))).toBe(true);
    expect(env.fake.sent().some((c) => String(c.params.text).includes(`Q-1 반영 완료`))).toBe(true);
  });

  it("free text via [직접 입력] → ForceReply → reply text → answer kept for interpretation (INV-AI-01)", async () => {
    const { scope, chatId } = await newNovel();
    const r = await create(scope, draft({ topic: "character_fate", gradeHints: { majorCharacterFate: true }, title: "서술형 질문", allowFreeText: true }));
    await hitl().runDispatcherOnce();
    await flushOutbox(env);
    env.fake.updateBatches.push([env.fake.callbackUpdate(chatId, `v1|t|${r.questionId}|900`, env.fake.nextMessageId - 1)]);
    await env.t.modules.messaging.service.pollOnce();
    await env.t.modules.messaging.service.processInboxOnce();
    await flushOutbox(env);
    const prompt = env.fake.sent().find((c) => c.params.reply_markup?.force_reply && String(c.params.text).includes("답장"))!;
    expect(prompt).toBeTruthy();
    const promptId = env.fake.nextMessageId - 1;
    env.fake.updateBatches.push([env.fake.textUpdate(chatId, "둘 다 아니고 섭정 윤씨로 해 줘", { replyTo: promptId })]);
    await env.t.modules.messaging.service.pollOnce();
    await env.t.modules.messaging.service.processInboxOnce();
    const row = await q(scope, r.questionId);
    expect(row.status).toBe("answered"); // not resolved before interpretation is confirmed
    const [refl] = await env.t.testDb.db.select().from(answerReflections).where(eq(answerReflections.questionId, r.questionId));
    expect(refl!.status).toBe("pending");
    const [ans] = await env.t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId));
    expect(ans!.payload).toMatchObject({ text: "둘 다 아니고 섭정 윤씨로 해 줘" });
  });
});

describe("interpretation confirmation (05 §7)", () => {
  it("proposed → confirm question (same grade) → '맞습니다' → confirmed, original resolved applied", async () => {
    const { scope, novel } = await newNovel(false);
    const r = await create(scope, draft({ topic: "character_fate", gradeHints: { majorCharacterFate: true }, title: "해석 질문", allowFreeText: true }));
    await hitl().runDispatcherOnce();
    const a = await env.t.http("POST", `/api/novels/${novel.id}/questions/${r.questionId}/answers`, { text: "C는 살리되 한쪽 팔을 잃게 해 줘", requestId: "req-itp-0001" });
    expect(a.body.disposition).toBe("accepted");
    const core = hitlCoreOf(hitl())!;
    const res = await env.t.platform.uow.run(async (tx) => {
      // a bare runs row (task / wake FKs skipped) so the interpretation can reference its world_keeper run
      await tx.db.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.db.execute(
        sql`INSERT INTO runs (id, novel_id, task_id, wake_request_id, agent_role, prompt_template_version) VALUES ('run_01JBX2Y3Z4A5B6C7D8E9F0G1H2', ${scope.novelId}, 'tsk_01JBX2Y3Z4A5B6C7D8E9F0G1H2', 'wak_01JBX2Y3Z4A5B6C7D8E9F0G1H2', 'world_keeper', 'test')`,
      );
      return core.commitInterpretation(tx, scope, { question_id: r.questionId, answer_id: a.body.answerId, root_question_id: r.questionId, round: 0 }, "run_01JBX2Y3Z4A5B6C7D8E9F0G1H2", actors.agent("world_keeper", "run_01JBX2Y3Z4A5B6C7D8E9F0G1H2"), {
        status: "proposed",
        summary_ko: "C 생존, 팔 상실",
        changes: [{ kind: "constraint", description_ko: "C는 12화에서 살아남지만 왼팔을 잃습니다" }],
      });
    });
    const confirmQ = await q(scope, res.questionId);
    expect(confirmQ).toMatchObject({ topic: "interpretation_confirm", grade: "blocking", parentQuestionId: r.questionId });
    expect((await q(scope, r.questionId)).status).toBe("answered");
    await hitl().runDispatcherOnce();
    const c = await env.t.http("POST", `/api/novels/${novel.id}/questions/${res.questionId}/answers`, { optionIds: ["0"], requestId: "req-itp-0002" });
    expect(c.body, JSON.stringify(c.body)).toMatchObject({ disposition: "accepted" });
    expect((await q(scope, r.questionId)).status).toBe("resolved");
    const [refl] = await env.t.testDb.db.select().from(answerReflections).where(eq(answerReflections.questionId, r.questionId));
    expect(refl!.status).toBe("applied");
    const items = await env.t.testDb.db.select().from(answerReflectionItems).where(eq(answerReflectionItems.reflectionId, refl!.id));
    expect(items.some((i) => i.summary.includes("왼팔"))).toBe(true);
  });
});

describe("approvals (ADR-014)", () => {
  it("requestApproval creates a 1:1 blocking approve_reject question; decision runs the handler in the same tx", async () => {
    const { scope, novel } = await newNovel(false);
    const calls: string[] = [];
    hitl().registerApprovalHandler("publish_batch", async (ctx) => {
      calls.push(`${ctx.decision}:${ctx.approval.status}`);
    });
    const req = await env.t.platform.uow.run((tx) =>
      hitl().requestApproval(tx, scope, {
        approvalType: "publish_batch",
        target: { type: "novel", id: novel.id },
        question: { title: "이번 주 공개 처리", body: "3화를 공개 처리합니다.", links: [{ type: "novel", id: novel.id }] },
        requestedBy: actors.system("publisher"),
      }),
    );
    const qq = await q(scope, req.questionId);
    expect(qq).toMatchObject({ grade: "blocking", blockingBasis: "approval_gate", questionType: "approve_reject", approvalId: req.approvalId, topic: "publish_batch" });

    // A5: a second request for the same subject supersedes the first, cancelling its question
    const req2 = await env.t.platform.uow.run((tx) =>
      hitl().requestApproval(tx, scope, {
        approvalType: "publish_batch",
        target: { type: "novel", id: novel.id },
        question: { title: "이번 주 공개 처리(갱신)", body: "4화까지", links: [{ type: "novel", id: novel.id }] },
        requestedBy: actors.system("publisher"),
      }),
    );
    const [old] = await env.t.testDb.db.select().from(approvals).where(eq(approvals.id, req.approvalId));
    expect(old).toMatchObject({ status: "superseded", supersededById: req2.approvalId });
    expect((await q(scope, req.questionId)).status).toBe("cancelled");

    const bad = await env.t.http("POST", `/api/novels/${novel.id}/approvals/${req2.approvalId}/decision`, { decision: "rejected" });
    expect(bad.status).toBe(400);
    const ok = await env.t.http("POST", `/api/novels/${novel.id}/approvals/${req2.approvalId}/decision`, { decision: "rejected", decisionNote: "4화는 다음 주에" });
    expect(ok.status).toBe(200);
    expect(ok.body.approval).toMatchObject({ status: "rejected", decisionNote: "4화는 다음 주에" });
    expect(calls).toEqual(["rejected:rejected"]);
    expect((await q(scope, req2.questionId)).status).toBe("resolved");
    const again = await env.t.http("POST", `/api/novels/${novel.id}/approvals/${req2.approvalId}/decision`, { decision: "approved" });
    expect(again.body.disposition).toBe("late");
    const list = await env.t.http("GET", `/api/novels/${novel.id}/approvals?status=rejected`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([req2.approvalId]);
  });

  it("a throwing approval handler rolls back the whole decision (INV-APR-02)", async () => {
    const { scope, novel } = await newNovel(false);
    hitl().registerApprovalHandler("schema_change", async () => {
      throw new Error("boom");
    });
    const req = await env.t.platform.uow.run((tx) =>
      hitl().requestApproval(tx, scope, { approvalType: "schema_change", target: { type: "novel", id: novel.id }, question: { title: "스키마 변경", body: "", links: [{ type: "novel", id: novel.id }] }, requestedBy: env.t.owner }),
    );
    const r = await env.t.http("POST", `/api/novels/${novel.id}/approvals/${req.approvalId}/decision`, { decision: "approved" });
    expect(r.status).toBe(500);
    const [a] = await env.t.testDb.db.select().from(approvals).where(eq(approvals.id, req.approvalId));
    expect(a!.status).toBe("pending");
    expect(await env.t.testDb.db.select().from(answers).where(eq(answers.questionId, req.questionId))).toHaveLength(0);
  });
});

describe("deadlines (05 §5.5, fail-closed)", () => {
  it("non-blocking apply → defaulted+applied; hold topic → deadline_hold+not_applied; blocking → reminders only", async () => {
    const { scope } = await newNovel();
    const apply = await create(scope, draft({ title: "추천안 적용" }));
    const hold = await create(scope, draft({ topic: "duplicate_entity", title: "중복", options: [{ label: "같다", value: { kind: "same" } }, { label: "다르다", value: { kind: "distinct" } }] }));
    const block = await create(scope, draft({ topic: "rewrite_limit", title: "재작성 상한", options: [{ label: "직접 수정", value: { kind: "human_edit" } }, { label: "보류", value: { kind: "hold" } }] }));
    await hitl().runDispatcherOnce();
    env.clock.advance(16 * 60_000);
    await hitl().runDispatcherOnce();
    await flushOutbox(env);
    env.clock.advance(25 * 3600_000);
    await hitl().runDeadlinesOnce();
    expect(await q(scope, apply.questionId)).toMatchObject({ status: "resolved", resolutionSource: "default_applied" });
    expect(await q(scope, hold.questionId)).toMatchObject({ status: "resolved", resolutionSource: "deadline_hold" });
    const [hr] = await env.t.testDb.db.select().from(answerReflections).where(eq(answerReflections.questionId, hold.questionId));
    expect(hr).toMatchObject({ status: "not_applied", notAppliedReason: "마감 경과, 보류" });
    const b = await q(scope, block.questionId);
    expect(b.status).toBe("open"); // INV-Q-02
    expect(b.resolutionSource).toBeNull();
    expect(b.reminderCount).toBe(1);
    await flushOutbox(env);
    expect(env.fake.sent().some((c) => String(c.params.text).includes("답변 대기 중, 마감 지남") && c.params.reply_parameters)).toBe(true);
    env.clock.advance(25 * 3600_000);
    await hitl().runDeadlinesOnce();
    await hitl().runDeadlinesOnce();
    const b2 = await q(scope, block.questionId);
    expect(b2).toMatchObject({ status: "open", reminderCount: 2 });
  });

  it("cancelQuestion withdraws deliveries and cancels a linked approval (Q8/A4)", async () => {
    const { scope, novel } = await newNovel();
    const req = await env.t.platform.uow.run((tx) =>
      hitl().requestApproval(tx, scope, { approvalType: "arc", target: { type: "novel", id: novel.id }, question: { title: "아크 승인", body: "", links: [{ type: "novel", id: novel.id }] }, requestedBy: env.t.owner }),
    );
    await hitl().runDispatcherOnce();
    await env.t.platform.uow.run((tx) => hitl().cancelQuestion(tx, scope, req.questionId, "대상 작업이 취소됐습니다", env.t.owner));
    const [a] = await env.t.testDb.db.select().from(approvals).where(eq(approvals.id, req.approvalId));
    expect(a!.status).toBe("cancelled");
    const dels = await env.t.testDb.db.select().from(questionDeliveries).where(eq(questionDeliveries.questionId, req.questionId));
    expect(dels.every((d) => d.state === "withdrawn")).toBe(true);
    await expect(env.t.platform.uow.run((tx) => hitl().cancelQuestion(tx, scope, req.questionId, "again", env.t.owner))).rejects.toMatchObject({ status: 409 });
  });
});

describe("rewrite_limit questions (gate sweep regression)", () => {
  it("accepts the manuscript gate's rewrite_limit options (object values) and rejects plain strings", async () => {
    const { scope } = await newNovel(false);
    const id = await create(scope, draft({
      topic: "rewrite_limit",
      title: "7화 자동 재작성 상한에 도달했습니다",
      options: [
        { label: "직접 고치기", value: { kind: "human_edit" } },
        { label: "이슈 허용", value: { kind: "waive_issue", continuity_issue_ids: ["cis_1"] } },
        { label: "아웃라인부터 다시 쓰기", value: { kind: "replan_from_outline" }, isRecommended: true },
        { label: "보류", value: { kind: "hold" } },
      ],
      proposedBlockingBasis: "rewrite_limit",
    }));
    expect(id).toBeTruthy();
    await expect(create(scope, draft({ topic: "rewrite_limit", options: [{ label: "직접 고치기", value: "human_edit" as never }, { label: "보류", value: "hold" as never }] }))).rejects.toMatchObject({ status: 422 });
  });
});
