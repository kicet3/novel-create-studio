/**
 * 공개 사이트 → Supabase 동기화 (an in-process PGlite with unrelated objects stands in for the user's Supabase DB):
 * the writer URL is an encrypted secret (never returned / logged), the studio applies the public schema itself,
 * only published versions of opted-in novels are upserted (allow-listed columns), unpublish / opt-out deletes rows,
 * reactions are left alone, unchanged novels are skipped, errors are sanitized.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { episodes, novels } from "@ncs/db/schema";
import { PUBLIC_EPISODE_COLUMNS, PUBLIC_NOVEL_COLUMNS, PUBLIC_SCHEMA_LATEST_VERSION, pgliteSqlClient } from "@ncs/public-schema";
import { publicSiteCheckDtoSchema, publicSiteRoleSqlDtoSchema, publicSiteStatusDtoSchema } from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { PUBLIC_SITE_DB_SECRET, type PublicDbConnector } from "../../src/modules/publication/index.js";
import { sanitizePublicDbError } from "../../src/modules/publication/adapters/pg/public-db.js";

const SECRET_NOTE = "내부메모-절대-공개-금지";
const PASSWORD = "sup3r-s3cret-pw-XYZ";
const URL_OK = `postgresql://postgres.abcd:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`;
const URL_BAD = `postgresql://postgres.abcd:${PASSWORD}@unreachable.example.invalid:5432/postgres`;
const SCHEMA = "ncs_public";

describe("publication → Supabase public schema", () => {
  let t: TestCore;
  let pg: PGlite;
  let novelId: string;
  let ids: string[] = [];
  const connected: string[] = [];
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec(`CREATE TABLE public.other_app (id int PRIMARY KEY, v text); INSERT INTO public.other_app VALUES (1, 'theirs');`);
    const connector: PublicDbConnector = (url) => {
      connected.push(url);
      if (url.includes("unreachable")) {
        const fail = async () => {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND while connecting to ${url}`), { code: "ENOTFOUND" });
        };
        return { client: { query: fail, exec: fail, transaction: fail }, close: async () => undefined };
      }
      return { client: pgliteSqlClient(pg), close: async () => undefined };
    };
    t = await createTestCore({ publicDbConnector: connector });
    novelId = (await t.modules.novel.service.createNovel({ title: "동기화 작품" }, t.owner)).id;
    await t.platform.uow.db.update(novels).set({ genre: "로맨스" }).where(eq(novels.id, novelId));
    const scope = { novelId };
    const ms = t.modules.manuscript.service;
    const arc = await t.modules.novel.service.createArc(
      undefined,
      scope,
      { ord: 1, title: SECRET_NOTE, goalText: SECRET_NOTE, conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 3 },
      t.owner,
    );
    const by = { approvedAt: new Date(), approvedByActorType: "user" as const, approvedByActorId: t.ownerId };
    const pub = { publishedAt: new Date("2026-11-02T00:00:00Z"), publishedByActorType: "user" as const, publishedByActorId: t.ownerId };
    await t.platform.uow.run(async (tx) => {
      const eps = await ms.createPlannedEpisodes(tx, scope, arc.id, [1, 2, 3].map((n) => ({ episodeNo: n, title: `${n}화` })), t.owner);
      ids = eps.map((e) => e.id);
      const [e1, e2, e3] = eps;
      const v1 = await ms.saveVersion(tx, scope, e1!.id, { kind: "final", content: "공개 1화 본문.", author: t.owner });
      const v1d = await ms.saveVersion(tx, scope, e1!.id, { kind: "draft", content: `초안 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, ...pub, approvedVersionId: v1.id, publishedVersionId: v1.id, currentVersionId: v1d.id, hookNote: SECRET_NOTE }).where(eq(episodes.id, e1!.id));
      const v2 = await ms.saveVersion(tx, scope, e2!.id, { kind: "final", content: "공개 2화 본문.", author: t.owner });
      await tx.db.update(episodes).set({ status: "published", ...by, ...pub, approvedVersionId: v2.id, publishedVersionId: v2.id, currentVersionId: v2.id }).where(eq(episodes.id, e2!.id));
      const v3 = await ms.saveVersion(tx, scope, e3!.id, { kind: "final", content: `승인만 ${SECRET_NOTE}`, author: t.owner });
      await tx.db.update(episodes).set({ status: "approved", ...by, approvedVersionId: v3.id, currentVersionId: v3.id }).where(eq(episodes.id, e3!.id));
    });
  });
  afterAll(async () => {
    await t?.close();
    await pg?.close();
  });

  it("defaults to the files target until a writer URL is saved", async () => {
    const s = publicSiteStatusDtoSchema.parse((await t.http("GET", "/api/public-site")).body);
    expect(s).toMatchObject({ target: "files", targetSource: "default", supabase: { configured: false, schema: SCHEMA, host: null } });
    const role = publicSiteRoleSqlDtoSchema.parse((await t.http("GET", "/api/public-site/role-sql")).body);
    expect(role).toMatchObject({ role: "ncs_public_reader", schema: SCHEMA });
    expect(role.sql).toContain(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "ncs_public_reader";`);
    expect(role.sql).toContain("<직접 입력>");
    const check = publicSiteCheckDtoSchema.parse((await t.http("POST", "/api/public-site/check")).body);
    expect(check.ok).toBe(false);
  });

  it("validates the config without echoing the URL", async () => {
    for (const body of [{ schema: "public" }, { schema: "auth" }, { schema: "Bad-Name" }, { target: "s3" }, { databaseUrl: `mysql://u:${PASSWORD}@h/db` }]) {
      const r = await t.http("PUT", "/api/public-site/config", body);
      expect([400, 422], JSON.stringify(body)).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    }
  });

  it("stores the writer URL encrypted, never returns it, and migrates + syncs on save", async () => {
    // opt the novel in first (files target for now)
    expect((await t.http("PATCH", `/api/novels/${novelId}/public-site`, { enabled: true, slug: "sync-novel", authorName: "작가", intro: "소개" })).status).toBe(200);
    const r = await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_OK });
    expect(r.status).toBe(200);
    const s = publicSiteStatusDtoSchema.parse(r.body);
    expect(s).toMatchObject({ target: "supabase", targetSource: "default", lastError: null, novelCount: 1, episodeCount: 2 });
    expect(s.supabase).toEqual({ configured: true, schema: SCHEMA, host: "aws-0-ap-northeast-2.pooler.supabase.com", schemaVersion: PUBLIC_SCHEMA_LATEST_VERSION, latestSchemaVersion: PUBLIC_SCHEMA_LATEST_VERSION });
    expect(s.lastRun).toMatchObject({ upsertedNovels: 1, upsertedEpisodes: 2, deletedNovels: 0, deletedEpisodes: 0 });
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);

    // encrypted at rest; the secrets API lists metadata only
    expect(await t.modules.system.service.secrets.get(PUBLIC_SITE_DB_SECRET)).toBe(URL_OK);
    const stored = await t.testDb.pg.query<{ v: string }>("SELECT row_to_json(s)::text AS v FROM secrets s");
    expect(stored.rows.map((x) => x.v).join("\n")).not.toContain(PASSWORD);
    const list = await t.http("GET", "/api/system/secrets");
    expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
    // audit trail has no URL either
    const activity = await t.testDb.pg.query<{ v: string }>("SELECT row_to_json(a)::text AS v FROM activity_log a WHERE action = 'publication.config_changed'");
    expect(activity.rows.length).toBe(1);
    expect(activity.rows[0]!.v).not.toContain(PASSWORD);
    expect(activity.rows[0]!.v).not.toContain("pooler.supabase.com");

    // public rows: published versions only, allow-listed columns only, nothing internal
    const cols = async (table: string) =>
      (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [SCHEMA, table])).map((c) => c.column_name);
    expect((await cols("novels")).sort()).toEqual([...PUBLIC_NOVEL_COLUMNS].sort());
    expect((await cols("episodes")).sort()).toEqual([...PUBLIC_EPISODE_COLUMNS].sort());
    const n = await q(`SELECT * FROM ${SCHEMA}.novels`);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ slug: "sync-novel", title: "동기화 작품", author_name: "작가", intro: "소개", genre: "로맨스", episode_count: 2 });
    const e = await q<{ episode_no: number; body: string }>(`SELECT * FROM ${SCHEMA}.episodes ORDER BY episode_no`);
    expect(e.map((x) => x.episode_no)).toEqual([1, 2]);
    expect(e[0]!.body).toContain("공개 1화 본문.");
    const dump = JSON.stringify([n, e]);
    expect(dump).not.toContain(SECRET_NOTE);
    expect(dump).not.toContain(novelId);
    for (const id of ids) expect(dump).not.toContain(id);
    // the user's other objects are untouched
    expect(await q("SELECT * FROM public.other_app")).toEqual([{ id: 1, v: "theirs" }]);
  });

  it("[연결 확인] reports the schema version; status never carries the URL", async () => {
    const c = publicSiteCheckDtoSchema.parse((await t.http("POST", "/api/public-site/check")).body);
    expect(c).toMatchObject({ ok: true, schemaVersion: PUBLIC_SCHEMA_LATEST_VERSION });
    expect(JSON.stringify((await t.http("GET", "/api/public-site")).body)).not.toContain(PASSWORD);
  });

  it("skips unchanged novels and is idempotent", async () => {
    const s = publicSiteStatusDtoSchema.parse((await t.http("POST", "/api/public-site/build")).body);
    expect(s.lastRun).toEqual({ upsertedNovels: 0, upsertedEpisodes: 0, deletedNovels: 0, deletedEpisodes: 0, unchangedNovels: 1 });
    expect(await q(`SELECT count(*)::int AS n FROM ${SCHEMA}.episodes`)).toEqual([{ n: 2 }]);
  });

  it("deletes an unpublished episode's row but keeps its reactions", async () => {
    await q(`INSERT INTO ${SCHEMA}.visitors (id) VALUES ('v_aaaaaaaaaaaaaaaaaaaaaaaa')`);
    await q(`INSERT INTO ${SCHEMA}.comments (novel_slug, episode_no, visitor_id, body, body_hash, ip_hash) VALUES ('sync-novel', 2, 'v_aaaaaaaaaaaaaaaaaaaaaaaa', '좋아요', 'h', 'ih')`);
    await t.platform.uow.db.update(episodes).set({ status: "approved", publishedVersionId: null, publishedAt: null }).where(eq(episodes.id, ids[1]!));
    await t.platform.uow.db.update(episodes).set({ title: "새 1화" }).where(eq(episodes.id, ids[0]!));
    const s = publicSiteStatusDtoSchema.parse(await t.modules.publication.service.rebuild());
    expect(s.lastRun).toMatchObject({ upsertedEpisodes: 1, deletedEpisodes: 1, upsertedNovels: 1 });
    expect(await q(`SELECT episode_no, title FROM ${SCHEMA}.episodes`)).toEqual([{ episode_no: 1, title: "새 1화" }]);
    expect(await q(`SELECT count(*)::int AS n FROM ${SCHEMA}.comments`)).toEqual([{ n: 1 }]);
  });

  it("opt-out deletes the novel and its episodes", async () => {
    expect((await t.http("PATCH", `/api/novels/${novelId}/public-site`, { enabled: false })).status).toBe(200);
    expect(await q(`SELECT count(*)::int AS n FROM ${SCHEMA}.novels`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM ${SCHEMA}.episodes`)).toEqual([{ n: 0 }]);
    expect(t.modules.publication.service.status()).toMatchObject({ novelCount: 0, episodeCount: 0, lastError: null });
  });

  it("reports connection errors sanitized (no URL, no password)", async () => {
    const r = await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_BAD });
    const s = publicSiteStatusDtoSchema.parse(r.body);
    expect(s.lastError).toMatch(/호스트를 찾을 수 없습니다/);
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(r.body)).not.toContain("unreachable.example.invalid:5432");
    const c = publicSiteCheckDtoSchema.parse((await t.http("POST", "/api/public-site/check")).body);
    expect(c.ok).toBe(false);
    expect(c.message).not.toContain(PASSWORD);
    expect(sanitizePublicDbError(new Error(`boom ${URL_BAD} password=${PASSWORD}`), URL_BAD)).not.toContain(PASSWORD);
  });

  it("an undecryptable writer secret (lost / different master key) never blocks startup and is reported plainly", async () => {
    expect((await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_OK })).status).toBe(200);
    // simulate the DB restored on another PC: the stored ciphertext no longer authenticates under this key
    await t.testDb.pg.query("UPDATE secrets SET auth_tag = $1 WHERE id = $2", [Buffer.alloc(16).toString("base64"), PUBLIC_SITE_DB_SECRET]);
    const svc = t.modules.publication.service;
    await expect(svc.init()).resolves.toBeUndefined();
    expect(svc.status()).toMatchObject({ supabase: { configured: true, host: null } });
    expect(svc.status().lastError).toMatch(/복호화할 수 없습니다/);
    const c = publicSiteCheckDtoSchema.parse((await t.http("POST", "/api/public-site/check")).body);
    expect(c).toMatchObject({ ok: false });
    expect(c.message).toMatch(/복호화할 수 없습니다/);
    const s = await svc.rebuild({ force: true });
    expect(s.lastError).toMatch(/복호화할 수 없습니다/);
    // re-entering the URL recovers
    const r = publicSiteStatusDtoSchema.parse((await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_OK })).body);
    expect(r).toMatchObject({ lastError: null, supabase: { configured: true } });
  });

  it("files target can be chosen explicitly; clearing the URL falls back to files", async () => {
    const r = await t.http("PUT", "/api/public-site/config", { databaseUrl: null });
    expect(publicSiteStatusDtoSchema.parse(r.body)).toMatchObject({ target: "files", supabase: { configured: false, host: null } });
    expect(await t.modules.system.service.secrets.has(PUBLIC_SITE_DB_SECRET)).toBe(false);
    const r2 = await t.http("PUT", "/api/public-site/config", { databaseUrl: URL_OK, target: "files", schema: "reader_site" });
    expect(publicSiteStatusDtoSchema.parse(r2.body)).toMatchObject({ target: "files", targetSource: "explicit", supabase: { configured: true, schema: "reader_site" } });
    expect(connected.every((u) => u === URL_OK || u === URL_BAD)).toBe(true);
  });
});
