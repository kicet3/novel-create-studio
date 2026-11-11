/**
 * 공개 사이트 스냅숏: no opt-in — every non-archived novel with a PUBLISHED episode is written at its lowercased id
 * under the fixed author name (drafts, awaiting_approval and approved-but-unpublished stay out); archiving or
 * unpublishing the last episode removes it; files carry only allow-listed keys.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "@ncs/db/orm";
import { conceptBriefs, conceptSessions, episodes, novels } from "@ncs/db/schema";
import { pgliteSqlClient } from "@ncs/public-schema";
import {
  PUBLIC_EPISODE_KEYS,
  PUBLIC_HOME_KEYS,
  PUBLIC_LIST_KEYS,
  PUBLIC_REF_KEYS,
  PUBLIC_SUMMARY_KEYS,
  PUBLIC_SLUG_RE,
  PUBLIC_TOC_KEYS,
  isPublicSlug,
} from "@ncs/reader-core/snapshot";
import { PUBLIC_AUTHOR_NAME, PUBLIC_SITE_ORIGIN, PUBLIC_SITE_SLUG_RE, isPublicSiteSlug, publicSiteNovelDtoSchema, publicSiteStatusDtoSchema } from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { PUBLIC_SITE_ADMIN_TOKEN_SECRET, PUBLIC_SITE_REVALIDATE_PATH, type PublicDbConnector } from "../../src/modules/publication/index.js";
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

  it("exposes automatically (no opt-in): slug = lowercased novel id, author fixed, novels without a published episode not listed", async () => {
    const r = await t.http("GET", settings());
    expect(r.status).toBe(200);
    const slug = novelId.toLowerCase();
    expect(slug).toMatch(/^nov_[0-9a-z]{26}$/);
    expect(publicSiteNovelDtoSchema.parse(r.body)).toMatchObject({
      slug,
      publicUrl: `https://novel.snowlink.team/novels/${slug}`,
      exposed: true,
      archived: false,
      authorName: PUBLIC_AUTHOR_NAME,
      publishedEpisodeCount: 2,
    });
    expect(PUBLIC_AUTHOR_NAME).toBe("새벽눈길");
    expect((await t.http("GET", settings(otherId))).body).toMatchObject({ slug: otherId.toLowerCase(), exposed: false, publishedEpisodeCount: 0 });
    const s = publicSiteStatusDtoSchema.parse((await t.http("POST", "/api/public-site/build")).body);
    expect(s).toMatchObject({ novelCount: 1, episodeCount: 2, lastError: null });
    expect(s.outputDir).toBe(join(t.home, "public-site", "data"));
    expect(read("novels.json").novels.map((n: { slug: string }) => n.slug)).toEqual([slug]);
    expect(existsSync(join(dir(), "novels", otherId.toLowerCase()))).toBe(false);
    expect((await t.http("GET", settings())).body).toMatchObject({ lastSyncedAt: expect.any(String) });
  });

  it("only the intro is editable: the old opt-in / slug / author fields are rejected", async () => {
    for (const body of [{ enabled: true }, { slug: "my-novel" }, { authorName: "작가" }, { intro: "x", unknown: 1 }]) {
      expect((await t.http("PATCH", settings(), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await t.http("PATCH", settings(), { intro: "x".repeat(2001) })).status).toBe(400);
  });

  it("writes only published versions, with allow-listed keys only and the fixed author name", async () => {
    const slug = novelId.toLowerCase();
    const r = await t.http("PATCH", settings(), { intro: "  공개 소개입니다.  " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ exposed: true, slug, intro: "  공개 소개입니다.  ", authorName: PUBLIC_AUTHOR_NAME });
    expect(t.modules.publication.service.status()).toMatchObject({ novelCount: 1, episodeCount: 2 });

    const list = read("novels.json");
    expect(Object.keys(list).sort()).toEqual([...PUBLIC_LIST_KEYS].sort());
    expect(list.novels).toHaveLength(1);
    expect(Object.keys(list.novels[0]).sort()).toEqual([...PUBLIC_SUMMARY_KEYS].sort());
    expect(list.novels[0]).toMatchObject({ slug, title: "공개 테스트", genre: "판타지", authorName: "새벽눈길", intro: "공개 소개입니다.", episodeCount: 2 });

    const home = read(`novels/${slug}/index.json`);
    expect(Object.keys(home).sort()).toEqual([...PUBLIC_HOME_KEYS].sort());
    expect(home.authorName).toBe("새벽눈길");
    expect(home.episodes.map((e: { episodeNo: number }) => e.episodeNo)).toEqual([1, 2]);
    for (const e of home.episodes) expect(Object.keys(e).sort()).toEqual([...PUBLIC_TOC_KEYS].sort());

    const ep1 = read(`novels/${slug}/episodes/1.json`);
    expect(Object.keys(ep1).sort()).toEqual([...PUBLIC_EPISODE_KEYS].sort());
    expect(ep1).toMatchObject({ episodeNo: 1, title: "1화 제목", prev: null, next: { episodeNo: 2, title: "2화 제목" } });
    expect(Object.keys(ep1.next).sort()).toEqual([...PUBLIC_REF_KEYS].sort());
    expect(ep1.text).toContain("공개된 1화 본문.");
    expect(read(`novels/${slug}/episodes/2.json`).text).toBe("공개된 2화 본문.");
    expect(readdirSync(join(dir(), `novels/${slug}/episodes`)).sort()).toEqual(["1.json", "2.json"]);

    // no internal text or other ids anywhere in the output (the novel's own id, lowercased, IS its public address)
    const all = ["novels.json", `novels/${slug}/index.json`, `novels/${slug}/episodes/1.json`, `novels/${slug}/episodes/2.json`]
      .map((f) => readFileSync(join(dir(), f), "utf8"))
      .join("\n");
    expect(all).not.toContain(SECRET_NOTE);
    expect(all).not.toContain(otherId.toLowerCase());
    for (const id of ids) {
      expect(all).not.toContain(id);
      expect(all).not.toContain(id.toLowerCase());
    }
    expect(all).not.toMatch(/"(id|novelId|versionId|arcId|status)"/);
  });

  it("an archived novel is not on the public site", async () => {
    const slug = novelId.toLowerCase();
    const was = (await t.platform.uow.db.select({ status: novels.status, briefId: novels.approvedConceptBriefId }).from(novels).where(eq(novels.id, novelId)))[0]!;
    // a non-concept status needs an approved brief (novels_ck_3): a minimal one stands in
    const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novelId));
    const briefId = t.platform.ids.next("cbf");
    await t.testDb.db.insert(conceptBriefs).values({
      id: briefId,
      novelId,
      sessionId: session!.id,
      versionNo: 1,
      authorActorType: "user",
      authorActorId: t.ownerId,
      entryMode: "conversation",
      questionSetVersion: "common@1",
      content: {},
      contentMd: "# 브리프",
    } as typeof conceptBriefs.$inferInsert);
    await t.platform.uow.db.update(novels).set({ status: "archived", approvedConceptBriefId: briefId }).where(eq(novels.id, novelId));
    try {
      await t.modules.publication.service.rebuild();
      expect(existsSync(join(dir(), "novels", slug))).toBe(false);
      expect(read("novels.json").novels).toEqual([]);
      expect((await t.http("GET", settings())).body).toMatchObject({ exposed: false, archived: true, publishedEpisodeCount: 2 });
    } finally {
      await t.platform.uow.db.update(novels).set({ status: was.status, approvedConceptBriefId: was.briefId }).where(eq(novels.id, novelId));
    }
    await t.modules.publication.service.rebuild();
    expect(read("novels.json").novels).toHaveLength(1);
  });

  it("removes an unpublished episode's file and picks up title changes on reconcile", async () => {
    const slug = novelId.toLowerCase();
    await t.platform.uow.db.update(episodes).set({ status: "approved", publishedVersionId: null, publishedAt: null }).where(eq(episodes.id, ids[1]!));
    await t.platform.uow.db.update(episodes).set({ title: "새 1화 제목" }).where(eq(episodes.id, ids[0]!));
    await t.modules.publication.service.rebuild();
    expect(existsSync(join(dir(), `novels/${slug}/episodes/2.json`))).toBe(false);
    const ep1 = read(`novels/${slug}/episodes/1.json`);
    expect(ep1).toMatchObject({ title: "새 1화 제목", next: null });
    expect(read(`novels/${slug}/index.json`).episodes).toHaveLength(1);
  });

  it("unpublishing the last episode removes the novel's files and its list entry", async () => {
    await t.platform.uow.db.update(episodes).set({ status: "approved", publishedVersionId: null, publishedAt: null }).where(eq(episodes.id, ids[0]!));
    await t.modules.publication.service.rebuild();
    expect(existsSync(join(dir(), "novels", novelId.toLowerCase()))).toBe(false);
    expect(read("novels.json").novels).toEqual([]);
    expect(t.modules.publication.service.status()).toMatchObject({ novelCount: 0, episodeCount: 0 });
    expect((await t.http("GET", settings())).body).toMatchObject({ exposed: false, publishedEpisodeCount: 0 });
  });

  it("records the settings change in the audit timeline", async () => {
    const page = await t.modules.audit.service.list({ novelId }, { actionPrefix: "publication." });
    expect(page.items.length).toBeGreaterThanOrEqual(1);
  });

  it("slug rules agree everywhere and allow '_'", () => {
    expect(PUBLIC_SITE_SLUG_RE.source).toBe(PUBLIC_SLUG_RE.source);
    for (const ok of ["nov_01m6qxdwfxeahe006mnnhf9j5j", "my-novel", "a", "a_b-c"]) expect(isPublicSlug(ok) && isPublicSiteSlug(ok), ok).toBe(true);
    for (const bad of ["_a", "a_", "-a", "a-", "a--b", "A", "한글", "a b", "x".repeat(65), "../etc"]) {
      expect(isPublicSlug(bad), bad).toBe(false);
      expect(isPublicSiteSlug(bad), bad).toBe(false);
    }
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

/**
 * After a Supabase sync that changed rows (publish / unpublish, or a forced [지금 동기화]) the studio asks snowpage to
 * drop its content cache: POST PUBLIC_SITE_ORIGIN/api/admin/revalidate with the saved ADMIN_TOKEN as bearer. Best
 * effort: a failing call never fails the sync; the token is never returned.
 */
