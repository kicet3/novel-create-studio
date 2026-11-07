/**
 * snowpage API (app/api/[...path]/route.ts → `createReaderApi(...).handle`). Fully anonymous: there is no login,
 * signup or account. Reading needs nothing; every write needs the CSRF token + an allowed Origin, gets an anonymous
 * visitor id (httpOnly cookie, issued on the first write), is rate limited per visitor and per ip hash, and targets
 * only something that is published right now (a row in novels / episodes).
 *
 *   GET    /api/session                                      → SessionDto (issues the CSRF cookie)
 *   GET    /api/novels/:slug/stats                           → NovelStatsDto
 *   POST   /api/novels/:slug/like        {liked}             → NovelStatsDto
 *   PUT    /api/novels/:slug/rating      {score: 1..5}       → NovelStatsDto
 *   DELETE /api/novels/:slug/rating                          → NovelStatsDto
 *   GET    /api/novels/:slug/episodes/:no/stats              → EpisodeStatsDto
 *   POST   /api/novels/:slug/episodes/:no/like {liked}       → EpisodeStatsDto
 *   GET    /api/novels/:slug/episodes/:no/comments           → CommentListDto
 *   POST   /api/novels/:slug/episodes/:no/comments {body, nickname?, parentId?, website(honeypot)} → CommentListDto
 *   DELETE /api/comments/:id                                 → 204 (own comment only, by visitor cookie)
 *   GET    /api/admin/session                                → AdminSessionDto
 *   POST   /api/admin/session            {token}             → AdminSessionDto (+ httpOnly admin cookie)
 *   DELETE /api/admin/session                                → AdminSessionDto
 *   GET    /api/admin/overview                               → AdminOverviewDto   (admin cookie)
 *   POST   /api/admin/comments/:id       {hidden?, deleted?} → AdminCommentDto    (admin cookie)
 *
 * Responses never contain a visitor id, an ip hash, or a body hash.
 */
import { assertSchemaName, quoteIdent, type SqlClient } from "@ncs/public-schema";
import { isPublicSlug } from "@ncs/reader-core/snapshot";
import type { AdminCommentDto, AdminOverviewDto, AdminSessionDto, CommentDto, CommentListDto, EpisodeStatsDto, NovelStatsDto, SessionDto } from "../lib/api-types";
import { episodeExists, isEpisodeNo, novelExists } from "./content";
import { EnvError, normalizeForMatch, type ReaderEnv } from "./env";
import {
  adminCookieValid,
  adminCookieValue,
  ADMIN_SESSION_MS,
  bodyHash,
  clientIp,
  cookieName,
  hitRateLimit,
  ipHash,
  newToken,
  originAllowed,
  parseCookies,
  pruneRateLimits,
  safeEqual,
  serializeCookie,
  VISITOR_ID_RE,
  type RuleName,
} from "./security";

export const NICKNAME_MAX = 20;
export const COMMENT_MAX = 1000;
export const DEFAULT_NICKNAME = "익명";
const MAX_BODY_BYTES = 8 * 1024;
const YEAR_S = 400 * 24 * 3600;
const DUP_VISITOR_MS = 10 * 60_000;
const DUP_IP_MS = 60_000;

export interface ReaderApiDeps {
  env: ReaderEnv;
  /** lazily: no DB connection for requests that do not need one */
  db: () => SqlClient;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new HttpError(404, "not_found", "찾을 수 없습니다.");

/** control characters out, NFC, trimmed */
export function cleanNickname(v: unknown): string {
  if (v === undefined || v === null) return DEFAULT_NICKNAME;
  if (typeof v !== "string") throw new HttpError(400, "bad_nickname", "닉네임 형식이 올바르지 않습니다.");
  const s = v
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return DEFAULT_NICKNAME;
  if ([...s].length > NICKNAME_MAX) throw new HttpError(422, "nickname_too_long", `닉네임은 ${NICKNAME_MAX}자까지입니다.`);
  return s;
}

export function cleanCommentBody(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "bad_body", "댓글 내용을 넣어 주세요.");
  const s = v
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!s) throw new HttpError(422, "empty_body", "댓글 내용을 넣어 주세요.");
  if ([...s].length > COMMENT_MAX) throw new HttpError(422, "body_too_long", `댓글은 ${COMMENT_MAX}자까지입니다.`);
  return s;
}

