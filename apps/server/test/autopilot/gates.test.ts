/**
 * 설계 추가 0014 — always-human gates under full_auto: only that branch waits (inbox + messenger + gate_hit), the rest
 * keeps being decided automatically; the kill switch and switching back to episode_approval.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { approvals } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { actors, type NovelScope } from "../../src/platform/index.js";
import { bindChat, CHAT, createTgEnv, flushOutbox, type TgEnv } from "../messaging/setup.js";
import { planningNovel } from "../structure/harness.js";
import { auditActions, enableFullAuto } from "./harness.js";

const SYS = actors.system("orchestrator");

let env: TgEnv;
beforeAll(async () => {
  env = await createTgEnv();
});
afterAll(() => env.t.close());

async function novelWithChat(title: string) {
  const { scope } = await planningNovel(env.t, { title });
  await bindChat(env, scope.novelId, CHAT + Math.floor(Math.random() * 100000));
  return scope;
}

/** a series bible waiting for its approval (eligible for an auto decision) */
async function bibleAwaiting(scope: NovelScope, label: string) {
  const t = env.t;
  return t.platform.uow.run(async (tx) => {
    const n = await t.modules.novel.service.getNovel(scope, tx);
    const bible = await t.modules.novel.service.createBibleVersion(tx, scope, { logline: "로그라인", synopsis: "시놉시스", content: {}, contentMd: "# 기획서", conceptBriefId: n.approvedConceptBriefId! }, SYS);
    const req = await t.modules.hitl.service.requestApproval(tx, scope, {
      approvalType: "series_bible",
      target: { type: "series_bible", id: bible.id },
      question: { title: `기획서 승인 요청 ${label}`, body: "기획서", links: [{ type: "series_bible", id: bible.id }] },
      requestedBy: SYS,
    });
    await t.modules.novel.service.transitionBible(tx, scope, bible.id, "awaiting_approval", SYS, { approvalId: req.approvalId });
    return { bibleId: bible.id, approvalId: req.approvalId, questionId: req.questionId };
  });
}

async function humanApproval(scope: NovelScope, type: "retcon" | "setup_abandon" | "canon_change", title: string) {
  return env.t.platform.uow.run((tx) =>
    env.t.modules.hitl.service.requestApproval(tx, scope, {
      approvalType: type,
      target: { type: "novel", id: scope.novelId },
      question: { title, body: `${title} 본문`, links: [{ type: "novel", id: scope.novelId }] },
      requestedBy: SYS,
    }),
  );
}