describe("publication → snowpage cache revalidate", () => {
  const TOKEN = "snowpage-admin-token-0123456789-abc";
  const URL_OK = "postgresql://postgres.abcd:pw-secret-123@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres";
  const REVALIDATE_URL = `${PUBLIC_SITE_ORIGIN}${PUBLIC_SITE_REVALIDATE_PATH}`;
  let t: TestCore;
  let pg: PGlite;
  let novelId: string;
  const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
  let reply: () => Response = () => Response.json({ ok: true, revalidatedAt: "2026-11-11T00:00:00.000Z" });
  const realFetch = globalThis.fetch;
  const untilCalls = async (n: number) => {
    const deadline = Date.now() + 10_000;
    while (calls.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(n);
    // the debounced rebuild that made the call is still finishing its bookkeeping: wait for the sync chain
    await t.modules.publication.service.rebuild();
  };
  const status = async () => {
    const r = await t.http("GET", "/api/public-site");
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    return publicSiteStatusDtoSchema.parse(r.body);
  };

  beforeAll(async () => {
    pg = await PGlite.create();
    const connector: PublicDbConnector = () => ({ client: pgliteSqlClient(pg), close: async () => undefined });
    // only the snowpage origin is faked; the test core's own HTTP calls keep using the real fetch
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(PUBLIC_SITE_ORIGIN)) return realFetch(input, init);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      return reply();
    });
    t = await createTestCore({ publicDbConnector: connector });
    novelId = (await t.modules.novel.service.createNovel({ title: "캐시 갱신 작품" }, t.owner)).id;
    const scope = { novelId };
    const ms = t.modules.manuscript.service;
    const arc = await t.modules.novel.service.createArc(undefined, scope, { ord: 1, title: "막", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 3 }, t.owner);
    const by = { approvedAt: new Date(), approvedByActorType: "user" as const, approvedByActorId: t.ownerId };
    const pub = { publishedAt: new Date("2026-11-10T00:00:00Z"), publishedByActorType: "user" as const, publishedByActorId: t.ownerId };
    await t.platform.uow.run(async (tx) => {
      const [e1, e2, e3] = await ms.createPlannedEpisodes(tx, scope, arc.id, [1, 2, 3].map((n) => ({ episodeNo: n, title: `${n}화` })), t.owner);
      const v1 = await ms.saveVersion(tx, scope, e1!.id, { kind: "final", content: "공개 1화.", author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, ...pub, approvedVersionId: v1.id, publishedVersionId: v1.id, currentVersionId: v1.id }).where(eq(episodes.id, e1!.id));
      // 2화 / 3화: approved → publishable over HTTP
      for (const e of [e2!, e3!]) {
        const v = await ms.saveVersion(tx, scope, e.id, { kind: "final", content: `공개 ${e.episodeNo}화.`, author: t.owner });
        await tx.db.update(episodes).set({ status: "approved", ...by, approvedVersionId: v.id, currentVersionId: v.id }).where(eq(episodes.id, e.id));
      }
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
    await pg?.close();
  });

  it("without a token: nothing is called and the status says so", async () => {
    expect((await status()).revalidate).toEqual({ configured: false, lastAt: null, lastOk: null, lastMessage: null });
    const r = await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_OK });
    expect(r.status).toBe(200);
    expect(publicSiteStatusDtoSchema.parse(r.body)).toMatchObject({ target: "supabase", lastError: null, episodeCount: 1, revalidate: { configured: false } });
    expect(calls).toEqual([]);
  });

  it("saving the token (write-only) forces a sync and purges the reader cache once with the bearer header", async () => {
    expect((await t.http("PUT", "/api/public-site/config", { adminToken: "short" })).status).toBe(400);
    const r = await t.http("PUT", "/api/public-site/config", { adminToken: ` ${TOKEN} ` });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(publicSiteStatusDtoSchema.parse(r.body)).toMatchObject({ lastError: null, revalidate: { configured: true, lastOk: true, lastAt: expect.any(String), lastMessage: expect.any(String) } });
    expect(await t.modules.system.service.secrets.get(PUBLIC_SITE_ADMIN_TOKEN_SECRET)).toBe(TOKEN);
    expect(calls).toEqual([{ url: REVALIDATE_URL, method: "POST", authorization: `Bearer ${TOKEN}`, body: { scope: "all" } }]);
    // the audit row records only that the token changed
    const page = await t.modules.audit.service.list(null, { actionPrefix: "publication.config_changed" });
    expect(JSON.stringify(page.items)).not.toContain(TOKEN);
    expect(JSON.stringify(page.items)).toContain('"adminTokenChanged":true');
  });

  it("an unchanged sync does not call it", async () => {
    await t.modules.publication.service.rebuild();
    await t.modules.publication.service.rebuild();
    expect(calls).toHaveLength(1);
  });

  it("publishing an episode in the studio triggers the sync and one purge", async () => {
    const pub = await t.http("POST", `/api/novels/${novelId}/episodes/2/publish`);
    expect(pub.status).toBe(200);
    await untilCalls(2);
    expect(calls[1]).toEqual({ url: REVALIDATE_URL, method: "POST", authorization: `Bearer ${TOKEN}`, body: { scope: "all" } });
    const s = await status();
    expect(s).toMatchObject({ lastError: null, episodeCount: 2, revalidate: { configured: true, lastOk: true } });
    expect((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM ncs_public.episodes")).rows[0]!.n).toBe(2);
  });

  it("a failing purge (HTTP 500) leaves the sync successful and only marks the revalidate status", async () => {
    reply = () => Response.json({ error: { code: "internal", message: "잠시 문제가 생겼습니다." } }, { status: 500 });
    const pub = await t.http("POST", `/api/novels/${novelId}/episodes/3/publish`);
    expect(pub.status).toBe(200);
    await untilCalls(3);
    const s = await status();
    expect(s.lastError).toBeNull();
    expect(s.episodeCount).toBe(3);
    expect(s.revalidate).toMatchObject({ configured: true, lastOk: false, lastMessage: expect.stringContaining("HTTP 500") });
    expect(s.revalidate.lastMessage).not.toContain(TOKEN);
  });

  it("a network failure is sanitized too, and a forced sync always purges", async () => {
    reply = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND novel.snowlink.team"), { code: "ENOTFOUND" }) });
    };
    const s = publicSiteStatusDtoSchema.parse((await t.http("POST", "/api/public-site/build")).body);
    expect(calls).toHaveLength(4);
    expect(s.lastError).toBeNull();
    expect(s.revalidate).toMatchObject({ lastOk: false, lastMessage: "연결 실패(ENOTFOUND)." });
  });

  it("clearing the token stops the purges", async () => {
    const r = await t.http("PUT", "/api/public-site/config", { adminToken: null });
    expect(r.status).toBe(200);
    expect(publicSiteStatusDtoSchema.parse(r.body).revalidate).toEqual({ configured: false, lastAt: null, lastOk: null, lastMessage: null });
    expect(await t.modules.system.service.secrets.has(PUBLIC_SITE_ADMIN_TOKEN_SECRET)).toBe(false);
    expect(calls).toHaveLength(4);
  });
});
