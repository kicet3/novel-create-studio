/**
 * snowpage API against the public schema (an in-process PGlite stands in for Supabase; schema applied by
 * @ncs/public-schema like the studio does): anonymous visitor cookie, CSRF + Origin, rate limits, honeypot,
 * duplicates, banned words, one like / one rating per visitor, reply depth, own-comment delete only, admin gating,
 * unpublished 404, and no visitor id / ip hash in any response. There is no login / signup route.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPublicSchema, pgliteSqlClient, type SqlClient } from "@ncs/public-schema";
import type { CommentListDto, EpisodeStatsDto, NovelStatsDto, SessionDto } from "../src/lib/api-types";
import { createReaderApi, type ReaderApi } from "../src/server/api";
import { parseEnv } from "../src/server/env";
import { getEpisode, getNovel, listNovels, sitemapRows } from "../src/server/content";

const SCHEMA = "ncs_public_rt";
const ORIGIN = "https://novel.snowlink.team";
const ADMIN = "admin-token-0123456789-abcdefghij";
const IP_SECRET = "ip-hash-secret-0123456789-abcdefghijklmnop";

let pg: PGlite;
let db: SqlClient;
let clock = Date.parse("2026-11-07T00:00:00Z");

const envOf = (over: Record<string, string> = {}) =>
  parseEnv({ DATABASE_URL: "postgresql://x:y@localhost/db", DB_SCHEMA: SCHEMA, ADMIN_TOKEN: ADMIN, IP_HASH_SECRET: IP_SECRET, BANNED_WORDS: "금칙어, spam link", ...over });

/** a browser: cookie jar + CSRF token */
class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(
    readonly api: ReaderApi,
    readonly ip = "203.0.113.7",
    readonly origin: string | null = ORIGIN,
  ) {}
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "x-real-ip": this.ip, ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET") {
      if (this.origin) headers.origin = this.origin;
      if (this.csrf && !("x-csrf-token" in extra)) headers["x-csrf-token"] = this.csrf;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`${ORIGIN}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await this.api.handle(req, path.split("?")[0]!.split("/"));
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const k = kv!.slice(0, i);
      const v = kv!.slice(i + 1);
      if (/Max-Age=0/.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = res.status === 204 ? "" : await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers, setCookies: res.headers.getSetCookie() };
  }
  async start() {
    const r = await this.call("GET", "session");
    this.csrf = (r.body as SessionDto).csrf;
    return r;
  }
}

async function seed() {
  await pg.exec(`
    INSERT INTO ${SCHEMA}.novels (slug, title, author_name, intro, genre, age_rating, episode_count, latest_published_at, content_hash)
      VALUES ('pub-novel', '공개 작품', '작가', '소개 <b>굵게</b>', '판타지', 'all', 2, '2026-11-01T00:00:00Z', 'h');
    INSERT INTO ${SCHEMA}.episodes (novel_slug, episode_no, title, body, char_count, published_at, content_hash)
      VALUES ('pub-novel', 1, '1화', '첫 문단\n\n둘째 문단', 10, '2026-11-01T00:00:00Z', 'h1'),
             ('pub-novel', 2, '2화', '두 번째 화', 6, '2026-11-02T00:00:00Z', 'h2');
  `);
}

let api: ReaderApi;

beforeAll(async () => {
  pg = await PGlite.create();
  db = pgliteSqlClient(pg);
  await applyPublicSchema(db, SCHEMA);
  await seed();
  api = createReaderApi({ env: envOf(), db: () => db, now: () => clock });
});
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  clock += 3600_000; // fresh rate-limit windows per test
});

const ep = (no = 1) => `novels/pub-novel/episodes/${no}`;

describe("content reads", () => {
  it("lists only synced rows and 404s the rest", async () => {
    expect((await listNovels(db, SCHEMA)).map((n) => n.slug)).toEqual(["pub-novel"]);
    const n = await getNovel(db, SCHEMA, "pub-novel");
    expect(n?.episodes.map((e) => e.episodeNo)).toEqual([1, 2]);
    expect(await getNovel(db, SCHEMA, "nope")).toBeNull();
    expect(await getNovel(db, SCHEMA, "../etc")).toBeNull();
    const e1 = await getEpisode(db, SCHEMA, "pub-novel", 1);
    expect(e1).toMatchObject({ episodeNo: 1, prev: null, next: { episodeNo: 2, title: "2화" }, novelTitle: "공개 작품" });
    expect(await getEpisode(db, SCHEMA, "pub-novel", 3)).toBeNull();
    expect((await sitemapRows(db, SCHEMA)).length).toBe(3);
  });
});

describe("anonymous reactions", () => {
  it("issues a CSRF token on GET /session but no visitor id until the first write", async () => {
    const b = new Browser(api);
    const r = await b.start();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ csrf: expect.any(String), writable: true });
    expect([...b.cookies.keys()]).toEqual(["__Host-snowpage_csrf"]);
    expect(r.setCookies[0]).toMatch(/HttpOnly/);
    expect(r.setCookies[0]).toMatch(/Secure/);
    expect(r.setCookies[0]).toMatch(/SameSite=Lax/);
    expect(r.setCookies[0]).not.toMatch(/Domain=/i);
    expect(r.headers.get("cache-control")).toBe("no-store");

    const like = await b.call("POST", `${ep()}/like`, { liked: true });
    expect(like.status).toBe(200);
    expect(like.body).toEqual({ likes: 1, liked: true, comments: 0 } satisfies EpisodeStatsDto);
    const vid = b.cookies.get("__Host-snowpage_vid");
    expect(vid).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(like.setCookies.find((c) => c.startsWith("__Host-snowpage_vid"))).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    expect(like.text).not.toContain(vid!);
  });

  it("rejects writes without the CSRF token or from another origin", async () => {
    const b = new Browser(api);
    await b.start();
    expect((await b.call("POST", `${ep()}/like`, { liked: true }, { "x-csrf-token": "" })).status).toBe(403);
    expect((await b.call("POST", `${ep()}/like`, { liked: true }, { "x-csrf-token": "wrong-token-wrong-token-xx" })).status).toBe(403);
    const evil = new Browser(api, "203.0.113.8", "https://evil.example");
    await evil.start();
    expect((await evil.call("POST", `${ep()}/like`, { liked: true })).body.error.code).toBe("bad_origin");
    const none = new Browser(api, "203.0.113.9", null);
    await none.start();
    expect((await none.call("POST", `${ep()}/like`, { liked: true })).status).toBe(403);
    // preview origins only with the flag
    const preview = new Browser(api, "203.0.113.10", "https://snowpage-git-x.vercel.app");
    await preview.start();
    expect((await preview.call("POST", `${ep()}/like`, { liked: true })).status).toBe(403);
    const apiPreview = createReaderApi({ env: envOf({ ALLOW_PREVIEW_ORIGINS: "true" }), db: () => db, now: () => clock });
    const p2 = new Browser(apiPreview, "203.0.113.10", "https://snowpage-git-x.vercel.app");
    await p2.start();
    expect((await p2.call("POST", `${ep()}/like`, { liked: true })).status).toBe(200);
    // form posts (non-JSON) are refused
    const form = await b.call("POST", `${ep()}/like`, undefined, { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(400);
  });

  it("does not honour a self-made visitor id: unknown ids are replaced and count against the new-visitor cap", async () => {
    const forged = (i: number) => `forged${String(i).padStart(4, "0")}AAAAAAAAAAAAAAAA`;
    const b = new Browser(api, "198.51.100.77");
    await b.start();
    b.cookies.set("__Host-snowpage_vid", forged(0));
    const r = await b.call("POST", "novels/pub-novel/like", { liked: true });
    expect(r.status).toBe(200);
    const issued = b.cookies.get("__Host-snowpage_vid");
    expect(issued).not.toBe(forged(0));
    expect(r.setCookies.some((c) => c.startsWith("__Host-snowpage_vid="))).toBe(true);
    expect((await pg.query(`SELECT 1 FROM ${SCHEMA}.visitors WHERE id = $1`, [forged(0)])).rows).toHaveLength(0);
    // an issued id keeps working without a new cookie
    const again = await b.call("POST", "novels/pub-novel/like", { liked: true });
    expect(again.setCookies.some((c) => c.startsWith("__Host-snowpage_vid="))).toBe(false);
    expect((again.body as NovelStatsDto).likes).toBe(1);
    await b.call("POST", "novels/pub-novel/like", { liked: false });
    // rotating forged ids from one IP hits newVisitorIp (20/hour; 1 already used above)
    const statuses: number[] = [];
    for (let i = 1; i <= 21; i++) {
      b.cookies.set("__Host-snowpage_vid", forged(i));
      statuses.push((await b.call("POST", "novels/pub-novel/like", { liked: true })).status);
    }
    expect(statuses.slice(0, 19).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(19)).toEqual([429, 429]);
    await pg.query(`DELETE FROM ${SCHEMA}.novel_likes`);
  });

  it("one like and one (updatable) rating per visitor", async () => {
    const b = new Browser(api, "198.51.100.1");
    await b.start();
    await b.call("POST", "novels/pub-novel/like", { liked: true });
    const twice = await b.call("POST", "novels/pub-novel/like", { liked: true });
    expect((twice.body as NovelStatsDto).likes).toBe(1);
    expect((await b.call("PUT", "novels/pub-novel/rating", { score: 4 })).body.rating).toEqual({ average: 4, count: 1, mine: 4 });
    expect((await b.call("PUT", "novels/pub-novel/rating", { score: 2 })).body.rating).toEqual({ average: 2, count: 1, mine: 2 });
    for (const bad of [0, 6, 2.5, "5"]) expect((await b.call("PUT", "novels/pub-novel/rating", { score: bad })).status).toBe(400);
    const other = new Browser(api, "198.51.100.2");
    await other.start();
    expect((await other.call("PUT", "novels/pub-novel/rating", { score: 5 })).body.rating).toEqual({ average: 3.5, count: 2, mine: 5 });
    expect((await b.call("DELETE", "novels/pub-novel/rating")).body.rating).toEqual({ average: 5, count: 1, mine: null });
    expect((await b.call("POST", "novels/pub-novel/like", { liked: false })).body.likes).toBe(0);
  });

  it("comments: anonymous nickname (default 익명), one reply level, plain text, own delete only", async () => {
    const a = new Browser(api, "192.0.2.1");
    await a.start();
    const xss = `<img src=x onerror=alert(1)><script>alert(1)</script>`;
    const r1 = await a.call("POST", `${ep()}/comments`, { body: `  ${xss}  ` });
    expect(r1.status).toBe(201);
    const l1 = r1.body as CommentListDto;
    expect(l1.items[0]).toMatchObject({ nickname: "익명", body: xss, state: "visible", mine: true, pending: false });
    const parentId = l1.items[0]!.id;

    const b = new Browser(api, "192.0.2.2");
    await b.start();
    const reply = await b.call("POST", `${ep()}/comments`, { body: "답글입니다", nickname: "  독자  둘 ", parentId });
    expect(reply.status).toBe(201);
    const replyId = (reply.body as CommentListDto).items[0]!.replies[0]!.id;
    expect((reply.body as CommentListDto).items[0]!.replies[0]).toMatchObject({ nickname: "독자 둘", mine: true });
    expect((reply.body as CommentListDto).items[0]!.mine).toBe(false);
    // no reply to a reply; parent must be on the same episode
    expect((await b.call("POST", `${ep()}/comments`, { body: "깊이 2", parentId: replyId })).body.error.code).toBe("reply_depth");
    expect((await b.call("POST", `${ep(2)}/comments`, { body: "다른 화", parentId })).status).toBe(422);
    // limits
    expect((await b.call("POST", `${ep()}/comments`, { body: "x".repeat(1001) })).status).toBe(422);
    expect((await b.call("POST", `${ep()}/comments`, { body: "   " })).status).toBe(422);
    expect((await b.call("POST", `${ep()}/comments`, { body: "ok", nickname: "가".repeat(21) })).status).toBe(422);

    // someone else's comment: 404, unchanged
    expect((await b.call("DELETE", `comments/${parentId}`)).status).toBe(404);
    const anon = new Browser(api, "192.0.2.3");
    await anon.start();
    expect((await anon.call("DELETE", `comments/${parentId}`)).status).toBe(404);
    // own: deleted, kept as placeholder because of the visible reply
    expect((await a.call("DELETE", `comments/${parentId}`)).status).toBe(204);
    const after = (await anon.call("GET", `${ep()}/comments`)).body as CommentListDto;
    expect(after.items[0]).toMatchObject({ id: parentId, state: "deleted", nickname: null, body: null, mine: false });
    expect(after.items[0]!.replies).toHaveLength(1);
    expect(after.total).toBe(1);
  });

  it("never returns visitor ids or ip hashes", async () => {
    const a = new Browser(api, "192.0.2.50");
    await a.start();
    const r = await a.call("POST", `${ep(2)}/comments`, { body: "흔적 확인" });
    const rows = await pg.query<{ visitor_id: string; ip_hash: string; body_hash: string }>(`SELECT visitor_id, ip_hash, body_hash FROM ${SCHEMA}.comments`);
    const all = [r.text, (await a.call("GET", `${ep(2)}/comments`)).text, (await a.call("GET", `${ep(2)}/stats`)).text, (await a.call("GET", "novels/pub-novel/stats")).text];
    for (const row of rows.rows) for (const t of all) {
      expect(t).not.toContain(row.visitor_id);
      expect(t).not.toContain(row.ip_hash);
      expect(t).not.toContain(row.body_hash);
    }
    for (const t of all) expect(t).not.toMatch(/visitor|ip_?hash|192\.0\.2\.50/i);
    // the raw IP is never stored
    const dump = JSON.stringify((await pg.query(`SELECT * FROM ${SCHEMA}.comments`)).rows) + JSON.stringify((await pg.query(`SELECT * FROM ${SCHEMA}.rate_limits`)).rows);
    expect(dump).not.toContain("192.0.2.50");
  });

  it("honeypot: pretends success, stores nothing", async () => {
    const a = new Browser(api, "192.0.2.60");
    await a.start();
    const before = Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${SCHEMA}.comments`)).rows[0]!.n);
    const r = await a.call("POST", `${ep()}/comments`, { body: "광고입니다", website: "http://spam.example" });
    expect(r.status).toBe(201);
    expect(Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${SCHEMA}.comments`)).rows[0]!.n)).toBe(before);
  });

  it("suppresses duplicates and rate limits per visitor and per ip hash", async () => {
    const a = new Browser(api, "192.0.2.70");
    await a.start();
    expect((await a.call("POST", `${ep()}/comments`, { body: "같은 말" })).status).toBe(201);
    expect((await a.call("POST", `${ep()}/comments`, { body: "같은  말" })).body.error.code).toBe("duplicate");
    // the duplicate attempt counted too: 5 per minute per visitor
    for (let i = 0; i < 3; i++) expect((await a.call("POST", `${ep()}/comments`, { body: `다른 말 ${i}` })).status).toBe(201);
    expect((await a.call("POST", `${ep()}/comments`, { body: "여섯 번째" })).status).toBe(429);

    // clearing cookies does not escape the per-ip limit (15/min): many fresh visitors from one IP
    clock += 3600_000;
    let limited = false;
    for (let i = 0; i < 20 && !limited; i++) {
      const v = new Browser(api, "192.0.2.71");
      await v.start();
      const r = await v.call("POST", `${ep()}/comments`, { body: `봇 ${i}` });
      if (r.status === 429) limited = true;
      else expect(r.status).toBe(201);
    }
    expect(limited).toBe(true);
  });

  it("banned words hold the comment: hidden from others, pending for its author", async () => {
    const a = new Browser(api, "192.0.2.80");
    await a.start();
    const r = await a.call("POST", `${ep(2)}/comments`, { body: "여기 금 칙 어 포함" });
    expect(r.status).toBe(201);
    const mine = (r.body as CommentListDto).items.find((c) => c.pending);
    expect(mine).toMatchObject({ state: "visible", pending: true, mine: true });
    const other = new Browser(api, "192.0.2.81");
    const seen = (await other.call("GET", `${ep(2)}/comments`)).body as CommentListDto;
    expect(seen.items.find((c) => c.id === mine!.id)).toBeUndefined();
  });

  it("unpublished targets are 404 for reads and writes; comments survive unpublishing", async () => {
    const a = new Browser(api, "192.0.2.90");
    await a.start();
    for (const [m, p, body] of [
      ["GET", "novels/nope/stats"],
      ["GET", `novels/pub-novel/episodes/9/stats`],
      ["GET", `novels/pub-novel/episodes/9/comments`],
      ["POST", `novels/pub-novel/episodes/9/comments`, { body: "x" }],
      ["POST", `novels/nope/like`, { liked: true }],
      ["PUT", `novels/nope/rating`, { score: 3 }],
    ] as const) {
      expect((await a.call(m, p, body)).status, `${m} ${p}`).toBe(404);
    }
    await pg.exec(`INSERT INTO ${SCHEMA}.episodes (novel_slug, episode_no, title, body, char_count, content_hash) VALUES ('pub-novel', 3, '3화', '곧 내림', 4, 'h3')`);
    expect((await a.call("POST", `${ep(3)}/comments`, { body: "3화 댓글" })).status).toBe(201);
    await pg.exec(`DELETE FROM ${SCHEMA}.episodes WHERE episode_no = 3`);
    expect((await a.call("GET", `${ep(3)}/comments`)).status).toBe(404);
    expect(Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${SCHEMA}.comments WHERE episode_no = 3`)).rows[0]!.n)).toBe(1);
  });

  it("writes are off without IP_HASH_SECRET (reads still work)", async () => {
    const off = createReaderApi({ env: envOf({ IP_HASH_SECRET: "" }), db: () => db, now: () => clock });
    const b = new Browser(off);
    expect((await b.start()).body.writable).toBe(false);
    expect((await b.call("POST", `${ep()}/like`, { liked: true })).status).toBe(503);
    expect((await b.call("GET", `${ep()}/stats`)).status).toBe(200);
  });
});