const sentTexts = () => env.fake.sent().map((c) => String(c.params.text));
const approvalRow = async (id: string) => (await env.t.testDb.db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

describe("always-human gates stop only their branch", () => {
  it("retcon / setup_abandon / canon_change wait for the author on the inbox AND the messenger while the bible is approved automatically", async () => {
    const scope = await novelWithChat("사람 게이트");
    await enableFullAuto(env.t, scope, {});
    const bible = await bibleAwaiting(scope, "A1");
    const gates = [await humanApproval(scope, "retcon", "공개 사실 리트콘"), await humanApproval(scope, "setup_abandon", "떡밥 S-01 폐기"), await humanApproval(scope, "canon_change", "승인 사실 변경")];

    await env.t.modules.hitl.service.runDispatcherOnce();
    await flushOutbox(env);
    const texts = sentTexts();
    for (const g of ["공개 사실 리트콘", "떡밥 S-01 폐기", "승인 사실 변경"]) expect(texts.some((x) => x.includes(g)), g).toBe(true);
    expect(texts.some((x) => x.includes("기획서 승인 요청 A1"))).toBe(false); // held for the auto decision (web inbox only)

    const r = await env.t.modules.autopilot.service.tick(scope);
    expect(r.decided).toEqual([`series_bible:${bible.approvalId}`]);
    expect(await approvalRow(bible.approvalId)).toMatchObject({ status: "approved", autoDecided: true, decidedByUserId: null });
    expect((await env.t.modules.novel.service.getBible(scope, bible.bibleId)).status).toBe("approved");
    for (const g of gates) expect((await approvalRow(g.approvalId)).status).toBe("pending");

    const hits = await auditActions(env.t, scope, "autopilot.gate_hit");
    expect(hits.map((h) => h.targetId).sort()).toEqual(gates.map((g) => g.approvalId).sort());
    expect(hits.every((h) => (h.details as { gate?: string }).gate === "always_human")).toBe(true);
    // the gate notice reaches the messenger once ("이 갈래만 멈췄고 다른 작업은 계속합니다")
    await flushOutbox(env);
    expect(sentTexts().filter((x) => x.includes("완전 자율:") && x.includes("공개 사실 리트콘"))).toHaveLength(1);
    await env.t.modules.autopilot.service.tick(scope);
    expect(await auditActions(env.t, scope, "autopilot.gate_hit")).toHaveLength(3); // no repeat
    const v = dto.autopilotViewSchema.parse((await env.t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(v.waitingHuman.map((w) => w.approvalId).sort()).toEqual(gates.map((g) => g.approvalId).sort());

    // the DB refuses an automatic decision of an always-human type (approvals_ck_auto)
    await expect(env.t.testDb.exec(`UPDATE approvals SET auto_decided = true WHERE id = '${gates[0]!.approvalId}'`)).rejects.toThrow(/approvals_ck_auto/);
  });

  it("with the bible setting off the bible goes to the author too", async () => {
    const scope = await novelWithChat("기획서 수동");
    await enableFullAuto(env.t, scope, { autoApproveBible: false });
    const bible = await bibleAwaiting(scope, "B2");
    await env.t.modules.hitl.service.runDispatcherOnce();
    await flushOutbox(env);
    expect(sentTexts().some((x) => x.includes("기획서 승인 요청 B2"))).toBe(true);
    expect((await env.t.modules.autopilot.service.tick(scope)).decided).toEqual([]);
    expect((await approvalRow(bible.approvalId)).status).toBe("pending");
  });
});

describe("kill switch and level change", () => {
  it("자율 진행 멈춤: no auto decision, the held approval goes to the messenger; resume decides it", async () => {
    const scope = await novelWithChat("멈춤");
    await enableFullAuto(env.t, scope, {});
    const bible = await bibleAwaiting(scope, "C3");
    await env.t.modules.hitl.service.runDispatcherOnce(); // web only (held)
    await flushOutbox(env);
    expect(sentTexts().some((x) => x.includes("기획서 승인 요청 C3"))).toBe(false);
    const halted = await env.t.http("POST", `/api/novels/${scope.novelId}/autopilot/halt`, {});
    expect(halted.status).toBe(200);
    expect(halted.body).toMatchObject({ active: false, phase: "halted", halted: { reason: "user" } });
    expect((await env.t.modules.autopilot.service.tick(scope)).skipped).toBe("halted");
    expect((await approvalRow(bible.approvalId)).status).toBe("pending");
    // the confirm step re-checks under the lock too
    const direct = await env.t.modules.hitl.service.autoDecideApproval(scope, bible.approvalId, { actor: actors.system("autopilot") });
    expect(direct).toMatchObject({ decided: false, code: "not_eligible" });
    expect((await approvalRow(bible.approvalId)).status).toBe("pending");
    // halted → not held: the dispatcher fans the open blocking approval out to the messenger
    await env.t.modules.hitl.service.runDispatcherOnce();
    await flushOutbox(env);
    expect(sentTexts().some((x) => x.includes("기획서 승인 요청 C3"))).toBe(true);
    // the scheduler starts nothing new while halted
    const sched = await env.t.modules.manuscript.service.schedule(scope);
    expect(sched.notes.some((n) => n === "autopilot:halted" || n.startsWith("no_"))).toBe(true);

    const resumed = await env.t.http("POST", `/api/novels/${scope.novelId}/autopilot/resume`);
    expect(resumed.body).toMatchObject({ active: true, halted: null });
    expect((await env.t.modules.autopilot.service.tick(scope)).decided).toEqual([`series_bible:${bible.approvalId}`]);
    expect((await auditActions(env.t, scope, "autopilot.")).map((e) => e.action)).toEqual(expect.arrayContaining(["autopilot.halted", "autopilot.resumed", "autopilot.approval_decided"]));
  });

  it("halt with 진행 중 작업도 멈춤 pauses the novel too", async () => {
    const scope = await novelWithChat("멈춤2");
    await enableFullAuto(env.t, scope, {});
    await env.t.http("POST", `/api/novels/${scope.novelId}/autopilot/halt`, { alsoPauseTasks: true });
    const n = await env.t.modules.novel.service.getNovel(scope);
    expect(n.pausedAt).not.toBeNull();
    expect(n.pauseReason).toBe("user");
  });

  it("switching back to episode_approval stops auto approvals at once; pending ones stay pending", async () => {
    const scope = await novelWithChat("전환");
    await enableFullAuto(env.t, scope, {});
    const bible = await bibleAwaiting(scope, "D4");
    const r = await env.t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "episode_approval" });
    expect(r.status).toBe(200);
    expect((await env.t.modules.autopilot.service.tick(scope)).skipped).toBe("not_full_auto");
    expect((await approvalRow(bible.approvalId)).status).toBe("pending");
    await env.t.modules.hitl.service.runDispatcherOnce();
    await flushOutbox(env);
    expect(sentTexts().some((x) => x.includes("기획서 승인 요청 D4"))).toBe(true);
  });
});
