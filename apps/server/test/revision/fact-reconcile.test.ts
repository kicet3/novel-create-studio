/**
 * 설계 추가(수정 반영): an edited episode text → the ontology follows it (revision chat patch / manual edit).
 * The extraction script answers from the scene text (one sentence = one fact of 한결), polishing echoes its input so the
 * edited sentences survive, every other step is the scripted pipeline (support/pipeline-script.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { approvals, factVersions } from "@ncs/db/schema";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { pipelineHelpers } from "./harness.js";

const S_ALIVE = "한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다.";
const S_BANMAL = "한결은 누구에게나 늘 반말을 썼다.";
const S_JONDAE = "한결은 누구에게나 늘 존댓말을 썼다.";
const S_HAEYO = "한결은 누구에게나 늘 해요체를 썼다.";
const S_HASIPSIO = "한결은 누구에게나 늘 하십시오체를 썼다.";
const S_GENDER = "한결은 키가 큰 젊은 사내였다.";
const S_GENDER_F = "한결은 키가 큰 젊은 여인이었다.";
const RULES: Array<{ sentence: string; predicate: string; value: unknown; kind: string }> = [
  { sentence: S_ALIVE, predicate: "life_status", value: "alive", kind: "state" },
  { sentence: S_BANMAL, predicate: "personality", value: "반말을 쓴다", kind: "attribute" },
  { sentence: S_JONDAE, predicate: "personality", value: "존댓말을 쓴다", kind: "attribute" },
  { sentence: S_HAEYO, predicate: "personality", value: "해요체를 쓴다", kind: "attribute" },
  { sentence: S_HASIPSIO, predicate: "personality", value: "하십시오체를 쓴다", kind: "attribute" },
  { sentence: S_GENDER, predicate: "gender", value: "남성", kind: "attribute" },
  { sentence: S_GENDER_F, predicate: "gender", value: "여성", kind: "attribute" },
];

/** extract_facts: one mention + fact per known sentence found in a scene */
function extraction(r: ClaudeRequest) {
  const mentions: unknown[] = [];
  const facts: unknown[] = [];
  for (const m of r.prompt.matchAll(/<scene ord="(\d+)"[^>]*>\n([\s\S]*?)\n<\/scene>/g)) {
    const ord = Number(m[1]);
    for (const rule of RULES) {
      if (!m[2]!.includes(rule.sentence)) continue;
      const k = `m${mentions.length}`;
      mentions.push({ local_key: k, scene_ord: ord, surface: "한결", quote: rule.sentence, mention_kind: "named", entity_type_hint: "character" });
      facts.push({ local_key: `f${facts.length}`, fact_kind: rule.kind, subject_mention_key: k, predicate: rule.predicate, value: rule.value, scope_hint: "from_here" });
    }
  }
  return { mentions, facts };
}

/** polish_episode: return the scene text unchanged */
function polishEcho(r: ClaudeRequest): string {
  const last = r.messages.at(-1)?.content ?? r.prompt;
  const m = /"text":"((?:\\.|[^"\\])*)"/.exec(last);
  return m ? (JSON.parse(`"${m[1]}"`) as string) : "";
}

let t: TestCore;
let h: ReturnType<typeof pipelineHelpers>;
let scope: { novelId: string };
let novelId: string;

beforeAll(async () => {
  t = await createTestCore();
  t.claude.reply(
    { when: { schemaHas: ["mentions", "facts"] }, times: Infinity, json: extraction },
    { when: { text: true, system: "문장 교정자(line_editor)" }, times: Infinity, text: polishEcho },
  );
  scriptPipeline(t.claude);
  h = pipelineHelpers(t);
  const r = await h.novelWithEpisodeAwaiting({ title: "수정 반영" });
  scope = r.scope;
  novelId = r.novel.id;
}, 180_000);
afterAll(() => t.close());

