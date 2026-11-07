/**
 * 읽기 viewer bodies: 페이지 넘김 (PageView, pages of about N characters, flipped sideways) and 스크롤 보기
 * (ScrollView, optional 다음 화 이어 보기). Positions go to a small external store (bars subscribe to it);
 * the scroll text never re-renders on scroll, and page turns write the track transform directly.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { labelKo, type ReaderEpisodeDto, type ReaderMode } from "@ncs/shared";
import { Badge, QueryError, formatNumber } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useReaderEpisodeExact } from "./api.js";
import { KIND_BADGE, ReaderIcon } from "./ReaderShell.js";
import {
  FINISHED_RATIO,
  START_ANCHOR,
  clamp01,
  episodeLabel,
  isStartAnchor,
  paragraphIndexes,
  readingMinutes,
  scrollProgress,
  skippedLabel,
  textBlocks,
  type BlocksOf,
  type ReadingAnchor,
  type ReadingBlock,
} from "./reader-model.js";
import { clampPage, dragOffset, firstIndex, pageFinished, pageForRatio, pageRatio, pageStep, swipeAction, tapZone, type PageGeometry } from "./reader-layout.js";
import { anchorForPage, estimatePageChars, pageCounter, pageForAnchor, paginateBlocks, type PageItem, type ReaderPage } from "./reader-pages.js";

// ── progress store (bars subscribe; the text does not) ──────────────────
export interface ProgressState {
  episodeNo: number;
  ratio: number;
  page: number;
  pageCount: number;
}
export function createProgressStore() {
  let state: ProgressState = { episodeNo: 0, ratio: 0, page: 0, pageCount: 0 };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<ProgressState>) {
      const next = { ...state, ...patch };
      if (next.episodeNo === state.episodeNo && next.ratio === state.ratio && next.page === state.page && next.pageCount === state.pageCount) return;
      state = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export type ProgressStore = ReturnType<typeof createProgressStore>;
export const useProgress = (store: ProgressStore) => useSyncExternalStore(store.subscribe, store.get, store.get);

/** what the bars can ask of the current view */
export interface ViewHandle {
  seek(ratio: number): void;
  step(dir: "prev" | "next"): void;
}

export interface ViewEvents {
  /** center tap: toggle the bars */
  onMenu(): void;
  /** the reader scrolled / turned a page: hide the bars */
  onScrolled(): void;
  /** debounced position for 이어 읽기 */
  onPosition(episodeNo: number, anchor: ReadingAnchor, ratio: number): void;
  /** the end of an episode was reached (읽음) */
  onFinished(episodeNo: number): void;
  /** 다음 화 이어 보기: the episode under the reading line changed */
  onVisibleEpisode(episodeNo: number): void;
  /** page view: turning past the first / last page */
  onLeave(dir: "prev" | "next"): void;
}

/** initial position of a view: anchor, a ratio (older resume records) or the start */
/** `at: "end"`: 페이지 넘김 entered backwards from the next episode → its last text page */
export type InitialPosition = { anchor: ReadingAnchor } | { ratio: number } | { at: "end" } | null;

const INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=dialog],[data-no-tap]";
const isInteractive = (t: EventTarget | null) => t instanceof Element && !!t.closest(INTERACTIVE);

// ── text ────────────────────────────────────────────────────────────────
/** anchor targets: text paragraphs (`data-p` = paragraph index, see ReadingAnchor) */
const PARA = "[data-p]";

