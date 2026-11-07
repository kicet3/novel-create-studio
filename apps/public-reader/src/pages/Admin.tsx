/** 운영: 댓글 숨기기·삭제, 숫자 보기. Needs ADMIN_TOKEN on the server (unset → disabled); the token stays in this tab. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminCommentDto, AdminOverviewDto } from "../../server/api-types.js";
import { api, errorText } from "../lib/data.js";
import { SITE_NAME, useDocumentMeta } from "../lib/hooks.js";
import { href } from "../lib/router.js";
import { Button, Message, formatCount, timeAgo } from "../components/ui.js";
import { AppHeader } from "./AppHeader.js";

const KEY = "ncs.reader.admin-token";

export function Admin() {
  useDocumentMeta(`운영 · ${SITE_NAME}`);
  const [token, setToken] = useState(() => sessionStorage.getItem(KEY) ?? "");
  const [input, setInput] = useState("");
  const [data, setData] = useState<AdminOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auth = { authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setData(await api<AdminOverviewDto>("GET", "/admin/overview", undefined, { authorization: `Bearer ${token}` }));
      setError(null);
    } catch (e) {
      setData(null);
      setError(errorText(e));
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    sessionStorage.setItem(KEY, input.trim());
    setToken(input.trim());
    setInput("");
  };
  const act = async (c: AdminCommentDto, body: { hidden?: boolean; deleted?: boolean }) => {
    try {
      await api("POST", `/admin/comments/${c.id}`, body, auth);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="pr-page">
      <AppHeader back={href.list()} title="운영" />
      <main className="pr-main" id="main">
        {!data && (
          <form className="pr-form" onSubmit={submit}>
            <label className="pr-field">
              <span>운영 토큰</span>
              <input type="password" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" required />
              <small>서버의 ADMIN_TOKEN 값입니다. 이 탭을 닫으면 지워집니다.</small>
            </label>
            <Button type="submit" variant="primary">
              확인
            </Button>
          </form>
        )}
        {error && <Message tone="danger">{error}</Message>}
        {data && (
          <>
            <dl className="pr-stats">
              {(
                [
                  ["독자", data.readers],
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
            <ul className="pr-comments">
              {data.recent.map((c) => (
                <li key={c.id} className="pr-comment" data-muted={c.deleted || c.hidden}>
                  <div className="pr-comment-meta">
                    <strong>{c.nickname}</strong>
                    <span className="pr-faint">
                      {c.slug} {c.episodeNo}화{c.parentId ? " · 답글" : ""} · {timeAgo(c.createdAt)}
                      {c.deleted ? " · 삭제됨" : c.hidden ? " · 숨김" : ""}
                      {c.unpublished ? " · 비공개된 화" : ""}
                    </span>
                  </div>
                  <p className="pr-comment-body">{c.body}</p>
                  {!c.deleted && (
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
            <Button
              variant="ghost"
              onClick={() => {
                sessionStorage.removeItem(KEY);
                setToken("");
                setData(null);
              }}
            >
              운영 토큰 지우기
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
