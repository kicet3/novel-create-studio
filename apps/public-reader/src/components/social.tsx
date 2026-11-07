"use client";
/**
 * 좋아요 · 평점 · 댓글 — anonymous (no login). The first write issues an anonymous visitor cookie on the server.
 * Comments are plain text: rendered as React text nodes, never as HTML.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CommentDto, CommentListDto, EpisodeStatsDto, NewCommentRequest, NovelStatsDto } from "../lib/api-types";
import { api, errorText, getSession } from "../lib/api-client";
import { browserStore } from "../lib/hooks";
import { formatCount, timeAgo } from "./format";
import { Sheet } from "./Sheet";
import { Button, Icon, Message } from "./ui";

const NICK_KEY = "snowpage.nickname";
const NICK_MAX = 20;
const BODY_MAX = 1000;

/** writes are on for this deployment (null until known) */
export function useWritable(): boolean | null {
  const [w, setW] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getSession().then(
      (s) => alive && setW(s.writable),
      () => alive && setW(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  return w;
}

// ── episode stats (likes + comment count) ────────────────────────────────
export function useEpisodeStats(slug: string, episodeNo: number) {
  const [stats, setStats] = useState<EpisodeStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/novels/${slug}/episodes/${episodeNo}`;
  useEffect(() => {
    let alive = true;
    api<EpisodeStatsDto>("GET", `${path}/stats`).then(
      (s) => alive && setStats(s),
      () => alive && setStats(null),
    );
    return () => {
      alive = false;
    };
  }, [path]);
  const toggleLike = useCallback(async () => {
    if (!stats) return;
    const liked = !stats.liked;
    setStats({ ...stats, liked, likes: stats.likes + (liked ? 1 : -1) }); // optimistic
    try {
      setStats(await api<EpisodeStatsDto>("POST", `${path}/like`, { liked }));
      setError(null);
    } catch (e) {
      setStats(stats);
      setError(errorText(e));
    }
  }, [stats, path]);
  const setComments = useCallback((n: number) => setStats((s) => (s ? { ...s, comments: n } : s)), []);
  return { stats, toggleLike, error, setComments };
}

export function LikeButton({ liked, count, onToggle, compact, disabled }: { liked: boolean; count: number; onToggle: () => void; compact?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`pr-like ${compact ? "pr-like-compact" : ""}`} aria-pressed={liked} disabled={disabled} onClick={onToggle} aria-label={compact ? `좋아요 ${count}개` : undefined}>
      <Icon name="heart" filled={liked} />
      <span>{compact ? formatCount(count) : `좋아요 ${formatCount(count)}`}</span>
    </button>
  );
}

// ── novel: like + rating ─────────────────────────────────────────────────
export interface NovelAggregates {
  likes: number;
  ratingAverage: number | null;
  ratingCount: number;
}

export function NovelSocial({ slug, initial }: { slug: string; initial: NovelAggregates }) {
  const writable = useWritable();
  const [stats, setStats] = useState<NovelStatsDto>({ likes: initial.likes, liked: false, rating: { average: initial.ratingAverage, count: initial.ratingCount, mine: null } });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<NovelStatsDto>("GET", `/novels/${slug}/stats`).then(
      (s) => alive && setStats(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [slug]);
  const run = async (fn: () => Promise<NovelStatsDto>) => {
    try {
      setStats(await fn());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const like = () => run(() => api("POST", `/novels/${slug}/like`, { liked: !stats.liked }));
  const rate = (score: number) => run(() => (stats.rating.mine === score ? api("DELETE", `/novels/${slug}/rating`) : api("PUT", `/novels/${slug}/rating`, { score })));
  const avg = stats.rating.average;
  const off = writable === false;
  return (
    <div className="pr-novel-social">
      <div className="pr-rating" aria-label={avg === null ? "아직 평점이 없습니다" : `평균 평점 ${avg}점, ${stats.rating.count}명`}>
        <span className="pr-rating-avg">
          <Icon name="star" filled size={18} /> {avg === null ? "평점 없음" : avg.toFixed(1)}
        </span>
        {avg !== null && <span className="pr-faint">({formatCount(stats.rating.count)}명)</span>}
      </div>
      <div className="pr-stars" role="group" aria-label={stats.rating.mine ? `내 평점 ${stats.rating.mine}점 (같은 별을 다시 누르면 취소)` : "평점 주기"}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className="pr-star" aria-label={`${n}점`} aria-pressed={stats.rating.mine === n} data-on={(stats.rating.mine ?? 0) >= n} disabled={off} onClick={() => rate(n)}>
            <Icon name="star" filled={(stats.rating.mine ?? 0) >= n} size={26} />
          </button>
        ))}
      </div>
      <LikeButton liked={stats.liked} count={stats.likes} onToggle={like} disabled={off} />
      {error && <Message tone="danger">{error}</Message>}
    </div>
  );
}

// ── comments ─────────────────────────────────────────────────────────────
export function CommentItem({ c, onReply, onDelete, isReply }: { c: CommentDto; onReply?: (c: CommentDto) => void; onDelete?: (c: CommentDto) => void; isReply?: boolean }) {
  return (
    <li className={`pr-comment ${isReply ? "pr-comment-reply" : ""}`}>
      {c.state === "visible" ? (
        <>
          <div className="pr-comment-meta">
            <strong>{c.nickname}</strong>
            <span className="pr-faint">{timeAgo(c.createdAt)}</span>
            {c.pending && <span className="pr-faint">· 검토 후 다른 독자에게 보입니다</span>}
          </div>
          {/* plain text: React escapes it; line breaks via CSS white-space */}
          <p className="pr-comment-body">{c.body}</p>
          <div className="pr-comment-actions">
            {!isReply && onReply && !c.pending && (
              <button type="button" className="pr-link-btn" onClick={() => onReply(c)}>
                답글
              </button>
            )}
            {c.mine && onDelete && (
              <button type="button" className="pr-link-btn" onClick={() => onDelete(c)}>
                삭제
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="pr-comment-body pr-faint">{c.state === "hidden" ? "운영 정책에 따라 숨겨진 댓글입니다." : "삭제된 댓글입니다."}</p>
      )}
      {c.replies.length > 0 && (
        <ul className="pr-replies">
          {c.replies.map((r) => (
            <CommentItem key={r.id} c={r} isReply onDelete={onDelete} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CommentsSheet({ open, onClose, slug, episodeNo, title, onCount }: { open: boolean; onClose: () => void; slug: string; episodeNo: number; title: string; onCount?: (n: number) => void }) {
  const writable = useWritable();
  const [list, setList] = useState<CommentListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [nickname, setNickname] = useState("");
  const [website, setWebsite] = useState("");
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/novels/${slug}/episodes/${episodeNo}/comments`;

  useEffect(() => {
    try {
      setNickname(browserStore()?.getItem(NICK_KEY) ?? "");
    } catch {
      /* storage blocked */
    }
  }, []);

  const apply = useCallback(
    (l: CommentListDto) => {
      setList(l);
      onCount?.(l.total);
    },
    [onCount],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    api<CommentListDto>("GET", path).then(
      (l) => alive && apply(l),
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [open, path, apply]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const nick = nickname.trim();
    try {
      const req: NewCommentRequest = { body, nickname: nick || null, parentId: replyTo?.id ?? null, website };
      apply(await api<CommentListDto>("POST", path, req));
      try {
        browserStore()?.setItem(NICK_KEY, nick);
      } catch {
        /* storage blocked */
      }
      setBody("");
      setReplyTo(null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: CommentDto) => {
    if (!window.confirm("이 댓글을 삭제할까요?")) return;
    try {
      await api("DELETE", `/comments/${c.id}`);
      apply(await api<CommentListDto>("GET", path));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const count = [...body].length;

  return (
    <Sheet
      open={open}
      title={`댓글${list ? ` ${formatCount(list.total)}` : ""}`}
      onClose={onClose}
      footer={
        writable === false ? (
          <Message>지금은 댓글을 남길 수 없습니다.</Message>
        ) : (
          <form className="pr-compose" onSubmit={submit}>
            {replyTo && (
              <div className="pr-compose-reply">
                <span>
                  <strong>{replyTo.nickname}</strong>님에게 답글
                </span>
                <button type="button" className="pr-link-btn" onClick={() => setReplyTo(null)}>
                  취소
                </button>
              </div>
            )}
            {/* honeypot: hidden from people, bots fill it in */}
            <label className="pr-hp" aria-hidden="true">
              웹사이트
              <input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
            <input
              className="pr-compose-nick"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={NICK_MAX}
              placeholder="닉네임(비우면 익명)"
              aria-label="닉네임(선택)"
              autoComplete="nickname"
            />
            <div className="pr-compose-row">
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={BODY_MAX} placeholder={replyTo ? "답글을 남겨 주세요" : `${title}에 댓글을 남겨 주세요`} aria-label="댓글 내용" />
              <Button type="submit" variant="primary" disabled={busy || !body.trim() || count > BODY_MAX}>
                등록
              </Button>
            </div>
            <small className="pr-faint pr-count">
              로그인 없이 익명으로 남습니다 · {count}/{BODY_MAX}
            </small>
          </form>
        )
      }
    >
      {error && <Message tone="danger">{error}</Message>}
      {!list && !error && <Message>불러오는 중…</Message>}
      {list && !list.items.length && <Message>첫 댓글을 남겨 보세요.</Message>}
      {list && list.items.length > 0 && (
        <ul className="pr-comments">
          {list.items.map((c) => (
            <CommentItem key={c.id} c={c} onReply={writable === false ? undefined : (x) => setReplyTo(x)} onDelete={remove} />
          ))}
        </ul>
      )}
    </Sheet>
  );
}
