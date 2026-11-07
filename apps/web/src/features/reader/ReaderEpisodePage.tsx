/**
 * 읽기 — 뷰어 (/novels/:novelId/read/:episodeNo): immersive web-novel viewer.
 * Bars hidden by default (tap the center to toggle), 페이지 넘김 (default) / 스크롤 보기, 보기 설정 sheet, 목차 drawer,
 * end card, read history and 이어 읽기 (paragraph anchor) — all per device (localStorage).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { ReaderMode } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { novelPath } from "../../components/layout/nav.js";
import { isApiRequestError } from "../../api/client.js";
import { Button, ButtonLink, QueryError } from "../../components/ui/index.js";
import { useDocumentTitle } from "../../lib/use-document-title.js";
import { usePrefetchReaderEpisode, useReaderEpisode, useReaderToc } from "./api.js";
import { ReaderRoot, browserStore, isReaderPanelOpen, lastInputWasKeyboard, useReadHistory, useReaderSettings, useReducedMotion, useWakeLock } from "./ReaderShell.js";
import { BottomBar, Dimmer, SettingsSheet, TapHint, TocDrawer, TopBar } from "./ReaderOverlays.js";
import { PageView, ScrollView, createProgressStore, type EndActions, type InitialPosition, type ViewEvents, type ViewHandle } from "./ReaderViews.js";
import {
  READER_LINE_HEIGHT,
  READER_MARGIN_PX,
  READER_MAX_EM,
  READER_PAGE_CHAR_COUNT,
  episodeLabel,
  fontPxOf,
  hintSeen,
  loadResume,
  markHintSeen,
  resumeAnchorFor,
  saveResume,
  typographyKey,
  type ReaderView,
  type ReadingAnchor,
} from "./reader-model.js";
import { keyAction, pageGeometry } from "./reader-layout.js";
import { leaveTarget } from "./reader-pages.js";

function useEpisodeNo(): number {
  const { episodeNo } = useParams();
  const n = Number(episodeNo);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const isControl = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("a,button,[role=switch]");

/** window size, updated once per frame on resize */
function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSize((s) => {
        const n = read();
        return n.w === s.w && n.h === s.h ? s : n;
      }));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return size;
}

type Panel = "settings" | "toc" | null;

