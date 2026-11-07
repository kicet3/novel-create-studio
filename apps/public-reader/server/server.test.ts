/**
 * Reader server: static serving (path traversal, headers, SPA fallback, per-page meta), auth (scrypt, session,
 * CSRF), one like / one rating per reader, reply depth 1, rate limits, unpublished targets, admin token gating.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_SLUG_RE } from "@ncs/reader-core/snapshot";
import { createApp } from "./app.js";
import { checkNickname, cleanCommentBody, csrfOk, hashPassword, verifyPassword } from "./auth.js";
import { SLUG_RE } from "./catalog.js";
import { RateLimiter } from "./rate-limit.js";
import { openStore, type Db } from "./store.js";

const ADMIN = "admin-token-0123456789-abcdefghij";

function writeSnapshot(dataDir: string, episodes: number[]) {
  mkdirSync(join(dataDir, "novels", "star", "episodes"), { recursive: true });
  const toc = episodes.map((n) => ({ episodeNo: n, title: `${n}화`, charCount: 10, publishedAt: "2026-11-01T00:00:00.000Z" }));
  writeFileSync(
    join(dataDir, "novels.json"),
    JSON.stringify({ version: 1, generatedAt: "2026-11-01T00:00:00.000Z", novels: [{ slug: "star", title: "별의 노래", genre: "", ageRating: "all", authorName: "", intro: "별 <소개>", episodeCount: episodes.length, updatedAt: null }] }),
  );
  writeFileSync(join(dataDir, "novels", "star", "index.json"), JSON.stringify({ version: 1, slug: "star", title: "별의 노래", genre: "", ageRating: "all", authorName: "", intro: "별 <소개>", episodes: toc }));
  for (const n of episodes) writeFileSync(join(dataDir, "novels", "star", "episodes", `${n}.json`), JSON.stringify({ version: 1, slug: "star", episodeNo: n, title: `${n}화`, text: "본문", charCount: 2, publishedAt: null, prev: null, next: null }));
}

class Client {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(
    private base: string,
    private ip = "10.0.0.1",
  ) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "x-test-ip": this.ip, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) h["content-type"] = "application/json";
    if (method !== "GET" && this.csrf && !("x-csrf-token" in headers)) h["x-csrf-token"] = this.csrf;
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const [k, v] = kv!.split("=");
      if (/Max-Age=0/.test(sc)) this.cookies.delete(k!);
      else this.cookies.set(k!, v!);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, json, text, headers: res.headers };
  }
  async init() {
    await this.req("GET", "/api/session");
    return this;
  }
}

describe("public reader server", () => {
  let root: string;
  let dataDir: string;
  let staticDir: string;
  let db: Db;
  let server: Server;
  let base: string;
  let clock = Date.parse("2026-11-07T00:00:00Z");
  let limiter: RateLimiter;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ncs-reader-"));
    dataDir = join(root, "data");
    staticDir = join(root, "dist");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), `<!doctype html><html><head><title>x</title><meta name="description" content="" /></head><body><div id="root"></div></body></html>`);
    writeFileSync(join(staticDir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "secret.txt"), "TOP SECRET");
    writeFileSync(join(staticDir, ".env"), "SECRET=1");
    symlinkSync(join(root, "secret.txt"), join(staticDir, "link.txt"));
    writeSnapshot(dataDir, [1, 2]);
    db = openStore(join(root, "reader.db"));
    limiter = new RateLimiter(() => clock);
    const app = createApp({ db, dataDir, staticDir, adminToken: ADMIN, limiter, now: () => clock, clientIp: (req) => String(req.headers["x-test-ip"] ?? "x") });
    server = createServer(app.handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    clock += 3600_000 * 2; // fresh rate-limit windows per test
  });

  describe("static", () => {
    it("sends security headers on every response", async () => {
      for (const p of ["/", "/data/novels.json", "/api/session", "/nope.js"]) {
        const r = await fetch(base + p);
        expect(r.headers.get("content-security-policy"), p).toContain("default-src 'self'");
        expect(r.headers.get("content-security-policy"), p).toContain("frame-ancestors 'none'");
        expect(r.headers.get("x-content-type-options"), p).toBe("nosniff");
        expect(r.headers.get("referrer-policy"), p).toBe("strict-origin-when-cross-origin");
        expect(r.headers.get("x-frame-options"), p).toBe("DENY");
      }
    });

    it("blocks path traversal, dotfiles, symlinks out of the root and directory listing", async () => {
      const bad = ["/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/data/..%2f..%2fsecret.txt", "/data/%2e%2e/secret.txt", "/.env", "/link.txt", "/assets/", "/data/novels/", "/data/novels/star", "/%00.js", "/%E0%A4%A.js", "/assets\\..\\secret.txt"];
      for (const p of bad) {
        const r = await fetch(base + p);
        const text = await r.text();
        expect(text, p).not.toContain("TOP SECRET");
        expect(text, p).not.toContain("SECRET=1");
        expect(text, p).not.toContain("app-abc123");
      }
      // raw (un-normalized) request line
      const raw = await new Promise<string>((resolve) => {
        const s = connect((server.address() as AddressInfo).port, "127.0.0.1", () => s.write("GET /data/../../secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        let buf = "";
        s.on("data", (d) => (buf += d));
        s.on("end", () => resolve(buf));
      });
      expect(raw).not.toContain("TOP SECRET");
    });

    it("caches hashed assets forever, revalidates html and data, answers 304 on a matching ETag", async () => {
      const a = await fetch(`${base}/assets/app-abc123.js`);
      expect(a.status).toBe(200);
      expect(a.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(a.headers.get("content-type")).toContain("text/javascript");
      const d = await fetch(`${base}/data/novels.json`);
      expect(d.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
      const etag = d.headers.get("etag")!;
      expect((await fetch(`${base}/data/novels.json`, { headers: { "if-none-match": etag } })).status).toBe(304);
      expect((await fetch(`${base}/`)).headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(`${base}/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    });

    it("falls back to the SPA with per-page, escaped title/description; unknown pages are 404 + noindex", async () => {
      const home = await fetch(`${base}/novels/star`);
      expect(home.status).toBe(200);
      const html = await home.text();
      expect(html).toContain("<title>별의 노래 · 연재 읽기</title>");
      expect(html).toContain('content="별 &lt;소개&gt;"');
      const ep = await (await fetch(`${base}/novels/star/2`)).text();
      expect(ep).toContain("별의 노래 2화");
      const missing = await fetch(`${base}/novels/star/9`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('name="robots" content="noindex"');
      expect((await fetch(`${base}/novels/nope`)).status).toBe(404);
      expect(await (await fetch(`${base}/admin`)).text()).toContain("noindex");
    });
  });

  describe("auth", () => {
    it("hashes passwords with scrypt and verifies in constant time", () => {
      const h = hashPassword("correct horse");
      expect(h.startsWith("scrypt$")).toBe(true);
      expect(h).not.toContain("correct horse");
      expect(hashPassword("correct horse")).not.toBe(h); // salted
      expect(verifyPassword("correct horse", h)).toBe(true);
      expect(verifyPassword("wrong horse", h)).toBe(false);
      expect(verifyPassword("x", "garbage")).toBe(false);
    });

    it("validates nicknames", () => {
      expect(checkNickname("독자1").ok).toBe(true);
      for (const bad of ["a", "x".repeat(17), "관리자", "admin", "a b", "<b>", "_ab", "😀😀"]) expect(checkNickname(bad).ok, bad).toBe(false);
    });

    it("signs up, keeps a session in an httpOnly SameSite=Lax cookie, logs out, logs in", async () => {
      const c = await new Client(base, "10.1.0.1").init();
      const r = await c.req("POST", "/api/signup", { nickname: "독자일", password: "password-1" });
      expect(r.status).toBe(201);
      expect(r.json.reader).toEqual({ nickname: "독자일" });
      const sc = r.headers.getSetCookie().find((s) => s.startsWith("ncs_rs="))!;
      expect(sc).toMatch(/HttpOnly/);
      expect(sc).toMatch(/SameSite=Lax/);
      expect((await c.req("GET", "/api/session")).json.reader).toEqual({ nickname: "독자일" });
      expect((await c.req("POST", "/api/signup", { nickname: "독자일", password: "password-2" })).status).toBe(409);
      expect((await c.req("POST", "/api/logout")).json.reader).toBeNull();
      expect((await c.req("GET", "/api/session")).json.reader).toBeNull();
      expect((await c.req("POST", "/api/login", { nickname: "독자일", password: "nope-nope" })).status).toBe(401);
      expect((await c.req("POST", "/api/login", { nickname: "독자일", password: "password-1" })).json.reader).toEqual({ nickname: "독자일" });
      const row = db.prepare("SELECT password_hash FROM readers WHERE nickname = ?").get("독자일") as { password_hash: string };
      expect(row.password_hash).not.toContain("password-1");
    });

    it("rejects writes without the CSRF token or from another origin", async () => {
      const c = await new Client(base, "10.2.0.1").init();
      expect((await c.req("POST", "/api/signup", { nickname: "독자이", password: "password-1" }, { "x-csrf-token": "" })).status).toBe(403);
      expect((await c.req("POST", "/api/signup", { nickname: "독자이", password: "password-1" }, { "x-csrf-token": "x".repeat(43) })).status).toBe(403);
      expect((await c.req("POST", "/api/signup", { nickname: "독자이", password: "password-1" }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await c.req("POST", "/api/signup", { nickname: "독자이", password: "password-1" }, { origin: base })).status).toBe(201);
      expect(csrfOk({ method: "POST", cookieToken: "a".repeat(43), headerToken: "a".repeat(43), origin: "https://r.example", referer: undefined, host: "other", allowedOrigins: ["https://r.example"] })).toBe(true);
      expect(csrfOk({ method: "POST", cookieToken: "a".repeat(43), headerToken: "a".repeat(43), origin: "https://x.example", referer: undefined, host: "r.example", allowedOrigins: ["https://r.example"] })).toBe(false);
      expect(csrfOk({ method: "GET", cookieToken: undefined, headerToken: undefined, origin: undefined, referer: undefined, host: undefined, allowedOrigins: [] })).toBe(true);
    });

    it("rate-limits signups and failed logins", async () => {
      const c = await new Client(base, "10.3.0.1").init();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await c.req("POST", "/api/signup", { nickname: `가입${i}번`, password: "password-1" })).status);
      expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(codes.slice(5)).toEqual([429, 429]);
      const d = await new Client(base, "10.3.0.2").init();
      const fails: number[] = [];
      for (let i = 0; i < 10; i++) fails.push((await d.req("POST", "/api/login", { nickname: "가입0번", password: "wrong-pass" })).status);
      expect(fails.slice(0, 8).every((s) => s === 401)).toBe(true);
      expect(fails.slice(8)).toEqual([429, 429]);
    });
  });

  describe("likes, ratings, comments", () => {
    let a: Client;
    let b: Client;
    beforeAll(async () => {
      a = await new Client(base, "10.4.0.1").init();
      b = await new Client(base, "10.4.0.2").init();
      await a.req("POST", "/api/signup", { nickname: "에이", password: "password-a" });
      await b.req("POST", "/api/signup", { nickname: "비독자", password: "password-b" });
    });

    it("reading needs no login; writing does", async () => {
      const anon = await new Client(base, "10.4.0.3").init();
      expect((await anon.req("GET", "/api/novels/star/episodes/1/comments")).status).toBe(200);
      expect((await anon.req("GET", "/api/novels/star/stats")).json).toMatchObject({ likes: 0, liked: false });
      expect((await anon.req("POST", "/api/novels/star/episodes/1/like", { liked: true })).status).toBe(401);
      expect((await anon.req("POST", "/api/novels/star/episodes/1/comments", { body: "hi" })).status).toBe(401);
      expect((await anon.req("PUT", "/api/novels/star/rating", { score: 5 })).status).toBe(401);
    });

    it("one like per reader per target (toggle is idempotent)", async () => {
      expect((await a.req("POST", "/api/novels/star/episodes/1/like", { liked: true })).json).toMatchObject({ likes: 1, liked: true });
      expect((await a.req("POST", "/api/novels/star/episodes/1/like", { liked: true })).json).toMatchObject({ likes: 1, liked: true });
      expect((await b.req("POST", "/api/novels/star/episodes/1/like", { liked: true })).json).toMatchObject({ likes: 2, liked: true });
      expect((await a.req("POST", "/api/novels/star/episodes/1/like", { liked: false })).json).toMatchObject({ likes: 1, liked: false });
      expect((await a.req("POST", "/api/novels/star/like", { liked: true })).json).toMatchObject({ likes: 1, liked: true });
      expect((await a.req("POST", "/api/novels/star/like", { liked: true })).json).toMatchObject({ likes: 1 });
      expect((await a.req("POST", "/api/novels/star/like", {})).status).toBe(400);
    });

    it("one rating per reader per novel (update replaces), average shown", async () => {
      expect((await a.req("PUT", "/api/novels/star/rating", { score: 5 })).json.rating).toEqual({ average: 5, count: 1, mine: 5 });
      expect((await a.req("PUT", "/api/novels/star/rating", { score: 3 })).json.rating).toEqual({ average: 3, count: 1, mine: 3 });
      expect((await b.req("PUT", "/api/novels/star/rating", { score: 4 })).json.rating).toEqual({ average: 3.5, count: 2, mine: 4 });
      for (const bad of [0, 6, 2.5, "5"]) expect((await a.req("PUT", "/api/novels/star/rating", { score: bad })).status, String(bad)).toBe(400);
      expect((await b.req("DELETE", "/api/novels/star/rating")).json.rating).toEqual({ average: 3, count: 1, mine: null });
    });

    it("replies are one level deep; comments are stored and returned as plain text", async () => {
      const xss = `<img src=x onerror=alert(1)><script>alert("x")</script>`;
      const r1 = await a.req("POST", "/api/novels/star/episodes/2/comments", { body: xss });
      expect(r1.status).toBe(201);
      const root = r1.json.items[0];
      expect(root.body).toBe(xss); // returned verbatim as a JSON string; the UI renders it as text
      expect(r1.headers.get("content-type")).toContain("application/json");
      const r2 = await b.req("POST", "/api/novels/star/episodes/2/comments", { body: "답글", parentId: root.id });
      expect(r2.status).toBe(201);
      const reply = r2.json.items[0].replies[0];
      expect(reply).toMatchObject({ body: "답글", nickname: "비독자", mine: true });
      expect((await a.req("POST", "/api/novels/star/episodes/2/comments", { body: "답글의 답글", parentId: reply.id })).status).toBe(400);
      expect((await a.req("POST", "/api/novels/star/episodes/1/comments", { body: "다른 화", parentId: root.id })).status).toBe(404);
      expect((await a.req("POST", "/api/novels/star/episodes/2/comments", { body: "x".repeat(1001) })).status).toBe(400);
      expect((await a.req("POST", "/api/novels/star/episodes/2/comments", { body: "   \n  " })).status).toBe(400);
      expect(cleanCommentBody("a\u0000b‮\r\n\n\n\n\nc")).toEqual({ ok: true, body: "ab\n\n\nc" });
    });

    it("the author of a comment can delete it; others cannot; a deleted root with replies stays as a placeholder", async () => {
      const list = (await a.req("GET", "/api/novels/star/episodes/2/comments")).json;
      const root = list.items[0];
      expect(root.mine).toBe(true);
      expect((await b.req("DELETE", `/api/comments/${root.id}`)).status).toBe(404);
      expect((await a.req("DELETE", `/api/comments/${root.id}`)).status).toBe(204);
      const after = (await b.req("GET", "/api/novels/star/episodes/2/comments")).json;
      expect(after.items[0]).toMatchObject({ id: root.id, state: "deleted", body: null, nickname: null });
      expect(after.items[0].replies).toHaveLength(1);
    });

    it("rate-limits comments per reader", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await b.req("POST", "/api/novels/star/episodes/1/comments", { body: `연속 ${i}` })).status);
      expect(codes.slice(0, 6).every((s) => s === 201)).toBe(true);
      expect(codes.slice(6)).toEqual([429, 429]);
    });

    it("rejects targets that are not in the published snapshot and hides comments of unpublished episodes", async () => {
      expect((await a.req("POST", "/api/novels/star/episodes/9/like", { liked: true })).status).toBe(404);
      expect((await a.req("POST", "/api/novels/ghost/like", { liked: true })).status).toBe(404);
      expect((await a.req("PUT", "/api/novels/ghost/rating", { score: 3 })).status).toBe(404);
      expect((await a.req("GET", "/api/novels/..%2f..%2fetc/stats")).status).toBe(404);
      await a.req("POST", "/api/novels/star/episodes/2/comments", { body: "곧 비공개될 화" });
      // 2화 unpublished in the studio → gone from the snapshot
      writeSnapshot(dataDir, [1]);
      rmSync(join(dataDir, "novels", "star", "episodes", "2.json"));
      await new Promise((r) => setTimeout(r, 20));
      expect((await a.req("GET", "/api/novels/star/episodes/2/comments")).status).toBe(404);
      expect((await a.req("POST", "/api/novels/star/episodes/2/comments", { body: "x" })).status).toBe(404);
      const kept = db.prepare("SELECT count(*) AS n FROM comments WHERE slug = 'star' AND episode_no = 2").get() as { n: number };
      expect(kept.n).toBeGreaterThan(0); // kept in the DB
    });

    it("admin API needs the bearer token; hides comments; reports unpublished targets", async () => {
      const anon = await new Client(base, "10.5.0.1").init();
      expect((await anon.req("GET", "/api/admin/overview")).status).toBe(401);
      expect((await anon.req("GET", "/api/admin/overview", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
      const ov = await anon.req("GET", "/api/admin/overview", undefined, { authorization: `Bearer ${ADMIN}` });
      expect(ov.status).toBe(200);
      expect(ov.json.readers).toBeGreaterThanOrEqual(2);
      expect(ov.json.recent.some((c: { unpublished: boolean }) => c.unpublished)).toBe(true);
      const target = ov.json.recent.find((c: { episodeNo: number; deleted: boolean }) => c.episodeNo === 1 && !c.deleted);
      const hide = await anon.req("POST", `/api/admin/comments/${target.id}`, { hidden: true }, { authorization: `Bearer ${ADMIN}` });
      expect(hide.json).toMatchObject({ id: target.id, hidden: true });
      const pub = (await anon.req("GET", "/api/novels/star/episodes/1/comments")).json;
      expect(pub.items.find((c: { id: number }) => c.id === target.id)).toBeUndefined();
      expect((await anon.req("POST", `/api/admin/comments/${target.id}`, { hidden: false })).status).toBe(401);
    });

    it("admin is disabled without ADMIN_TOKEN", async () => {
      const app = createApp({ db, dataDir, staticDir, adminToken: undefined });
      const s = createServer(app.handler);
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/admin/overview`, { headers: { authorization: "Bearer " } });
      expect(r.status).toBe(404);
      await new Promise((r) => s.close(r));
    });
  });

  it("uses the same slug rule as the snapshot contract", () => {
    expect(SLUG_RE.source).toBe(PUBLIC_SLUG_RE.source);
  });
});
