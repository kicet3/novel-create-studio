"use client";
/**
 * 화 읽기 (client): 페이지 넘김(기본, 글자 수 기준) / 스크롤 보기, 탭 영역·스와이프·키보드, 끝 카드(좋아요·댓글·다음 화),
 * 보기 설정, 이어 읽기 위치(localStorage). The server-rendered HTML carries the whole episode as plain paragraphs
 * (search engines, no-JS); after hydration the reader takes over with the stored settings and the real viewport.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { episodeLabel, loadHistory, loadResume, markHistory, readingBlocks, resumeAnchorFor, saveHistory, saveResume } from "@ncs/reader-core";
import type { PublicEpisode, PublicTocEntry } from "@ncs/reader-core/snapshot";
import { browserStore, useDesktopReader, useMounted, useReaderSettings, useViewport } from "../lib/hooks";
import { DesktopReader } from "../desktop/DesktopReader";
import { href } from "../lib/href";
import { CommentsSheet, LikeButton, useEpisodeStats, useWritable } from "../components/social";
import { SettingsSheet } from "../components/SettingsSheet";
import { formatCount } from "../components/format";
import { Icon, IconButton, Message } from "../components/ui";
import { PagedView, type InitialPosition, type Position } from "./PagedView";
import { ScrollView } from "./ScrollView";

export interface EpisodeReaderProps {
  ep: PublicEpisode;
  novelTitle: string;
  /** published episodes of the novel (PC 목차 drawer) */
  toc: PublicTocEntry[];
  /** ?at=end (coming back from the next episode) */
  startAtEnd: boolean;
}

export function EpisodeReader(props: EpisodeReaderProps) {
  const mounted = useMounted();
  const desktop = useDesktopReader();
  if (!mounted) return <StaticEpisode ep={props.ep} novelTitle={props.novelTitle} />;
  // PC (≥ 1024px, not folded): the studio viewer; phones / tablets / foldables: the mobile reader below
  if (desktop) return <DesktopReader key={`${props.ep.slug}/${props.ep.episodeNo}`} {...props} />;
  return <Reader key={`${props.ep.slug}/${props.ep.episodeNo}`} {...props} />;
}

/** server render / first paint: the text as an article (same markup as the scroll view) */
function StaticEpisode({ ep, novelTitle }: { ep: PublicEpisode; novelTitle: string }) {
  const blocks = readingBlocks(ep.text);
  const heading = episodeLabel(ep.episodeNo, ep.title);
  return (
    <div className="pr-reader pr-reader-static" data-chrome="true">
      <header className="pr-bar pr-bar-top">
        <Link href={href.novel(ep.slug)} className="pr-icon-btn" aria-label="목차로">
          <Icon name="back" />
        </Link>
        <div className="pr-bar-title">
          <span className="pr-bar-novel">{novelTitle}</span>
          <span className="pr-bar-ep">{heading}</span>
        </div>
        <span className="pr-icon-btn" aria-hidden="true" />
      </header>
      <div className="pr-scroll">
        <article className="pr-prose pr-column">
          <h1 className="pr-ep-title">{heading}</h1>
          {blocks.map((b, i) =>
            b.type === "p" ? (
              <p key={i}>{b.text}</p>
            ) : b.type === "break" ? (
              <div key={i} className="pr-break">
                * * *
              </div>
            ) : null,
          )}
        </article>
        <nav className="pr-column pr-scroll-end" aria-label="화 이동">
          {ep.next && (
            <Link className="pr-btn pr-btn-primary pr-btn-block" href={href.episode(ep.slug, ep.next.episodeNo)}>
              다음 화 · {episodeLabel(ep.next.episodeNo, ep.next.title)}
            </Link>
          )}
          <Link className="pr-btn pr-btn-ghost pr-btn-block" href={href.novel(ep.slug)}>
            목차로
          </Link>
        </nav>
      </div>
    </div>
  );
}

function Reader({ ep, novelTitle, startAtEnd }: EpisodeReaderProps) {
  const { slug, episodeNo } = ep;
  const router = useRouter();
  const [settings] = useReaderSettings();
  const vp = useViewport();
  const writable = useWritable();
  const { stats, toggleLike, error: likeError, setComments } = useEpisodeStats(slug, episodeNo);
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<"comments" | "settings" | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const blocks = useMemo(() => readingBlocks(ep.text), [ep.text]);
  const heading = episodeLabel(ep.episodeNo, ep.title);

  const initial = useMemo<InitialPosition>(() => {
    if (startAtEnd) return { kind: "end" };
    const saved = loadResume(browserStore(), slug);
    const a = resumeAnchorFor(saved, episodeNo, "approved", false);
    if (a === "ratio") return { kind: "ratio", ratio: saved!.ratio };
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
    if (pos?.finished && ep.next) router.prefetch(href.episode(slug, ep.next.episodeNo));
  }, [pos?.finished, ep.next, slug, router]);

  const leave = useCallback(
    (dir: "prev" | "next") => {
      const t = dir === "next" ? ep.next : ep.prev;
      if (!t) {
        if (dir === "next") setChrome(true);
        return;
      }
      router.push(href.episode(slug, t.episodeNo, dir === "prev" ? "end" : undefined), { scroll: settings.view === "scroll" });
    },
    [ep.next, ep.prev, slug, settings.view, router],
  );
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const social = writable !== null && stats;
  const endCard = (
    <div className="pr-end">
      <p className="pr-end-kicker">{heading}</p>
      <p className="pr-end-title">이번 화 끝</p>
      {social && (
        <div className="pr-end-actions">
          <LikeButton liked={stats.liked} count={stats.likes} onToggle={toggleLike} disabled={writable === false} />
          <button type="button" className="pr-like" onClick={() => setSheet("comments")}>
            <Icon name="comment" />
            <span>댓글 {formatCount(stats.comments)}</span>
          </button>
        </div>
      )}
      {likeError && <Message tone="danger">{likeError}</Message>}
      {ep.next ? (
        <Link className="pr-btn pr-btn-primary pr-btn-block" href={href.episode(slug, ep.next.episodeNo)}>
          다음 화 · {episodeLabel(ep.next.episodeNo, ep.next.title)}
        </Link>
      ) : (
        <p className="pr-faint">지금 공개된 마지막 화입니다.</p>
      )}
      <Link className="pr-btn pr-btn-ghost pr-btn-block" href={href.novel(slug)}>
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
        <Link href={href.novel(slug)} className="pr-icon-btn" aria-label="목차로">
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
            <LikeButton compact liked={stats.liked} count={stats.likes} onToggle={toggleLike} disabled={writable === false} />
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
      <CommentsSheet open={sheet === "comments"} onClose={() => setSheet(null)} slug={slug} episodeNo={episodeNo} title={heading} onCount={setComments} />
    </div>
  );
}