export function ReaderEpisodePage() {
  const novelId = useNovelId();
  const episodeNo = useEpisodeNo();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const [settings, update] = useReaderSettings();
  const { mode, view } = settings;
  const q = useReaderEpisode(novelId, episodeNo, mode);
  const toc = useReaderToc(novelId);
  const prefetch = usePrefetchReaderEpisode(novelId);
  const [history, mark] = useReadHistory(novelId);
  const reducedMotion = useReducedMotion();
  useWakeLock(settings.keepAwake);
  // show the placeholder (previous episode) only while the new one loads
  const ep = q.data && q.data.episodeNo === episodeNo ? q.data : undefined;
  useDocumentTitle(ep ? `${episodeLabel(ep.episodeNo, ep.title)} · ${toc.data?.title ?? "읽기"}` : "읽기");

  const [bars, setBars] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [hintsSeen, setHintsSeen] = useState(() => ({ scroll: hintSeen(browserStore(), "scroll"), page: hintSeen(browserStore(), "page") }));
  const store = useMemo(createProgressStore, []);
  const handleRef = useRef<ViewHandle | null>(null);
  const tocPath = novelPath(novelId, "read");

  // 다음 화 이어 보기: episodes shown one after another; the route follows the one being read
  const [chain, setChain] = useState<number[]>([episodeNo]);
  let activeChain = chain;
  // a new episode outside the chain, or 페이지 넘김 (one episode at a time): start a new chain here
  if (!chain.includes(episodeNo) || (view === "page" && (chain.length > 1 || chain[0] !== episodeNo))) {
    activeChain = [episodeNo];
    setChain(activeChain);
  }

  /** 페이지 넘김 flipped into an episode: where it opens (page 1 going forward, the last page going back) */
  const enterAt = useRef<{ no: number; at: "start" | "end" } | null>(null);
  const go = useCallback(
    (no: number | null | undefined, at?: "start" | "end") => {
      if (!no) return;
      enterAt.current = at ? { no, at } : null;
      setPanel(null);
      setChain([no]);
      navigate(novelPath(novelId, `read/${no}`));
    },
    [navigate, novelId],
  );

  // the last reported position (survives switching 스크롤 ↔ 페이지)
  const live = useRef<{ no: number; mode: ReaderMode; anchor: ReadingAnchor } | null>(null);
  // ?resume=1 (목차 → 이어 읽기) also reopens a finished position
  const explicitNo = useRef(search.get("resume") === "1" ? episodeNo : null);
  useEffect(() => {
    if (search.has("resume")) setSearch((s) => (s.delete("resume"), s), { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialFor = (no: number): InitialPosition => {
    if (view === "page" && enterAt.current?.no === no) return enterAt.current.at === "end" ? { at: "end" } : null;
    if (live.current && live.current.no === no && live.current.mode === mode) return { anchor: live.current.anchor };
    const saved = loadResume(browserStore(), novelId);
    const r = resumeAnchorFor(saved, no, mode, no === explicitNo.current);
    if (r === "ratio") return { ratio: saved?.ratio ?? 0 };
    return r ? { anchor: r } : null;
  };

  const finished = useRef(new Set<string>());
  const epRef = useRef(ep);
  epRef.current = ep;
  const events = useMemo<ViewEvents>(
    () => ({
      onMenu: () => setBars((b) => !b),
      onScrolled: () => setBars(false),
      onPosition: (no, anchor, ratio) => {
        live.current = { no, mode, anchor };
        saveResume(browserStore(), novelId, { episodeNo: no, mode, ratio, anchor, at: Date.now() });
      },
      onFinished: (no) => {
        const key = `${no}|${mode}`;
        if (finished.current.has(key)) return;
        finished.current.add(key);
        mark(no, "read");
      },
      onVisibleEpisode: (no) => {
        mark(no, "open");
        navigate(novelPath(novelId, `read/${no}`), { replace: true });
      },
      // page view edges: past the end card → next episode at page 1; back from page 1 → previous episode's last page.
      // None (latest / first episode): the end card stays; show the bars (이전 화 · 목차 · 다음 화)
      onLeave: (dir) => {
        const t = leaveTarget(dir, epRef.current);
        if (t) go(t.episodeNo, t.at);
        else setBars(true);
      },
    }),
    [mode, novelId, mark, navigate, go],
  );

  const moreLater = useCallback((no: number) => !!toc.data?.episodes.some((x) => x.episodeNo > no), [toc.data]);
  const actions = useMemo<EndActions>(() => ({ onGo: go, onOpenToc: () => setPanel("toc"), moreLater }), [go, moreLater]);

  // history: opened
  useEffect(() => {
    if (ep) mark(ep.episodeNo, "open");
  }, [ep?.episodeNo]); // eslint-disable-line react-hooks/exhaustive-deps

  // warm the neighbours (flipping either way opens them)
  useEffect(() => {
    if (ep?.next) prefetch(ep.next.episodeNo, mode);
    if (ep?.prev && view === "page") prefetch(ep.prev.episodeNo, mode);
  }, [ep?.next?.episodeNo, ep?.prev?.episodeNo, mode, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard (registered once; reads the latest state through a ref)
  const keyState = useRef({ view, ep, go, bars, hint: false });
  /** the bars were opened from the keyboard: move focus into the top bar */
  const focusBars = useRef(false);
  const skipRef = useRef<HTMLButtonElement>(null);
  const showHint = !!ep && !hintsSeen[view] && !panel;
  keyState.current = { view, ep, go, bars, hint: showHint };
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
      else if (a === "prevEpisode" && s.ep?.prev) s.go(s.ep.prev.episodeNo);
      else if (a === "nextEpisode" && s.ep?.next) s.go(s.ep.next.episodeNo);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const vp = useViewport();
  const geometry = useMemo(
    () =>
      pageGeometry({
        viewportWidth: vp.w,
        viewportHeight: vp.h,
        fontPx: fontPxOf(settings.fontStep),
        maxEm: READER_MAX_EM[settings.margin],
        sidePad: READER_MARGIN_PX[settings.margin],
        topPad: vp.h >= 720 ? 52 : 40,
        bottomPad: vp.h >= 720 ? 52 : 40,
      }),
    [vp.w, vp.h, settings.fontStep, settings.margin],
  );
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

  const openBarsFromKeyboard = () => {
    focusBars.current = true;
    setBars(true);
  };
  const notReadable = !ep && !q.isFetching && isApiRequestError(q.error) && q.error.status === 404;
  const barsShown = (bars || !ep) && !panel;
  // keyboard / screen reader: focus follows the bars (they are inert while hidden)
  useEffect(() => {
    if (barsShown && focusBars.current) {
      focusBars.current = false;
      document.querySelector<HTMLElement>(".rv-bar-top a, .rv-bar-top button")?.focus();
    } else if (!barsShown && !panel) {
      const a = document.activeElement;
      const lost = !a || a === document.body || !!a.closest(".rv-bar");
      // bars / a panel just closed from the keyboard: keep focus at the menu toggle instead of <body>
      if (lost && lastInputWasKeyboard()) skipRef.current?.focus({ preventScroll: true });
    }
  }, [barsShown, panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollKey = `${activeChain[0]}|${mode}`;
  const initialScroll = useMemo(() => initialFor(activeChain[0]!), [scrollKey, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageKey = ep ? `${ep.episodeNo}|${ep.versionId}|${mode}` : "";
  const initialPage = useMemo(() => (ep ? initialFor(ep.episodeNo) : null), [pageKey, view]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ReaderRoot settings={settings}>
      {/* first Tab stop: the bars cannot be tapped open from a keyboard */}
      <button ref={skipRef} type="button" className="rv-skip" onClick={() => (barsShown ? setBars(false) : openBarsFromKeyboard())} aria-expanded={barsShown}>
        {barsShown ? "메뉴 닫기" : "메뉴 열기"}
      </button>
      {ep ? (
        view === "page" ? (
          <PageView
            key={pageKey}
            ep={ep}
            geometry={geometry}
            initial={initialPage}
            typoKey={typoKey}
            maxChars={READER_PAGE_CHAR_COUNT[settings.pageChars]}
            fontPx={fontPxOf(settings.fontStep)}
            lineHeight={READER_LINE_HEIGHT[settings.lineHeight]}
            handleRef={handleRef}
            events={events}
            store={store}
            actions={actions}
            reducedMotion={reducedMotion}
          />
        ) : (
          <ScrollView
            key={scrollKey}
            novelId={novelId}
            mode={mode}
            chain={activeChain}
            onAppend={(no) => setChain((c) => (c.includes(no) ? c : [...c, no]))}
            continuous={settings.continuous}
            initial={initialScroll}
            typoKey={typoKey}
            handleRef={handleRef}
            events={events}
            store={store}
            actions={actions}
            barsShown={barsShown}
          />
        )
      ) : (
        <main className="rv-scroll px-5 pt-20">
          {notReadable ? (
            <NotReadable mode={mode} code={isApiRequestError(q.error) ? q.error.code : ""} episodeNo={episodeNo} tocPath={tocPath} onDraft={() => update({ mode: "draft" })} />
          ) : q.error && !q.isFetching ? (
            <div className="reader-column">
              <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
            </div>
          ) : (
            <div className="reader-column text-muted" aria-busy="true">
              본문을 불러오는 중…
            </div>
          )}
        </main>
      )}

      <TopBar shown={barsShown} novelTitle={toc.data?.title} episodeNo={episodeNo} ep={ep} backTo={tocPath} onToc={() => openPanel("toc")} onSettings={() => openPanel("settings")} />
      <BottomBar
        shown={barsShown}
        store={store}
        view={view}
        ep={ep}
        handle={handleRef}
        onGo={go}
        onToc={() => openPanel("toc")}
        onSettings={() => openPanel("settings")}
        onView={setView}
      />
      <SettingsSheet open={panel === "settings"} onClose={() => setPanel(null)} settings={settings} onChange={update} />
      <TocDrawer
        open={panel === "toc"}
        onClose={() => setPanel(null)}
        toc={toc.data}
        error={toc.error}
        onRetry={() => void toc.refetch()}
        mode={mode}
        history={history}
        currentNo={ep?.episodeNo ?? episodeNo}
        onJump={go}
        tocHref={tocPath}
        editHref={novelPath(novelId, `episodes/${ep?.episodeNo ?? episodeNo}`)}
      />
      {showHint && <TapHint view={view} onClose={dismissHint} />}
      <Dimmer brightness={settings.brightness} />
    </ReaderRoot>
  );
}

function NotReadable({ mode, code, episodeNo, tocPath, onDraft }: { mode: ReaderMode; code: string; episodeNo: number; tocPath: string; onDraft: () => void }) {
  return (
    <div className="reader-column rounded-[12px] border border-dashed border-border px-5 py-10 text-center">
      <p className="text-[16px] font-semibold">{code === "not_found" ? `${episodeNo}화가 없습니다` : `${episodeNo}화는 아직 읽을 수 있는 원고가 없습니다`}</p>
      <p className="mt-1 text-[13.5px] text-muted">
        {code === "not_readable" && mode === "approved" ? "승인되지 않은 화입니다. 초안 포함으로 바꾸면 작성 중인 원고를 볼 수 있습니다." : "목차에서 다른 화를 골라 주세요."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {code === "not_readable" && mode === "approved" && (
          <Button className="h-11 px-4" onClick={onDraft}>
            초안 포함으로 보기
          </Button>
        )}
        <ButtonLink to={tocPath} variant="primary" className="h-11 px-4">
          목차로
        </ButtonLink>
      </div>
    </div>
  );
}
