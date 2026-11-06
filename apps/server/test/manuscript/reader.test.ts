/** 읽기(reader): GET …/reader/toc and …/reader/episodes/:no (read-only; approved vs draft; scene breaks; count basis). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { episodes } from "@ncs/db/schema";
import { READER_SCENE_BREAK, readerEpisodeDtoSchema, readerTocDtoSchema } from "@ncs/shared";
import { buildReadingText } from "../../src/modules/manuscript/domain/reader.js";
import { createTestCore, type TestCore } from "../support/test-core.js";

const SCENE_A = "비가 그친 새벽, 서윤은 낡은 우산을 접었다.\n\n골목 끝에서 누군가 그녀의 이름을 불렀다.";
const SCENE_B = "\"늦었네.\"\n\n도현은 웃지 않았다. 그 대신 젖은 편지 한 장을 내밀었다.";
const DRAFT = "고쳐 쓰는 중인 초안입니다.\n\n* * *\n\n둘째 장면.";

describe("reader routes", () => {
  let t: TestCore;
  let novelId: string;
  const base = () => `/api/novels/${novelId}/reader`;

  beforeAll(async () => {
    t = await createTestCore();
    const novel = await t.modules.novel.service.createNovel({ title: "읽기 테스트" }, t.owner);
    novelId = novel.id;
    const scope = { novelId };
    const ms = t.modules.manuscript.service;
    const arc = await t.modules.novel.service.createArc(
      undefined,
      scope,
      { ord: 1, title: "첫 플롯", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 5 },
      t.owner,
    );
    const approvedBy = { approvedAt: new Date(), approvedByActorType: "user" as const, approvedByActorId: t.ownerId };
    await t.platform.uow.run(async (tx) => {
      const eps = await ms.createPlannedEpisodes(
        tx,
        scope,
        arc.id,
        [1, 2, 3, 4, 5].map((n) => ({ episodeNo: n, title: `${n}화 제목` })),
        t.owner,
      );
      const [e1, e2, e3, , e5] = eps;
      // 1화: published, two scenes without a separator line (breaks come from scene offsets)
      const content1 = `# 1화 제목\n\n${SCENE_A}\n\n${SCENE_B}`;
      const v1 = await ms.saveVersion(tx, scope, e1!.id, { kind: "final", content: content1, author: t.owner });
      await ms.replaceScenes(
        tx,
        scope,
        v1.id,
        [
          { ord: 1, charStart: 0, charEnd: content1.indexOf(SCENE_B), summary: "a" },
          { ord: 2, charStart: content1.indexOf(SCENE_B), charEnd: content1.length, summary: "b" },
        ],
        t.owner,
      );
      await tx.db.update(episodes).set({ status: "published", currentVersionId: v1.id, ...approvedBy, approvedVersionId: v1.id, publishedVersionId: v1.id, publishedAt: new Date(), publishedByActorType: "user", publishedByActorId: t.ownerId }).where(eq(episodes.id, e1!.id));
      // 2화: approved, then a newer draft on top (revising)
      const v2 = await ms.saveVersion(tx, scope, e2!.id, { kind: "final", content: "승인된 2화 본문.", author: t.owner });
      const v2d = await ms.saveVersion(tx, scope, e2!.id, { kind: "draft", content: DRAFT, author: t.owner });
      await tx.db.update(episodes).set({ status: "revising", ...approvedBy, approvedVersionId: v2.id, currentVersionId: v2d.id }).where(eq(episodes.id, e2!.id));
      // 3화: draft only
      const v3 = await ms.saveVersion(tx, scope, e3!.id, { kind: "draft", content: "3화 초고 본문 입니다", author: t.owner });
      await tx.db.update(episodes).set({ status: "drafting", currentVersionId: v3.id }).where(and(eq(episodes.id, e3!.id)));
      // 4화: planned only (outline-less)
      // 5화: approved out of order (3·4화 are not) → neighbours report the skipped episodes
      const v5 = await ms.saveVersion(tx, scope, e5!.id, { kind: "final", content: "승인된 5화 본문.", author: t.owner });
      await tx.db.update(episodes).set({ status: "approved", ...approvedBy, approvedVersionId: v5.id, currentVersionId: v5.id }).where(eq(episodes.id, e5!.id));
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("TOC lists every episode with approved / draft availability and counts in the novel's basis", async () => {
    const r = await t.http("GET", `${base()}/toc`);
    expect(r.status).toBe(200);
    const toc = readerTocDtoSchema.parse(r.body);
    expect(toc.title).toBe("읽기 테스트");
    expect(toc.plots).toEqual([expect.objectContaining({ title: "첫 플롯", partId: null })]);
    const byNo = Object.fromEntries(toc.episodes.map((e) => [e.episodeNo, e]));
    expect(byNo[1]!.approved?.source).toBe("published");
    expect(byNo[1]!.draft).toBeNull();
    expect(byNo[2]!.approved?.source).toBe("approved");
    expect(byNo[2]!.draft).not.toBeNull();
    expect(byNo[3]!.approved).toBeNull();
    const draftCount = byNo[3]!.draft!.charCount;
    expect(draftCount).toBe(toc.countBasis === "without_spaces" ? "3화초고본문입니다".length : "3화 초고 본문 입니다".length);
    expect(byNo[4]).toMatchObject({ approved: null, draft: null, status: "planned" });
  });

  it("approved mode reads the approved text with scene breaks and approved-only neighbours", async () => {
    const r = await t.http("GET", `${base()}/episodes/1`);
    expect(r.status).toBe(200);
    const ep = readerEpisodeDtoSchema.parse(r.body);
    expect(ep.source).toBe("published");
    expect(ep.text.startsWith("비가 그친 새벽")).toBe(true); // leading "# 1화 제목" heading dropped
    expect(ep.text).toContain(`\n\n${READER_SCENE_BREAK}\n\n"늦었네."`);
    expect(ep.sceneCount).toBe(2);
    expect(ep.prev).toBeNull();
    expect(ep.next).toEqual({ episodeNo: 2, title: "2화 제목", skipped: [] });

    const two = readerEpisodeDtoSchema.parse((await t.http("GET", `${base()}/episodes/2`)).body);
    expect(two.source).toBe("approved");
    expect(two.text).toBe("승인된 2화 본문.");
    expect(two.next).toEqual({ episodeNo: 5, title: "5화 제목", skipped: [3, 4] }); // 3·4화 have no approved text
    const five = readerEpisodeDtoSchema.parse((await t.http("GET", `${base()}/episodes/5`)).body);
    expect(five.prev).toEqual({ episodeNo: 2, title: "2화 제목", skipped: [3, 4] });
    expect(five.next).toBeNull();

    const three = await t.http("GET", `${base()}/episodes/3`);
    expect(three.status).toBe(404);
    expect(three.body.error.code).toBe("not_readable");
    expect((await t.http("GET", `${base()}/episodes/99`)).body.error.code).toBe("not_found");
  });

  it("draft mode prefers the current draft and walks through draft-only episodes", async () => {
    const two = readerEpisodeDtoSchema.parse((await t.http("GET", `${base()}/episodes/2?mode=draft`)).body);
    expect(two.source).toBe("draft");
    expect(two.text).toBe(`고쳐 쓰는 중인 초안입니다.\n\n${READER_SCENE_BREAK}\n\n둘째 장면.`);
    expect(two.next).toEqual({ episodeNo: 3, title: "3화 제목", skipped: [] });
    const three = readerEpisodeDtoSchema.parse((await t.http("GET", `${base()}/episodes/3?mode=draft`)).body);
    expect(three).toMatchObject({ source: "draft", prev: { episodeNo: 2, skipped: [] }, next: { episodeNo: 5, skipped: [4] } });
    expect((await t.http("GET", `${base()}/episodes/4?mode=draft`)).status).toBe(404);
    expect((await t.http("GET", `${base()}/episodes/1?mode=bogus`)).status).toBe(400);
  });

  it("is scoped to the novel (another novel's reader is a 404)", async () => {
    expect((await t.http("GET", `/api/novels/nvl_00000000000000000000000000/reader/toc`)).status).toBe(404);
  });
});

describe("buildReadingText", () => {
  it("normalizes separators, merges duplicate breaks and never drops text", () => {
    expect(buildReadingText("가\n\n\n\n나\n---\n\n* * *\n다\n◇◇◇\n")).toBe(`가\n\n나\n\n${READER_SCENE_BREAK}\n\n다`);
    expect(buildReadingText("* * *\n가")).toBe("가");
    const s = "첫 장면.\n둘째 장면.";
    expect(buildReadingText(s, [0, s.indexOf("둘째"), 999])).toBe(`첫 장면.\n\n${READER_SCENE_BREAK}\n\n둘째 장면.`);
    expect(buildReadingText("한 줄\n다음 줄")).toBe("한 줄\n다음 줄");
  });
});
