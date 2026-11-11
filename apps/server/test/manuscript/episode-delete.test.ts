/**
 * 설계 추가(화 삭제, E17): deleting an episode's generated manuscript cleans every derived record — the ontology
 * (facts rejected / retracted, mentions gone, other facts keep living minus the evidence), continuity issues, scenes,
 * versions — and returns the episode to planned, where the scheduler writes it again (unless held).
 * Same scripted pipeline as test/revision/fact-reconcile.test.ts (extraction answers from the scene text).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { facts, setupBeats } from "@ncs/db/schema";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { pipelineHelpers } from "../revision/harness.js";

const S_ALIVE = "한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다.";
const RULES = [{ sentence: S_ALIVE, predicate: "life_status", value: "alive", kind: "state" }];

function extraction(r: ClaudeRequest) {
  const mentions: unknown[] = [];
  const facts: unknown[] = [];
  for (const m of r.prompt.matchAll(/<scene ord="(\d+)"[^>]*>\n([\s\S]*?)\n<\/scene>/g)) {
    for (const rule of RULES) {
      if (!m[2]!.includes(rule.sentence)) continue;
      const k = `m${mentions.length}`;
      mentions.push({ local_key: k, scene_ord: Number(m[1]), surface: "한결", quote: rule.sentence, mention_kind: "named", entity_type_hint: "character" });
      facts.push({ local_key: `f${facts.length}`, fact_kind: rule.kind, subject_mention_key: k, predicate: rule.predicate, value: rule.value, scope_hint: "from_here" });
    }
  }
  return { mentions, facts };
}

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
  const r = await h.novelWithEpisodeAwaiting({ title: "화 삭제" });
  scope = r.scope;
  novelId = r.novel.id;
}, 180_000);
afterAll(() => t.close());

const ep = (no: number) => h.ms().getEpisodeByNo(scope, no);
const onto = () => t.modules.ontology.service;
const liveFacts = async (no: number) => onto().listEpisodeFacts(scope, (await ep(no)).id);
const factStatus = async (id: string) => (await t.testDb.db.select({ s: facts.canonStatus, m: facts.mentionIds }).from(facts).where(and(eq(facts.novelId, novelId), eq(facts.id, id))))[0]!;
const del = (no: number, body: unknown) => t.http("POST", `/api/novels/${novelId}/episodes/${no}/delete-manuscript`, body);
const preview = (no: number) => t.http("GET", `/api/novels/${novelId}/episodes/${no}/delete-preview`);
const deleteAudits = async (episodeId: string) => (await t.modules.audit.service.list(scope, { targetIds: [episodeId], actionPrefix: "episode.manuscript_deleted", limit: 20 })).items;

describe("화 삭제 (E17)", () => {
  it("a planned episode without a manuscript has nothing to delete", async () => {
    const e2 = await ep(2);
    expect(e2.status).toBe("planned");
    const p = await preview(2);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ episodeNo: 2, status: "planned", published: false, versionCount: 0, facts: { candidate: 0, approved: 0, publishedLocked: 0 } });
    const r = await del(2, { reason: "테스트" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("nothing_to_delete");
  });

  it("the preview counts what the delete would remove", async () => {
    const e1 = await ep(1);
    expect(e1.status).toBe("awaiting_approval");
    const p = await preview(1);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.status).toBe("awaiting_approval");
    expect(p.body.published).toBe(false);
    expect(p.body.versionCount).toBeGreaterThan(0);
    expect(p.body.facts.candidate).toBeGreaterThan(0);
    expect(p.body.mentionCount).toBeGreaterThan(0);
    for (const k of ["entityRetireCount", "issueCount", "setupBeatCount", "recapCount", "revisionSessionCount", "activeTaskCount", "pendingApprovalCount", "pendingQuestionCount"]) {
      expect(typeof p.body[k], k).toBe("number");
    }
    const r = await del(1, { reason: "" });
    expect(r.status).toBe(400); // zod: reason required
  });

  it("published: the external confirmation is required; with it the locked facts end retracted and the episode is written again", async () => {
    const e1 = await ep(1);
    await h.decide(scope, "episode", e1.id, "approved");
    expect((await t.http("POST", `/api/novels/${novelId}/episodes/1/publish`, {})).status).toBe(200);
    const before = await liveFacts(1);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((f) => f.canonStatus === "published_locked")).toBe(true);
    const p = await preview(1);
    expect(p.body).toMatchObject({ status: "published", published: true, facts: { publishedLocked: before.length } });

    const refused = await del(1, { reason: "다시 쓰고 싶어요" });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("external_confirmation_required");
    expect((await ep(1)).status).toBe("published");

    const ok = await del(1, { reason: "다시 쓰고 싶어요", confirmedNotPublishedExternally: true, holdRewrite: false });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: "planned", publishedVersionId: null, approvedVersionId: null, currentVersionId: null, outlineVersionId: null, pausedAt: null, rejectionCount: 0, blockReasons: [] });
    expect(ok.body.title).toBe(e1.title); // the plan stays
    expect((await t.http("GET", `/api/novels/${novelId}/episodes/1/versions`)).body.items).toEqual([]);
    for (const f of before) expect((await factStatus(f.factId)).s).toBe("retracted");
    expect(await liveFacts(1)).toEqual([]);
    const audits = await deleteAudits(e1.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe("다시 쓰고 싶어요");
    expect(audits[0]!.details).toMatchObject({ facts: { retracted: before.length, rejected: 0 }, holdRewrite: false });
    expect((audits[0]!.details as { versionCount: number }).versionCount).toBeGreaterThan(0);

    // the scheduler treats the planned episode normally: outline → draft → … → awaiting approval again
    await h.drain(scope, async () => (await ep(1)).status === "awaiting_approval", 150);
    const again = await liveFacts(1);
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((f) => f.canonStatus === "candidate")).toBe(true);
    expect(again.some((f) => before.some((b) => b.factId === f.factId))).toBe(false); // fresh facts, old ones stay retracted
  }, 240_000);

  it("awaiting approval + holdRewrite: facts rejected, mentions / scenes / issues gone, shared evidence of another episode kept, episode paused", async () => {
    const e1 = await ep(1);
    const e2 = await ep(2);
    expect(e1.status).toBe("awaiting_approval");
    const own = await liveFacts(1);
    const f = own[0]!;
    const m1 = f.mentionIds[0]!;
    const timeline = await onto().getDefaultTimeline(scope);
    // a fact of episode 2 whose evidence includes a mention of episode 1 and one of its own
    const { sharedFactId } = await t.platform.uow.run(async (tx) => {
      const { mentionIds: [m2] } = await onto().writeMentions(
        tx,
        scope,
        [{ sourceKind: "user_input", storyPoint: 2001, timelineId: timeline.id, surface: "한결", mentionKind: "named", candidates: [], linkedEntityId: f.subjectEntityId, confidence: 1, linkStatus: "confirmed", linkerVersion: "test" }],
        t.owner,
      );
      const r = await onto().writeCandidateFacts(
        tx,
        scope,
        [{ factKind: "attribute", subjectEntityId: f.subjectEntityId, predicate: "personality", value: "느긋하다", timelineId: timeline.id, storyRange: { from: 2001, to: null }, sourceKind: "manuscript", source: { refType: "manuscript_version", refId: e2.id }, mentionIds: [m1, m2!], episodeId: e2.id }],
        t.owner,
      );
      expect(r.rejected).toEqual([]);
      return { sharedFactId: r.written[0]!.factId, m2: m2! };
    });
    // a continuity issue about the text
    await t.platform.uow.run((tx) =>
      t.modules.continuity.service.openIssue(tx, scope, { kind: "appearance", severity: "low", detector: "continuity_editor", episodeId: e1.id, manuscriptVersionId: e1.currentVersionId!, message: "테스트 이슈", evidence: [{ factId: f.factId, factVersionId: f.factVersionId, quote: "테스트" }] }, t.owner),
    );
    // a payoff beat whose `missing` result pointed at the text, then released by a due change (B6: `cancelled` keeps the
    // version anchor) — the delete must clear the anchor instead of failing on setup_beats.manuscript_version_id
    const fs = t.modules.foreshadow.service;
    const setup = await t.platform.uow.run((tx) => fs.createSetup(tx, scope, { title: "봉인된 편지", description: "테스트 떡밥", importance: "low", dueKind: "episode", dueEpisodeNo: 3 }, t.owner));
    const [beat] = await t.platform.uow.run((tx) => fs.planBeats(tx, scope, setup.id, [{ kind: "payoff", plannedEpisodeNo: 3 }], t.owner));
    await t.platform.uow.run((tx) => fs.recordBeatResult(tx, scope, beat!.id, { status: "missing", manuscriptVersionId: e1.currentVersionId!, episodeId: e1.id }, t.owner));
    await t.platform.uow.run((tx) => fs.changeDue(tx, scope, setup.id, { dueKind: "episode", dueEpisodeNo: 2, reason: "앞당김" }, t.owner));
    const beatRow = async () => (await t.testDb.db.select({ s: setupBeats.status, v: setupBeats.manuscriptVersionId }).from(setupBeats).where(and(eq(setupBeats.novelId, novelId), eq(setupBeats.id, beat!.id))))[0]!;
    expect(await beatRow()).toEqual({ s: "cancelled", v: e1.currentVersionId });
    const versionIds = (await h.ms().listVersions(scope, e1.id)).map((v) => v.id);
    const mentionIds = (await Promise.all(versionIds.map((v) => onto().listMentions(scope, { manuscriptVersionId: v })))).flat().map((m) => m.id);
    expect(mentionIds).toContain(m1);
    expect((await h.ms().listScenes(scope, e1.id, { includeRetired: true })).length).toBeGreaterThan(0);
    const p = await preview(1);
    expect(p.body).toMatchObject({ issueCount: 1, mentionCount: mentionIds.length, versionCount: versionIds.length });

    const r = await del(1, { reason: "처음부터 다시" }); // holdRewrite omitted → paused by default
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("planned");
    expect(r.body.pausedAt).not.toBeNull();
    expect(r.body.currentVersionId).toBeNull();
    expect(await h.ms().listVersions(scope, e1.id)).toEqual([]);
    expect(await h.ms().listScenes(scope, e1.id, { includeRetired: true })).toEqual([]);
    for (const x of own) expect((await factStatus(x.factId)).s).toBe("rejected");
    expect(await onto().listMentions(scope, { ids: mentionIds })).toEqual([]);
    expect(await t.modules.continuity.service.listIssues(scope, { episodeId: e1.id })).toEqual([]);
    expect(await beatRow()).toEqual({ s: "cancelled", v: null }); // released beat: status kept, text anchor gone
    // the other episode's fact keeps living with only its own evidence
    const shared = await factStatus(sharedFactId);
    expect(shared.s).toBe("candidate");
    expect(shared.m).toHaveLength(1);
    expect(shared.m).not.toContain(m1);
    const audits = await deleteAudits(e1.id);
    expect(audits).toHaveLength(2);
    expect(audits[0]!.details).toMatchObject({ holdRewrite: true, issues: 1, mentions: mentionIds.length, facts: { rejected: own.length, otherPruned: 1 } });
    expect((await preview(1)).body).toMatchObject({ versionCount: 0, mentionCount: 0, issueCount: 0, facts: { candidate: 0 } });
    // held: the scheduler leaves the planned episode alone
    const sched = await h.ms().schedule(scope);
    expect(sched.createdTasks.filter((x) => x.kind === "outline_episode" && x.targetId === e1.id)).toEqual([]);
    expect((await ep(1)).status).toBe("planned");
  }, 120_000);

  it("0026 regression: a link-held candidate fact (subject still unresolved) is retired without a constraint error", async () => {
    const timeline = await onto().getDefaultTimeline(scope);
    const factId = await t.platform.uow.run(async (tx) => {
      const { mentionIds: [m] } = await onto().writeMentions(
        tx,
        scope,
        [{ sourceKind: "user_input", storyPoint: 3001, timelineId: timeline.id, surface: "낯선 자", mentionKind: "named", candidates: [], confidence: 0.4, linkStatus: "ambiguous", linkerVersion: "test" }],
        t.owner,
      );
      const r = await onto().writeCandidateFacts(
        tx,
        scope,
        [{ factKind: "attribute", subjectEntityId: "", predicate: "gender", value: "남성", timelineId: timeline.id, storyRange: { from: 3001, to: null }, sourceKind: "manuscript", source: { refType: "manuscript_version", refId: "mnv_test" }, mentionIds: [m!], argMentions: { subject: m! } }],
        t.owner,
      );
      expect(r.rejected).toEqual([]);
      return r.written[0]!.factId;
    });
    const row = (await t.testDb.db.select().from(facts).where(and(eq(facts.novelId, novelId), eq(facts.id, factId))))[0]!;
    expect(row.subjectEntityId).toBeNull();
    expect(row.canonStatus).toBe("candidate");
    const changed = await t.platform.uow.run((tx) => onto().retireFacts(tx, scope, [{ factId }], t.owner, { changeReason: "episode_deleted", reason: "테스트" }));
    expect(changed).toEqual([factId]);
    expect((await factStatus(factId)).s).toBe("rejected");
  });
});