describe("admin", () => {
  it("is gated by ADMIN_TOKEN and kept in an httpOnly cookie (never the token itself)", async () => {
    const b = new Browser(api, "192.0.2.100");
    await b.start();
    expect((await b.call("GET", "admin/session")).body).toEqual({ enabled: true, authed: false });
    expect((await b.call("GET", "admin/overview")).status).toBe(401);
    expect((await b.call("POST", "admin/session", { token: "wrong" })).status).toBe(401);
    const ok = await b.call("POST", "admin/session", { token: ADMIN });
    expect(ok.body).toEqual({ enabled: true, authed: true });
    const cookie = ok.setCookies.find((c) => c.startsWith("__Host-snowpage_admin"))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(ADMIN);
    const ov = await b.call("GET", "admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.text).not.toMatch(/visitor_?id|ip_?hash/i);
    const target = ov.body.recent[0];
    expect((await b.call("POST", `admin/comments/${target.id}`, { hidden: true })).body).toMatchObject({ id: target.id, hidden: true });
    // admin writes need CSRF + origin too
    expect((await b.call("POST", `admin/comments/${target.id}`, { hidden: false }, { "x-csrf-token": "nope-nope-nope-nope-nope" })).status).toBe(403);
    // a forged cookie does not work
    const f = new Browser(api, "192.0.2.101");
    await f.start();
    f.cookies.set("__Host-snowpage_admin", `${clock + 1000}.forged`);
    expect((await f.call("GET", "admin/overview")).status).toBe(401);
    expect((await b.call("DELETE", "admin/session")).body.authed).toBe(false);
    expect((await b.call("GET", "admin/overview")).status).toBe(401);
  });

  it("is 404 when ADMIN_TOKEN is unset or too short", async () => {
    for (const token of ["", "short-token"]) {
      const off = createReaderApi({ env: envOf({ ADMIN_TOKEN: token }), db: () => db, now: () => clock });
      const b = new Browser(off);
      await b.start();
      expect((await b.call("GET", "admin/session")).body).toEqual({ enabled: false, authed: false });
      expect((await b.call("POST", "admin/session", { token })).status).toBe(404);
      expect((await b.call("GET", "admin/overview")).status).toBe(404);
    }
  });
});

describe("no accounts", () => {
  it("has no login / signup / logout endpoints", async () => {
    const b = new Browser(api);
    await b.start();
    for (const p of ["login", "signup", "logout", "register", "auth/login", "account"]) {
      expect((await b.call("POST", p, { nickname: "a", password: "b" })).status, p).toBe(404);
      expect((await b.call("GET", p)).status, p).toBe(404);
    }
  });

  it("has no login / signup pages or route files", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? [p, ...walk(p)] : [p];
      });
    const files = walk(join(__dirname, "..", "app")).map((p) => p.toLowerCase());
    expect(files.filter((p) => /login|signup|sign-up|register|account|auth/.test(p))).toEqual([]);
  });
});