const ep1 = () => h.ms().getEpisodeByNo(scope, 1);
const current = async () => {
  const ep = await ep1();
  return { ep, v: await h.ms().getVersion(scope, ep.currentVersionId!) };
};
const awaiting = async () => (await ep1()).status === "awaiting_approval";
const live = async () => t.modules.ontology.service.listEpisodeFacts(scope, (await ep1()).id);
const byValue = async (predicate: string, value: unknown) => (await live()).filter((f) => f.predicate === predicate && JSON.stringify(f.value) === JSON.stringify(value));
const factRow = async (id: string) => (await t.modules.ontology.service.getFactsByIds(scope, [id]))[0]!;
const contentOf = async (id: string) => {
  const rows = await t.testDb.db.select().from(factVersions).where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.factId, id)));
  return rows.find((r) => r.supersededAt === null)!.content as Record<string, unknown>;
};
const api = (method: string, path: string, body?: unknown) => t.http(method, `/api/novels/${novelId}/episodes/1/revision-chat${path}`, body);
const chatReply = (json: unknown) => t.claude.reply({ when: { schemaHas: ["reply_text", "diagnosis_kind"] }, json });
const patchTurn = async (patches: Array<{ quote: string; replacement: string }>) => {
  expect((await api("POST", "/messages", { body: "이 문장을 고쳐 줘" })).status).toBe(201);
  chatReply({
    reply_text: "고쳐 보았습니다.",
    diagnosis_kind: "style",
    sources: [],
    question: null,
    proposals: [{ kind: "text_patch", patches: patches.map((p) => ({ ...p, reason: "작가 요청" })), fact_id: null, new_value: null, reason: "" }],
  });
  await t.modules.orchestration.service.runOnce();
  const view = (await api("GET", "")).body;
  return view.proposals.filter((p: { kind: string; status: string }) => p.kind === "text_patch" && p.status === "pending").at(-1);
};
const reconcileApprovals = async () =>
  (await t.testDb.db.select().from(approvals).where(and(eq(approvals.novelId, novelId), eq(approvals.status, "pending")))).filter((a) => (a.payload as { kind?: string } | null)?.kind === "episode_fact_reconcile");

