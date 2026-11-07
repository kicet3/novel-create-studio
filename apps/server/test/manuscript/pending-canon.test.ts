/**
 * 설계 추가(미확정 사실 선행 집필): drafts written ahead while earlier episodes wait for the author's approval.
 * Episode 1 (awaiting approval) establishes "한결 = 여성" as a candidate fact; episode 2's outline / draft / continuity
 * check see it as a provisional fact of 1화; conflicting / held candidates stay out; after approval it is canon (not
 * repeated as pending); an edit of episode 1 that changes the fact re-checks episode 2 (and notes it when 2 waits).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fitSections } from "../../src/modules/agents/domain/context-budget.js";
import { adjustSeverity } from "../../src/modules/continuity/domain/rules.js";
import { CONTINUITY_KEEP_SECTIONS } from "../../src/modules/manuscript/application/writing.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { SCENE_1, SCENE_2, scriptPipeline } from "../support/pipeline-script.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { runHandle, seedTaskRun } from "../llm/support.js";
import { pipelineHelpers } from "../revision/harness.js";

const S_FEMALE = "한결은 키가 큰 젊은 여인이었다.";
const S_MALE = "한결은 키가 큰 젊은 사내였다.";
const RULES = [
  { sentence: S_FEMALE, predicate: "gender", value: "여성", kind: "attribute" },
  { sentence: S_MALE, predicate: "gender", value: "남성", kind: "attribute" },
];
const PENDING_TITLE = "## 미확정 사실 (앞 화 승인 대기 — 확정 설정이 우선)";

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

describe("pending canon (pure)", () => {
  it("budget: pending_canon goes after glossary / story so far, before canon_1hop; recent_text + prev_handoff stay", () => {
    const items = [
      { section: "instruction" as const, tokenEstimate: 100 },
      { section: "prev_handoff" as const, tokenEstimate: 120 },
      { section: "canon_1hop" as const, tokenEstimate: 200 },
      { section: "pending_canon" as const, tokenEstimate: 200 },
      { section: "story_so_far" as const, tokenEstimate: 300 },
      { section: "glossary" as const, tokenEstimate: 300 },
      { section: "recent_text" as const, tokenEstimate: 900 },
    ];
    const mid = fitSections(items, 50, 1600, CONTINUITY_KEEP_SECTIONS);
    expect(mid.ok && mid.dropped.sort()).toEqual(["glossary", "story_so_far"]);
    const tight = fitSections(items, 50, 1400, CONTINUITY_KEEP_SECTIONS);
    expect(tight.ok && tight.dropped.sort()).toEqual(["glossary", "pending_canon", "story_so_far"]);
    const tighter = fitSections(items, 50, 1200, CONTINUITY_KEEP_SECTIONS);
    expect(tighter.ok && tighter.kept.map((k) => k.section)).toEqual(["instruction", "prev_handoff", "recent_text"]);
  });

  it("a contradiction with a provisional fact of an earlier episode is reported at most medium", () => {
    expect(adjustSeverity("appearance", "high", ["pending_prior"])).toBe("medium");
    expect(adjustSeverity("appearance", "high", ["candidate", "pending_prior"])).toBe("medium");
    expect(adjustSeverity("appearance", "high", ["approved", "pending_prior"])).toBe("high");
    expect(adjustSeverity("appearance", "high", ["candidate"])).toBe("low");
  });
});

let t: TestCore;
let h: ReturnType<typeof pipelineHelpers>;
let scope: { novelId: string };

describe("pending canon on the writing pipeline", () => {
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { when: { schemaHas: ["mentions", "facts"] }, times: Infinity, json: extraction },
      { when: { text: true, system: "문장 교정자(line_editor)" }, times: Infinity, text: polishEcho },
      // episode 1 establishes the provisional fact; later episodes are the plain scripted text
      { when: { text: true, system: "아웃라인의 씬을 순서대로 본문으로 씁니다", prompt: '"episode":{"no":1' }, times: Infinity, text: `${SCENE_1}\n\n${S_FEMALE}\n\n* * *\n\n${SCENE_2}` },
      // no setups: episode 2 reaches approval without a planted beat
      { when: { schemaHas: ["new_setups"] }, times: Infinity, json: { new_setups: [], existing_setup_beats: [], rationale: "이번 아크에는 새 떡밥이 없습니다." } },
    );
    scriptPipeline(t.claude);
    h = pipelineHelpers(t);
    scope = (await h.novelWithEpisodeAwaiting({ title: "미리 쓰기", sequential: false })).scope;
    await h.drain(scope, async () => (await h.ms().getEpisodeByNo(scope, 2)).status === "awaiting_approval", 150);
  }, 300_000);
  afterAll(() => t.close());

  const ep = (no: number) => h.ms().getEpisodeByNo(scope, no);
  const isEp2 = (p: string) => p.includes('"episode":{"no":2');
  const female = async () => (await t.modules.ontology.service.listEpisodeFacts(scope, (await ep(1)).id)).find((f) => f.predicate === "gender" && f.value === "여성");

  it("episode 2's outline and draft carry episode 1's candidate fact while 1 waits for approval", async () => {
    expect((await ep(1)).status).toBe("awaiting_approval");
    const f = (await female())!;
    expect(f.canonStatus).toBe("candidate");
    const outline = t.claude.requests.find((r) => r.schema && "outline" in ((r.schema.properties ?? {}) as object) && isEp2(r.prompt))!;
    const draft = t.claude.requests.find((r) => r.system.includes("아웃라인의 씬을 순서대로 본문으로 씁니다") && isEp2(r.prompt))!;
    for (const r of [outline, draft]) {
      expect(r.prompt).toContain(PENDING_TITLE);
      const section = r.prompt.slice(r.prompt.indexOf(PENDING_TITLE)).split("\n## ")[0]!;
      expect(section).toContain("성별: 여성");
      expect(section).toContain("(1화, 미확정)");
      expect(section).toContain("확정 설정(제약·캐논 사실·아웃라인)과 어긋나지 않는 한");
      // not canon yet: the confirmed-facts section does not carry it
      const canon = r.prompt.includes("## 캐논 사실") ? r.prompt.slice(r.prompt.indexOf("## 캐논 사실")).split("\n## ")[0]! : "";
      expect(canon).not.toContain("여성");
      // recent_text / prev_handoff are still there
      expect(r.prompt).toContain("## 직전 내용");
      // shown once: the entity card does not repeat it as a bare "[미확정]" line
      expect(r.prompt.match(/성별: 여성/g)).toHaveLength(1);
    }
    expect(outline.system).toContain("'미확정 사실 (앞 화 승인 대기)'은 아직 승인 전인 앞 화에서 나온 설정입니다");
    expect(draft.system).toContain("아웃라인과 어긋나지 않는 한 그 설정과 일관되게 씁니다");
    // the snapshot of episode 2's draft run records the fact version it read
    const drafts = await t.modules.orchestration.service.listTasks(scope, { kinds: ["draft_episode"], episodeId: (await ep(2)).id });
    const runs = await t.modules.orchestration.service.listRuns(scope, drafts[0]!.id);
    const snap = await t.modules.agents.service.getContextSnapshot(scope, runs.find((r) => r.contextSnapshotId)!.contextSnapshotId!);
    expect(snap.factVersionIds).toContain(f.factVersionId);
    // the continuity check of episode 2 sees it as provisional
    const check = t.claude.requests.find((r) => r.prompt.includes("[EPISODE] no=2"))!;
    expect(check.prompt).toMatch(/F\d+: .*성별: 여성.* \(1화, 미확정 — 앞 화 승인 대기\)/);
    expect(check.system).toContain('"앞 화 승인 대기"로 표시된 사실은 아직 승인 전인 앞 화의 미확정 설정입니다');
  });

  it("conflicting / held candidates are left out; approved episodes contribute nothing", async () => {
    const f = (await female())!;
    const list = () => h.ms().listPendingPriorFacts(scope, 2);
    expect((await list()).map((x) => [x.factId, x.sourceEpisodeNo])).toEqual([[f.factId, 1]]);
    expect(await h.ms().listPendingPriorFacts(scope, 1)).toEqual([]);
    const patch = (json: string) => t.testDb.exec(`UPDATE fact_versions SET content = content || '${json}'::jsonb WHERE fact_id = '${f.factId}' AND superseded_at IS NULL`);
    const e2 = await ep(2);
    const body = async (sections: Parameters<typeof t.modules.agents.service.defaultContextSpec>[1]["sections"]) => {
      const { taskId, runId } = await seedTaskRun(t, scope.novelId);
      const spec = t.modules.agents.service.defaultContextSpec("writer", {
        anchor: { storyPoint: 2000, timelineId: e2.primaryTimelineId },
        episodeId: e2.id,
        sections,
        seeds: { entityIds: [f.subjectEntityId], setupIds: [], answerIds: [], mentionIds: [] },
      });
      const pack = await t.modules.agents.service.contextBuilder.build(runHandle(scope.novelId, taskId, runId, "writer"), spec);
      // the seeded run must not hold the novel's dispatcher slot for the next tests
      await t.testDb.exec(`UPDATE runs SET status = 'succeeded', stop_reason = 'completed', finished_at = now() WHERE id = '${runId}'`);
      await t.testDb.exec(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = '${taskId}'`);
      return pack.messages.map((m) => m.content).join("\n");
    };
    // without pending_canon the card still carries it; with it, once (in the labelled section)
    expect(await body(["instruction", "entity_cards"])).toMatch(/\[미확정\] .*성별: 여성/);
    const both = await body(["instruction", "entity_cards", "candidates", "pending_canon"]);
    expect(both.match(/성별: 여성/g)).toHaveLength(2); // pending_canon + candidates (bare card line removed)
    expect(both).toContain("성별: 여성 (1001~) (1화, 미확정)");
    await patch(`{"conflictWith":"fct_CANON"}`);
    expect(await list()).toEqual([]);
    // a candidate in conflict with canon reaches no section of the prompt (cards / candidates / pending)
    expect(await body(["instruction", "entity_cards", "candidates", "pending_canon"])).not.toContain("여성");
    await patch(`{"conflictWith":null,"reconcilePending":true}`);
    expect(await list()).toEqual([]);
    expect(await body(["instruction", "entity_cards", "candidates", "pending_canon"])).not.toContain("여성");
    await patch(`{"reconcilePending":false}`);
    expect(await list()).toHaveLength(1);
    // relevance: other entities only → nothing
    expect(await h.ms().listPendingPriorFacts(scope, 2, { entityIds: ["ent_01J0000000000000000000000Z"] })).toEqual([]);
  });

  it("an edit of episode 1 that changes the fact re-checks episode 2 and notes it (2 waits for approval)", async () => {
    const before = (await female())!;
    const e1 = await ep(1);
    const v = await h.ms().getVersion(scope, e1.currentVersionId!);
    await h.ms().saveHumanEdit(scope, 1, { content: v.content.replace(S_FEMALE, S_MALE), baseVersionId: v.id }, t.owner);
    await h.drain(scope, async () => (await ep(1)).status === "awaiting_approval", 120);
    expect(await female()).toBeUndefined();
    const e2 = await ep(2);
    const checks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["check_continuity"], episodeId: e2.id, includeCancelled: true, limit: 50 });
    const recheck = checks.find((c) => String((c.input as { cycle_key?: string }).cycle_key ?? "").includes(`prior:${e1.id}`));
    expect(recheck).toBeTruthy();
    expect((recheck!.input as { manuscript_version_id: string; fact_ids: string[] }).manuscript_version_id).toBe(e2.currentVersionId);
    expect((recheck!.input as { fact_ids: string[] }).fact_ids).toContain(before.factId);
    const issues = await t.modules.continuity.service.listIssues(scope, { episodeId: e2.id, kinds: ["pending_canon_changed"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "medium", status: "open", manuscriptVersionId: e2.currentVersionId });
    expect(issues[0]!.message).toContain("앞 화(1화)의 미확정 설정이 바뀌었습니다");
    // the pending fact now is the new one
    const now = await h.ms().listPendingPriorFacts(scope, 2);
    expect(now.map((x) => x.value)).toEqual(["남성"]);
    // the recheck runs on episode 2's current text
    await h.drain(scope, async () => (await t.modules.orchestration.service.getTask(scope, recheck!.id)).status === "done", 40);
    const rerun = t.claude.requests.filter((r) => r.prompt.includes("[EPISODE] no=2")).at(-1)!;
    expect(rerun.prompt).toMatch(/성별: 남성.* \(1화, 미확정 — 앞 화 승인 대기\)/);
    // an unrelated edit of episode 1 (the changed fact stays as it is now) neither re-checks nor notes episode 2 again
    const v2 = await h.ms().getVersion(scope, (await ep(1)).currentVersionId!);
    await h.ms().saveHumanEdit(scope, 1, { content: `${v2.content}\n\n바람이 잦아들었다.`, baseVersionId: v2.id }, t.owner);
    await h.drain(scope, async () => (await ep(1)).status === "awaiting_approval", 120);
    expect((await ep(1)).currentVersionId).not.toBe(v2.id);
    const priorChecks = async () =>
      (await t.modules.orchestration.service.listTasks(scope, { kinds: ["check_continuity"], episodeId: e2.id, includeCancelled: true, limit: 50 })).filter((c) =>
        String((c.input as { cycle_key?: string }).cycle_key ?? "").includes(`prior:${e1.id}`),
      );
    expect(await priorChecks()).toHaveLength(1);
    expect(await t.modules.continuity.service.listIssues(scope, { episodeId: e2.id, kinds: ["pending_canon_changed"] })).toHaveLength(1);
  }, 120_000);

  it("after episode 1's approval the fact is canon and no longer listed as pending (no duplicate)", async () => {
    const e1 = await ep(1);
    await h.decide(scope, "episode", e1.id, "approved");
    expect(await h.ms().listPendingPriorFacts(scope, 2)).toEqual([]);
    const e2 = await ep(2);
    const male = (await t.modules.ontology.service.listEpisodeFacts(scope, e1.id)).find((f) => f.predicate === "gender")!;
    expect(male.canonStatus).toBe("approved");
    const { taskId, runId } = await seedTaskRun(t, scope.novelId);
    const spec = t.modules.agents.service.defaultContextSpec("writer", {
      anchor: { storyPoint: 2000, timelineId: e2.primaryTimelineId },
      episodeId: e2.id,
      sections: ["instruction", "canon_1hop", "pending_canon"],
      seeds: { entityIds: [male.subjectEntityId], setupIds: [], answerIds: [], mentionIds: [] },
    });
    const pack = await t.modules.agents.service.contextBuilder.build(runHandle(scope.novelId, taskId, runId, "writer"), spec);
    const body = pack.messages.map((m) => m.content).join("\n");
    expect(body).toContain("## 캐논 사실");
    expect(body).not.toContain(PENDING_TITLE);
    expect(body.match(/성별: 남성/g)).toHaveLength(1);
  });
});
