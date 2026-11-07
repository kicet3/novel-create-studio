/** 화 읽기: 페이지 넘김(기본) / 스크롤 보기, 끝 카드(좋아요·댓글·다음 화), 보기 설정, 이어 읽기 위치 저장. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { episodeLabel, loadHistory, loadResume, markHistory, readingBlocks, resumeAnchorFor, saveHistory, saveResume } from "@ncs/reader-core";
import type { PublicEpisode } from "@ncs/reader-core/snapshot";
import { SITE_NAME, browserStore, useDocumentMeta, useReaderSettings, useViewport } from "../lib/hooks.js";
import { href, Link, navigate, useLocation } from "../lib/router.js";
import { loadEpisode, loadNovel, useAsync } from "../lib/data.js";
import { useSession } from "../lib/session.js";
import { CommentsSheet, LikeButton, useEpisodeStats } from "../components/social.js";
import { SettingsSheet } from "../components/SettingsSheet.js";
import { Icon, IconButton, Message, formatCount } from "../components/ui.js";
import { PagedView, type InitialPosition, type Position } from "./PagedView.js";
import { ScrollView } from "./ScrollView.js";

export function EpisodeReader({ slug, episodeNo }: { slug: string; episodeNo: number }) {
  const q = useAsync(`ep:${slug}:${episodeNo}`, () => loadEpisode(slug, episodeNo));
  const novel = useAsync(`novel:${slug}`, () => loadNovel(slug));
  const ep = q.data?.slug === slug && q.data.episodeNo === episodeNo ? q.data : undefined;
  if (q.error) {
    return (
      <div className="pr-page">
        <main className="pr-main">
          <Message tone="danger">공개된 화가 아닙니다.</Message>
          <Link className="pr-btn" to={href.novel(slug)}>
            작품 홈으로
          </Link>
        </main>
      </div>
    );
  }
  if (!ep) return <div className="pr-page pr-reader-loading" aria-busy="true" />;
  return <Reader key={`${slug}/${episodeNo}`} ep={ep} novelTitle={novel.data?.slug === slug ? novel.data.title : null} intro={novel.data?.intro ?? null} />;
}

function Reader({ ep, novelTitle, intro }: { ep: PublicEpisode; novelTitle: string | null; intro: string | null }) {
  const { slug, episodeNo } = ep;
  const [settings] = useReaderSettings();
  const vp = useViewport();
  const { search } = useLocation();
  const session = useSession();
  const { stats, toggleLike, error: likeError, setComments } = useEpisodeStats(slug, episodeNo);
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<"comments" | "settings" | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const blocks = useMemo(() => readingBlocks(ep.text), [ep.text]);
  const heading = episodeLabel(ep.episodeNo, ep.title);
  useDocumentMeta(`${novelTitle ?? ""} ${heading} · ${SITE_NAME}`.trim(), intro ?? novelTitle);

  const initial = useMemo<InitialPosition>(() => {
    if (search.get("at") === "end") return { kind: "end" };
    const a = resumeAnchorFor(loadResume(browserStore(), slug), episodeNo, "approved", false);
    if (a === "ratio") return { kind: "ratio", ratio: loadResume(browserStore(), slug)!.ratio };
    return a ? { kind: "anchor", anchor: a } : { kind: "start" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, episodeNo]);

  // read marks + resume position
  const historyRef = useRef(loadHistory(browserStore(), slug));
  useEffect(() => {
    historyRef.current = markHistory(historyRef.current, episodeNo, "open");
    saveHistory(browserStore(), slug, historyRef.current);
  }, [slug, episodeNo]);
  const onPosition = useCallback(
    (p: Position) => {
      setPos(p);
      saveResume(browserStore(), slug, { episodeNo, mode: "approved", ratio: p.ratio, anchor: p.anchor, at: Date.now() });
      if (p.finished) {
        const h = markHistory(historyRef.current, episodeNo, "read");
        if (h !== historyRef.current) {
          historyRef.current = h;
          saveHistory(browserStore(), slug, h);
        }
      }
    },
    [slug, episodeNo],
  );

  // warm the next episode when the end is near
  useEffect(() => {
    if (pos?.finished && ep.next) void loadEpisode(slug, ep.next.episodeNo).catch(() => undefined);
  }, [pos?.finished, ep.next, slug]);

  const leave = useCallback(
    (dir: "prev" | "next") => {
      const t = dir === "next" ? ep.next : ep.prev;
      if (!t) {
        if (dir === "next") setChrome(true);
        return;
      }
      navigate(href.episode(slug, t.episodeNo, dir === "prev" ? "end" : undefined));
      if (settings.view === "scroll") window.scrollTo(0, 0);
    },
    [ep.next, ep.prev, slug, settings.view],
  );
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const social = session.available && stats;
  const endCard = (
    <div className="pr-end">
      <p className="pr-end-kicker">{heading}</p>
      <p className="pr-end-title">이번 화 끝</p>
      {social && (
        <div className="pr-end-actions">
          <LikeButton liked={stats.liked} count={stats.likes} onToggle={toggleLike} />
          <button type="button" className="pr-like" onClick={() => setSheet("comments")}>
            <Icon name="comment" />
            <span>댓글 {formatCount(stats.comments)}</span>
          </button>
        </div>
      )}
      {likeError && <Message tone="danger">{likeError}</Message>}
      {ep.next ? (
        <Link className="pr-btn pr-btn-primary pr-btn-block" to={href.episode(slug, ep.next.episodeNo)}>
          다음 화 · {episodeLabel(ep.next.episodeNo, ep.next.title)}
        </Link>
      ) : (
        <p className="pr-faint">지금 공개된 마지막 화입니다.</p>
      )}
      <Link className="pr-btn pr-btn-ghost pr-btn-block" to={href.novel(slug)}>
        목차로
      </Link>
    </div>
  );

  return (
    <div className="pr-reader" data-chrome={chrome}>
      {settings.view === "page" ? (
        <PagedView blocks={blocks} heading={heading} settings={settings} vp={vp} initial={initial} endCard={endCard} onPosition={onPosition} onLeave={leave} onMenu={toggleChrome} />
      ) : (
        <ScrollView blocks={blocks} heading={heading} settings={settings} vp={vp} initial={initial} endCard={endCard} onPosition={onPosition} onMenu={toggleChrome} />
      )}

      <header className="pr-bar pr-bar-top" data-hidden={!chrome}>
        <Link to={href.novel(slug)} className="pr-icon-btn" aria-label="목차로">
          <Icon name="back" />
        </Link>
        <div className="pr-bar-title">
          <span className="pr-bar-novel">{novelTitle}</span>
          <span className="pr-bar-ep">{heading}</span>
        </div>
        <IconButton label="보기 설정" onClick={() => setSheet("settings")}>
          <Icon name="settings" />
        </IconButton>
      </header>

      <nav className="pr-bar pr-bar-bottom" data-hidden={!chrome} aria-label="화 이동과 반응">
        <IconButton label="이전 화" disabled={!ep.prev} onClick={() => leave("prev")}>
          <Icon name="back" />
        </IconButton>
        {social ? (
          <>
            <LikeButton compact liked={stats.liked} count={stats.likes} onToggle={toggleLike} />
            <button type="button" className="pr-like pr-like-compact" onClick={() => setSheet("comments")} aria-label={`댓글 ${stats.comments}개`}>
              <Icon name="comment" />
              <span>{formatCount(stats.comments)}</span>
            </button>
          </>
        ) : (
          <span className="pr-faint pr-bar-progress">{pos ? `${Math.round(pos.ratio * 100)}%` : ""}</span>
        )}
        <IconButton label="다음 화" disabled={!ep.next} onClick={() => leave("next")}>
          <Icon name="next" />
        </IconButton>
      </nav>

      <SettingsSheet open={sheet === "settings"} onClose={() => setSheet(null)} />
      {session.available && <CommentsSheet open={sheet === "comments"} onClose={() => setSheet(null)} slug={slug} episodeNo={episodeNo} title={heading} onCount={setComments} />}
    </div>
  );
}
