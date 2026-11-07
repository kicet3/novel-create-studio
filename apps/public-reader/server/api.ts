/**
 * Reader API (/api/…): 회원가입·로그인, 좋아요(작품·화), 평점(작품, 1–5), 댓글(화, 답글 1단계), 운영 보기(ADMIN_TOKEN).
 * Reading needs no account; every write needs a session + CSRF token and targets something in the published snapshot.
 *
 *   GET    /api/session                                  → SessionDto (issues the CSRF cookie)
 *   POST   /api/signup {nickname, password}              → SessionDto (+ session cookie)
 *   POST   /api/login  {nickname, password}              → SessionDto
 *   POST   /api/logout                                   → SessionDto
 *   GET    /api/novels/:slug/stats                       → NovelStatsDto
 *   POST   /api/novels/:slug/like      {liked}           → NovelStatsDto
 *   PUT    /api/novels/:slug/rating    {score: 1..5}     → NovelStatsDto
 *   DELETE /api/novels/:slug/rating                      → NovelStatsDto
 *   GET    /api/novels/:slug/episodes/:no/stats          → EpisodeStatsDto
 *   POST   /api/novels/:slug/episodes/:no/like {liked}   → EpisodeStatsDto
 *   GET    /api/novels/:slug/episodes/:no/comments       → CommentListDto
 *   POST   /api/novels/:slug/episodes/:no/comments {body, parentId?} → CommentListDto
 *   DELETE /api/comments/:id                             → 204 (own comment, soft delete)
 *   GET    /api/admin/overview                           → AdminOverviewDto   (Authorization: Bearer ADMIN_TOKEN)
 *   POST   /api/admin/comments/:id {hidden?, deleted?}   → AdminCommentDto
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminCommentDto, AdminOverviewDto, CommentDto, CommentListDto, EpisodeStatsDto, NovelStatsDto, SessionDto } from "./api-types.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  DUMMY_HASH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  checkNickname,
  checkPassword,
  cleanCommentBody,
  cookie,
  csrfOk,
  hashPassword,
  newToken,
  parseCookies,
  safeEqual,
  tokenHash,
  verifyPassword,
} from "./auth.js";
import type { Catalog } from "./catalog.js";
import { RULES, type RateLimiter, type RateRule } from "./rate-limit.js";
import { tx, type CommentRow, type Db, type ReaderRow } from "./store.js";

export interface ApiOptions {
  db: Db;
  catalog: Catalog;
  limiter: RateLimiter;
  /** unset / empty → the admin API is disabled (404) */
  adminToken?: string | undefined;
  /** exact origins allowed to POST (e.g. https://reader.example.com); empty → same host as the request */
  allowedOrigins?: readonly string[];
  /** set the Secure flag on cookies (https deployments) */
  secureCookies?: boolean;
  /** client IP (default: the socket address; behind a proxy pass a trusted resolver) */
  clientIp?: (req: IncomingMessage) => string;
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

