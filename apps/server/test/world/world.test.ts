/**
 * world (설계 추가: 세계관 온톨로지 생성) over HTTP with the test core and scripted Claude:
 * N2 queues build_world_ontology (coalesced per novel), candidates land in the ontology with provenance (task, run,
 * web sources picked from the call's citations only), review (approve / held relation / approve all / edit / reject),
 * "다시 생성" keeps approved + edited items and supersedes untouched old candidates, context for cast / structure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { conceptBriefs, conceptSessions } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { SAMPLE_WORLD, isWorldRequest } from "../support/world.js";
import { normalizeProposal, pickSources, worldProposalSchema } from "../../src/modules/world/domain/proposal.js";
import { lookupPredicate } from "../../src/modules/ontology/index.js";
import { actors } from "../../src/platform/index.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
});
afterAll(() => t.close());

const BRIEF_MD = "# 회귀 짐꾼\n- 장르: 현대 판타지(헌터물)\n- 세계 규칙: 헌터 등급은 F~S급\n- 대립: S급 길드장과 그의 길드";

async function approvedNovel(title = "회귀 짐꾼") {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title }, t.owner);
  const scope = { novelId: novel.id };
  const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novel.id));
  const briefId = t.platform.ids.next("cbf");
  await t.testDb.db.insert(conceptBriefs).values({
    id: briefId,
    novelId: novel.id,
    sessionId: session!.id,
    versionNo: 1,
    authorActorType: "user",
    authorActorId: t.ownerId,
    entryMode: "conversation",
    questionSetVersion: "common@1",
    content: { logline: "회귀한 짐꾼이 배신자에게 복수한다", protagonist: { name: "한결", desire: "복수" } },
    contentMd: BRIEF_MD,
  } as typeof conceptBriefs.$inferInsert);
  await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "현대 판타지", ageRating: "age_15", category: {} }, t.owner));
  return { scope, base: `/api/novels/${novel.id}`, mine: (r: { system: string; prompt: string }) => isWorldRequest(r) && r.prompt.includes(`제목: ${title}\n`) };
}

const view = async (base: string) => dto.worldOntologyViewSchema.parse((await t.http("GET", `${base}/world-ontology`)).body);
const items = (v: dto.WorldOntologyView) => v.groups.flatMap((g) => g.items);
const byName = (v: dto.WorldOntologyView, name: string) => items(v).find((i) => i.name === name)!;
/** run only this novel's world task (other novels in the core may have queued their own) */
async function runWorld(base: string) {
  for (let i = 0; i < 4; i++) {
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE kind = 'build_world_ontology' AND status = 'ready'`);
    await t.modules.orchestration.service.runOnce();
    const g = (await view(base)).generation;
    if (g.state === "done" || g.state === "failed") return g;
  }
  return (await view(base)).generation;
}

describe("world proposal domain", () => {
  it("normalizes kinds onto base@1, turns parents / event places / participants into relations, drops unknown predicates", () => {
    const n = normalizeProposal(worldProposalSchema.parse({ ...SAMPLE_WORLD, relations: [...SAMPLE_WORLD.relations, { subject_key: "f_sun", predicate: "loves", object_key: "f_assoc" }] }));
    expect(n.entities.map((e) => [e.kind, e.entityType, e.name])).toEqual([
      ["faction", "organization", "태양 길드"],
      ["faction", "organization", "헌터 협회"],
      ["place", "place", "서울"],
      ["place", "place", "균열 던전"],
      ["system", "ability", "헌터 등급"],
      ["object", "item", "균열 핵"],
      ["history", "event", "첫 균열"],
      ["constraint", "rule", "등급 체계"],
    ]);
    expect(n.entities.find((e) => e.name === "헌터 등급")!.attributes.map((a) => a.predicate)).toEqual(["ability_cost", "ability_limit"]);
    expect(n.entities.find((e) => e.kind === "constraint")).toMatchObject({ fromBrief: true, attributes: [{ predicate: "rule_statement" }] });
    expect(n.relations.map((r) => `${r.subjectKey} ${r.predicate} ${r.objectKey}`)).toEqual([
      "p_rift located_in p_seoul",
      "h_first occurred_at p_seoul",
      "f_assoc participated_in h_first",
      "f_sun headquartered_in p_seoul",
      "f_sun enemy_of f_assoc",
    ]);
    // per-item sources: only URLs the call reported (an invented link never shows up)
    const cites = [{ url: "https://ko.wikipedia.org/wiki/헌터", title: "헌터", retrievedAt: "t" }];
    expect(pickSources(["https://ko.wikipedia.org/wiki/헌터", "https://invented.example/x", "javascript:alert(1)"], cites)).toEqual(cites);
  });
});

describe("world ontology step", () => {
  it("N2 queues one build_world_ontology per novel; generation before the brief is approved is refused", async () => {
    const draft = await t.modules.novel.service.createNovel({ title: "아직 컨셉" }, t.owner);
    const early = await t.http("POST", `/api/novels/${draft.id}/world-ontology/generate`, {});
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("concept_not_approved");
    expect((await view(`/api/novels/${draft.id}`)).generation.state).toBe("waiting_brief");

    const { scope, base } = await approvedNovel("코얼레싱");
    const tasks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_world_ontology"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ agentRole: "world_keeper", targetType: "novel", goalId: null });
    // a click while it is queued reuses the task
    const again = await t.http("POST", `${base}/world-ontology/generate`, {});
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ taskId: tasks[0]!.id, created: false });
    // …but an added request would be dropped by the reused task: refused, not lost silently (review fix)
    const busy = await t.http("POST", `${base}/world-ontology/generate`, { instructions: "무협 느낌은 빼 주세요" });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("world_generation_busy");
    expect(await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_world_ontology"] })).toHaveLength(1);
    expect((await view(base)).generation).toMatchObject({ state: "queued", taskId: tasks[0]!.id });
  });

  it("writes candidates with provenance, groups them by kind, and reviews them (held relation, approve, approve all, edit, reject)", async () => {
    const { scope, base, mine } = await approvedNovel();
    const url = "https://namu.example/wiki/헌터_등급";
    const world = structuredClone(SAMPLE_WORLD);
    world.systems[0]!.source_urls = [url, "https://invented.example/rank"];
    t.claude.reply({ when: (r) => mine(r) && r.prompt.includes(BRIEF_MD), json: world, webSearch: { query: "헌터물 등급 체계 관습", results: [{ url, title: "헌터 등급 - 나무" }] } });
    const g = await runWorld(base);
    expect(g.state, JSON.stringify(g)).toBe("done");
    expect(g.webSearch).toMatchObject({ status: "used", requests: 1 });
    expect(g.sources.map((s) => s.url)).toContain(url);

    // the request: brief + rules, the brief text itself is data (not a search query) — search was offered
    const req = t.claude.requests.filter(mine).at(-1)!;
    expect(req.system).toContain("세계관 온톨로지 작성 규칙");
    expect(req.system).toContain("인터넷 검색");
    expect(req.body.tools).toBeTruthy();

    let v = await view(base);
    expect(v.groups.map((x) => x.kind)).toEqual(["faction", "place", "system", "object", "history", "relation", "constraint"]);
    expect(v.counts).toMatchObject({ approved: 0, rejected: 0 });
    const rank = byName(v, "헌터 등급");
    expect(rank).toMatchObject({ status: "pending", origin: "agent", entityType: "ability", entityStatus: "candidate", statement: "등급을 올리려면 균열 핵을 흡수해야 한다.", details: ["한 번 정해진 각성 계열은 바뀌지 않는다."] });
    expect(rank.sources.map((s) => s.url)).toEqual([url]); // the invented link is dropped
    expect(byName(v, "등급 체계")).toMatchObject({ fromBrief: true, statement: "헌터 등급은 F급부터 S급까지 여섯 단계뿐이다." });
    // candidates, not canon: system_derived facts from the task, the run on the fact version
    const facts = await t.testDb.query<{ canon_status: string; source_kind: string; source_ref_type: string; source_ref_id: string; run_id: string | null }>(
      `SELECT f.canon_status, f.source_kind, f.source_ref_type, f.source_ref_id, v.run_id FROM facts f JOIN fact_versions v ON v.fact_id = f.id WHERE f.novel_id = '${scope.novelId}'`,
    );
    expect(facts.length).toBeGreaterThan(5);
    expect(new Set(facts.map((f) => `${f.canon_status}|${f.source_kind}|${f.source_ref_type}`))).toEqual(new Set(["candidate|system_derived|task"]));
    expect(facts.every((f) => f.source_ref_id === rank.taskId && f.run_id === rank.runId)).toBe(true);

    // a relation whose endpoints are still candidates stays pending with a reason
    const hq = items(v).find((i) => i.relation?.predicate === "headquartered_in")!;
    const held = await t.http("POST", `${base}/world-ontology/items/${hq.id}/approve`);
    expect(held.status).toBe(200);
    expect(held.body.approved).toBe(0);
    expect(held.body.held[0].reason).toContain("먼저 승인하세요");

    // edit a pending item (statement + summary) → user-edited, fact value revised
    const edit = await t.http("PATCH", `${base}/world-ontology/items/${rank.id}`, { statement: "등급은 균열 핵 흡수로만 오른다.", summary: "F~S급 각성자 등급." });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body).toMatchObject({ userEdited: true, statement: "등급은 균열 핵 흡수로만 오른다.", summary: "F~S급 각성자 등급." });

    // reject an entity → its pending relations go with it, the entity is retired
    const assoc = byName(v, "헌터 협회");
    const rej = await t.http("POST", `${base}/world-ontology/items/${assoc.id}/reject`, { reason: "협회는 없는 설정" });
    expect(rej.status).toBe(200);
    expect(rej.body.rejected).toBeGreaterThanOrEqual(3); // entity + enemy_of + participated_in
    v = await view(base);
    expect(byName(v, "헌터 협회")).toMatchObject({ status: "rejected", entityStatus: "retired" });
    expect(items(v).filter((i) => i.relation?.objectName === "헌터 협회" || i.relation?.subjectName === "헌터 협회").every((i) => i.status === "rejected")).toBe(true);

    // approve one entity, then everything else
    const one = await t.http("POST", `${base}/world-ontology/items/${byName(v, "서울").id}/approve`);
    expect(one.body).toMatchObject({ approved: 1, held: [] });
    const all = await t.http("POST", `${base}/world-ontology/approve-all`);
    expect(all.status).toBe(200);
    expect(all.body.held).toEqual([]);
    v = await view(base);
    expect(v.counts.pending).toBe(0);
    expect(byName(v, "태양 길드")).toMatchObject({ status: "approved", entityStatus: "active" });
    expect(items(v).find((i) => i.relation?.predicate === "headquartered_in")!.facts[0]!.canonStatus).toBe("approved");
    // closed items cannot be edited / re-rejected
    expect((await t.http("PATCH", `${base}/world-ontology/items/${byName(v, "서울").id}`, { summary: "x" })).status).toBe(409);

    // approved facts are canon in the ontology now
    const canon = await t.testDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE novel_id = '${scope.novelId}' AND canon_status = 'approved'`);
    expect(canon[0]!.n).toBeGreaterThan(5);

    // context: approved items as settings; the cast draft prompt gets the world section
    const ctx = await t.modules.world.service.renderWorldContext(scope);
    expect(ctx.text).toContain("태양 길드");
    expect(ctx.text).toContain("헌터 등급");
    expect(ctx.text).not.toContain("헌터 협회");
    expect(ctx.text).not.toContain("[미확정 후보");
    expect(ctx.factVersionIds.length).toBeGreaterThan(0);
  });

  it("다시 생성 keeps approved / edited items, refreshes untouched candidates, supersedes the ones not proposed again", async () => {
    const { scope, base, mine } = await approvedNovel("다시 생성");
    const first = structuredClone(SAMPLE_WORLD);
    t.claude.reply({ when: (r) => mine(r) && !r.prompt.includes("다시 정리"), json: first });
    expect((await runWorld(base)).state).toBe("done");
    let v = await view(base);
    // approve 서울 + 태양 길드, edit 균열 핵, leave the rest pending
    for (const name of ["서울", "태양 길드"]) expect((await t.http("POST", `${base}/world-ontology/items/${byName(v, name).id}/approve`)).body.approved).toBe(1);
    expect((await t.http("PATCH", `${base}/world-ontology/items/${byName(v, "균열 핵").id}`, { summary: "작가가 고친 요약" })).status).toBe(200);
    const oldRift = byName(v, "균열 던전");
    const oldEvent = byName(v, "첫 균열");

    const second = {
      ...structuredClone(SAMPLE_WORLD),
      factions: [{ key: "f_sun", name: "태양 길드", aliases: [], summary: "AI가 바꾸려는 요약", source_urls: [] }],
      places: [{ key: "p_rift", name: "균열 던전", aliases: [], summary: "새 요약: 짐꾼만 들어갈 수 있다.", parent_key: "", source_urls: [] }],
      objects: [{ key: "o_core", name: "균열 핵", aliases: [], summary: "AI가 바꾸려는 핵 요약", source_urls: [] }],
      history: [],
      relations: [{ subject_key: "f_sun", predicate: "headquartered_in", object_key: "p_rift", note: "", source_urls: [] }],
    };
    t.claude.reply({ when: (r) => mine(r) && r.prompt.includes("다시 정리"), json: second });
    const re = await t.http("POST", `${base}/world-ontology/generate`, { instructions: "다시 정리해 주세요" });
    expect(re.status).toBe(202);
    expect(re.body.created).toBe(true);
    expect((await runWorld(base)).state).toBe("done");
    // the second request listed the kept items as existing (X keys), not to be re-created
    const req = t.claude.requests.filter(mine).at(-1)!;
    expect(req.prompt).toMatch(/X\d+ \| 세력·조직 \| 태양 길드/);

    v = await view(base);
    expect(byName(v, "태양 길드")).toMatchObject({ status: "approved", summary: SAMPLE_WORLD.factions[0]!.summary });
    expect(byName(v, "균열 핵")).toMatchObject({ status: "pending", userEdited: true, summary: "작가가 고친 요약" });
    // untouched candidate proposed again: same item, refreshed by the new run
    expect(byName(v, "균열 던전")).toMatchObject({ id: oldRift.id, status: "pending", summary: "새 요약: 짐꾼만 들어갈 수 있다." });
    expect(byName(v, "균열 던전").taskId).not.toBe(oldRift.taskId);
    // not proposed again: superseded (hidden from the view), the entity retired
    expect(items(v).some((i) => i.id === oldEvent.id)).toBe(false);
    const ent = await t.modules.ontology.service.getEntity(scope, oldEvent.entityId!);
    expect(ent.status).toBe("retired");
    // the new relation exists once
    expect(items(v).filter((i) => i.relation?.predicate === "headquartered_in" && i.relation.objectName === "균열 던전")).toHaveLength(1);

    // candidates are flagged in the context; approved ones are not
    const ctx = await t.modules.world.service.renderWorldContext(scope);
    expect(ctx.text).toMatch(/- 태양 길드: [^\n]*\n/);
    expect(ctx.text).toMatch(/균열 던전[^\n]*\[미확정 후보/);
  });

  it("two [다시 생성] clicks at once queue one task (review fix)", async () => {
    const { scope, base, mine } = await approvedNovel("동시 클릭");
    t.claude.reply({ when: mine, json: SAMPLE_WORLD });
    expect((await runWorld(base)).state).toBe("done");
    const [a, b] = await Promise.all([t.http("POST", `${base}/world-ontology/generate`, {}), t.http("POST", `${base}/world-ontology/generate`, {})]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.taskId).toBe(b.body.taskId);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    const active = (await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_world_ontology"] })).filter((x) => x.status !== "done");
    expect(active).toHaveLength(1);
  });

  it("a rejected item is not proposed again by 다시 생성 (review fix)", async () => {
    const { scope, base, mine } = await approvedNovel("기각 존중");
    t.claude.reply({ when: mine, json: SAMPLE_WORLD, times: 2 });
    expect((await runWorld(base)).state).toBe("done");
    let v = await view(base);
    const assoc = byName(v, "헌터 협회");
    expect((await t.http("POST", `${base}/world-ontology/items/${assoc.id}/reject`, { reason: "협회는 없는 설정" })).status).toBe(200);

    // the model proposes the same faction again
    expect((await t.http("POST", `${base}/world-ontology/generate`, {})).status).toBe(202);
    expect((await runWorld(base)).state).toBe("done");
    const req = t.claude.requests.filter(mine).at(-1)!;
    expect(req.system).toContain("작가가 기각한 항목");
    expect(req.system).toContain("헌터 협회");
    v = await view(base);
    const same = items(v).filter((i) => i.name === "헌터 협회");
    expect(same.map((i) => i.status)).toEqual(["rejected"]);
    expect(items(v).some((i) => i.status === "pending" && (i.relation?.objectName === "헌터 협회" || i.relation?.subjectName === "헌터 협회"))).toBe(false);
    const ents = await t.testDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entities e JOIN entity_names n ON n.id = e.preferred_name_id WHERE e.novel_id = '${scope.novelId}' AND n.surface = '헌터 협회' AND e.status <> 'retired'`,
    );
    expect(ents[0]!.n).toBe(0);
  });

  it("다시 생성 / reject never retract canon of a partly approved item (review fix)", async () => {
    const { scope, base, mine } = await approvedNovel("부분 승인");
    t.claude.reply({ when: (r) => mine(r) && !r.prompt.includes("두 번째"), json: SAMPLE_WORLD });
    expect((await runWorld(base)).state).toBe("done");
    let v = await view(base);
    const rank = byName(v, "헌터 등급");
    const core = byName(v, "균열 핵");
    const cost = rank.facts.find((f) => f.predicate === "ability_cost")!;
    // partial approval: entity active + ability_cost approved, ability_limit still a candidate (held)
    // 균열 핵: activated by another path (e.g. a bible approval), its facts untouched
    await t.platform.uow.run(async (tx) => {
      const o = t.modules.ontology.service;
      await o.setEntityStatus(tx, scope, rank.entityId!, "active", t.owner, "test");
      await o.approveCandidateFacts(tx, scope, [cost.factId], t.owner);
      await o.setEntityStatus(tx, scope, core.entityId!, "active", t.owner, "test");
    });
    v = await view(base);
    expect(byName(v, "헌터 등급").status).toBe("pending");

    // reject is refused: the item is partly canon
    const rej = await t.http("POST", `${base}/world-ontology/items/${rank.id}/reject`, {});
    expect(rej.status).toBe(409);
    expect(rej.body.error.code).toBe("world_item_partly_canon");

    // 다시 생성: 헌터 등급 proposed again with other text, 균열 핵 not proposed at all
    const second = {
      ...structuredClone(SAMPLE_WORLD),
      systems: [{ key: "s_rank", name: "헌터 등급", system_kind: "ability" as const, summary: "AI가 바꾸려는 요약", cost_or_rule: "AI가 바꾸려는 대가", limits: [], source_urls: [] }],
      objects: [],
    };
    t.claude.reply({ when: (r) => mine(r) && r.prompt.includes("두 번째"), json: second });
    expect((await t.http("POST", `${base}/world-ontology/generate`, { instructions: "두 번째 생성" })).status).toBe(202);
    expect((await runWorld(base)).state).toBe("done");
    v = await view(base);
    const r2 = byName(v, "헌터 등급");
    expect(r2).toMatchObject({ id: rank.id, summary: rank.summary, statement: rank.statement });
    expect(r2.facts.find((f) => f.factId === cost.factId)!.canonStatus).toBe("approved");
    // not proposed again, but its entity is canon: kept (not superseded), its summary untouched
    expect(byName(v, "균열 핵")).toMatchObject({ id: core.id, entityStatus: "active", summary: core.summary });
    const left = await t.testDb.query<{ canon_status: string }>(`SELECT canon_status FROM facts WHERE id = '${cost.factId}'`);
    expect(left[0]!.canon_status).toBe("approved");
  });

  it("a candidate of another step with the same name is neither duplicated nor used as a relation end (review fix)", async () => {
    const { scope, base, mine } = await approvedNovel("다른 출처 후보");
    const foreign = await t.platform.uow.run((tx) =>
      t.modules.ontology.service.createEntity(tx, scope, { entityType: "organization", preferredName: { surface: "태양 길드" }, status: "candidate", source: { kind: "series_bible", refType: "series_bible", refId: "sb_other" } }, t.owner),
    );
    t.claude.reply({ when: mine, json: SAMPLE_WORLD });
    expect((await runWorld(base)).state).toBe("done");
    const v = await view(base);
    expect(items(v).some((i) => i.name === "태양 길드" || i.entityId === foreign.entity.id)).toBe(false);
    expect(items(v).some((i) => i.relation && (i.relation.subjectEntityId === foreign.entity.id || i.relation.objectEntityId === foreign.entity.id))).toBe(false);
    expect(byName(v, "헌터 협회").status).toBe("pending");
  });

  it("an entity rejected in the world review stays out of canon even when a bible fact still refers to it (review fix)", async () => {
    const { scope, base, mine } = await approvedNovel("기각 후 기획서");
    t.claude.reply({ when: mine, json: SAMPLE_WORLD });
    expect((await runWorld(base)).state).toBe("done");
    let v = await view(base);
    const assoc = byName(v, "헌터 협회");
    const seoul = byName(v, "서울");
    const bibleId = "sbl_test_world";
    await t.platform.uow.run(async (tx) => {
      const o = t.modules.ontology.service;
      const { schema } = await o.getSchema(scope, tx);
      const def = lookupPredicate(schema, "headquartered_in")!;
      const tl = await o.getDefaultTimeline(scope, tx);
      await o.writeCandidateFacts(
        tx,
        scope,
        [{ factKind: def.kind === "relation" ? def.def.factKind : "relation", subjectEntityId: assoc.entityId!, predicate: "headquartered_in", objectEntityId: seoul.entityId!, timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "series_bible", source: { refType: "series_bible", refId: bibleId }, seriesBibleId: bibleId }],
        actors.system("importer"),
      );
    });
    expect((await t.http("POST", `${base}/world-ontology/items/${assoc.id}/reject`, {})).status).toBe(200);
    const row = async (id: string) => (await t.testDb.query<{ status: string; check: { status?: string } | null }>(`SELECT status, equivalence_check AS check FROM entities WHERE id = '${id}'`))[0]!;
    expect(await row(assoc.entityId!)).toMatchObject({ status: "candidate", check: { status: "rejected" } });
    // the bible approval activates the bible's other world entity (author approval) but not the rejected one
    await t.platform.uow.run((tx) => t.modules.ontology.service.approveBibleFacts(tx, scope, bibleId, t.owner));
    expect((await row(assoc.entityId!)).status).toBe("candidate");
    v = await view(base);
    expect(byName(v, "헌터 협회").status).toBe("rejected");
  });

  it("the cast draft prompt carries the world ontology", async () => {
    const { base, mine } = await approvedNovel("캐스트 컨텍스트");
    t.claude.reply({ when: mine, json: SAMPLE_WORLD });
    expect((await runWorld(base)).state).toBe("done");
    t.claude.reply({ when: { system: /등장인물 초안/ }, json: { characters: [] } });
    const r = await t.http("POST", `${base}/cast/draft`, { includeAntagonist: true });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await t.modules.orchestration.service.runOnce();
    const sent = t.claude.requests.filter((x) => /등장인물 초안/.test(x.system)).at(-1)!;
    expect(sent.prompt).toContain("# 세계관 온톨로지");
    expect(sent.prompt).toContain("태양 길드");
    expect(sent.prompt).toContain("[미확정 후보");
  });
});

