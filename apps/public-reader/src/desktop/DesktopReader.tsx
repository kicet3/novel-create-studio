"use client";
/**
 * PC 읽기 (≥ 1024px): the studio's viewer (@ncs/reader-ui — same page geometry, typography, themes, bars, 목차 drawer,
 * 보기 설정 sheet, end card, keyboard / wheel / click paging) over a published snowpage episode. Bars are hidden by
 * default (click the middle of the page or press Enter); reactions sit on the end card and comments open in a
 * right-side panel. Phones, tablets and foldables keep the mobile reader (src/reader/EpisodeReader.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  READER_LINE_HEIGHT,
  READER_PAGE_CHAR_COUNT,
  episodeLabel,
  fontPxOf,
  hintSeen,
  keyAction,
  leaveTarget,
  loadHistory,
  loadResume,
  markHintSeen,
  markHistory,
  readingBlocks,
  readingMinutes,
  resumeAnchorFor,
  saveHistory,
  saveResume,
  typographyKey,
  type ReadHistory,
  type ReaderView,
  type ReadingAnchor,
} from "@ncs/reader-core";
import type { PublicEpisode, PublicTocEntry } from "@ncs/reader-core/snapshot";
import {
  BAR_BTN,
  BottomBar,
  DRAWER_LINK,
  Dimmer,
  EndCard,
  EpisodeHeading,
  ICON_BTN,
  PageView,
  ReaderDrawer,
  ReaderIcon,
  ReadingArticle,
  ScrollView,
  SettingsSheet,
  TapHint,
  TocDrawerItem,
  TopBar,
  createProgressStore,
  cx,
  isReaderPanelOpen,
  lastInputWasKeyboard,
  useReducedMotion,
  useWakeLock,
  useWindowSize,
  type InitialPosition,
  type ViewEvents,
  type ViewHandle,
} from "@ncs/reader-ui";
import "@ncs/reader-ui/reader.css";
import { browserStore, useReaderSettings } from "../lib/hooks";
import { href } from "../lib/href";
import { desktopPageGeometry } from "../lib/layout";
import { CommentsDrawer, useEpisodeStats, useWritable } from "../components/social";
import { formatCount } from "../components/format";
import { Message } from "../components/ui";

export interface DesktopReaderProps {
  ep: PublicEpisode;
  novelTitle: string;
  /** published episodes of the novel (목차 drawer) */
  toc: PublicTocEntry[];
  /** ?at=end (coming back from the next episode) */
  startAtEnd: boolean;
}

type Panel = "settings" | "toc" | "comments" | null;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const isControl = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("a,button,[role=switch]");