export const containsBannedWord = (words: readonly string[], ...texts: string[]) => {
  if (!words.length) return false;
  const t = normalizeForMatch(texts.join(" "));
  return words.some((w) => t.includes(w));
};

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export function createReaderApi(deps: ReaderApiDeps) {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const schema = assertSchemaName(env.schema);
  const s = quoteIdent(schema);

  // ── response helpers ───────────────────────────────────────────────────
  interface Ctx {
    req: Request;
    cookies: Map<string, string>;
    setCookies: string[];
    ip: string;
  }
  const json = (ctx: Ctx, status: number, body: unknown) => {
    const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    for (const c of ctx.setCookies) h.append("set-cookie", c);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
  };

  async function readJson(req: Request): Promise<Record<string, unknown>> {
    const type = req.headers.get("content-type") ?? "";
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "요청이 너무 큽니다.");
    if (!text) return {};
    if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "JSON으로 보내 주세요.");
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "bad_json", "요청 형식이 올바르지 않습니다.");
    }
  }

  // ── guards ─────────────────────────────────────────────────────────────
  function csrfToken(ctx: Ctx): string {
    let t = ctx.cookies.get(cookieName(env, "csrf"));
    if (!t || !/^[A-Za-z0-9_-]{20,100}$/.test(t)) {
      t = newToken(24);
      ctx.setCookies.push(serializeCookie(env, "csrf", t, YEAR_S));
      ctx.cookies.set(cookieName(env, "csrf"), t);
    }
    return t;
  }

  /** every state-changing request: allowed Origin + double-submit CSRF token */
  function guardWrite(ctx: Ctx): void {
    if (!originAllowed(env, ctx.req.headers.get("origin"))) throw new HttpError(403, "bad_origin", "허용되지 않은 출처의 요청입니다.");
    const cookie = ctx.cookies.get(cookieName(env, "csrf"));
    const header = ctx.req.headers.get("x-csrf-token");
    if (!cookie || !header || !safeEqual(cookie, header)) throw new HttpError(403, "bad_csrf", "페이지를 새로고침한 뒤 다시 해 주세요.");
  }

  const ipKey = (ctx: Ctx) => ipHash(env.ipHashSecret!, ctx.ip);

  async function limit(db: SqlClient, rule: RuleName, subject: string) {
    if (!(await hitRateLimit(db, schema, rule, subject, now()))) throw new HttpError(429, "rate_limited", "요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요.");
  }

  function requireWritable(): void {
    if (!env.ipHashSecret) throw new HttpError(503, "writes_disabled", "지금은 좋아요·평점·댓글을 남길 수 없습니다.");
  }

  /** the anonymous visitor (only reads the cookie; null when none / malformed) */
  const visitorOf = (ctx: Ctx): string | null => {
    const v = ctx.cookies.get(cookieName(env, "vid"));
    return v && VISITOR_ID_RE.test(v) ? v : null;
  };

  /** the visitor for a write: issued on the first write (httpOnly cookie), recorded in visitors */
  async function ensureVisitor(db: SqlClient, ctx: Ctx): Promise<string> {
    const existing = visitorOf(ctx);
    if (existing) {
      // only ids the server issued (present in visitors) are honoured; a forged / unknown id is replaced
      const [row] = await db.query<{ x: number }>(`SELECT 1 AS x FROM ${s}.visitors WHERE id = $1`, [existing]);
      if (row) return existing;
    }
    await limit(db, "newVisitorIp", ipKey(ctx));
    const id = newToken(24);
    await db.query(`INSERT INTO ${s}.visitors (id) VALUES ($1)`, [id]);
    ctx.setCookies.push(serializeCookie(env, "vid", id, YEAR_S));
    ctx.cookies.set(cookieName(env, "vid"), id);
    return id;
  }

  const adminEnabled = () => !!env.adminToken;
  const isAdmin = (ctx: Ctx) => !!env.adminToken && adminCookieValid(env.adminToken, ctx.cookies.get(cookieName(env, "admin")), now());
  function requireAdmin(ctx: Ctx) {
    if (!adminEnabled()) throw notFound();
    if (!isAdmin(ctx)) throw new HttpError(401, "admin_required", "운영 토큰을 먼저 입력하세요.");
  }

  // ── targets ────────────────────────────────────────────────────────────
  async function requireNovel(db: SqlClient, slug: string) {
    if (!(await novelExists(db, schema, slug))) throw new HttpError(404, "not_found", "공개된 작품이 아닙니다.");
  }
  async function requireEpisode(db: SqlClient, slug: string, no: number) {
    if (!(await episodeExists(db, schema, slug, no))) throw new HttpError(404, "not_found", "공개된 화가 아닙니다.");
  }

  // ── reads ──────────────────────────────────────────────────────────────
  async function novelStats(db: SqlClient, slug: string, visitor: string | null): Promise<NovelStatsDto> {
    const [l] = await db.query<{ n: number; mine: boolean }>(
      `SELECT count(*)::int AS n, coalesce(bool_or(visitor_id = $2), false) AS mine FROM ${s}.novel_likes WHERE novel_slug = $1`,
      [slug, visitor ?? ""],
    );
    const [r] = await db.query<{ n: number; avg: string | null }>(`SELECT count(*)::int AS n, round(avg(score)::numeric, 2)::text AS avg FROM ${s}.ratings WHERE novel_slug = $1`, [slug]);
    const mine = visitor ? (await db.query<{ score: number }>(`SELECT score FROM ${s}.ratings WHERE novel_slug = $1 AND visitor_id = $2`, [slug, visitor]))[0] : undefined;
    return {
      likes: Number(l?.n ?? 0),
      liked: !!l?.mine,
      rating: { average: r?.avg == null ? null : Math.round(Number(r.avg) * 10) / 10, count: Number(r?.n ?? 0), mine: mine ? Number(mine.score) : null },
    };
  }

  const VISIBLE = "deleted_at IS NULL AND hidden = false";

  async function episodeStats(db: SqlClient, slug: string, no: number, visitor: string | null): Promise<EpisodeStatsDto> {
    const [l] = await db.query<{ n: number; mine: boolean }>(
      `SELECT count(*)::int AS n, coalesce(bool_or(visitor_id = $3), false) AS mine FROM ${s}.episode_likes WHERE novel_slug = $1 AND episode_no = $2`,
      [slug, no, visitor ?? ""],
    );
    const [c] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${s}.comments WHERE novel_slug = $1 AND episode_no = $2 AND ${VISIBLE}`, [slug, no]);
    return { likes: Number(l?.n ?? 0), liked: !!l?.mine, comments: Number(c?.n ?? 0) };
  }

  interface CommentRow {
    id: number | string;
    parent_id: number | string | null;
    visitor_id: string;
    nickname: string;
    body: string;
    created_at: Date | string;
    deleted_at: Date | string | null;
    hidden: boolean;
    held_reason: string | null;
  }

  async function listComments(db: SqlClient, slug: string, no: number, visitor: string | null): Promise<CommentListDto> {
    const rows = await db.query<CommentRow>(
      `SELECT id, parent_id, visitor_id, nickname, body, created_at, deleted_at, hidden, held_reason FROM ${s}.comments
       WHERE novel_slug = $1 AND episode_no = $2 ORDER BY id LIMIT 2000`,
      [slug, no],
    );
    const toDto = (r: CommentRow): CommentDto => {
      const mine = !!visitor && r.visitor_id === visitor;
      const deleted = r.deleted_at !== null;
      // held (banned word) comments: only their author sees them, marked pending
      const pending = mine && !deleted && r.hidden && r.held_reason !== null;
      const state: CommentDto["state"] = deleted ? "deleted" : r.hidden && !pending ? "hidden" : "visible";
      return {
        id: Number(r.id),
        nickname: state === "visible" ? r.nickname : null,
        body: state === "visible" ? r.body : null,
        createdAt: iso(r.created_at),
        state,
        mine: mine && !deleted,
        pending,
        replies: [],
      };
    };
    const top: CommentDto[] = [];
    const byId = new Map<number, CommentDto>();
    for (const r of rows) {
      const d = toDto(r);
      if (r.parent_id === null) {
        top.push(d);
        byId.set(d.id, d);
      } else byId.get(Number(r.parent_id))?.replies.push(d);
    }
    const shown = (c: CommentDto) => c.state === "visible";
    const items = top
      .map((c) => ({ ...c, replies: c.replies.filter(shown) }))
      // a removed comment stays only as a placeholder for its visible replies
      .filter((c) => shown(c) || c.replies.length > 0);
    const total = items.reduce((n, c) => n + (shown(c) && !c.pending ? 1 : 0) + c.replies.filter((r) => !r.pending).length, 0);
    return { items, total };
  }

  // ── writes ─────────────────────────────────────────────────────────────
  async function addComment(db: SqlClient, ctx: Ctx, slug: string, no: number, body: Record<string, unknown>): Promise<CommentListDto> {
    const visitor = await ensureVisitor(db, ctx);
    // honeypot: a bot filled the hidden field → pretend success, store nothing
    if (typeof body.website === "string" && body.website.trim() !== "") return listComments(db, slug, no, visitor);
    const text = cleanCommentBody(body.body);
    const nickname = cleanNickname(body.nickname);
    let parentId: number | null = null;
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== "number" || !Number.isSafeInteger(body.parentId) || body.parentId < 1) throw new HttpError(400, "bad_parent", "답글 대상이 올바르지 않습니다.");
      const [p] = await db.query<{ parent_id: number | null; deleted_at: unknown; novel_slug: string; episode_no: number }>(
        `SELECT parent_id, deleted_at, novel_slug, episode_no FROM ${s}.comments WHERE id = $1`,
        [body.parentId],
      );
      if (!p || p.novel_slug !== slug || Number(p.episode_no) !== no || p.deleted_at !== null) throw new HttpError(422, "bad_parent", "답글을 달 댓글이 없습니다.");
      if (p.parent_id !== null) throw new HttpError(422, "reply_depth", "답글에는 답글을 달 수 없습니다.");
      parentId = body.parentId;
    }
    const ih = ipKey(ctx);
    await limit(db, "commentVisitor", visitor);
    await limit(db, "commentVisitorHour", visitor);
    await limit(db, "commentIp", ih);
    await limit(db, "commentIpDay", ih);
    const bh = bodyHash(normalizeForMatch(text));
    const t = now();
    const [dup] = await db.query<{ x: number }>(
      `SELECT 1 AS x FROM ${s}.comments WHERE body_hash = $1 AND deleted_at IS NULL AND (
         (visitor_id = $2 AND novel_slug = $3 AND episode_no = $4 AND created_at > $5::timestamptz) OR (ip_hash = $6 AND created_at > $7::timestamptz)
       ) LIMIT 1`,
      [bh, visitor, slug, no, new Date(t - DUP_VISITOR_MS).toISOString(), ih, new Date(t - DUP_IP_MS).toISOString()],
    );
    if (dup) throw new HttpError(409, "duplicate", "같은 댓글을 방금 남겼습니다.");
    const held = containsBannedWord(env.bannedWords, text, nickname);
    await db.query(
      `INSERT INTO ${s}.comments (novel_slug, episode_no, parent_id, visitor_id, nickname, body, body_hash, ip_hash, hidden, held_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
      [slug, no, parentId, visitor, nickname, text, bh, ih, held, held ? "banned_word" : null, new Date(t).toISOString()],
    );
    if (Math.random() < 0.02) await pruneRateLimits(db, schema, t).catch(() => undefined);
    return listComments(db, slug, no, visitor);
  }

  async function adminOverview(db: SqlClient): Promise<AdminOverviewDto> {
    const n = async (sql: string) => Number((await db.query<{ n: number }>(sql))[0]?.n ?? 0);
    const rows = await db.query<CommentRow & { novel_slug: string; episode_no: number; published: boolean }>(
      `SELECT c.id, c.parent_id, c.visitor_id, c.nickname, c.body, c.created_at, c.deleted_at, c.hidden, c.held_reason, c.novel_slug, c.episode_no,
              (e.novel_slug IS NOT NULL) AS published
       FROM ${s}.comments c LEFT JOIN ${s}.episodes e ON e.novel_slug = c.novel_slug AND e.episode_no = c.episode_no
       ORDER BY c.id DESC LIMIT 100`,
    );
    return {
      visitors: await n(`SELECT count(*)::int AS n FROM ${s}.visitors`),
      comments: await n(`SELECT count(*)::int AS n FROM ${s}.comments WHERE deleted_at IS NULL`),
      hiddenComments: await n(`SELECT count(*)::int AS n FROM ${s}.comments WHERE deleted_at IS NULL AND hidden = true`),
      novelLikes: await n(`SELECT count(*)::int AS n FROM ${s}.novel_likes`),
      episodeLikes: await n(`SELECT count(*)::int AS n FROM ${s}.episode_likes`),
      ratings: await n(`SELECT count(*)::int AS n FROM ${s}.ratings`),
      recent: rows.map(adminDto),
    };
  }
  const adminDto = (r: CommentRow & { novel_slug: string; episode_no: number; published: boolean }): AdminCommentDto => ({
    id: Number(r.id),
    slug: r.novel_slug,
    episodeNo: Number(r.episode_no),
    parentId: r.parent_id === null ? null : Number(r.parent_id),
    nickname: r.nickname,
    body: r.body,
    createdAt: iso(r.created_at),
    deleted: r.deleted_at !== null,
    hidden: r.hidden,
    heldReason: r.held_reason,
    unpublished: !r.published,
  });

  // ── routing ────────────────────────────────────────────────────────────
  async function route(ctx: Ctx, method: string, path: readonly string[]): Promise<Response> {
    const [a, b, c, d, e, f] = path;
    const n = path.length;

    if (n === 1 && a === "session" && method === "GET") {
      const dto: SessionDto = { csrf: csrfToken(ctx), writable: !!env.ipHashSecret };
      return json(ctx, 200, dto);
    }

    // ── admin ──
    if (a === "admin") {
      if (n === 2 && b === "session") {
        if (method === "GET") return json(ctx, 200, { enabled: adminEnabled(), authed: isAdmin(ctx) } satisfies AdminSessionDto);
        if (method === "POST") {
          guardWrite(ctx);
          if (!adminEnabled()) throw notFound();
          const db = deps.db();
          if (env.ipHashSecret) await limit(db, "adminLoginIp", ipKey(ctx));
          const body = await readJson(ctx.req);
          if (typeof body.token !== "string" || !safeEqual(body.token.trim(), env.adminToken!)) throw new HttpError(401, "bad_token", "운영 토큰이 맞지 않습니다.");
          ctx.setCookies.push(serializeCookie(env, "admin", adminCookieValue(env.adminToken!, now()), ADMIN_SESSION_MS / 1000));
          return json(ctx, 200, { enabled: true, authed: true } satisfies AdminSessionDto);
        }
        if (method === "DELETE") {
          guardWrite(ctx);
          ctx.setCookies.push(serializeCookie(env, "admin", "", 0));
          return json(ctx, 200, { enabled: adminEnabled(), authed: false } satisfies AdminSessionDto);
        }
      }
      if (n === 2 && b === "overview" && method === "GET") {
        requireAdmin(ctx);
        return json(ctx, 200, await adminOverview(deps.db()));
      }
      if (n === 3 && b === "comments" && method === "POST") {
        guardWrite(ctx);
        requireAdmin(ctx);
        const id = Number(c);
        if (!/^\d{1,15}$/.test(c ?? "")) throw notFound();
        const body = await readJson(ctx.req);
        const db = deps.db();
        if (body.deleted === true) await db.query(`UPDATE ${s}.comments SET deleted_at = coalesce(deleted_at, $2::timestamptz) WHERE id = $1`, [id, new Date(now()).toISOString()]);
        if (typeof body.hidden === "boolean") await db.query(`UPDATE ${s}.comments SET hidden = $2, held_reason = CASE WHEN $2 THEN held_reason ELSE NULL END WHERE id = $1`, [id, body.hidden]);
        const [row] = await db.query<CommentRow & { novel_slug: string; episode_no: number; published: boolean }>(
          `SELECT c.id, c.parent_id, c.visitor_id, c.nickname, c.body, c.created_at, c.deleted_at, c.hidden, c.held_reason, c.novel_slug, c.episode_no, (e.novel_slug IS NOT NULL) AS published
           FROM ${s}.comments c LEFT JOIN ${s}.episodes e ON e.novel_slug = c.novel_slug AND e.episode_no = c.episode_no WHERE c.id = $1`,
          [id],
        );
        if (!row) throw notFound();
        return json(ctx, 200, adminDto(row));
      }
      throw notFound();
    }

    // ── own comment delete ──
    if (n === 2 && a === "comments" && method === "DELETE") {
      guardWrite(ctx);
      requireWritable();
      if (!/^\d{1,15}$/.test(b ?? "")) throw notFound();
      const visitor = visitorOf(ctx);
      if (!visitor) throw notFound();
      const db = deps.db();
      await limit(db, "deleteVisitor", visitor);
      const done = await db.query(`UPDATE ${s}.comments SET deleted_at = $3::timestamptz WHERE id = $1 AND visitor_id = $2 AND deleted_at IS NULL RETURNING id`, [Number(b), visitor, new Date(now()).toISOString()]);
      // someone else's comment looks exactly like a missing one
      if (!done.length) throw notFound();
      return json(ctx, 204, null);
    }

    // ── novels ──
    if (a === "novels" && b && isPublicSlug(b)) {
      const slug = b;
      if (n === 3 && c === "stats" && method === "GET") {
        const db = deps.db();
        await requireNovel(db, slug);
        return json(ctx, 200, await novelStats(db, slug, visitorOf(ctx)));
      }
      if (n === 3 && c === "like" && method === "POST") {
        guardWrite(ctx);
        requireWritable();
        const body = await readJson(ctx.req);
        if (typeof body.liked !== "boolean") throw new HttpError(400, "bad_request", "요청 형식이 올바르지 않습니다.");
        const db = deps.db();
        await requireNovel(db, slug);
        const visitor = await ensureVisitor(db, ctx);
        await limit(db, "likeVisitor", visitor);
        await limit(db, "likeIp", ipKey(ctx));
        if (body.liked) await db.query(`INSERT INTO ${s}.novel_likes (visitor_id, novel_slug) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [visitor, slug]);
        else await db.query(`DELETE FROM ${s}.novel_likes WHERE visitor_id = $1 AND novel_slug = $2`, [visitor, slug]);
        return json(ctx, 200, await novelStats(db, slug, visitor));
      }
      if (n === 3 && c === "rating" && (method === "PUT" || method === "DELETE")) {
        guardWrite(ctx);
        requireWritable();
        const body = method === "PUT" ? await readJson(ctx.req) : {};
        if (method === "PUT" && !(typeof body.score === "number" && Number.isInteger(body.score) && body.score >= 1 && body.score <= 5))
          throw new HttpError(400, "bad_score", "평점은 1~5점입니다.");
        const db = deps.db();
        await requireNovel(db, slug);
        const visitor = await ensureVisitor(db, ctx);
        await limit(db, "rateVisitor", visitor);
        await limit(db, "likeIp", ipKey(ctx));
        if (method === "PUT")
          await db.query(
            `INSERT INTO ${s}.ratings (visitor_id, novel_slug, score) VALUES ($1, $2, $3)
             ON CONFLICT (visitor_id, novel_slug) DO UPDATE SET score = excluded.score, updated_at = now()`,
            [visitor, slug, body.score],
          );
        else await db.query(`DELETE FROM ${s}.ratings WHERE visitor_id = $1 AND novel_slug = $2`, [visitor, slug]);
        return json(ctx, 200, await novelStats(db, slug, visitor));
      }
      if (c === "episodes" && d && /^\d{1,6}$/.test(d) && isEpisodeNo(Number(d))) {
        const no = Number(d);
        if (n === 5 && e === "stats" && method === "GET") {
          const db = deps.db();
          await requireEpisode(db, slug, no);
          return json(ctx, 200, await episodeStats(db, slug, no, visitorOf(ctx)));
        }
        if (n === 5 && e === "like" && method === "POST") {
          guardWrite(ctx);
          requireWritable();
          const body = await readJson(ctx.req);
          if (typeof body.liked !== "boolean") throw new HttpError(400, "bad_request", "요청 형식이 올바르지 않습니다.");
          const db = deps.db();
          await requireEpisode(db, slug, no);
          const visitor = await ensureVisitor(db, ctx);
          await limit(db, "likeVisitor", visitor);
          await limit(db, "likeIp", ipKey(ctx));
          if (body.liked) await db.query(`INSERT INTO ${s}.episode_likes (visitor_id, novel_slug, episode_no) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [visitor, slug, no]);
          else await db.query(`DELETE FROM ${s}.episode_likes WHERE visitor_id = $1 AND novel_slug = $2 AND episode_no = $3`, [visitor, slug, no]);
          return json(ctx, 200, await episodeStats(db, slug, no, visitor));
        }
        if (n === 5 && e === "comments" && method === "GET") {
          const db = deps.db();
          await requireEpisode(db, slug, no);
          return json(ctx, 200, await listComments(db, slug, no, visitorOf(ctx)));
        }
        if (n === 5 && e === "comments" && method === "POST") {
          guardWrite(ctx);
          requireWritable();
          const body = await readJson(ctx.req);
          const db = deps.db();
          await requireEpisode(db, slug, no);
          return json(ctx, 201, await addComment(db, ctx, slug, no, body));
        }
      }
    }
    void f;
    throw notFound();
  }

  return {
    /** `path`: the segments after /api/ */
    async handle(req: Request, path: readonly string[]): Promise<Response> {
      const ctx: Ctx = { req, cookies: parseCookies(req.headers.get("cookie")), setCookies: [], ip: clientIp(req.headers) };
      try {
        return await route(ctx, req.method.toUpperCase(), path);
      } catch (err) {
        if (err instanceof HttpError) return json(ctx, err.status, { error: { code: err.code, message: err.message } });
        if (err instanceof EnvError) {
          console.error(`[snowpage] ${err.message}`);
          return json(ctx, 503, { error: { code: "not_configured", message: "사이트 설정이 아직 끝나지 않았습니다." } });
        }
        // database / unexpected: log the class and code only (never values or connection details)
        const code = (err as { code?: unknown })?.code;
        console.error(`[snowpage] api error: ${(err as Error)?.name ?? "Error"}${typeof code === "string" ? ` (${code})` : ""}`);
        return json(ctx, 500, { error: { code: "internal", message: "잠시 문제가 생겼습니다. 다시 해 주세요." } });
      }
    },
  };
}

export type ReaderApi = ReturnType<typeof createReaderApi>;