const MAX_BODY = 8 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "요청이 너무 큽니다.");
    chunks.push(c);
  }
  if (!size) return {};
  if (!type.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "JSON으로 보내 주세요.");
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "요청 형식이 올바르지 않습니다.");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(Buffer.byteLength(text)));
  res.end(text);
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createApi(o: ApiOptions) {
  const { db, catalog, limiter } = o;
  const now = o.now ?? Date.now;
  const adminToken = o.adminToken?.trim() || null;
  const ipOf = o.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? "unknown");

  const limit = (key: string, rule: RateRule) => {
    if (!limiter.hit(key, rule)) throw new HttpError(429, "rate_limited", "요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요.");
  };

  // ── prepared statements ────────────────────────────────────────────────
  const q = {
    readerByKey: db.prepare("SELECT * FROM readers WHERE nickname_key = ?"),
    insertReader: db.prepare("INSERT INTO readers (nickname, nickname_key, password_hash, created_at) VALUES (?, ?, ?, ?)"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, reader_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    sessionReader: db.prepare("SELECT r.* FROM sessions s JOIN readers r ON r.id = s.reader_id WHERE s.token_hash = ? AND s.expires_at > ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    novelLikes: db.prepare("SELECT count(*) AS n FROM novel_likes WHERE slug = ?"),
    novelLiked: db.prepare("SELECT 1 AS x FROM novel_likes WHERE slug = ? AND reader_id = ?"),
    likeNovel: db.prepare("INSERT OR IGNORE INTO novel_likes (reader_id, slug, created_at) VALUES (?, ?, ?)"),
    unlikeNovel: db.prepare("DELETE FROM novel_likes WHERE reader_id = ? AND slug = ?"),
    ratingAgg: db.prepare("SELECT count(*) AS n, avg(score) AS avg FROM ratings WHERE slug = ?"),
    ratingMine: db.prepare("SELECT score FROM ratings WHERE slug = ? AND reader_id = ?"),
    upsertRating: db.prepare(
      "INSERT INTO ratings (reader_id, slug, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (reader_id, slug) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at",
    ),
    deleteRating: db.prepare("DELETE FROM ratings WHERE reader_id = ? AND slug = ?"),
    episodeLikes: db.prepare("SELECT count(*) AS n FROM episode_likes WHERE slug = ? AND episode_no = ?"),
    episodeLiked: db.prepare("SELECT 1 AS x FROM episode_likes WHERE slug = ? AND episode_no = ? AND reader_id = ?"),
    likeEpisode: db.prepare("INSERT OR IGNORE INTO episode_likes (reader_id, slug, episode_no, created_at) VALUES (?, ?, ?, ?)"),
    unlikeEpisode: db.prepare("DELETE FROM episode_likes WHERE reader_id = ? AND slug = ? AND episode_no = ?"),
    commentCount: db.prepare("SELECT count(*) AS n FROM comments WHERE slug = ? AND episode_no = ? AND deleted_at IS NULL AND hidden = 0"),
    comments: db.prepare("SELECT c.*, r.nickname FROM comments c JOIN readers r ON r.id = c.reader_id WHERE c.slug = ? AND c.episode_no = ? ORDER BY c.id"),
    comment: db.prepare("SELECT c.*, r.nickname FROM comments c JOIN readers r ON r.id = c.reader_id WHERE c.id = ?"),
    insertComment: db.prepare("INSERT INTO comments (slug, episode_no, reader_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    softDelete: db.prepare("UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"),
    setHidden: db.prepare("UPDATE comments SET hidden = ? WHERE id = ?"),
    recent: db.prepare("SELECT c.*, r.nickname FROM comments c JOIN readers r ON r.id = c.reader_id ORDER BY c.id DESC LIMIT 200"),
    count: (table: string, where = "") => db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`),
  };
  const n = (row: unknown) => Number((row as { n?: number } | undefined)?.n ?? 0);

  // ── session / csrf ─────────────────────────────────────────────────────
  interface Ctx {
    req: IncomingMessage;
    res: ServerResponse;
    cookies: Record<string, string>;
    reader: ReaderRow | null;
    ip: string;
  }

  const appendCookie = (res: ServerResponse, value: string) => {
    const prev = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), value]);
  };

  function csrfToken(c: Ctx): string {
    const existing = c.cookies[CSRF_COOKIE];
    if (existing && /^[\w-]{32,64}$/.test(existing)) return existing;
    const t = newToken();
    c.cookies[CSRF_COOKIE] = t;
    appendCookie(c.res, cookie(CSRF_COOKIE, t, { maxAgeSec: 365 * 24 * 3600, secure: o.secureCookies }));
    return t;
  }

  function startSession(c: Ctx, reader: ReaderRow): void {
    const token = newToken();
    q.insertSession.run(tokenHash(token), reader.id, iso(now()), now() + SESSION_TTL_MS);
    appendCookie(c.res, cookie(SESSION_COOKIE, token, { httpOnly: true, maxAgeSec: SESSION_TTL_MS / 1000, secure: o.secureCookies }));
    c.reader = reader;
  }

  const sessionDto = (c: Ctx): SessionDto => ({ reader: c.reader ? { nickname: c.reader.nickname } : null, csrf: csrfToken(c) });

  const requireReader = (c: Ctx): ReaderRow => {
    if (!c.reader) throw new HttpError(401, "login_required", "로그인이 필요합니다.");
    return c.reader;
  };

  // ── targets ────────────────────────────────────────────────────────────
  const novelOr404 = (slug: string) => {
    if (!catalog.novel(slug)) throw new HttpError(404, "not_found", "공개된 작품이 아닙니다.");
  };
  const episodeOr404 = (slug: string, no: number) => {
    if (!catalog.hasEpisode(slug, no)) throw new HttpError(404, "not_found", "공개된 화가 아닙니다.");
  };

  const novelStats = (slug: string, reader: ReaderRow | null): NovelStatsDto => {
    const agg = q.ratingAgg.get(slug) as { n: number; avg: number | null };
    const mine = reader ? ((q.ratingMine.get(slug, reader.id) as { score: number } | undefined)?.score ?? null) : null;
    return {
      likes: n(q.novelLikes.get(slug)),
      liked: !!reader && !!q.novelLiked.get(slug, reader.id),
      rating: { average: agg.n ? Math.round(Number(agg.avg) * 10) / 10 : null, count: Number(agg.n), mine },
    };
  };

  const episodeStats = (slug: string, no: number, reader: ReaderRow | null): EpisodeStatsDto => ({
    likes: n(q.episodeLikes.get(slug, no)),
    liked: !!reader && !!q.episodeLiked.get(slug, no, reader.id),
    comments: n(q.commentCount.get(slug, no)),
  });

  const commentList = (slug: string, no: number, reader: ReaderRow | null): CommentListDto => {
    const rows = q.comments.all(slug, no) as unknown as CommentRow[];
    const toDto = (r: CommentRow): CommentDto => {
      const state = r.deleted_at ? "deleted" : r.hidden ? "hidden" : "visible";
      return {
        id: r.id,
        nickname: state === "visible" ? r.nickname : null,
        body: state === "visible" ? r.body : null,
        createdAt: r.created_at,
        state,
        mine: !!reader && r.reader_id === reader.id && state === "visible",
        replies: [],
      };
    };
    const roots: CommentDto[] = [];
    const byId = new Map<number, CommentDto>();
    for (const r of rows.filter((x) => x.parent_id === null)) {
      const d = toDto(r);
      byId.set(r.id, d);
      roots.push(d);
    }
    for (const r of rows.filter((x) => x.parent_id !== null)) {
      const d = toDto(r);
      if (d.state !== "visible") continue; // removed replies simply disappear
      byId.get(r.parent_id!)?.replies.push(d);
    }
    // a removed top-level comment stays as a placeholder only while it has visible replies
    const items = roots.filter((d) => d.state === "visible" || d.replies.length > 0).reverse();
    return { items, total: n(q.commentCount.get(slug, no)) };
  };

  const adminDto = (r: CommentRow): AdminCommentDto => ({
    id: r.id,
    slug: r.slug,
    episodeNo: r.episode_no,
    parentId: r.parent_id,
    nickname: r.nickname,
    body: r.body,
    createdAt: r.created_at,
    deleted: !!r.deleted_at,
    hidden: !!r.hidden,
    unpublished: !catalog.hasEpisode(r.slug, r.episode_no),
  });

  const requireAdmin = (c: Ctx) => {
    if (!adminToken) throw new HttpError(404, "not_found", "찾을 수 없습니다.");
    limit(`admin:ip:${c.ip}`, RULES.adminIp);
    const auth = String(c.req.headers.authorization ?? "");
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    if (!m || !safeEqual(m[1]!, adminToken)) throw new HttpError(401, "unauthorized", "운영 토큰이 올바르지 않습니다.");
  };

  const boolField = (v: unknown, name: string) => {
    if (typeof v !== "boolean") throw new HttpError(400, "bad_request", `${name} 값이 필요합니다.`);
    return v;
  };

  // ── routes ─────────────────────────────────────────────────────────────
  async function route(c: Ctx, method: string, path: string): Promise<void> {
    const { res } = c;
    let m: RegExpExecArray | null;

    if (path === "/api/session" && method === "GET") return json(res, 200, sessionDto(c));

    if (path === "/api/signup" && method === "POST") {
      const body = await readJson(c.req);
      const nick = checkNickname(body.nickname);
      if (!nick.ok) throw new HttpError(400, "bad_nickname", nick.message);
      const pw = checkPassword(body.password);
      if (!pw.ok) throw new HttpError(400, "bad_password", pw.message);
      limit(`signup:ip:${c.ip}`, RULES.signupIp);
      if (q.readerByKey.get(nick.key)) throw new HttpError(409, "nickname_taken", "이미 쓰이는 닉네임입니다.");
      const hash = hashPassword(pw.password);
      let reader: ReaderRow;
      try {
        reader = tx(db, () => {
          q.insertReader.run(nick.nickname, nick.key, hash, iso(now()));
          return q.readerByKey.get(nick.key) as unknown as ReaderRow;
        });
      } catch {
        throw new HttpError(409, "nickname_taken", "이미 쓰이는 닉네임입니다.");
      }
      startSession(c, reader);
      return json(res, 201, sessionDto(c));
    }

    if (path === "/api/login" && method === "POST") {
      const body = await readJson(c.req);
      limit(`login:ip:${c.ip}`, RULES.loginIp);
      const nick = checkNickname(body.nickname);
      const key = nick.ok ? nick.key : String(body.nickname ?? "").toLowerCase().slice(0, 32);
      if (!limiter.peek(`loginfail:${key}`, RULES.loginFailNick)) throw new HttpError(429, "rate_limited", "로그인 시도가 너무 많습니다. 잠시 뒤에 다시 해 주세요.");
      const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
      const reader = nick.ok ? ((q.readerByKey.get(nick.key) as unknown as ReaderRow | undefined) ?? null) : null;
      const ok = verifyPassword(password, reader?.password_hash ?? DUMMY_HASH) && !!reader;
      if (!ok) {
        limiter.hit(`loginfail:${key}`, RULES.loginFailNick);
        throw new HttpError(401, "bad_credentials", "닉네임 또는 비밀번호가 맞지 않습니다.");
      }
      limiter.reset(`loginfail:${key}`);
      startSession(c, reader!);
      return json(res, 200, sessionDto(c));
    }

    if (path === "/api/logout" && method === "POST") {
      const token = c.cookies[SESSION_COOKIE];
      if (token) q.deleteSession.run(tokenHash(token));
      appendCookie(res, cookie(SESSION_COOKIE, "", { httpOnly: true, maxAgeSec: 0, secure: o.secureCookies }));
      c.reader = null;
      return json(res, 200, sessionDto(c));
    }

    if ((m = /^\/api\/novels\/([^/]+)\/stats$/.exec(path)) && method === "GET") {
      const slug = m[1]!;
      novelOr404(slug);
      return json(res, 200, novelStats(slug, c.reader));
    }

    if ((m = /^\/api\/novels\/([^/]+)\/like$/.exec(path)) && method === "POST") {
      const slug = m[1]!;
      const reader = requireReader(c);
      novelOr404(slug);
      const liked = boolField((await readJson(c.req)).liked, "liked");
      limit(`like:r:${reader.id}`, RULES.likeReader);
      limit(`like:ip:${c.ip}`, RULES.likeIp);
      if (liked) q.likeNovel.run(reader.id, slug, iso(now()));
      else q.unlikeNovel.run(reader.id, slug);
      return json(res, 200, novelStats(slug, reader));
    }

    if ((m = /^\/api\/novels\/([^/]+)\/rating$/.exec(path)) && (method === "PUT" || method === "DELETE")) {
      const slug = m[1]!;
      const reader = requireReader(c);
      novelOr404(slug);
      limit(`rate:r:${reader.id}`, RULES.rateReader);
      if (method === "DELETE") q.deleteRating.run(reader.id, slug);
      else {
        const score = (await readJson(c.req)).score;
        if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) throw new HttpError(400, "bad_score", "평점은 1~5점입니다.");
        q.upsertRating.run(reader.id, slug, score, iso(now()), iso(now()));
      }
      return json(res, 200, novelStats(slug, reader));
    }

    if ((m = /^\/api\/novels\/([^/]+)\/episodes\/(\d{1,6})\/(stats|like|comments)$/.exec(path))) {
      const slug = m[1]!;
      const no = Number(m[2]);
      const what = m[3]!;
      if (what === "stats" && method === "GET") {
        episodeOr404(slug, no);
        return json(res, 200, episodeStats(slug, no, c.reader));
      }
      if (what === "like" && method === "POST") {
        const reader = requireReader(c);
        episodeOr404(slug, no);
        const liked = boolField((await readJson(c.req)).liked, "liked");
        limit(`like:r:${reader.id}`, RULES.likeReader);
        limit(`like:ip:${c.ip}`, RULES.likeIp);
        if (liked) q.likeEpisode.run(reader.id, slug, no, iso(now()));
        else q.unlikeEpisode.run(reader.id, slug, no);
        return json(res, 200, episodeStats(slug, no, reader));
      }
      if (what === "comments" && method === "GET") {
        episodeOr404(slug, no);
        return json(res, 200, commentList(slug, no, c.reader));
      }
      if (what === "comments" && method === "POST") {
        const reader = requireReader(c);
        episodeOr404(slug, no);
        const body = await readJson(c.req);
        const text = cleanCommentBody(body.body);
        if (!text.ok) throw new HttpError(400, "bad_body", text.message);
        let parentId: number | null = null;
        if (body.parentId !== undefined && body.parentId !== null) {
          if (typeof body.parentId !== "number" || !Number.isInteger(body.parentId)) throw new HttpError(400, "bad_parent", "답글을 달 댓글이 올바르지 않습니다.");
          const parent = q.comment.get(body.parentId) as unknown as CommentRow | undefined;
          if (!parent || parent.slug !== slug || parent.episode_no !== no || parent.deleted_at || parent.hidden) throw new HttpError(404, "parent_not_found", "답글을 달 댓글을 찾을 수 없습니다.");
          if (parent.parent_id !== null) throw new HttpError(400, "reply_depth", "답글에는 답글을 달 수 없습니다.");
          parentId = parent.id;
        }
        limit(`comment:r:${reader.id}`, RULES.commentReader);
        limit(`commenth:r:${reader.id}`, RULES.commentReaderHour);
        limit(`comment:ip:${c.ip}`, RULES.commentIp);
        q.insertComment.run(slug, no, reader.id, parentId, text.body, iso(now()));
        return json(res, 201, commentList(slug, no, reader));
      }
    }

    if ((m = /^\/api\/comments\/(\d{1,12})$/.exec(path)) && method === "DELETE") {
      const reader = requireReader(c);
      const row = q.comment.get(Number(m[1])) as unknown as CommentRow | undefined;
      if (!row || row.reader_id !== reader.id || row.deleted_at) throw new HttpError(404, "not_found", "댓글을 찾을 수 없습니다.");
      q.softDelete.run(iso(now()), row.id);
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return;
    }

    if (path === "/api/admin/overview" && method === "GET") {
      requireAdmin(c);
      const body: AdminOverviewDto = {
        readers: n(q.count("readers").get()),
        comments: n(q.count("comments", "WHERE deleted_at IS NULL").get()),
        hiddenComments: n(q.count("comments", "WHERE hidden = 1 AND deleted_at IS NULL").get()),
        novelLikes: n(q.count("novel_likes").get()),
        episodeLikes: n(q.count("episode_likes").get()),
        ratings: n(q.count("ratings").get()),
        recent: (q.recent.all() as unknown as CommentRow[]).map(adminDto),
      };
      return json(res, 200, body);
    }

    if ((m = /^\/api\/admin\/comments\/(\d{1,12})$/.exec(path)) && method === "POST") {
      requireAdmin(c);
      const id = Number(m[1]);
      const row = q.comment.get(id) as unknown as CommentRow | undefined;
      if (!row) throw new HttpError(404, "not_found", "댓글을 찾을 수 없습니다.");
      const body = await readJson(c.req);
      if (body.hidden !== undefined) q.setHidden.run(boolField(body.hidden, "hidden") ? 1 : 0, id);
      if (body.deleted === true) q.softDelete.run(iso(now()), id);
      return json(res, 200, adminDto(q.comment.get(id) as unknown as CommentRow));
    }

    throw new HttpError(404, "not_found", "찾을 수 없습니다.");
  }

  let lastPurge = 0;

  return async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? "GET";
    const cookies = parseCookies(req.headers.cookie);
    const c: Ctx = { req, res, cookies, reader: null, ip: ipOf(req) };
    try {
      if (now() - lastPurge > 3600_000) {
        lastPurge = now();
        q.purgeSessions.run(now());
      }
      const token = cookies[SESSION_COOKIE];
      if (token && token.length <= 128) c.reader = (q.sessionReader.get(tokenHash(token), now()) as unknown as ReaderRow | undefined) ?? null;
      const isAdmin = path.startsWith("/api/admin/");
      // CSRF: cookie-authenticated writes need the double-submit token + same origin. The admin API authenticates
      // with a bearer header (never sent automatically by browsers), so it is not CSRF-able.
      if (!isAdmin) {
        const ok = csrfOk({
          method,
          cookieToken: cookies[CSRF_COOKIE],
          headerToken: typeof req.headers[CSRF_HEADER] === "string" ? (req.headers[CSRF_HEADER] as string) : undefined,
          origin: req.headers.origin,
          referer: req.headers.referer,
          host: req.headers.host,
          allowedOrigins: o.allowedOrigins ?? [],
        });
        if (!ok) throw new HttpError(403, "csrf", "페이지를 새로 고친 뒤 다시 해 주세요.");
      }
      await route(c, method, path);
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return json(res, err.status, { error: { code: err.code, message: err.message } });
      console.error("[public-reader] api error", err instanceof Error ? err.message : err);
      json(res, 500, { error: { code: "internal", message: "잠시 뒤에 다시 해 주세요." } });
    }
  };
}