describe("본문 수정 → 온톨로지 반영", () => {
  it("manual edits: candidates follow the text (changed value superseded, no duplicate for unchanged facts)", async () => {
    let { v } = await current();
    expect(v.content).toContain(S_ALIVE);
    const [alive0] = await byValue("life_status", "alive");
    expect(alive0).toBeTruthy();
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_ALIVE, `${S_ALIVE}\n\n${S_BANMAL}\n\n${S_GENDER_F}\n\n`), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    expect((await live()).filter((f) => f.predicate === "life_status")).toHaveLength(1); // still the same fact
    const [female] = await byValue("gender", "여성");
    expect(female?.canonStatus).toBe("candidate");

    ({ v } = await current());
    const edited = await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_GENDER_F, S_GENDER), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    // single-valued slot: the extraction classified 남성 as a conflict with 여성 → the new fact supersedes it
    const [male] = await byValue("gender", "남성");
    expect(male).toBeTruthy();
    expect((await factRow(female!.factId)).canonStatus).toBe("rejected"); // candidate of the old text
    expect(male!.supersedes).toBe(female!.factId);
    expect(male!.conflictWith).toBeNull();
    expect((await contentOf(female!.factId)).supersededByFactId).toBe(male!.factId);
    // unchanged fact: one fact, its evidence re-pointed to the newest extracted text
    const alive = (await live()).filter((f) => f.predicate === "life_status");
    expect(alive.map((f) => f.factId)).toEqual([alive0!.factId]);
    const ms = await t.modules.ontology.service.listMentions(scope, { ids: alive[0]!.mentionIds });
    expect(new Set(ms.map((m) => m.manuscriptVersionId))).toEqual(new Set([edited.id])); // (polishing kept the text: no re-extraction)

    await h.decide(scope, "episode", (await ep1()).id, "approved");
    const after = await live();
    expect(after.map((f) => [f.predicate, f.canonStatus]).sort()).toEqual([
      ["gender", "approved"],
      ["life_status", "approved"],
      ["personality", "approved"],
    ]);
  }, 180_000);

  it("revision chat: the card lists the affected settings; confirmed → 반말 superseded by 존댓말, removed sentence retracted", async () => {
    const [banmal] = await byValue("personality", "반말을 쓴다");
    const [gender] = await byValue("gender", "남성");
    const p = await patchTurn([
      { quote: S_BANMAL, replacement: S_JONDAE },
      { quote: S_GENDER, replacement: "" },
    ]);
    const effects = p.payload.factEffects as Array<{ factId: string; effect: string; certain: boolean; needsConfirm: boolean }>;
    expect(effects.find((e) => e.factId === banmal!.factId)).toMatchObject({ effect: "change", certain: false, needsConfirm: true });
    expect(effects.find((e) => e.factId === gender!.factId)).toMatchObject({ effect: "retract", needsConfirm: true });
    expect(effects.some((e) => e.factId !== banmal!.factId && e.factId !== gender!.factId)).toBe(false); // untouched passages are not listed

    const acc = await api("POST", `/proposals/${p.id}/decision`, { decision: "accepted", confirmedFactIds: effects.map((e) => e.factId) });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    await h.drain(scope, awaiting, 100);

    expect((await factRow(banmal!.factId)).canonStatus).toBe("retracted"); // not left approved
    expect((await factRow(gender!.factId)).canonStatus).toBe("retracted");
    const [jondae] = await byValue("personality", "존댓말을 쓴다");
    expect(jondae?.canonStatus).toBe("candidate");
    expect(jondae!.supersedes).toBe(banmal!.factId);
    expect(jondae!.reconcilePending).toBe(false);
    expect(await reconcileApprovals()).toHaveLength(0); // the confirmation was the decision
    expect((await live()).filter((f) => f.predicate === "life_status")).toHaveLength(1);

    const events = (await t.modules.audit.service.list(scope, { actionPrefix: "fact.", limit: 200 })).items;
    const sup = events.find((e) => e.action === "fact.superseded" && e.targetId === banmal!.factId);
    expect(sup?.actorType).toBe("user");
    expect(sup?.details).toMatchObject({ decidedBy: "human_confirmed", episodeId: (await ep1()).id });
    expect(events.some((e) => e.action === "fact.retracted" && e.targetId === gender!.factId)).toBe(true);

    await h.decide(scope, "episode", (await ep1()).id, "approved");
    expect((await factRow(jondae!.factId)).canonStatus).toBe("approved");
  }, 180_000);

  it("an approved change the author did not confirm goes to a canon_change approval; the new candidate waits for it", async () => {
    const [jondae] = await byValue("personality", "존댓말을 쓴다");
    const p = await patchTurn([{ quote: S_JONDAE, replacement: S_BANMAL }]);
    const acc = await api("POST", `/proposals/${p.id}/decision`, { decision: "accepted", confirmedFactIds: [] });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    await h.drain(scope, awaiting, 100);

    expect((await factRow(jondae!.factId)).canonStatus).toBe("approved"); // never changed without a human decision
    const [banmal] = (await byValue("personality", "반말을 쓴다")).filter((f) => f.canonStatus === "candidate");
    expect(banmal?.reconcilePending).toBe(true);
    const [ap] = await reconcileApprovals();
    expect(ap?.approvalType).toBe("canon_change");
    expect((ap!.payload as { changes: Array<{ oldFactId: string; newFactId: string }> }).changes).toEqual([expect.objectContaining({ oldFactId: jondae!.factId, newFactId: banmal!.factId })]);

    // the episode approval does not promote the held candidate
    await h.decide(scope, "episode", (await ep1()).id, "approved");
    expect((await factRow(banmal!.factId)).canonStatus).toBe("candidate");

    const dec = await t.http("POST", `/api/novels/${novelId}/approvals/${ap!.id}/decision`, { decision: "approved" });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect((await factRow(jondae!.factId)).canonStatus).toBe("retracted");
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved"); // episode already approved → promoted now
    expect((await contentOf(banmal!.factId)).supersedes).toBe(jondae!.factId);
    const ev = (await t.modules.audit.service.list(scope, { actionPrefix: "fact.superseded", limit: 50 })).items.find((e) => e.targetId === jondae!.factId);
    expect(ev?.approvalId).toBe(ap!.id);
    expect(ev?.details).toMatchObject({ decidedBy: "approval" });
  }, 180_000);

  it("a rejected canon_change keeps the approved fact and rejects the replacing candidate", async () => {
    const [banmal] = await byValue("personality", "반말을 쓴다");
    const { v } = await current();
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_BANMAL, S_JONDAE), baseVersionId: v.id }, t.owner); // manual (EditPanel) path
    await h.drain(scope, awaiting, 100);
    const [ap] = await reconcileApprovals();
    expect(ap).toBeTruthy();
    const [jondae] = (await byValue("personality", "존댓말을 쓴다")).filter((f) => f.canonStatus === "candidate");
    expect(jondae?.reconcilePending).toBe(true);
    const dec = await t.http("POST", `/api/novels/${novelId}/approvals/${ap!.id}/decision`, { decision: "rejected", decisionNote: "예전 설정 유지" });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved");
    expect((await factRow(jondae!.factId)).canonStatus).toBe("rejected");
  }, 180_000);

  it("after a rejection the same replacement is not asked again (rejected in line with the decision)", async () => {
    const [banmal] = await byValue("personality", "반말을 쓴다");
    const { v } = await current();
    expect(v.content).toContain(S_JONDAE);
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_ALIVE, `${S_ALIVE}\n\n바람이 창틈으로 불어 들었다.`), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    expect(await reconcileApprovals()).toHaveLength(0);
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved");
    expect((await byValue("personality", "존댓말을 쓴다")).filter((f) => f.canonStatus === "candidate")).toHaveLength(0);
  }, 180_000);

  it("a pending request follows later edits: new replacement re-issued, request cancelled when the text supports the canon again", async () => {
    const [banmal] = await byValue("personality", "반말을 쓴다");
    let { v } = await current();
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_JONDAE, S_HAEYO), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    const [ap1] = await reconcileApprovals();
    const [haeyo] = await byValue("personality", "해요체를 쓴다");
    expect((ap1!.payload as { changes: unknown[] }).changes).toEqual([expect.objectContaining({ oldFactId: banmal!.factId, newFactId: haeyo!.factId })]);
    expect(haeyo!.reconcilePending).toBe(true);

    ({ v } = await current());
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_HAEYO, S_HASIPSIO), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    const pend = await reconcileApprovals();
    expect(pend).toHaveLength(1);
    expect(pend[0]!.id).not.toBe(ap1!.id);
    const [hasipsio] = await byValue("personality", "하십시오체를 쓴다");
    expect((pend[0]!.payload as { changes: unknown[] }).changes).toEqual([expect.objectContaining({ oldFactId: banmal!.factId, newFactId: hasipsio!.factId })]);
    expect(hasipsio!.reconcilePending).toBe(true);
    expect((await factRow(haeyo!.factId)).canonStatus).toBe("rejected");

    ({ v } = await current());
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_HASIPSIO, S_BANMAL), baseVersionId: v.id }, t.owner);
    await h.drain(scope, awaiting, 100);
    expect(await reconcileApprovals()).toHaveLength(0);
    const [closed] = await t.testDb.db.select().from(approvals).where(and(eq(approvals.novelId, novelId), eq(approvals.id, pend[0]!.id)));
    expect(closed!.status).not.toBe("pending");
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved");
    expect((await factRow(hasipsio!.factId)).canonStatus).toBe("rejected");
    expect((await live()).filter((f) => f.predicate === "personality").map((f) => f.factId)).toEqual([banmal!.factId]);
  }, 180_000);

  it("a fact shown as 유지(예상) cannot be confirmed: the extraction missing it → canon_change approval", async () => {
    await h.decide(scope, "episode", (await ep1()).id, "approved");
    const [banmal] = await byValue("personality", "반말을 쓴다");
    const p = await patchTurn([{ quote: S_BANMAL, replacement: "한결이 반말을 쓴다는 소문이 돌았다." }]);
    const effects = p.payload.factEffects as Array<{ factId: string; effect: string; needsConfirm: boolean }>;
    expect(effects.find((e) => e.factId === banmal!.factId)).toMatchObject({ effect: "keep", needsConfirm: false });
    const acc = await api("POST", `/proposals/${p.id}/decision`, { decision: "accepted", confirmedFactIds: [banmal!.factId] });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    await h.drain(scope, awaiting, 100);
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved");
    const [ap] = await reconcileApprovals();
    expect((ap!.payload as { changes: unknown[] }).changes).toEqual([expect.objectContaining({ oldFactId: banmal!.factId, newFactId: null })]);
    const dec = await t.http("POST", `/api/novels/${novelId}/approvals/${ap!.id}/decision`, { decision: "rejected", decisionNote: "예전 설정 유지" });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect((await factRow(banmal!.factId)).canonStatus).toBe("approved");
  }, 180_000);

  it("published episode: patches refused (retcon), facts untouched", async () => {
    await h.decide(scope, "episode", (await ep1()).id, "approved");
    expect((await t.http("POST", `/api/novels/${novelId}/episodes/1/publish`, {})).status).toBe(200);
    const before = (await live()).map((f) => [f.factId, f.canonStatus]);
    expect(before.every(([, s]) => s === "published_locked")).toBe(true);
    const p = await patchTurn([{ quote: S_ALIVE, replacement: "한결은 끝내 눈을 뜨지 못했다." }]);
    const acc = await api("POST", `/proposals/${p.id}/decision`, { decision: "accepted" });
    expect(acc.status).toBe(422);
    expect(acc.body.error.code).toBe("retcon_required");
    expect((await live()).map((f) => [f.factId, f.canonStatus])).toEqual(before);
  }, 180_000);
});
