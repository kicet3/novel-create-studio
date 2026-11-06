/**
 * 설계 추가 0014 — 질문 자동 응답: low-sensitivity choice questions are answered with the recommendation after the
 * configured minutes (provenance "자동 응답"); high-sensitivity / hold topics never; important blocking questions
 * (arc goal) only with the opt-in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { answers, questions } from "@ncs/db/schema";
import { FakeClock } from "@ncs/test-kit";
import type { QuestionDraft } from "../../src/modules/hitl/index.js";
import type { NovelScope } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { auditActions, enableFullAuto } from "./harness.js";

let t: TestCore;
let clock: FakeClock;
beforeAll(async () => {
  clock = new FakeClock("2026-11-05T03:00:00.000Z");
  t = await createTestCore({ clock });
});
afterAll(() => t.close());

const draft = (scope: NovelScope, over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  topic: "creative_choice",
  questionType: "single_choice",
  title: "조연 이름을 고르세요",
  body: "12화에 나올 조연의 이름입니다.",
  options: [
    { label: "윤서", value: { kind: "choice", key: "a" } },
    { label: "하린", value: { kind: "choice", key: "b" }, isRecommended: true },
  ],
  links: [{ type: "novel", id: scope.novelId }],
  ...over,
});
const ask = (scope: NovelScope, d: QuestionDraft) => t.platform.uow.run((tx) => t.modules.hitl.service.createQuestion(tx, scope, d, { createdBy: t.owner }));
const row = async (id: string) => (await t.testDb.db.select().from(questions).where(eq(questions.id, id)))[0]!;

async function fullAutoNovel(settings: Record<string, unknown> = {}) {
  const n = await t.modules.novel.service.createNovel({ title: "질문 자동 응답" }, t.owner);
  const scope = { novelId: n.id };
  await enableFullAuto(t, scope, settings);
  return scope;
}

describe("question auto answer", () => {
  it("answers a non-blocking creative choice with the recommendation after 30 minutes, not before", async () => {
    const scope = await fullAutoNovel();
    const q = await ask(scope, draft(scope));
    expect(q.grade).toBe("non_blocking");
    expect((await row(q.questionId)).sensitivity).toBe("normal");
    clock.advance(29 * 60_000);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([]);
    expect((await row(q.questionId)).status).toBe("pending");
    clock.advance(2 * 60_000);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([q.questionId]);
    const r = await row(q.questionId);
    expect(["answered", "resolved"]).toContain(r.status);
    expect(r.resolutionSource).toBe("auto_answer");
    const [a] = await t.testDb.db.select().from(answers).where(and(eq(answers.questionId, q.questionId)));
    expect(a).toMatchObject({ autoAnswered: true, responderUserId: t.ownerId, disposition: "accepted" });
    expect((a!.payload as { selected_idx: number[] }).selected_idx).toEqual([1]); // the recommended option
    const logged = await auditActions(t, scope, "autopilot.question_answered");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ provenance: "자동 응답" });
    const answered = (await auditActions(t, scope, "question.answered"))[0]!;
    expect(answered).toMatchObject({ actorType: "system", actorId: "autopilot" });
  });

  it("never answers high-sensitivity questions (major character fate, hold topics, agent-raised)", async () => {
    const scope = await fullAutoNovel();
    const fate = await ask(scope, draft(scope, { topic: "character_fate", gradeHints: { majorCharacterFate: true } }));
    const hold = await ask(scope, draft(scope, { topic: "interpretation_confirm", options: [{ label: "맞습니다", value: { kind: "choice", key: "confirm" } }, { label: "취소", value: { kind: "choice", key: "cancel" }, isRecommended: true }] }));
    const raised = await ask(scope, draft(scope, { sensitivity: "high" }));
    for (const q of [fate, hold, raised]) expect((await row(q.questionId)).sensitivity).toBe("high");
    clock.advance(24 * 60 * 60_000);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([]);
    for (const q of [fate, hold, raised]) expect((await row(q.questionId)).resolutionSource).not.toBe("auto_answer");
    // hitl refuses it as well (defense in depth)
    expect(await t.modules.hitl.service.autoAnswerQuestion(scope, fate.questionId, { actor: { type: "system", id: "autopilot" } })).toMatchObject({ decided: false, code: "high_sensitivity" });
  });

  it("an important blocking question (arc goal) is answered only with autoAnswerImportant", async () => {
    const scope = await fullAutoNovel();
    const q = await ask(scope, draft(scope, { gradeHints: { arcGoal: true } }));
    expect(q.grade).toBe("blocking");
    expect((await row(q.questionId))).toMatchObject({ blockingBasis: "arc_goal", sensitivity: "normal" });
    clock.advance(31 * 60_000);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([]);
    const p = await t.http("PATCH", `/api/novels/${scope.novelId}/autopilot/settings`, { autoAnswerImportant: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.settings.autoAnswerImportant).toBe(true);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([q.questionId]);
    expect((await row(q.questionId)).resolutionSource).toBe("auto_answer"); // questions_ck_4 allows it for arc_goal
  });

  it("does nothing outside full_auto", async () => {
    const n = await t.modules.novel.service.createNovel({ title: "수동" }, t.owner);
    const scope = { novelId: n.id };
    const q = await ask(scope, draft(scope));
    clock.advance(60 * 60_000);
    expect((await t.modules.autopilot.service.tick(scope)).skipped).toBe("not_full_auto");
    expect((await row(q.questionId)).status).toBe("pending");
  });
});
