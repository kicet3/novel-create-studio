/**
 * End-to-end through HTTP with the real modules and the real Claude adapter against the scripted Messages API
 * mock (every model response is stated in this file or in support/pipeline-script.ts):
 * N1 novel → concept brief (direct input) → approval (N2) → goal (N3) → series bible → arc plan →
 * episode 1 pipeline (outline … polish, extraction, checks) → episode approval (E9) → publish → export.
 * Approvals are answered through the inbox API exactly like the web does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { SCENE_1, scriptPipeline } from "../support/pipeline-script.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  // concept: the brief check finds nothing; a conversation turn only phrases the code-chosen question
  t.claude.reply(
    { times: Infinity, when: { schemaHas: ["llm_overlap_signals"] }, json: { llm_overlap_signals: [], safety_flags: [], notes: [] } },
    { times: Infinity, when: { schemaHas: ["reply_text", "slot_updates"] }, json: { reply_text: "좋아요. 장르부터 정해 볼까요?", slot_updates: [] } },
    // extraction of the scripted scene 1 ("한결은 …"): the protagonist's mention + one state fact
    {
      times: Infinity,
      when: { schemaHas: ["mentions", "facts"], prompt: SCENE_1.slice(0, 20) },
      json: {
        mentions: [{ local_key: "m1", scene_ord: 1, char_start: 0, char_end: 2, surface: "한결", mention_kind: "named", entity_type_hint: "character" }],
        facts: [{ local_key: "f1", fact_kind: "state", subject_mention_key: "m1", predicate: "life_status", value: "alive", scope_hint: "from_here" }],
      },
    },
  );
  scriptPipeline(t.claude);
});
afterAll(() => t.close());

const REQUIRED: Array<[string, unknown]> = [
  ["category.genre_label", "현판"],
  ["age_rating", "age_15"],
  ["protagonist.starting_condition", "회귀 전 S급 헌터에게 배신당해 죽은 F급 짐꾼"],
  ["protagonist.desire", "배신자에게 복수"],
  ["opposition", "S급 길드장과 그의 길드"],
  ["core_hook", "짐꾼만 볼 수 있는 던전의 균열"],
  ["world_rules[item_key=power_rank]", "F~S급"],
  ["ending_direction", "복수를 끝내고 새 길드를 세운다"],
];

describe("MVP-α end to end (scripted Claude responses)", () => {
  it("concept → goal → bible → arc → episode 1 approved, published and exported", async () => {
    const created = await t.http("POST", "/api/novels", { title: "회귀 짐꾼", entryMode: "direct_input" });
    expect(created.status).toBe(201);
    const novelId = created.body.id as string;
    const base = `/api/novels/${novelId}`;
    const scope = { novelId };

    // ── concept (direct input form) ──
    let view = await t.http("GET", `${base}/concept/session`);
    expect(view.status).toBe(200);
    const sessionId = (view.body.session?.id ?? view.body.id) as string;
    for (const [path, value] of REQUIRED) {
      const r = await t.http("PATCH", `${base}/concept/sessions/${sessionId}/brief`, { path, value });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    view = await t.http("GET", `${base}/concept/session`);
    const brief = (view.body.session?.workingBrief ?? view.body.workingBrief) as { content: { logline_options?: string[] } };
    const logline = brief.content.logline_options?.[0] ?? "회귀한 짐꾼이 배신자에게 복수한다";
    expect((await t.http("PATCH", `${base}/concept/sessions/${sessionId}/brief`, { path: "logline", value: logline })).status).toBe(200);
    const sub = await t.http("POST", `${base}/concept/sessions/${sessionId}/submit`);
    expect(sub.status, JSON.stringify(sub.body)).toBe(202);

    const tasksDump = async () =>
      (await t.modules.orchestration.service.listTasks(scope, { includeCancelled: true, limit: 500 })).map((x) => `${x.kind}:${x.status}${x.blockReason ? `(${x.blockReason})` : ""}${x.latestRun?.errorMessage ? ` ! ${x.latestRun.errorMessage}` : ""}`);

    /** run tasks / scheduler and approve every pending approval through the inbox API until `done()` */
    const drive = async (done: () => Promise<boolean>, max = 120) => {
      for (let i = 0; i < max; i++) {
        if (await done()) return;
        await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${novelId}' AND status = 'ready'`);
        await t.testDb.exec(`UPDATE wake_requests SET not_before_at = NULL WHERE novel_id = '${novelId}' AND status = 'pending'`);
        const ran = await t.modules.orchestration.service.runOnce();
        const n = await t.modules.novel.service.getNovel(scope);
        if (n.status === "planning" || n.status === "serializing") await t.modules.manuscript.service.schedule(scope);
        const approvals = await t.http("GET", `${base}/approvals?status=pending`);
        expect(approvals.status).toBe(200);
        let answered = 0;
        for (const a of approvals.body.items as Array<{ questionId: string; approvalType: string }>) {
          const r = await t.http("POST", `${base}/questions/${a.questionId}/answers`, { approval: { decision: "approved" } });
          expect(r.status, `${a.approvalType}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
          answered++;
        }
        if (!ran && !answered) {
          // deferred gate / scheduler sweep may need one more pass
          if (!(await t.modules.orchestration.service.runOnce()) && i > 3 && !(await done())) {
            // keep looping a few times: wakes may still be inside their coalesce window
          }
        }
      }
      if (!(await done())) throw new Error(`stalled:\n${(await tasksDump()).join("\n")}`);
    };

    // brief approval (N2) → onboarding
    await drive(async () => (await t.modules.novel.service.getNovel(scope)).status === "onboarding", 20);

    // goal (N3) → planning → plan_series_bible
    const defaults = await t.http("GET", `${base}/concept/goal-defaults`);
    expect(defaults.status).toBe(200);
    const goalBody = {
      totalEpisodesMin: 10,
      totalEpisodesMax: 12,
      cadenceEpisodesPerWeek: 5,
      reserveTargetEpisodes: 1,
      endingDirection: "복수를 끝내고 새 길드를 세운다",
      notes: null,
    };

    // 캐릭터 설정 단계 (설계 추가): the goal waits for a confirmed cast; N2 seeded the brief's protagonist
    const blocked = await t.http("PUT", `${base}/goal`, goalBody);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("cast_not_confirmed");
    const castRes = await t.http("GET", `${base}/cast`);
    const castView = dto.castViewSchema.parse(castRes.body);
    expect(castView).toMatchObject({ confirmed: false, stepRequired: true, counts: { protagonist: 1 } });
    const hero = castView.items.find((c) => c.role === "protagonist")!;
    expect(hero.desire).toBe("배신자에게 복수");
    expect(hero.fieldOrigins).toMatchObject({ desire: "user", name: "agent" });
    expect((await t.http("POST", `${base}/cast/confirm`)).body.error.code).toBe("cast_invalid"); // name still 이름 미정
    expect((await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { name: "한결" })).status).toBe(200);
    expect((await t.http("POST", `${base}/cast/characters`, { role: "sub_protagonist", name: "서린", personality: "냉정한 기록관" })).status).toBe(201);
    const confirmed = await t.http("POST", `${base}/cast/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ confirmed: true, stepRequired: false, counts: { protagonist: 1, subProtagonist: 1 } });

    const goal = await t.http("PUT", `${base}/goal`, goalBody);
    expect(goal.status, JSON.stringify(goal.body)).toBe(200);

    // bible → arc plan → episode 1 … → approved
    const ep1 = async () => {
      const r = await t.http("GET", `${base}/episodes/1`);
      return r.status === 200 ? (r.body.episode ?? r.body) : null;
    };
    await drive(async () => ["approved", "published"].includes((await ep1())?.status));
    expect((await t.http("GET", `${base}/bibles/approved`)).body).toMatchObject({ status: "approved" });

    // publish (E13) + export
    const pub = await t.http("POST", `${base}/episodes/1/publish`);
    expect(pub.status, JSON.stringify(pub.body)).toBeLessThan(300);
    expect((await ep1()).status).toBe("published");
    const exp = await t.http("POST", `${base}/exports`, { scopeKind: "novel", format: "txt", versionSelection: "default" });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    const dl = await t.http("GET", `${base}/exports/${exp.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(String(dl.body)).toContain("1화");

    // the chain really ran: provider calls journaled, scenes split, home aggregates
    const tasks = await tasksDump();
    for (const kind of ["check_concept_brief", "plan_series_bible", "plan_arc", "outline_episode", "draft_episode", "split_scenes", "polish_episode"]) {
      expect(tasks.some((x) => x.startsWith(`${kind}:done`)), `${kind} done\n${tasks.join("\n")}`).toBe(true);
    }
    // the writer saw the cast (entity_cards seeds) → the prose names bible characters → linked mentions + candidate facts
    const cast = (await t.http("GET", `${base}/entities?type=character`)).body.items as Array<{ preferredName: string; appearanceEpisodeCount: number }>;
    const draftPrompt = t.claude.requests.filter((r) => r.schema === null && r.system.includes("아웃라인의 씬을 순서대로 본문으로")).map((r) => `${r.system}\n${r.prompt}`).at(-1) ?? "";
    expect(draftPrompt.length).toBeGreaterThan(0);
    for (const c of cast) expect(draftPrompt, `entity card of ${c.preferredName} in the draft prompt`).toMatch(new RegExp(`E\\d+ ${c.preferredName} \\(인물\\)`));
    expect(cast.some((c) => c.appearanceEpisodeCount > 0), JSON.stringify(cast)).toBe(true);
    // the confirmed cast is an input of the bible and the writer (context section "cast"); the bible's 한결/서린
    // reuse the cast entities (no duplicate characters)
    const biblePrompt = t.claude.requests.find((r) => r.system.includes("연재 기획서를 JSON으로"))!;
    expect(biblePrompt.prompt).toContain("캐릭터 설정 (확정)");
    expect(biblePrompt.prompt).toMatch(/\[주인공\] 한결/);
    expect(draftPrompt).toMatch(/\[서브 주인공\] 서린/);
    expect(cast.filter((c) => c.preferredName === "한결")).toHaveLength(1);
    const msFacts = await t.testDb.query<{ c: number }>(`SELECT count(*)::int AS c FROM facts WHERE novel_id = '${novelId}' AND source_kind = 'manuscript'`);
    expect(msFacts[0]!.c).toBeGreaterThan(0);
    expect(t.claude.unmatched.map((r) => r.system.slice(0, 80))).toEqual([]);
    const home = await t.http("GET", `${base}/home`);
    expect(home.status).toBe(200);
    const runs = (await t.modules.orchestration.service.listTasks(scope, { kinds: ["draft_episode"] }))[0]!;
    const calls = await t.http("GET", `${base}/runs/${runs.latestRun!.id}/provider-calls`);
    expect(calls.status).toBe(200);
    expect((calls.body.items as unknown[]).length).toBeGreaterThan(0);

    // ── responses the web reads conform to the shared DTOs (web ↔ server contract) ──
    const items = <T extends z.ZodType>(s: T) => z.object({ items: z.array(s) });
    const ep = (await t.http("GET", `${base}/episodes/1`)).body;
    const versionId = (ep.episode ?? ep).currentVersionId as string;
    const entityList = (await t.http("GET", `${base}/entities`)).body;
    const checks: Array<[string, z.ZodType]> = [
      [`${base}`, dto.novelDtoSchema],
      [`${base}/goal`, dto.goalDtoSchema],
      [`${base}/cast`, dto.castViewSchema],
      [`${base}/arcs`, items(dto.arcDtoSchema)],
      [`${base}/bibles/approved`, dto.seriesBibleDtoSchema],
      [`${base}/episodes`, items(dto.episodeDtoSchema)],
      [`${base}/episodes/1`, dto.episodeDetailDtoSchema],
      [`${base}/episodes/1/versions`, items(dto.manuscriptVersionSummaryDtoSchema)],
      [`${base}/episodes/1/rejections`, items(dto.episodeRejectionDtoSchema)],
      [`${base}/episodes/1/scenes`, items(dto.sceneDtoSchema)],
      [`${base}/versions/${versionId}?with=spans,scenes,issues,beats`, dto.manuscriptVersionDetailDtoSchema],
      [`${base}/tasks`, dto.taskListSchema],
      [`${base}/budget`, z.object({ items: z.array(dto.budgetStatusViewSchema) }).passthrough()],
      [`${base}/budget/cost-events`, dto.costEventListSchema],
      [`${base}/model-bindings`, dto.roleModelBindingListSchema],
      [`${base}/questions`, items(dto.hitlQuestionDtoSchema)],
      [`${base}/approvals`, items(dto.hitlApprovalDtoSchema)],
      [`${base}/inbox/summary`, dto.hitlInboxSummarySchema],
      [`${base}/channels`, items(dto.messagingChannelDtoSchema)],
      [`${base}/entities`, items(dto.entityListItemDtoSchema)],
      [`${base}/timelines`, items(dto.timelineDtoSchema)],
      [`${base}/schema`, dto.ontologySchemaDtoSchema],
      [`${base}/identity-decisions`, items(dto.identityDecisionDtoSchema)],
      [`${base}/continuity-issues`, dto.continuityIssueListDtoSchema],
      [`${base}/setups`, dto.setupListDtoSchema],
      [`${base}/setups/report`, dto.setupReportDtoSchema],
      [`${base}/activity`, dto.activityPageSchema],
      [`${base}/exports`, items(dto.exportJobDtoSchema)],
      [`${base}/concept/session`, dto.conceptSessionViewDtoSchema],
      [`${base}/concept/briefs`, items(dto.conceptBriefDtoSchema)],
      [`${base}/concept/goal-defaults`, dto.conceptGoalDefaultsDtoSchema],
      [`${base}/health-checks`, z.unknown()],
      [`${base}/home`, z.unknown()],
      ["/api/llm/provider-profiles", dto.llmProviderProfileListSchema],
      ["/api/agents/roles", dto.agentRoleListSchema],
      ["/api/messaging/bots", items(dto.messagingBotDtoSchema)],
      ["/api/system/info", dto.systemInfoDtoSchema],
      ["/api/system/backups", z.object({ items: z.array(dto.backupRecordDtoSchema), schedule: dto.backupScheduleDtoSchema })],
      ["/api/health", dto.healthResponseSchema],
    ];
    const firstEntity = (entityList.items as Array<{ entity?: { id: string }; id?: string }>)[0];
    if (firstEntity) checks.push([`${base}/entities/${firstEntity.entity?.id ?? firstEntity.id}`, dto.entityDetailDtoSchema]);
    const qs = (await t.http("GET", `${base}/questions`)).body.items as Array<{ id: string }>;
    if (qs[0]) checks.push([`${base}/questions/${qs[0].id}`, dto.hitlQuestionViewSchema]);
    const problems: string[] = [];
    for (const [url, schema] of checks) {
      const r = await t.http("GET", url);
      if (r.status !== 200) {
        problems.push(`${url} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        continue;
      }
      const parsed = schema.safeParse(r.body);
      if (!parsed.success) problems.push(`${url}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("conversation mode: a web message gets an agent reply through concept_turn (scripted model turn)", async () => {
    const created = await t.http("POST", "/api/novels", { title: "대화 작품" });
    const base = `/api/novels/${created.body.id}`;
    const view = await t.http("GET", `${base}/concept/session`);
    const sessionId = (view.body.session?.id ?? view.body.id) as string;
    const before = await t.http("GET", `${base}/concept/sessions/${sessionId}/messages`);
    const sent = await t.http("POST", `${base}/concept/sessions/${sessionId}/messages`, { body: "회귀한 짐꾼이 S급 배신자에게 복수" });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${created.body.id}'`);
    expect(await t.modules.orchestration.service.runOnce()).toBeGreaterThan(0);
    const after = await t.http("GET", `${base}/concept/sessions/${sessionId}/messages`);
    const items = (after.body.items ?? after.body) as Array<{ authorKind: string }>;
    const prevCount = ((before.body.items ?? before.body) as unknown[]).length;
    expect(items.length).toBeGreaterThanOrEqual(prevCount + 2);
    expect(items.at(-1)!.authorKind).toBe("agent");
  });
});
