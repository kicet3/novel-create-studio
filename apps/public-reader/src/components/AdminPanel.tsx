"use client";
/** 운영 화면 (client): token → POST /api/admin/session (httpOnly cookie); overview, hide / delete comments. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminCommentDto, AdminOverviewDto, AdminSessionDto } from "../lib/api-types";
import { api, errorText } from "../lib/api-client";
import { formatCount, timeAgo } from "./format";
import { Button, Message } from "./ui";

export function AdminPanel() {
  const [session, setSession] = useState<AdminSessionDto | null>(null);
  const [input, setInput] = useState("");
  const [data, setData] = useState<AdminOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminOverviewDto>("GET", "/admin/overview"));
      setError(null);
    } catch (e) {
      setData(null);
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    api<AdminSessionDto>("GET", "/admin/session").then(setSession, (e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (session?.authed) void load();
  }, [session?.authed, load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setSession(await api<AdminSessionDto>("POST", "/admin/session", { token: input.trim() }));
      setInput("");
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const logout = async () => {
    try {
      setSession(await api<AdminSessionDto>("DELETE", "/admin/session"));
      setData(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const act = async (c: AdminCommentDto, body: { hidden?: boolean; deleted?: boolean }) => {
    try {
      await api("POST", `/admin/comments/${c.id}`, body);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!session) return error ? <Message tone="danger">{error}</Message> : <Message>불러오는 중…</Message>;
  if (!session.enabled) return <Message>이 사이트에는 운영 화면이 꺼져 있습니다(ADMIN_TOKEN 미설정).</Message>;

  return (
    <>
      {!session.authed && (
        <form className="pr-form" onSubmit={submit}>
          <label className="pr-field">
            <span>운영 토큰</span>
            <input type="password" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" required />
            <small>배포 환경 변수 ADMIN_TOKEN 값입니다. 한 번 입력하면 이 브라우저에 7일 동안 보관됩니다(httpOnly 쿠키, 토큰 자체는 저장하지 않음).</small>
          </label>
          <Button type="submit" variant="primary">
            확인
          </Button>
        </form>
      )}
      {error && <Message tone="danger">{error}</Message>}
      {session.authed && data && (
        <>
          <dl className="pr-stats">
            {(
              [
                ["방문자", data.visitors],
                ["댓글", data.comments],
                ["숨김", data.hiddenComments],
                ["작품 좋아요", data.novelLikes],
                ["화 좋아요", data.episodeLikes],
                ["평점", data.ratings],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{formatCount(v)}</dd>
              </div>
            ))}
          </dl>
          <h2 className="pr-h2">최근 댓글</h2>
          <ul className="pr-comments pr-admin-list">
            {/* PC: column heads of the comment table (hidden below 1024px) */}
            <li className="pr-admin-head" aria-hidden="true">
              <span>작성자 · 위치</span>
              <span>내용</span>
              <span className="text-right">관리</span>
            </li>
            {data.recent.map((c) => (
              <li key={c.id} className="pr-comment pr-admin-row" data-muted={c.deleted || c.hidden}>
                <div className="pr-comment-meta">
                  <strong>{c.nickname}</strong>
                  <span className="pr-faint">
                    {c.slug} {c.episodeNo}화{c.parentId ? " · 답글" : ""} · {timeAgo(c.createdAt)}
                    {c.deleted ? " · 삭제됨" : c.hidden ? (c.heldReason === "banned_word" ? " · 금칙어 보류" : " · 숨김") : ""}
                    {c.unpublished ? " · 비공개된 화" : ""}
                  </span>
                </div>
                <p className="pr-comment-body">{c.body}</p>
                {c.deleted ? <span aria-hidden="true" /> : (
                  <div className="pr-comment-actions">
                    <button type="button" className="pr-link-btn" onClick={() => act(c, { hidden: !c.hidden })}>
                      {c.hidden ? "다시 보이기" : "숨기기"}
                    </button>
                    <button type="button" className="pr-link-btn" onClick={() => window.confirm("삭제할까요? 되돌릴 수 없습니다.") && act(c, { deleted: true })}>
                      삭제
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={() => void logout()}>
            운영 화면에서 나가기
          </Button>
        </>
      )}
    </>
  );
}
