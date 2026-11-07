/**
 * 공개 사이트 스냅숏: only PUBLISHED episodes of opted-in novels are written (drafts, awaiting_approval and
 * approved-but-unpublished stay out), opt-out / unpublish removes files, files carry only allow-listed keys.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { episodes, novels } from "@ncs/db/schema";
import {
  PUBLIC_EPISODE_KEYS,
  PUBLIC_HOME_KEYS,
  PUBLIC_LIST_KEYS,
  PUBLIC_REF_KEYS,
  PUBLIC_SUMMARY_KEYS,
  PUBLIC_TOC_KEYS,
} from "@ncs/reader-core/snapshot";
import { publicSiteNovelDtoSchema, publicSiteStatusDtoSchema } from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { buildSnapshot } from "../../src/modules/publication/domain/snapshot.js";
import { SiteDirError, writeSite } from "../../src/modules/publication/adapters/fs/site-writer.js";

const SECRET_NOTE = "내부메모-절대-공개-금지";

describe("publication (공개 사이트)", () => {
  let t: TestCore;
  let novelId: string;
  let otherId: string;
  let ids: string[] = [];
  const dir = () => t.modules.publication.service.outputDir;
  const read = (rel: string) => JSON.parse(readFileSync(join(dir(), rel), "utf8"));
  const settings = (id = novelId) => `/api/novels/${id}/public-site`;

  beforeAll(async () => {
    t = await createTestCore();
    const novel = await t.modules.novel.service.createNovel({ title: "공개 테스트" }, t.owner);
    novelId = novel.id;
    await t.platform.uow.db.update(novels).set({ genre: "판타지" }).where(eq(novels.id, novelId));
    otherId = (await t.modules.novel.service.createNovel({ title: "다른 작품" }, t.owner)).id;
    const scope = { novelId };
    const ms = t.modules.manuscript.service;
    const arc = await t.modules.novel.service.createArc(
      undefined,
      scope,
      { ord: 1, title: SECRET_NOTE, goalText: SECRET_NOTE, conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 5 },
      t.owner,
    );
    const by = { approvedAt: new Date(), approvedByActorType: "user" as const, approvedByActorId: t.ownerId };
    const pub = { publishedAt: new Date("2026-11-01T00:00:00Z"), publishedByActorType: "user" as const, publishedByActorId: t.ownerId };
    await t.platform.uow.run(async (tx) => {
      const eps = await ms.createPlannedEpisodes(tx, scope, arc.id, [1, 2, 3, 4, 5].map((n) => ({ episodeNo: n, title: `${n}화 제목` })), t.owner);
      ids = eps.map((e) => e.id);
      const [e1, e2, e3, e4, e5] = eps;
      // 1화: published
      const v1 = await ms.saveVersion(tx, scope, e1!.id, { kind: "final", content: "공개된 1화 본문.\n\n두 번째 문단.", author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, ...pub, approvedVersionId: v1.id, publishedVersionId: v1.id, currentVersionId: v1.id, hookNote: SECRET_NOTE, planSummary: SECRET_NOTE }).where(eq(episodes.id, e1!.id));
      // 2화: published, then a newer draft on top → only the published version is public
      const v2 = await ms.saveVersion(tx, scope, e2!.id, { kind: "final", content: "공개된 2화 본문.", author: t.owner });
      const v2d = await ms.saveVersion(tx, scope, e2!.id, { kind: "draft", content: `초안 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, ...pub, approvedVersionId: v2.id, publishedVersionId: v2.id, currentVersionId: v2d.id }).where(eq(episodes.id, e2!.id));
      // 3화: approved but not published
      const v3 = await ms.saveVersion(tx, scope, e3!.id, { kind: "final", content: `승인만 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "approved", ...by, approvedVersionId: v3.id, currentVersionId: v3.id }).where(eq(episodes.id, e3!.id));
      // 4화: awaiting approval
      const v4 = await ms.saveVersion(tx, scope, e4!.id, { kind: "final", content: `대기 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "awaiting_approval", currentVersionId: v4.id }).where(eq(episodes.id, e4!.id));
      // 5화: draft
      const v5 = await ms.saveVersion(tx, scope, e5!.id, { kind: "draft", content: `초고 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "drafting", currentVersionId: v5.id }).where(eq(episodes.id, e5!.id));
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("is off by default: nothing public until the author opts in", async () => {
    const r = await t.http("GET", settings());
    expect(r.status).toBe(200);
    expect(publicSiteNovelDtoSchema.parse(r.body)).toMatchObject({ enabled: false, slug: null, publishedEpisodeCount: 2 });
    const s = publicSiteStatusDtoSchema.parse((await t.http("POST", "/api/public-site/build")).body);
    expect(s).toMatchObject({ novelCount: 0, episodeCount: 0, lastError: null });
    expect(s.outputDir).toBe(join(t.home, "public-site", "data"));
    expect(read("novels.json").novels).toEqual([]);
    expect(existsSync(join(dir(), "novels"))).toBe(false);
  });

  it("validates the slug and requires one to opt in", async () => {
    expect((await t.http("PATCH", settings(), { enabled: true })).status).toBe(422);
    for (const bad of ["-a", "a-", "한글", "a b", "a--b", "x".repeat(65), "../etc"]) {
      expect((await t.http("PATCH", settings(), { slug: bad })).status, bad).toBe(400);
    }
    expect((await t.http("PATCH", settings(), { slug: "x", unknown: 1 })).status).toBe(400);
  });

  it("writes only published versions of an opted-in novel, with allow-listed keys only", async () => {
    const r = await t.http("PATCH", settings(), { enabled: true, slug: "My-Novel", intro: "  공개 소개입니다.  ", authorName: "작가" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, slug: "my-novel", intro: "  공개 소개입니다.  " });
    expect(t.modules.publication.service.status()).toMatchObject({ novelCount: 1, episodeCount: 2 });

    const list = read("novels.json");
    expect(Object.keys(list).sort()).toEqual([...PUBLIC_LIST_KEYS].sort());
    expect(list.novels).toHaveLength(1);
    expect(Object.keys(list.novels[0]).sort()).toEqual([...PUBLIC_SUMMARY_KEYS].sort());
    expect(list.novels[0]).toMatchObject({ slug: "my-novel", title: "공개 테스트", genre: "판타지", authorName: "작가", intro: "공개 소개입니다.", episodeCount: 2 });

    const home = read("novels/my-novel/index.json");
    expect(Object.keys(home).sort()).toEqual([...PUBLIC_HOME_KEYS].sort());
    expect(home.episodes.map((e: { episodeNo: number }) => e.episodeNo)).toEqual([1, 2]);
    for (const e of home.episodes) expect(Object.keys(e).sort()).toEqual([...PUBLIC_TOC_KEYS].sort());

    const ep1 = read("novels/my-novel/episodes/1.json");
    expect(Object.keys(ep1).sort()).toEqual([...PUBLIC_EPISODE_KEYS].sort());
    expect(ep1).toMatchObject({ episodeNo: 1, title: "1화 제목", prev: null, next: { episodeNo: 2, title: "2화 제목" } });
    expect(Object.keys(ep1.next).sort()).toEqual([...PUBLIC_REF_KEYS].sort());
    expect(ep1.text).toContain("공개된 1화 본문.");
    expect(read("novels/my-novel/episodes/2.json").text).toBe("공개된 2화 본문.");
    expect(readdirSync(join(dir(), "novels/my-novel/episodes")).sort()).toEqual(["1.json", "2.json"]);

    // no internal text or ids anywhere in the output
    const all = ["novels.json", "novels/my-novel/index.json", "novels/my-novel/episodes/1.json", "novels/my-novel/episodes/2.json"]
      .map((f) => readFileSync(join(dir(), f), "utf8"))
      .join("\n");
    expect(all).not.toContain(SECRET_NOTE);
    expect(all).not.toContain(novelId);
    for (const id of ids) expect(all).not.toContain(id);
    expect(all).not.toMatch(/"(id|novelId|versionId|arcId|status)"/);
  });

  it("rejects a slug another novel already uses", async () => {
    const r = await t.http("PATCH", settings(otherId), { enabled: true, slug: "my-novel" });
    expect(r.status).toBe(409);
  });

  it("removes an unpublished episode's file and picks up title changes on reconcile", async () => {
    await t.platform.uow.db.update(episodes).set({ status: "approved", publishedVersionId: null, publishedAt: null }).where(eq(episodes.id, ids[1]!));
    await t.platform.uow.db.update(episodes).set({ title: "새 1화 제목" }).where(eq(episodes.id, ids[0]!));
    await t.modules.publication.service.rebuild();
    expect(existsSync(join(dir(), "novels/my-novel/episodes/2.json"))).toBe(false);
    const ep1 = read("novels/my-novel/episodes/1.json");
    expect(ep1).toMatchObject({ title: "새 1화 제목", next: null });
    expect(read("novels/my-novel/index.json").episodes).toHaveLength(1);
  });

  it("opt-out removes the novel's files and its list entry", async () => {
    expect((await t.http("PATCH", settings(), { enabled: false })).status).toBe(200);
    expect(existsSync(join(dir(), "novels/my-novel"))).toBe(false);
    expect(read("novels.json").novels).toEqual([]);
    expect(t.modules.publication.service.status()).toMatchObject({ novelCount: 0, episodeCount: 0 });
  });

  it("records the settings change in the audit timeline", async () => {
    const page = await t.modules.audit.service.list({ novelId }, { actionPrefix: "publication." });
    expect(page.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("site writer", () => {
  it("refuses a non-empty folder it does not own and rejects unexpected paths", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "ncs-site-"));
    writeFileSync(join(d, "someone-elses.txt"), "x");
    const snap = buildSnapshot([], new Date());
    await expect(writeSite(d, snap.files)).rejects.toBeInstanceOf(SiteDirError);
    const d2 = join(d, "fresh");
    mkdirSync(d2);
    await expect(writeSite(d2, new Map([["../evil.json", "{}"]]))).rejects.toBeInstanceOf(SiteDirError);
    await writeSite(d2, snap.files);
    expect(readdirSync(d2).sort()).toEqual([".ncs-public-site", "novels.json"]);
    expect(readdirSync(d2).some((f) => f.startsWith(".tmp-"))).toBe(false);
  });
});