function Block({ b, p }: { b: ReadingBlock; p: number | null }) {
  switch (b.type) {
    case "p":
      return <p data-p={p ?? undefined}>{b.text}</p>;
    case "break":
      return (
        <div className="reader-break" role="separator" aria-label="장면 전환">
          <span aria-hidden="true">◆</span>
        </div>
      );
    case "image":
      return (
        <figure className="reader-figure">
          <img src={b.src} alt={b.alt} loading="lazy" decoding="async" width={b.width ?? undefined} height={b.height ?? undefined} />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
  }
}

/** title block at the top of an episode (scroll view: above the text; page view: top of page 1) */
function EpisodeHeader({ ep, titleId }: { ep: ReaderEpisodeDto; titleId?: string }) {
  const badge = KIND_BADGE[ep.source];
  return (
    <header className="mb-10 pt-2 text-center sm:mb-12">
      {ep.title?.trim() && <p className="mb-2 text-[0.8em] font-semibold tracking-wide text-muted tabular">{ep.episodeNo}화</p>}
      <h1 id={titleId} className="reader-title text-[1.4em] leading-snug font-bold text-balance">
        {ep.title?.trim() || `${ep.episodeNo}화`}
      </h1>
      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-muted">
        <span className="tabular">
          {formatNumber(ep.charCount)}자 ({labelKo("count_basis", ep.countBasis)})
        </span>
        <span aria-hidden="true">·</span>
        <span>약 {readingMinutes(ep.charCount)}분</span>
        <Badge tone={badge.tone} glyph={ep.source === "draft"}>
          {badge.label}
        </Badge>
      </p>
      {ep.source === "draft" && (
        <p className="mx-auto mt-4 max-w-[30em] rounded-[10px] border border-violet/40 bg-violet-soft px-3 py-2 text-[13px] text-text">
          승인 전 초안입니다 ({labelKo("episode_status", ep.status)}). 내용이 바뀔 수 있습니다.
        </p>
      )}
    </header>
  );
}

/** `blocksOf`: extension point for illustrations (paragraphs | scene breaks | images); keep it referentially stable */
export const EpisodeArticle = memo(function EpisodeArticle({ ep, titleId, blocksOf = textBlocks }: { ep: ReaderEpisodeDto; titleId?: string; blocksOf?: BlocksOf }) {
  const blocks = useMemo(() => blocksOf(ep), [ep, blocksOf]);
  const paras = useMemo(() => paragraphIndexes(blocks), [blocks]);
  return (
    <article className="reader-column" aria-labelledby={titleId}>
      <EpisodeHeader ep={ep} titleId={titleId} />
      {blocks.length ? (
        <div className="reader-prose">
          {blocks.map((b, i) => (
            <Block key={i} b={b} p={paras[i] ?? null} />
          ))}
        </div>
      ) : (
        <p className="text-center text-muted">본문이 비어 있습니다.</p>
      )}
    </article>
  );
});

// ── end of episode ──────────────────────────────────────────────────────
export interface EndActions {
  onGo(episodeNo: number): void;
  onOpenToc(): void;
  /** a later episode exists but is not readable yet */
  moreLater(episodeNo: number): boolean;
}

/** end of an episode. `paged`: 페이지 넘김's last page (one more flip opens the next episode) */
export function EndCard({ ep, actions, paged = false }: { ep: ReaderEpisodeDto; actions: EndActions; paged?: boolean }) {
  const skipped = skippedLabel(ep.next?.skipped);
  return (
    <div className="reader-column rv-end-card py-12 text-center">
      <p className="text-[13px] font-semibold tracking-[0.18em] text-muted">{ep.episodeNo}화 끝</p>
      <p className="reader-title mx-auto mt-2 max-w-[22em] text-[18px] leading-snug font-bold text-balance text-text">{ep.title?.trim() || `${ep.episodeNo}화`}</p>
      <div className="mx-auto mt-7 grid max-w-[420px] gap-2.5">
        {ep.next ? (
          <button
            type="button"
            onClick={() => actions.onGo(ep.next!.episodeNo)}
            className="flex min-h-[64px] w-full flex-col items-center justify-center rounded-[14px] bg-accent px-4 py-2.5 text-accent-text shadow-card hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="flex items-center gap-1 text-[16px] font-bold">
              다음 화 보기 <ReaderIcon name="next" size={18} />
            </span>
            <span className="mt-0.5 block max-w-full truncate text-[13px] font-medium opacity-90">{episodeLabel(ep.next.episodeNo, ep.next.title)}</span>
          </button>
        ) : (
          <div className="rounded-[14px] border border-dashed border-border px-4 py-5 text-[14px] text-muted">
            <p className="m-0 font-semibold text-text">지금 읽을 수 있는 최신 화입니다</p>
            {actions.moreLater(ep.episodeNo) && <p className="m-0 mt-1 text-[13px]">다음 화는 아직 읽을 수 없습니다</p>}
          </div>
        )}
        {paged && ep.next && <p className="m-0 text-[12.5px] text-muted">한 번 더 넘기면 다음 화로 넘어갑니다</p>}
        {skipped && (
          <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] font-semibold text-warn">
            {skipped}는 아직 읽을 수 있는 원고가 없어 건너뜁니다
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!ep.prev}
            onClick={() => ep.prev && actions.onGo(ep.prev.episodeNo)}
            className="flex min-h-12 items-center justify-center gap-1 rounded-[12px] border border-border bg-surface text-[14px] font-semibold text-text hover:bg-surface-2 disabled:opacity-50"
          >
            <ReaderIcon name="back" size={17} /> 이전 화
          </button>
          <button
            type="button"
            onClick={actions.onOpenToc}
            className="flex min-h-12 items-center justify-center gap-1.5 rounded-[12px] border border-border bg-surface text-[14px] font-semibold text-text hover:bg-surface-2"
          >
            <ReaderIcon name="list" size={17} /> 목차
          </button>
        </div>
      </div>
    </div>
  );
}

/** 다음 화 이어 보기: divider between two appended episodes; the last one asks for the next episode when it nears the screen */
function ContinueDivider({ ep, sentinel, onNeed }: { ep: ReaderEpisodeDto; sentinel: boolean; onNeed: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const need = useRef(onNeed);
  need.current = onNeed;
  useEffect(() => {
    if (!sentinel || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) need.current();
    }, { rootMargin: "0px 0px 1200px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [sentinel]);
  const skipped = skippedLabel(ep.next?.skipped);
  return (
    <div ref={ref} className="reader-column my-16" role="separator" aria-label={`${ep.episodeNo}화 끝`}>
      <div className="rounded-[14px] border border-border bg-surface px-4 py-5 text-center">
        <p className="text-[13px] font-semibold tracking-[0.18em] text-muted">{ep.episodeNo}화 끝</p>
        {ep.next && (
          <p className="mt-1.5 inline-flex max-w-full items-center gap-1 text-[14.5px] font-semibold text-text">
            <span className="truncate">이어서 {episodeLabel(ep.next.episodeNo, ep.next.title)}</span>
            <ReaderIcon name="next" size={15} />
          </p>
        )}
        {skipped && <p className="mt-1.5 text-[12.5px] font-semibold text-warn">{skipped} 건너뜀</p>}
      </div>
    </div>
  );
}

// ── scroll view ─────────────────────────────────────────────────────────
const MAX_CHAIN = 12;

function blockRects(section: Element) {
  return section.querySelectorAll<HTMLElement>(PARA);
}

/** anchor of the reading line (viewport top) inside a section */
function scrollAnchorOf(section: Element): ReadingAnchor {
  const blocks = blockRects(section);
  if (!blocks.length || blocks[0]!.getBoundingClientRect().top >= 0) return START_ANCHOR;
  const i = firstIndex(blocks.length, (k) => blocks[k]!.getBoundingClientRect().bottom > 0);
  if (i >= blocks.length) return { para: blocks.length - 1, offset: 1 };
  const r = blocks[i]!.getBoundingClientRect();
  return { para: i, offset: r.height > 0 ? clamp01(-r.top / r.height) : 0 };
}

function ScrollSection({ novelId, no, mode, isLast, continuous, canGrow, onAppend, actions, root, blocksOf }: {
  novelId: string;
  no: number;
  mode: ReaderMode;
  isLast: boolean;
  continuous: boolean;
  canGrow: boolean;
  onAppend: (no: number) => void;
  actions: EndActions;
  root: boolean;
  blocksOf?: BlocksOf;
}) {
  const q = useReaderEpisodeExact(novelId, no, mode);
  const ep = q.data;
  return (
    <section data-ep={no} aria-label={`${no}화`}>
      {ep ? (
        <EpisodeArticle ep={ep} titleId={root ? "reader-title" : undefined} blocksOf={blocksOf} />
      ) : q.error ? (
        <div className="reader-column py-10">
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      ) : (
        <div className="reader-column py-16 text-center text-muted" aria-busy="true">
          {no}화를 불러오는 중…
        </div>
      )}
      {ep && (continuous && ep.next && (canGrow || !isLast) ? <ContinueDivider ep={ep} sentinel={isLast} onNeed={() => onAppend(ep.next!.episodeNo)} /> : <EndCard ep={ep} actions={actions} />)}
    </section>
  );
}

export function ScrollView({ novelId, mode, chain, onAppend, continuous, initial, typoKey, handleRef, events, store, actions, barsShown, blocksOf }: {
  novelId: string;
  mode: ReaderMode;
  /** episode numbers shown one after another (first = the opened episode) */
  chain: readonly number[];
  onAppend: (no: number) => void;
  continuous: boolean;
  initial: InitialPosition;
  typoKey: string;
  handleRef: RefObject<ViewHandle | null>;
  events: ViewEvents;
  store: ProgressStore;
  actions: EndActions;
  barsShown: boolean;
  /** illustrations extension point (default: the text alone) */
  blocksOf?: BlocksOf;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ev = useRef(events);
  ev.current = events;
  const bars = useRef({ shown: barsShown, at: 0 });
  if (bars.current.shown !== barsShown) bars.current = { shown: barsShown, at: typeof window === "undefined" ? 0 : window.scrollY };
  const anchorRef = useRef<{ no: number; anchor: ReadingAnchor } | null>(null);
  /** time of the last scroll we caused (seek / restore): those must not hide the bars */
  const programmatic = useRef(0);
  const scrollTo = (y: number) => {
    programmatic.current = performance.now();
    bars.current.at = y;
    window.scrollTo(0, y);
  };

  const sections = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("section[data-ep]") ?? [])];
  /** the section under the upper third of the screen */
  const current = () => {
    const secs = sections();
    const line = window.innerHeight * 0.35;
    let el = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top <= line) el = s;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    const ratio = scrollProgress(window.scrollY - top, r.height, window.innerHeight);
    return { el, no: Number(el.dataset.ep), top, height: r.height, ratio };
  };

  const scrollToAnchor = (no: number, anchor: ReadingAnchor) => {
    const sec = rootRef.current?.querySelector<HTMLElement>(`section[data-ep="${no}"]`);
    if (!sec) return;
    const isRoot = sec === sections()[0];
    if (isStartAnchor(anchor)) {
      scrollTo(isRoot ? 0 : sec.getBoundingClientRect().top + window.scrollY);
      return;
    }
    const blocks = blockRects(sec);
    const b = blocks[Math.min(anchor.para, blocks.length - 1)];
    if (!b) return;
    const r = b.getBoundingClientRect();
    scrollTo(Math.round(r.top + window.scrollY + clamp01(anchor.offset) * r.height));
  };

  handleRef.current = {
    seek(ratio) {
      const c = current();
      if (c) scrollTo(Math.round(c.top + clamp01(ratio) * Math.max(0, c.height - window.innerHeight)));
    },
    step(dir) {
      scrollTo(window.scrollY + (dir === "next" ? 1 : -1) * (window.innerHeight - 72));
    },
  };

  // initial position (the opened episode is already rendered from the query cache)
  useLayoutEffect(() => {
    const no = chain[0]!;
    if (initial && "anchor" in initial) {
      scrollToAnchor(no, initial.anchor);
      anchorRef.current = { no, anchor: initial.anchor };
    } else if (initial && "ratio" in initial) {
      const el = document.documentElement;
      scrollTo(Math.round(clamp01(initial.ratio) * Math.max(0, el.scrollHeight - window.innerHeight)));
    } else scrollTo(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // typography changed: keep the paragraph at the top of the screen
  const firstTypo = useRef(true);
  useLayoutEffect(() => {
    if (firstTypo.current) {
      firstTypo.current = false;
      return;
    }
    const a = anchorRef.current;
    if (a) scrollToAnchor(a.no, a.anchor);
  }, [typoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastNo = 0;
    const settle = () => {
      const c = current();
      if (!c) return;
      const anchor = scrollAnchorOf(c.el);
      anchorRef.current = { no: c.no, anchor };
      ev.current.onPosition(c.no, anchor, c.ratio);
    };
    const frame = () => {
      const c = current();
      if (!c) return;
      store.set({ episodeNo: c.no, ratio: Math.round(c.ratio * 1000) / 1000, page: 0, pageCount: 0 });
      if (c.ratio >= FINISHED_RATIO) ev.current.onFinished(c.no);
      if (c.no !== lastNo) {
        if (lastNo) ev.current.onVisibleEpisode(c.no);
        lastNo = c.no;
      }
      if (bars.current.shown && performance.now() - programmatic.current > 400 && Math.abs(window.scrollY - bars.current.at) > 48) ev.current.onScrolled();
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
      clearTimeout(timer);
      timer = setTimeout(settle, 250);
    };
    frame();
    settle();
    // width changes re-wrap the text: restore the paragraph (height-only changes = mobile URL bar, ignore)
    let width = rootRef.current?.clientWidth ?? 0;
    const ro = new ResizeObserver(() => {
      const w = rootRef.current?.clientWidth ?? 0;
      if (w === width) return;
      width = w;
      const a = anchorRef.current;
      if (a) scrollToAnchor(a.no, a.anchor);
    });
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", settle);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", settle);
    };
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  const onClick = (e: ReactMouseEvent) => {
    if (isInteractive(e.target)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    ev.current.onMenu();
  };

  return (
    <main ref={rootRef} className="rv-scroll" onClick={onClick}>
      {chain.map((no, i) => (
        <ScrollSection
          key={no}
          novelId={novelId}
          no={no}
          mode={mode}
          root={i === 0}
          isLast={i === chain.length - 1}
          continuous={continuous}
          canGrow={chain.length < MAX_CHAIN}
          onAppend={onAppend}
          actions={actions}
          blocksOf={blocksOf}
        />
      ))}
    </main>
  );
}

// ── page view ───────────────────────────────────────────────────────────
/** one paginated item (a paragraph piece keeps `data-p`; a continued piece has no first-line indent) */
function PageItemView({ it, blocks }: { it: PageItem; blocks: readonly ReadingBlock[] }) {
  if (it.type === "text") return <p data-p={it.para} className={it.start > 0 ? "rv-cont" : undefined}>{it.text}</p>;
  const b = blocks[it.block];
  return b ? <Block b={b} p={null} /> : null;
}

const PageBody = memo(function PageBody({ page, index, ep, blocks }: { page: ReaderPage; index: number; ep: ReaderEpisodeDto; blocks: readonly ReadingBlock[] }) {
  return (
    <div className="reader-column">
      {index === 0 && (
        <div className="rv-flow">
          <EpisodeHeader ep={ep} titleId="reader-title" />
        </div>
      )}
      {page.items.length ? (
        <div className="reader-prose">
          {page.items.map((it, k) => (
            <PageItemView key={k} it={it} blocks={blocks} />
          ))}
        </div>
      ) : (
        index === 0 && <p className="text-center text-muted">본문이 비어 있습니다.</p>
      )}
    </div>
  );
});

/** DOM twin of PageItemView for the hidden measurer */
function itemNode(it: PageItem): HTMLElement {
  if (it.type === "text") {
    const p = document.createElement("p");
    if (it.start > 0) p.className = "rv-cont";
    p.textContent = it.text;
    return p;
  }
  const d = document.createElement("div");
  if (it.type === "break") {
    d.className = "reader-break";
    const s = document.createElement("span");
    s.textContent = "◆";
    d.append(s);
  }
  return d;
}

const EMPTY_PAGES: ReaderPage[] = [{ items: [], chars: 0 }];

/**
 * 페이지 넘김: the episode is cut into pages of about `maxChars` characters (reader-pages.ts), each also checked
 * against the screen with a hidden measurer of the same width and typography. Pages sit side by side on a
 * track that slides by one page per turn; the page after the last one is the end card.
 */
export function PageView({ ep, geometry: g, initial, typoKey, maxChars, fontPx, lineHeight, handleRef, events, store, actions, reducedMotion, blocksOf = textBlocks }: {
  ep: ReaderEpisodeDto;
  geometry: PageGeometry;
  initial: InitialPosition;
  typoKey: string;
  /** target characters per page (보기 설정 → 글자 수) */
  maxChars: number;
  /** font size (px) and line-height factor: estimate fallback when nothing can be measured */
  fontPx: number;
  lineHeight: number;
  handleRef: RefObject<ViewHandle | null>;
  events: ViewEvents;
  store: ProgressStore;
  actions: EndActions;
  reducedMotion: boolean;
  /** illustrations extension point (default: the text alone) */
  blocksOf?: BlocksOf;
}) {
  const blocks = useMemo(() => blocksOf(ep), [ep, blocksOf]);
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const ev = useRef(events);
  ev.current = events;
  const [pages, setPages] = useState<ReaderPage[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [fontsTick, setFontsTick] = useState(0);
  const pagesRef = useRef<ReaderPage[]>(EMPTY_PAGES);
  const pos = useRef({ page: 0, count: 2, laidOut: false });
  const anchorRef = useRef<ReadingAnchor | null>(initial && "anchor" in initial ? initial.anchor : null);
  const geo = useRef(g);
  geo.current = g;
  const stride = () => geo.current.width + geo.current.gap;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedAt = useRef(0);

  // paginate (before paint): text + typography + screen size + 글자 수
  useLayoutEffect(() => {
    const prose = proseRef.current;
    const head = headRef.current;
    const measurable = !!prose && !!head && prose.getBoundingClientRect().width > 0;
    const headH = measurable ? head.getBoundingClientRect().height : 0;
    const estimate = estimatePageChars({ width: g.width, height: g.height, fontPx, lineHeight });
    const fits = (items: readonly PageItem[], index: number) => {
      if (!measurable) return items.reduce((n, i) => n + (i.type === "text" ? i.end - i.start : 0), 0) <= (index === 0 ? estimate * 0.6 : estimate);
      prose.replaceChildren(...items.map(itemNode));
      return prose.getBoundingClientRect().height <= g.height - (index === 0 ? headH : 0) + 0.5;
    };
    const next = paginateBlocks(blocks, { maxChars, fits });
    prose?.replaceChildren();
    setPages(next.length ? next : EMPTY_PAGES);
  }, [blocks, g.width, g.height, typoKey, maxChars, fontPx, lineHeight, fontsTick]);

  useEffect(() => {
    mountedAt.current = performance.now();
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) setFontsTick((t) => t + 1);
    });
    return () => {
      alive = false;
      clearTimeout(saveTimer.current);
    };
  }, []);

  const publish = (page: number) => {
    const { count } = pos.current;
    store.set({ episodeNo: ep.episodeNo, page, pageCount: count, ratio: pageRatio(page, count) });
    if (pageFinished(page, count)) ev.current.onFinished(ep.episodeNo);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      ev.current.onPosition(ep.episodeNo, anchorRef.current ?? START_ANCHOR, pageRatio(pos.current.page, pos.current.count));
    }, 200);
  };

  const place = (x: number, animate: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    if (!animate || reducedMotion) {
      track.style.transition = "none";
      track.style.transform = `translate3d(${x}px,0,0)`;
      void track.offsetWidth;
      track.style.transition = "";
    } else track.style.transform = `translate3d(${x}px,0,0)`;
  };

  /**
   * show a page. `user`: the reader moved (turn / seek) → the anchor becomes the start of that page.
   * Re-pagination passes false and keeps the anchor, so repeated font / size changes do not drift.
   */
  const apply = (page: number, animate: boolean, user = true) => {
    const p = clampPage(page, pos.current.count);
    pos.current.page = p;
    if (user || !anchorRef.current) anchorRef.current = anchorForPage(pagesRef.current, p);
    place(-p * stride(), animate);
    setCurrent(p);
    publish(p);
  };

  const doStep = (dir: "prev" | "next") => {
    const r = pageStep(pos.current.page, pos.current.count, dir);
    if ("page" in r) {
      apply(r.page, true);
      ev.current.onScrolled(); // like scrolling: a page turn hides the bars
    } else ev.current.onLeave(r.episode);
  };

  handleRef.current = {
    seek: (ratio) => apply(pageForRatio(ratio, pos.current.count), false),
    step: doStep,
  };

  // new pages: put the anchored paragraph back on screen
  useLayoutEffect(() => {
    if (!pages) return;
    pagesRef.current = pages;
    pos.current.count = pages.length + 1;
    let page: number;
    if (!pos.current.laidOut) {
      pos.current.laidOut = true;
      page = !initial ? 0 : "at" in initial ? pages.length - 1 : "anchor" in initial ? pageForAnchor(pages, initial.anchor) : pageForRatio(initial.ratio, pages.length);
    } else page = anchorRef.current ? pageForAnchor(pages, anchorRef.current) : pos.current.page;
    apply(page, false, false);
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  // the document must not scroll behind the fixed page box
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      el.style.overflow = prev;
    };
  }, []);

  // focus inside the clipped frame (Tab, screen-reader cursor) must not scroll it out of sync with the track
  const pageFrameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = pageFrameRef.current;
    if (!frame) return;
    const reset = () => {
      if (frame.scrollLeft || frame.scrollTop) {
        frame.scrollLeft = 0;
        frame.scrollTop = 0;
      }
    };
    frame.addEventListener("scroll", reset, { passive: true });
    return () => frame.removeEventListener("scroll", reset);
  }, []);

  // mouse wheel / trackpad: one page per gesture (ignored right after an episode change: trackpad inertia)
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      if (isInteractive(e.target)) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const now = performance.now();
      if (Math.abs(d) < 12 || now - lastAt < 380 || now - mountedAt.current < 600) return;
      lastAt = now;
      doStep(d > 0 ? "next" : "prev");
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // drag / swipe / tap zones
  const drag = useRef<{ id: number; x: number; y: number; t: number; active: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, active: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || e.pointerId !== d.id || !track) return;
    const dx = e.clientX - d.x;
    if (!d.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - d.y)) {
      d.active = true;
      track.dataset.dragging = "true";
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.active) track.style.transform = `translate3d(${-pos.current.page * stride() + dragOffset(dx, pos.current.page, pos.current.count)}px,0,0)`;
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const track = trackRef.current;
    if (!d || e.pointerId !== d.id || !track) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.active) {
      track.dataset.dragging = "false";
      const act = swipeAction(dx, dy, e.timeStamp - d.t, geo.current.width);
      // snap back first: leaving the episode keeps this page in place until the next one mounts
      if (!act || !("page" in pageStep(pos.current.page, pos.current.count, act))) place(-pos.current.page * stride(), true);
      if (act) doStep(act);
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const zone = tapZone(e.clientX, window.innerWidth, "page");
      if (zone === "menu") ev.current.onMenu();
      else doStep(zone);
    }
  };
  const onPointerCancel = () => {
    if (drag.current?.active && trackRef.current) {
      trackRef.current.dataset.dragging = "false";
      place(-pos.current.page * stride(), true);
    }
    drag.current = null;
  };

  const shown = pages ?? EMPTY_PAGES;
  const count = shown.length + 1;
  const pageStyle = (i: number): CSSProperties => ({ left: i * (g.width + g.gap), width: g.width });
  const off = (i: number) => (i !== current ? { "aria-hidden": true, inert: true } : {});
  return (
    <main ref={frameRef} className="rv-pages" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <div ref={pageFrameRef} className="rv-page-frame" style={{ left: g.left, top: g.top, width: g.width, height: g.height, "--page-h": `${g.height}px` } as CSSProperties}>
        <div ref={trackRef} className={cx("rv-track", !pages && "invisible")}>
          {shown.map((pg, i) => (
            <section
              key={i}
              className={cx("rv-page", pg.items[0]?.type === "image" && pg.items.length === 1 && "rv-page-image")}
              style={pageStyle(i)}
              aria-label={`${i + 1}쪽`}
              {...off(i)}
            >
              {Math.abs(i - current) <= 2 && <PageBody page={pg} index={i} ep={ep} blocks={blocks} />}
            </section>
          ))}
          <section className="rv-page rv-page-end" style={pageStyle(shown.length)} aria-label={`${ep.episodeNo}화 끝`} {...off(shown.length)}>
            <EndCard ep={ep} actions={actions} paged />
          </section>
        </div>
      </div>
      {/* hidden measurer: same width + typography as a page */}
      <div ref={measureRef} className="rv-measure" style={{ width: g.width }} aria-hidden="true">
        <div className="reader-column">
          <div ref={headRef} className="rv-flow">
            <EpisodeHeader ep={ep} />
          </div>
          <div ref={proseRef} className="reader-prose" />
        </div>
      </div>
      <PageMeta ep={ep} g={g} page={current} count={count} />
    </main>
  );
}

/** faint running header (episode) and page counter, always visible in 페이지 넘김; announces page turns */
function PageMeta({ ep, g, page, count }: { ep: ReaderEpisodeDto; g: PageGeometry; page: number; count: number }) {
  const label = pageCounter(page, count);
  return (
    <>
      <div className="rv-page-meta" style={{ top: Math.max(8, (g.top - 12) / 2), paddingInline: g.left }} aria-hidden="true">
        <span className="min-w-0 truncate">{episodeLabel(ep.episodeNo, ep.title)}</span>
      </div>
      <div className="rv-page-meta" style={{ bottom: Math.max(8, (g.top - 12) / 2), paddingInline: g.left }} aria-hidden="true">
        <span className="ml-auto tabular">{label}</span>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {label === "끝" ? `${ep.episodeNo}화 끝` : `${label} 페이지`}
      </p>
    </>
  );
}
