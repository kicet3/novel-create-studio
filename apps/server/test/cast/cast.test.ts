/**
 * cast (설계 추가: 캐릭터 설정 단계) end to end over HTTP with the test core:
 * N2 seeding from the approved brief, protagonist 1 / sub-protagonists 0..N, provenance (agent never overwrites user
 * fields), the goal guard (cast_not_confirmed), confirm → ontology entities + approved user_input facts, the AI cast
 * draft (draft_cast, scripted Claude), the design sheet (draft_design_sheet, edits, view prompts, image generation
 * through imaging on a local xAI mock, primary image) and the `cast` context section.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { conceptBriefs, conceptSessions } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { json, startMockHttp, type MockHttp } from "../llm/mock-http.js";
import { PNG_B64 } from "../imaging/fixtures.js";
import { seedFromBrief, castBlockers, agentWritable, parseAge, relationPredicate, roleFromLabel } from "../../src/modules/cast/domain/cast.js";
import { buildViewPrompt, normalizeSpec } from "../../src/modules/cast/domain/design-sheet.js";

let t: TestCore;
let m: MockHttp;
const ENV_KEYS = ["XAI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  m = await startMockHttp();
  t = await createTestCore({ config: { llm: { endpoints: { xai_api_base_url: m.base } } } as never });
});
afterAll(async () => {
  await t.close();
  await m.close();
  for (const k of ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
});

const BRIEF = {
  logline: "회귀한 검사가 흉터의 비밀을 쫓는다",
  protagonist: { character_key: "c_hero", name: "한결", age_note: "17세", desire: "흉터를 새긴 자를 찾는다", lack: "사람을 믿지 못한다" },
  main_characters: [
    { character_key: "c_seorin", name: "서린", role_label: "히로인", relation_to_protagonist: "소꿉친구", sketch: "냉정한 기록관" },
    { character_key: "c_baek", name: "백야", role_label: "악역", sketch: "길드장" },
  ],
};

const goal = { totalEpisodesMin: 10, totalEpisodesMax: 12, cadenceEpisodesPerWeek: 5, reserveTargetEpisodes: 1, endingDirection: "흉터의 비밀을 밝힌다", notes: null };

async function approvedNovel(content: unknown = BRIEF) {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title: "회귀자의 흉터" }, t.owner);
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
    content,
    contentMd: "# 브리프",
  } as typeof conceptBriefs.$inferInsert);
  await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "회귀 판타지", ageRating: "age_15", category: {} }, t.owner));
  return { novelId: novel.id, scope, base: `/api/novels/${novel.id}` };
}

type C = dto.CharacterDto;
const byName = (items: C[], name: string) => items.find((c) => c.name === name)!;

describe("cast domain", () => {
  it("seeds protagonist + main characters from a brief, maps roles, guards provenance, parses ages and relations", () => {
    const seeds = seedFromBrief(BRIEF as never);
    expect(seeds.map((s) => [s.role, s.profile.name])).toEqual([
      ["protagonist", "한결"],
      ["sub_protagonist", "서린"],
      ["antagonist", "백야"],
    ]);
    expect(seeds[0]!.profile).toMatchObject({ age: "17세", desire: "흉터를 새긴 자를 찾는다", weakness: "사람을 믿지 못한다" });
    expect(seedFromBrief({ protagonist: { desire: "x" } } as never)[0]).toMatchObject({ namePlaceholder: true, profile: { name: "이름 미정" } });
    expect(castBlockers([])).toEqual(["등장인물이 없습니다. 주인공을 추가하세요."]);
    expect(castBlockers([{ id: "a", role: "supporting", status: "draft", name: "갑", proposed: false }])).toEqual(["주인공을 1명 정하세요."]);
    const w = agentWritable({ desire: "사용자 값", weakness: "" }, { desire: "user", weakness: "user" }, { desire: "AI 값", weakness: "AI 약점" });
    expect(w).toEqual({ accepted: { weakness: "AI 약점" }, skipped: ["desire"] });
    expect([parseAge("17세"), parseAge("17"), parseAge("30대 초반")]).toEqual([17, 17, null]);
    expect([relationPredicate("소꿉친구"), relationPredicate("친오빠"), relationPredicate("숙적"), relationPredicate("스승")]).toEqual(["ally_of", "sibling_of", "enemy_of", null]);
    // review3 #4: bare 적 / 형 inside other words are not enemy / sibling
    expect(["적극적인 조력자", "정치적 동맹", "목적을 공유한 동료", "형사 파트너"].map(relationPredicate)).toEqual(["ally_of", "ally_of", "ally_of", "ally_of"]);
    expect(["정신적 지주", "적", "적수", "형", "라이벌"].map(relationPredicate)).toEqual([null, "enemy_of", "enemy_of", "sibling_of", "enemy_of"]);
    expect(["정신적 지주", "적극적인 조력자", "악역", "적대 세력의 간부"].map(roleFromLabel)).toEqual(["supporting", "sub_protagonist", "antagonist", "antagonist"]);
    const p = buildViewPrompt({ name: "한결", age: "17세", gender: "남" }, normalizeSpec({ hair: "짧은 흑발", artStyle: "셀 셰이딩", avoid: "피" }), "side");
    expect(p.prompt).toContain("SIDE view");
    expect(p.prompt).toContain("머리: 짧은 흑발");
    expect(p).toMatchObject({ styleNotes: "셀 셰이딩" });
    expect(p.negativePrompt).toContain("피");
  });
});

describe("cast seeding: nameless protagonist listed among the main characters (live-test regression)", () => {
  it("takes the name of the entry labelled 주인공 (or the only one named in the protagonist text) and does not duplicate it", () => {
    const seeds = seedFromBrief({
      protagonist: { starting_condition: "낡은 수선집을 물려받은 재봉사 윤서하", desire: "사라진 언니 윤서진을 찾는다" },
      main_characters: [
        { name: "윤서하", sketch: "주인공. 스물아홉 살 재봉사" },
        { name: "윤서진", sketch: "서하의 언니" },
        { name: "강태오", sketch: "재개발 조합장", role_label: "악역" },
      ],
    } as never);
    expect(seeds.map((x) => [x.role, x.profile.name, x.namePlaceholder])).toEqual([
      ["protagonist", "윤서하", false],
      ["supporting", "윤서진", false],
      ["antagonist", "강태오", false],
    ]);
    expect(seeds[0]!.profile.personality).toBe("스물아홉 살 재봉사");
    // unlabelled: the only main character named in the starting condition
    const byText = seedFromBrief({ protagonist: { starting_condition: "재봉사 윤서하" }, main_characters: [{ name: "윤서하" }, { name: "강태오" }] } as never);
    expect(byText.map((x) => x.profile.name)).toEqual(["윤서하", "강태오"]);
    // ambiguous → placeholder kept
    const amb = seedFromBrief({ protagonist: { starting_condition: "윤서하와 강태오" }, main_characters: [{ name: "윤서하" }, { name: "강태오" }] } as never);
    expect(amb[0]).toMatchObject({ namePlaceholder: true, profile: { name: "이름 미정" } });
  });
});

describe("cast step", () => {
  it("is not editable before the storyline is approved", async () => {
    const n = await t.modules.novel.service.createNovel({}, t.owner);
    const r = await t.http("POST", `/api/novels/${n.id}/cast/characters`, { role: "protagonist", name: "한결" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("concept_not_approved");
    expect((await t.http("GET", `/api/novels/${n.id}/cast`)).body).toMatchObject({ items: [], confirmed: false, stepRequired: false });
  });

  it("N2 seeds the cast; protagonist 1 + sub-protagonists 0..N; edits, reorder, delete; goal guard; confirm → ontology", async () => {
    const { scope, base, novelId } = await approvedNovel();
    let view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(view).toMatchObject({ confirmed: false, stepRequired: true, canImportBrief: false, counts: { protagonist: 1, subProtagonist: 1, other: 1 } });
    expect(view.items.map((c) => [c.role, c.name, c.status])).toEqual([
      ["protagonist", "한결", "draft"],
      ["sub_protagonist", "서린", "draft"],
      ["antagonist", "백야", "draft"],
    ]);
    const hero = byName(view.items, "한결");
    const seorin = byName(view.items, "서린");
    expect(hero.fieldOrigins).toMatchObject({ name: "user", desire: "user", age: "user" });
    expect(hero.conceptCharacterKey).toBe("c_hero");
    expect(seorin.relationships).toEqual([{ targetCharacterId: hero.id, kind: "소꿉친구", description: "" }]);
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "character." })).items.map((e) => e.action)).toEqual(["character.created"]);

    // goal guard (N3 needs a confirmed cast)
    const blocked = await t.http("PUT", `${base}/goal`, goal);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("cast_not_confirmed");

    // sub-protagonists: any number (here 3 more, then all removed again → 0)
    const added: string[] = [];
    for (const name of ["도윤", "하람", "이안"]) {
      const r = await t.http("POST", `${base}/cast/characters`, { role: "sub_protagonist", name, relationships: [{ targetCharacterId: hero.id, kind: "동료" }] });
      expect(r.status).toBe(201);
      expect(r.body.fieldOrigins).toMatchObject({ name: "user", relationships: "user" });
      added.push(r.body.id);
    }
    expect((await t.http("GET", `${base}/cast`)).body.counts).toEqual({ protagonist: 1, subProtagonist: 4, other: 1 });
    expect((await t.http("POST", `${base}/cast/characters`, { role: "supporting", name: " 서린 " })).body.error.code).toBe("character_name_taken");
    for (const id of [...added, seorin.id]) expect((await t.http("DELETE", `${base}/cast/characters/${id}`)).status).toBe(204);
    view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(view.counts).toEqual({ protagonist: 1, subProtagonist: 0, other: 1 });
    expect(view.canImportBrief).toBe(true); // 서린 can be imported again
    view = dto.castViewSchema.parse((await t.http("POST", `${base}/cast/import-brief`)).body);
    const seorin2 = byName(view.items, "서린");
    expect(seorin2.role).toBe("sub_protagonist");

    // a new protagonist demotes the current one; edit role back
    const newHero = await t.http("POST", `${base}/cast/characters`, { role: "protagonist", name: "무명" });
    expect(newHero.status).toBe(201);
    view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(byName(view.items, "한결").role).toBe("sub_protagonist");
    expect((await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { role: "protagonist" })).body.role).toBe("protagonist");
    expect((await t.http("DELETE", `${base}/cast/characters/${newHero.body.id}`)).status).toBe(204);

    // edit profile: user fields
    const edited = await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { gender: "남", personality: "말수가 적고 집요하다", aliases: ["흉터의 검사", "한결"] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ gender: "남", aliases: ["흉터의 검사"], fieldOrigins: { gender: "user", personality: "user" } });
    // relationship to the antagonist (rival → enemy_of)
    const baek = byName(view.items, "백야");
    await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { relationships: [{ targetCharacterId: baek.id, kind: "숙적", description: "스승을 죽인 자" }] });

    // reorder: every id once
    const ids = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body).items.map((c) => c.id);
    expect((await t.http("PUT", `${base}/cast/order`, { ids: ids.slice(1) })).body.error.code).toBe("cast_order_mismatch");
    expect((await t.http("PUT", `${base}/cast/order`, { ids: [...ids].reverse() })).status).toBe(200);

    // confirm → entities + approved facts (user_input, source character)
    const conf = await t.http("POST", `${base}/cast/confirm`);
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(conf.body).toMatchObject({ confirmed: true, stepRequired: false, blockers: [] });
    const items = conf.body.items as C[];
    expect(items.every((c) => c.status === "confirmed" && c.entityId && c.confirmedAt)).toBe(true);
    const heroEntity = items.find((c) => c.id === hero.id)!.entityId!;
    const entity = await t.http("GET", `${base}/entities/${heroEntity}`);
    expect(entity.status).toBe(200);
    expect(JSON.stringify(entity.body)).toContain("흉터의 검사");
    const facts = await t.testDb.query<{ predicate: string; canon_status: string; source_kind: string; source_ref_type: string }>(
      `SELECT predicate, canon_status, source_kind, source_ref_type FROM facts WHERE novel_id = '${novelId}' AND source_ref_id = '${hero.id}' ORDER BY predicate`,
    );
    expect(facts.map((f) => f.predicate)).toEqual(["age", "enemy_of", "gender", "personality"]);
    expect(facts.every((f) => f.canon_status === "approved" && f.source_kind === "user_input" && f.source_ref_type === "character")).toBe(true);
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "cast." })).items[0]).toMatchObject({ action: "cast.confirmed" });

    // the cast context section (series bible / outline / draft input)
    const ctx = await t.modules.cast.service.renderCastContext(scope);
    expect(ctx.text).toContain("[주인공] 한결");
    expect(ctx.text).toContain("관계: 백야(숙적 — 스승을 죽인 자)");
    expect(ctx.entityIds).toContain(heroEntity);

    // an edit puts the character back to draft; re-confirm writes only the changed fact
    const re = await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { age: "18" });
    expect(re.body.status).toBe("draft");
    expect((await t.http("GET", `${base}/cast`)).body.confirmed).toBe(false);
    expect((await t.http("POST", `${base}/cast/confirm`)).body.confirmed).toBe(true);
    const after = await t.testDb.query<{ c: number }>(`SELECT count(*)::int AS c FROM facts WHERE novel_id = '${novelId}' AND source_ref_id = '${hero.id}'`);
    expect(after[0]!.c).toBe(5);

    // the goal can be saved now (N3 → planning)
    const g = await t.http("PUT", `${base}/goal`, goal);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((await t.modules.novel.service.getNovel(scope)).status).toBe("planning");
    expect((await t.http("GET", `${base}/cast`)).body.stepRequired).toBe(false);
  });

  it("after the goal: an edit keeps the last confirmed profile in the context; re-confirm replaces canon and the preferred name", async () => {
    const { scope, base, novelId } = await approvedNovel();
    let view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    const hero = byName(view.items, "한결");
    await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { gender: "남", personality: "집요하다" });
    expect((await t.http("POST", `${base}/cast/confirm`)).status).toBe(200);
    expect((await t.http("PUT", `${base}/goal`, goal)).status).toBe(200);
    view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(view).toMatchObject({ confirmed: true, goalSet: true, pendingChanges: 0 });

    // edit after the goal: the writing context keeps the confirmed protagonist (review3 #2)
    await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { personality: "다정하다", age: "18", gender: "여", name: "한별" });
    view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(view).toMatchObject({ confirmed: false, stepRequired: false, goalSet: true, pendingChanges: 1 });
    let ctx = await t.modules.cast.service.renderCastContext(scope);
    expect(ctx.text).toContain("[주인공] 한결");
    expect(ctx.text).toContain("성격: 집요하다");
    expect(ctx.text).not.toContain("다정하다");
    expect(ctx.text).toMatch(/^주인공 1명, 서브 주인공 1명을 포함한 확정 캐스트\(3명\)/);

    // re-confirm: the old single values are withdrawn, the new ones are canon (review3 #3)
    expect((await t.http("POST", `${base}/cast/confirm`)).body.confirmed).toBe(true);
    const facts = await t.testDb.query<{ predicate: string; value: unknown; canon_status: string }>(
      `SELECT predicate, value, canon_status FROM facts WHERE novel_id = '${novelId}' AND source_ref_id = '${hero.id}' AND predicate IN ('age','gender','personality') ORDER BY predicate, created_at`,
    );
    const canon = facts.filter((f) => f.canon_status === "approved").map((f) => [f.predicate, f.value]);
    expect(canon).toEqual([
      ["age", 18],
      ["gender", "여"],
      ["personality", "다정하다"],
    ]);
    expect(facts.filter((f) => f.canon_status === "retracted").map((f) => [f.predicate, f.value])).toEqual([
      ["age", 17],
      ["gender", "남"],
      ["personality", "집요하다"],
    ]);
    expect(facts.some((f) => f.canon_status === "candidate")).toBe(false);
    ctx = await t.modules.cast.service.renderCastContext(scope);
    expect(ctx.text).toContain("[주인공] 한별");
    expect(ctx.text).toContain("나이: 18");

    // rename: the new name is the preferred name, the old true name is retired (review3 #5)
    const entityId = (await t.modules.cast.service.getCharacter(scope, hero.id)).entityId!;
    const names = await t.modules.ontology.service.listEntityNames(scope, entityId);
    expect(names.filter((n) => n.status === "active" && n.nameKind === "true_name").map((n) => [n.surface, n.isPreferred])).toEqual([["한별", true]]);
    expect(names.find((n) => n.surface === "한결")!.status).toBe("retired");
    const entity = await t.modules.ontology.service.getEntity(scope, entityId);
    expect(names.find((n) => n.id === entity.preferredNameId)!.surface).toBe("한별");

    // a third confirm without changes writes nothing new
    const count = async () => (await t.testDb.query<{ c: number }>(`SELECT count(*)::int AS c FROM facts WHERE novel_id = '${novelId}'`))[0]!.c;
    const before = await count();
    await t.http("PATCH", `${base}/cast/characters/${hero.id}`, { notes: "메모만 바꿈" });
    await t.http("POST", `${base}/cast/confirm`);
    expect(await count()).toBe(before);
  });

  it("confirm needs exactly one protagonist", async () => {
    const { base } = await approvedNovel({ logline: "x" });
    expect((await t.http("GET", `${base}/cast`)).body.items).toEqual([]);
    const empty = await t.http("POST", `${base}/cast/confirm`);
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatchObject({ code: "cast_invalid", message: "등장인물이 없습니다. 주인공을 추가하세요." });
    await t.http("POST", `${base}/cast/characters`, { role: "supporting", name: "행인" });
    expect((await t.http("POST", `${base}/cast/confirm`)).body.error.message).toBe("주인공을 1명 정하세요.");
    await t.http("POST", `${base}/cast/characters`, { role: "protagonist", name: "주인" });
    expect((await t.http("POST", `${base}/cast/confirm`)).body.confirmed).toBe(true); // sub-protagonists: 0 is fine
  });

  it("AI cast draft: proposals never overwrite user fields, respect the sub-protagonist count, link relationships; accept", async () => {
    const { base } = await approvedNovel();
    const hero = byName((await t.http("GET", `${base}/cast`)).body.items, "한결");
    t.claude.reply({
      when: { system: /등장인물 초안/ },
      json: {
        characters: [
          { existing_id: hero.id, role: "protagonist", name: "다른 이름", aliases: [], age: "", gender: "남", personality: "AI 성격", background: "AI 배경", desire: "AI 욕망", weakness: "", notes: "", relationships: [] },
          { existing_id: "", role: "sub_protagonist", name: "도윤", aliases: ["윤"], age: "18", gender: "남", personality: "밝다", background: "", desire: "", weakness: "", notes: "", relationships: [{ target_name: "한결", kind: "동료", description: "같은 길드" }] },
          { existing_id: "", role: "sub_protagonist", name: "하람", aliases: [], age: "", gender: "여", personality: "", background: "", desire: "", weakness: "", notes: "", relationships: [] },
          { existing_id: "", role: "protagonist", name: "가짜 주인공", aliases: [], age: "", gender: "", personality: "", background: "", desire: "", weakness: "", notes: "", relationships: [] },
          { existing_id: "", role: "supporting", name: "노인", aliases: [], age: "", gender: "", personality: "", background: "", desire: "", weakness: "", notes: "", relationships: [] },
        ],
      },
    });
    const req = await t.http("POST", `${base}/cast/draft`, { subProtagonistCount: 2, instructions: "조연은 한 명만" });
    expect(req.status).toBe(202);
    expect((await t.http("POST", `${base}/cast/draft`, {})).body.taskId).toBe(req.body.taskId); // coalesced
    expect((await t.http("GET", `${base}/cast`)).body.draftTask).toMatchObject({ id: req.body.taskId });
    await t.modules.orchestration.service.runOnce();
    expect(t.claude.unmatched.filter((r) => /등장인물 초안/.test(r.system))).toEqual([]); // (an earlier novel's plan_series_bible is unscripted here)
    const sent = t.claude.requests.find((r) => /등장인물 초안/.test(r.system))!;
    expect(sent.prompt).toContain("서브 주인공 수: 2명");
    expect(sent.prompt).toContain("조연은 한 명만");

    const view = dto.castViewSchema.parse((await t.http("GET", `${base}/cast`)).body);
    expect(view.draftTask).toBeNull();
    const h = byName(view.items, "한결");
    expect(h).toMatchObject({ name: "한결", desire: "흉터를 새긴 자를 찾는다", gender: "남", personality: "AI 성격", background: "AI 배경" });
    expect(h.fieldOrigins).toMatchObject({ desire: "user", gender: "agent", personality: "agent" });
    // 서린 (brief) + 도윤 → 2 sub-protagonists; 하람 dropped by the count, "가짜 주인공" demoted then dropped too
    expect(view.items.filter((c) => c.role === "sub_protagonist").map((c) => c.name)).toEqual(["서린", "도윤"]);
    expect(view.items.map((c) => c.name)).toContain("노인");
    const doyun = byName(view.items, "도윤");
    expect(doyun).toMatchObject({ proposed: true, aliases: ["윤"], relationships: [{ targetCharacterId: h.id, kind: "동료", description: "같은 길드" }] });
    expect(doyun.fieldOrigins.name).toBe("agent");

    const acc = await t.http("POST", `${base}/cast/characters/${doyun.id}/accept`);
    expect(acc.body).toMatchObject({ proposed: false, fieldOrigins: { name: "user", gender: "user" } });
    const rm = await t.http("DELETE", `${base}/cast/characters/${byName(view.items, "노인").id}`);
    expect(rm.status).toBe(204);
  });

  it("design sheet: AI draft keeps user fields, view prompts, image generation per view, primary image, reference text", async () => {
    const { base, scope } = await approvedNovel();
    const hero = byName((await t.http("GET", `${base}/cast`)).body.items, "한결");
    const sheetUrl = `${base}/cast/characters/${hero.id}/design-sheet`;
    let sheet = dto.designSheetViewSchema.parse((await t.http("GET", sheetUrl)).body);
    expect(sheet).toMatchObject({ images: [], primaryImages: {}, draftTask: null });
    expect((await t.http("POST", `${sheetUrl}/images`, { view: "front", provider: "xai", modelId: "grok-imagine-image-2.0" })).body.error.code).toBe("design_sheet_empty");

    // user sets the hair first; the AI draft must keep it
    expect((await t.http("PATCH", sheetUrl, { hair: "짧은 흑발, 앞머리로 흉터를 가림" })).body.fieldOrigins).toEqual({ hair: "user" });
    t.claude.reply({
      when: { system: /디자인 시트/ },
      json: {
        face: "날카로운 턱선",
        hair: "긴 은발",
        eyes: "회색 눈",
        build: "마른 근육형",
        height: "178cm",
        outfits: [{ name: "검사복", description: "낡은 회색 코트와 가죽 장갑" }],
        color_palette: [{ name: "잿빛", hex: "#6B6B6B" }, { name: "틀린 색", hex: "grey" }],
        distinguishing_marks: "왼쪽 손등의 흉터",
        art_style: "웹툰풍 셀 셰이딩",
        avoid: "피",
      },
    });
    const d = await t.http("POST", `${sheetUrl}/draft`);
    expect(d.status).toBe(202);
    await t.modules.orchestration.service.runOnce();
    sheet = dto.designSheetViewSchema.parse((await t.http("GET", sheetUrl)).body);
    expect(sheet.spec).toMatchObject({ hair: "짧은 흑발, 앞머리로 흉터를 가림", face: "날카로운 턱선", height: "178cm", colorPalette: [{ name: "잿빛", hex: "#6B6B6B" }] });
    expect(sheet.fieldOrigins).toMatchObject({ hair: "user", face: "agent" });
    expect(sheet.referenceText).toContain("특징: 왼쪽 손등의 흉터");

    const prompt = await t.http("GET", `${sheetUrl}/prompt?view=expressions`);
    expect(prompt.body.prompt).toContain("expression sheet");
    expect(prompt.body.prompt).toContain("머리: 짧은 흑발");
    expect(prompt.body.styleNotes).toBe("웹툰풍 셀 셰이딩");

    // image generation through imaging (xAI mock), novel-scoped
    expect((await t.http("POST", `${sheetUrl}/images`, { view: "front", provider: "xai", modelId: "grok-imagine-image-2.0" })).body.error.code).toBe("provider_not_connected");
    expect((await t.http("PUT", "/api/providers/xai/api-key", { apiKey: "xai-secret-key-123456" })).status).toBe(200);
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }], usage: { cost_in_usd_ticks: 400_000_000 } }));
    const gen = await t.http("POST", `${sheetUrl}/images`, { view: "front", provider: "xai", modelId: "grok-imagine-image-2.0", count: 2 });
    expect(gen.status, JSON.stringify(gen.body)).toBe(202);
    expect(gen.body).toMatchObject({ view: "front", generation: { status: "queued", novelId: scope.novelId } });
    await t.modules.imaging.service.whenIdle();
    const sent = m.captured.find((c) => c.path === "/v1/images/generations")!;
    expect(sent.json.prompt).toContain("FRONT view");
    expect(sent.json.prompt).toContain("의상(검사복): 낡은 회색 코트와 가죽 장갑");
    expect(sent.json.prompt).toContain("스타일 지시: 웹툰풍 셀 셰이딩");
    expect(sent.json.aspect_ratio).toBe("2:3");
    sheet = dto.designSheetViewSchema.parse((await t.http("GET", sheetUrl)).body);
    expect(sheet.images).toHaveLength(1);
    expect(sheet.images[0]!.generation).toMatchObject({ status: "succeeded" });
    const asset = sheet.images[0]!.generation.assets[1]!;

    // primary image per view (only this character's view images)
    expect((await t.http("PUT", `${sheetUrl}/primary`, { view: "side", assetId: asset.id })).body.error.code).toBe("design_sheet_asset_invalid");
    sheet = dto.designSheetViewSchema.parse((await t.http("PUT", `${sheetUrl}/primary`, { view: "front", assetId: asset.id })).body);
    expect(sheet.primaryImages).toEqual({ front: asset.id });
    const listed = byName((await t.http("GET", `${base}/cast`)).body.items, "한결");
    expect(listed).toMatchObject({ hasDesignSheet: true, thumbnailUrl: `/api/images/assets/${asset.id}/file` });
    expect((await t.modules.cast.service.referenceText(scope, hero.id))).toContain("눈: 회색 눈");
    const acts = (await t.modules.audit.service.list(scope, { actionPrefix: "design_sheet." })).items.map((e) => e.action);
    expect(acts).toEqual(expect.arrayContaining(["design_sheet.updated", "design_sheet.draft_requested", "design_sheet.image_requested", "design_sheet.image_selected"]));
    expect(JSON.stringify(sheet)).not.toContain("xai-secret");

    // deleting the generation drops the thumbnail (review3 #6) — checked on a second generation picked as side view
    const gen2 = await t.http("POST", `${sheetUrl}/images`, { view: "side", provider: "xai", modelId: "grok-imagine-image-2.0" });
    await t.modules.imaging.service.whenIdle();
    const g2 = (await t.http("GET", `/api/images/generations/${gen2.body.generation.id}`)).body;
    await t.http("PUT", `${sheetUrl}/primary`, { view: "side", assetId: g2.assets[0].id });

    expect((await t.http("DELETE", `/api/images/generations/${gen.body.generation.id}`)).status).toBe(204);
    const gone = byName((await t.http("GET", `${base}/cast`)).body.items, "한결");
    expect(gone).toMatchObject({ hasDesignSheet: true, thumbnailUrl: null });
    expect(dto.designSheetViewSchema.parse((await t.http("GET", sheetUrl)).body).primaryImages).toEqual({ side: g2.assets[0].id });

    // the sheet's look is part of the cast context once confirmed
    await t.http("POST", `${base}/cast/confirm`);
    expect((await t.modules.cast.service.renderCastContext(scope)).text).toContain("외형: ");
  });
});