/** the whole studio viewer chrome for one published episode */
export function DesktopReader({ ep, novelTitle, toc, startAtEnd }: DesktopReaderProps) {
  const { slug, episodeNo } = ep;
  const router = useRouter();
  const [settings, update] = useReaderSettings();
  const { view } = settings;
  const reducedMotion = useReducedMotion();
  useWakeLock(settings.keepAwake);
  const writable = useWritable();
  const { stats, toggleLike, error: likeError, setComments } = useEpisodeStats(slug, episodeNo);

  const [bars, setBars] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [hintsSeen, setHintsSeen] = useState(() => ({ scroll: hintSeen(browserStore(), "scroll"), page: hintSeen(browserStore(), "page") }));
  const store = useMemo(createProgressStore, []);
  const handleRef = useRef<ViewHandle | null>(null);
  const blocks = useMemo(() => readingBlocks(ep.text), [ep.text]);
  const heading = episodeLabel(ep.episodeNo, ep.title);

  // read history (목차 drawer marks) — this device only
  const [history, setHistory] = useState<ReadHistory>(() => loadHistory(browserStore(), slug));
  const mark = useCallback(
    (no: number, state: "open" | "read") => {
      setHistory((h) => {
        const next = markHistory({ ...loadHistory(browserStore(), slug), ...h }, no, state);
        if (next[no] !== h[no]) saveHistory(browserStore(), slug, next);
        return next[no] === h[no] ? h : next;
      });
    },
    [slug],
  );
  useEffect(() => {
    mark(episodeNo, "open");
  }, [episodeNo, mark]);

  const go = useCallback(
    (no: number | null | undefined, at?: "start" | "end") => {
      if (!no) return;
      setPanel(null);
      router.push(href.episode(slug, no, at === "end" ? "end" : undefined), { scroll: view === "scroll" });
    },
    [router, slug, view],
  );

  // warm the neighbours (flipping either way opens them)
  useEffect(() => {
    if (ep.next) router.prefetch(href.episode(slug, ep.next.episodeNo));
    if (ep.prev) router.prefetch(href.episode(slug, ep.prev.episodeNo, "end"));
  }, [ep.next, ep.prev, slug, router]);

  // the last reported position (survives switching 스크롤 ↔ 페이지)
  const live = useRef<ReadingAnchor | null>(null);
  const initialFor = (): InitialPosition => {
    if (live.current) return { anchor: live.current };
    if (startAtEnd) return { at: "end" };
    const saved = loadResume(browserStore(), slug);
    const r = resumeAnchorFor(saved, episodeNo, "approved", false);
    if (r === "ratio") return { ratio: saved?.ratio ?? 0 };
    return r ? { anchor: r } : null;
  };
  const initial = useMemo(initialFor, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = useRef(false);
  const events = useMemo<ViewEvents>(
    () => ({
      onMenu: () => setBars((b) => !b),
      onScrolled: () => setBars(false),
      onPosition: (no, anchor, ratio) => {
        live.current = anchor;
        saveResume(browserStore(), slug, { episodeNo: no, mode: "approved", ratio, anchor, at: Date.now() });
      },
      onFinished: (no) => {
        if (finished.current) return;
        finished.current = true;
        mark(no, "read");
      },
      onVisibleEpisode: () => undefined,
      // page view edges: past the end card → next episode at page 1; back from page 1 → previous episode's last page.
      // None (latest / first episode): the end card stays; show the bars (이전 화 · 목차 · 다음 화)
      onLeave: (dir) => {
        const t = leaveTarget(dir, ep);
        if (t) go(t.episodeNo, t.at);
        else setBars(true);
      },
    }),
    [slug, mark, go, ep],
  );

  // keyboard (registered once; reads the latest state through a ref)
  const focusBars = useRef(false);
  const skipRef = useRef<HTMLButtonElement>(null);
  const showHint = !hintsSeen[view] && !panel;
  const keyState = useRef({ view, ep, go, bars });
  keyState.current = { view, ep, go, bars };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target) || isReaderPanelOpen()) return;
      const s = keyState.current;
      const a = keyAction(e.key, e.shiftKey, s.view);
      if (!a) return;
      if ((e.key === " " || e.key === "Enter") && isControl(e.target)) return;
      if (a === "escape") {
        if (!s.bars) return;
        setBars(false);
      } else if (a === "menu") {
        if (isControl(e.target)) return;
        if (!s.bars) focusBars.current = true;
        setBars(!s.bars);
      } else if (a === "prevPage" || a === "nextPage") handleRef.current?.step(a === "prevPage" ? "prev" : "next");
      else if (a === "prevEpisode" && s.ep.prev) s.go(s.ep.prev.episodeNo);
      else if (a === "nextEpisode" && s.ep.next) s.go(s.ep.next.episodeNo);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const vp = useWindowSize();
  const geometry = useMemo(() => desktopPageGeometry(vp.w, vp.h, settings), [vp.w, vp.h, settings]);
  const typoKey = typographyKey(settings);

  const openPanel = (p: Panel) => {
    setBars(false);
    setPanel(p);
  };
  const setView = (v: ReaderView) => update({ view: v });
  const dismissHint = () => {
    markHintSeen(browserStore(), view);
    setHintsSeen((h) => ({ ...h, [view]: true }));
  };
  const barsShown = bars && !panel;
  // keyboard / screen reader: focus follows the bars (they are inert while hidden)
  useEffect(() => {
    if (barsShown && focusBars.current) {
      focusBars.current = false;
      document.querySelector<HTMLElement>(".rv-bar-top a, .rv-bar-top button")?.focus();
    } else if (!barsShown && !panel) {
      const a = document.activeElement;
      const lost = !a || a === document.body || !!a.closest(".rv-bar");
      if (lost && lastInputWasKeyboard()) skipRef.current?.focus({ preventScroll: true });
    }
  }, [barsShown, panel]);

  const social = writable !== null && stats;
  const header = useMemo(
    () => (
      <EpisodeHeading
        episodeNo={ep.episodeNo}
        title={ep.title}
        titleId="reader-title"
        meta={
          <>
            <span>약 {readingMinutes(ep.charCount)}분</span>
          </>
        }
      />
    ),
    [ep.episodeNo, ep.title, ep.charCount],
  );
  const measureHeader = useMemo(
    () => (
      <EpisodeHeading
        episodeNo={ep.episodeNo}
        title={ep.title}
        meta={
          <>
            <span>약 {readingMinutes(ep.charCount)}분</span>
          </>
        }
      />
    ),
    [ep.episodeNo, ep.title, ep.charCount],
  );

  const reactions = social ? (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={stats.liked}
          disabled={writable === false}
          onClick={toggleLike}
          className={cx(
            "flex min-h-12 items-center justify-center gap-1.5 rounded-[12px] border bg-surface text-[14px] font-semibold hover:bg-surface-2 disabled:opacity-50",
            stats.liked ? "border-danger/50 text-danger" : "border-border text-text",
          )}
        >
          <ReaderIcon name="heart" size={17} filled={stats.liked} /> 좋아요 {formatCount(stats.likes)}
        </button>
        <button
          type="button"
          onClick={() => openPanel("comments")}
          className="flex min-h-12 items-center justify-center gap-1.5 rounded-[12px] border border-border bg-surface text-[14px] font-semibold text-text hover:bg-surface-2"
        >
          <ReaderIcon name="comment" size={17} /> 댓글 {formatCount(stats.comments)}
        </button>
      </div>
      <Link href={`${href.novel(slug)}#rating`} className="text-[13px] font-semibold text-muted underline-offset-2 hover:text-text hover:underline">
        <span className="inline-flex items-center gap-1">
          <ReaderIcon name="star" size={15} /> 이 작품 평점 주기
        </span>
      </Link>
      {likeError && <Message tone="danger">{likeError}</Message>}
    </div>
  ) : null;
  const endCard = (paged: boolean) => (
    <EndCard
      episodeNo={ep.episodeNo}
      title={ep.title}
      next={ep.next}
      prev={ep.prev}
      paged={paged}
      onGo={(no) => go(no)}
      onOpenToc={() => openPanel("toc")}
      extra={reactions}
    />
  );

  const commentsCount = stats ? formatCount(stats.comments) : null;
  return (
    <div className="pr-studio" data-reader-view={view}>
      {/* first Tab stop: the bars cannot be clicked open from a keyboard */}
      <button
        ref={skipRef}
        type="button"
        className="rv-skip"
        onClick={() => {
          if (!barsShown) focusBars.current = true;
          setBars(!barsShown);
        }}
        aria-expanded={barsShown}
      >
        {barsShown ? "메뉴 닫기" : "메뉴 열기"}
      </button>
      {view === "page" ? (
        <PageView
          key={`page|${episodeNo}`}
          episodeNo={episodeNo}
          blocks={blocks}
          header={header}
          measureHeader={measureHeader}
          runningHead={heading}
          endCard={endCard(true)}
          geometry={geometry}
          initial={initial}
          typoKey={typoKey}
          maxChars={READER_PAGE_CHAR_COUNT[settings.pageChars]}
          fontPx={fontPxOf(settings.fontStep)}
          lineHeight={READER_LINE_HEIGHT[settings.lineHeight]}
          handleRef={handleRef}
          events={events}
          store={store}
          reducedMotion={reducedMotion}
        />
      ) : (
        <ScrollView
          key={`scroll|${episodeNo}`}
          chain={[episodeNo]}
          renderSection={() => (
            <>
              <ReadingArticle blocks={blocks} header={header} titleId="reader-title" />
              {endCard(false)}
            </>
          )}
          initial={initial}
          typoKey={typoKey}
          handleRef={handleRef}
          events={events}
          store={store}
          barsShown={barsShown}
        />
      )}

      <TopBar
        shown={barsShown}
        novelTitle={novelTitle}
        episodeNo={episodeNo}
        ep={ep}
        back={
          <Link href={href.novel(slug)} className={ICON_BTN} aria-label="작품 목차로">
            <ReaderIcon name="back" />
          </Link>
        }
        actions={
          social ? (
            <button type="button" className={cx(ICON_BTN, "w-auto gap-1 px-3 text-[13px] font-semibold")} aria-label={`댓글 ${stats.comments}개`} onClick={() => openPanel("comments")}>
              <ReaderIcon name="comment" />
              <span aria-hidden="true" className="tabular">
                {commentsCount}
              </span>
            </button>
          ) : null
        }
        onToc={() => openPanel("toc")}
        onSettings={() => openPanel("settings")}
      />
      <BottomBar
        shown={barsShown}
        store={store}
        view={view}
        ep={ep}
        handle={handleRef}
        onGo={(no) => go(no)}
        onToc={() => openPanel("toc")}
        onSettings={() => openPanel("settings")}
        onView={setView}
        extra={
          social ? (
            <button type="button" className={cx(BAR_BTN, "flex-col gap-0 text-[12px]")} onClick={() => openPanel("comments")}>
              <ReaderIcon name="comment" />
              댓글 {commentsCount}
            </button>
          ) : undefined
        }
      />
      <SettingsSheet open={panel === "settings"} onClose={() => setPanel(null)} settings={settings} onChange={update} showMode={false} showFont showContinuous={false} />
      <ReaderDrawer
        open={panel === "toc"}
        onClose={() => setPanel(null)}
        title={novelTitle}
        titleId="rv-toc-title"
        subtitle={`${toc.length}화 · 읽음 ${toc.filter((e) => history[e.episodeNo] === "read").length}화`}
        closeLabel="목차 닫기"
        initial='[aria-current="page"]'
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Link href={href.novel(slug)} className={DRAWER_LINK}>
              <ReaderIcon name="book" size={18} /> 작품 홈
            </Link>
            <Link href={href.list()} className={DRAWER_LINK}>
              <ReaderIcon name="home" size={17} /> 작품 목록
            </Link>
          </div>
        }
      >
        {toc.length ? (
          <ol className="m-0 list-none p-0">
            {toc.map((e) => (
              <TocDrawerItem key={e.episodeNo} episodeNo={e.episodeNo} title={e.title} current={e.episodeNo === episodeNo} state={history[e.episodeNo]} onJump={(no) => go(no)} />
            ))}
          </ol>
        ) : (
          <p className="p-4 text-[14px] text-muted">읽을 수 있는 화가 없습니다.</p>
        )}
      </ReaderDrawer>
      <CommentsDrawer open={panel === "comments"} onClose={() => setPanel(null)} slug={slug} episodeNo={episodeNo} title={heading} onCount={setComments} />
      {showHint && <TapHint view={view} onClose={dismissHint} />}
      <Dimmer brightness={settings.brightness} />
    </div>
  );
}
