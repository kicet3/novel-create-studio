/** 좋아요 · 평점 · 댓글 (reader API). Comments are plain text: rendered as React text nodes, never as HTML. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CommentDto, CommentListDto, EpisodeStatsDto, NovelStatsDto } from "../../server/api-types.js";
import { api, errorText } from "../lib/data.js";
import { useSession } from "../lib/session.js";
import { Button, Icon, Message, Sheet, formatCount, timeAgo } from "./ui.js";

// ── episode stats (likes + comment count) ────────────────────────────────
export function useEpisodeStats(slug: string, episodeNo: number) {
  const { available, nickname } = useSession();
  const [stats, setStats] = useState<EpisodeStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/novels/${slug}/episodes/${episodeNo}`;
  useEffect(() => {
    if (!available) return;
    let alive = true;
    api<EpisodeStatsDto>("GET", `${path}/stats`).then(
      (s) => alive && setStats(s),
      () => alive && setStats(null),
    );
    return () => {
      alive = false;
    };
  }, [available, path, nickname]);
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

export function LikeButton({ liked, count, onToggle, compact }: { liked: boolean; count: number; onToggle: () => void; compact?: boolean }) {
  const { nickname, requireLogin } = useSession();
  return (
    <button type="button" className={`pr-like ${compact ? "pr-like-compact" : ""}`} aria-pressed={liked} onClick={() => (nickname ? onToggle() : requireLogin(onToggle))}>
      <Icon name="heart" filled={liked} />
      <span>{compact ? formatCount(count) : `좋아요 ${formatCount(count)}`}</span>
    </button>
  );
}

// ── novel: like + rating ─────────────────────────────────────────────────
export function NovelSocial({ slug }: { slug: string }) {
  const { available, nickname, requireLogin } = useSession();
  const [stats, setStats] = useState<NovelStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!available) return;
    let alive = true;
    api<NovelStatsDto>("GET", `/novels/${slug}/stats`).then(
      (s) => alive && setStats(s),
      () => alive && setStats(null),
    );
    return () => {
      alive = false;
    };
  }, [available, slug, nickname]);
  if (!available || !stats) return null;
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
          <button
            key={n}
            type="button"
            className="pr-star"
            aria-label={`${n}점`}
            aria-pressed={stats.rating.mine === n}
            data-on={(stats.rating.mine ?? 0) >= n}
            onClick={() => (nickname ? rate(n) : requireLogin(() => rate(n)))}
          >
            <Icon name="star" filled={(stats.rating.mine ?? 0) >= n} size={26} />
          </button>
        ))}
      </div>
      <LikeButton liked={stats.liked} count={stats.likes} onToggle={like} />
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
          </div>
          {/* plain text: React escapes it; line breaks via CSS white-space */}
          <p className="pr-comment-body">{c.body}</p>
          <div className="pr-comment-actions">
            {!isReply && onReply && (
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
  const { nickname, requireLogin } = useSession();
  const [list, setList] = useState<CommentListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<CommentDto | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/novels/${slug}/episodes/${episodeNo}/comments`;

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
  }, [open, path, nickname, apply]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nickname) return requireLogin();
    setBusy(true);
    try {
      apply(await api<CommentListDto>("POST", path, { body, parentId: replyTo?.id ?? null }));
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
        nickname ? (
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
            <div className="pr-compose-row">
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={1000} placeholder={replyTo ? "답글을 남겨 주세요" : `${title}에 댓글을 남겨 주세요`} aria-label="댓글 내용" />
              <Button type="submit" variant="primary" disabled={busy || !body.trim() || count > 1000}>
                등록
              </Button>
            </div>
            <small className="pr-faint pr-count">{count}/1000</small>
          </form>
        ) : (
          <Button variant="primary" className="pr-btn-block" onClick={() => requireLogin()}>
            로그인하고 댓글 쓰기
          </Button>
        )
      }
    >
      {error && <Message tone="danger">{error}</Message>}
      {!list && !error && <Message>불러오는 중…</Message>}
      {list && !list.items.length && <Message>첫 댓글을 남겨 보세요.</Message>}
      {list && list.items.length > 0 && (
        <ul className="pr-comments">
          {list.items.map((c) => (
            <CommentItem key={c.id} c={c} onReply={(x) => (nickname ? setReplyTo(x) : requireLogin(() => setReplyTo(x)))} onDelete={remove} />
          ))}
        </ul>
      )}
    </Sheet>
  );
}
