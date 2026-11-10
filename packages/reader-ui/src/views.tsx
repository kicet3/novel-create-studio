/**
 * 읽기 viewer bodies: 페이지 넘김 (PageView, pages of about N characters, flipped sideways) and 스크롤 보기
 * (ScrollView, one or more episodes one after another). Positions go to a small external store (bars subscribe to it);
 * the scroll text never re-renders on scroll, and page turns write the track transform directly.
 * Data stays with the app: sections / headings / end cards come in as render props and nodes.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { FINISHED_RATIO, START_ANCHOR, clamp01, isStartAnchor, scrollProgress, type ReadingAnchor, type ReadingBlock } from "@ncs/reader-core/model";
import { clampPage, dragOffset, firstIndex, pageFinished, pageForRatio, pageRatio, pageStep, swipeAction, tapZone, type PageGeometry } from "@ncs/reader-core/layout";
import { anchorForPage, estimatePageChars, pageCounter, pageForAnchor, paginateBlocks, type PageItem, type ReaderPage } from "@ncs/reader-core/pages";
import { cx } from "./cx.js";
import { Block } from "./text.js";
import type { InitialPosition, ProgressStore, ViewEvents, ViewHandle } from "./progress.js";

const INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=dialog],[data-no-tap]";
const isInteractive = (t: EventTarget | null) => t instanceof Element && !!t.closest(INTERACTIVE);

/** anchor targets: text paragraphs (`data-p` = paragraph index, see ReadingAnchor) */
const PARA = "[data-p]";

// ── scroll view ─────────────────────────────────────────────────────────
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

export interface SectionContext {
  /** the opened episode (first in the chain) */
  root: boolean;
  isLast: boolean;
}

export function ScrollView({ chain, renderSection, initial, typoKey, handleRef, events, store, barsShown }: {
  /** episode numbers shown one after another (first = the opened episode) */
  chain: readonly number[];
  /** content of one episode section (heading + text + end card / divider) */
  renderSection: (episodeNo: number, ctx: SectionContext) => ReactNode;
  initial: InitialPosition;
  typoKey: string;
  handleRef: RefObject<ViewHandle | null>;
  events: ViewEvents;
  store: ProgressStore;
  barsShown: boolean;
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

  // initial position (the opened episode is already rendered)
  useLayoutEffect(() => {
    const no = chain[0]!;
    if (initial && "anchor" in initial) {
      scrollToAnchor(no, initial.anchor);
      anchorRef.current = { no, anchor: initial.anchor };
    } else if (initial && "ratio" in initial) {
      const el = document.documentElement;
      scrollTo(Math.round(clamp01(initial.ratio) * Math.max(0, el.scrollHeight - window.innerHeight)));
    } else if (initial && "at" in initial) {
      scrollTo(document.documentElement.scrollHeight);
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
        <section key={no} data-ep={no} aria-label={`${no}화`}>
          {renderSection(no, { root: i === 0, isLast: i === chain.length - 1 })}
        </section>
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

const PageBody = memo(function PageBody({ page, index, header, blocks }: { page: ReaderPage; index: number; header: ReactNode; blocks: readonly ReadingBlock[] }) {
  return (
    <div className="reader-column">
      {index === 0 && <div className="rv-flow">{header}</div>}
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
 * 페이지 넘김: the episode is cut into pages of about `maxChars` characters (@ncs/reader-core/pages), each also checked
 * against the screen with a hidden measurer of the same width and typography. Pages sit side by side on a
 * track that slides by one page per turn; the page after the last one is the end card.
 */
export function PageView({ episodeNo, blocks, header, measureHeader, runningHead, endCard, geometry: g, initial, typoKey, maxChars, fontPx, lineHeight, handleRef, events, store, reducedMotion }: {
  episodeNo: number;
  blocks: readonly ReadingBlock[];
  /** heading on page 1 (keep it referentially stable: pages are memoized) */
  header: ReactNode;
  /** the same heading without ids, for the hidden measurer (default: `header`) */
  measureHeader?: ReactNode;
  /** faint running header (e.g. "3화 · 제목") */
  runningHead: string;
  /** the page after the last text page */
  endCard: ReactNode;
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
  reducedMotion: boolean;
}) {
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
    store.set({ episodeNo, page, pageCount: count, ratio: pageRatio(page, count) });
    if (pageFinished(page, count)) ev.current.onFinished(episodeNo);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      ev.current.onPosition(episodeNo, anchorRef.current ?? START_ANCHOR, pageRatio(pos.current.page, pos.current.count));
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
              {Math.abs(i - current) <= 2 && <PageBody page={pg} index={i} header={header} blocks={blocks} />}
            </section>
          ))}
          <section className="rv-page rv-page-end" style={pageStyle(shown.length)} aria-label={`${episodeNo}화 끝`} {...off(shown.length)}>
            {endCard}
          </section>
        </div>
      </div>
      {/* hidden measurer: same width + typography as a page */}
      <div ref={measureRef} className="rv-measure" style={{ width: g.width }} aria-hidden="true">
        <div className="reader-column">
          <div ref={headRef} className="rv-flow">
            {measureHeader ?? header}
          </div>
          <div ref={proseRef} className="reader-prose" />
        </div>
      </div>
      <PageMeta episodeNo={episodeNo} runningHead={runningHead} g={g} page={current} count={count} />
    </main>
  );
}

/** faint running header (episode) and page counter, always visible in 페이지 넘김; announces page turns */
function PageMeta({ episodeNo, runningHead, g, page, count }: { episodeNo: number; runningHead: string; g: PageGeometry; page: number; count: number }) {
  const label = pageCounter(page, count);
  return (
    <>
      <div className="rv-page-meta" style={{ top: Math.max(8, (g.top - 12) / 2), paddingInline: g.left }} aria-hidden="true">
        <span className="min-w-0 truncate">{runningHead}</span>
      </div>
      <div className="rv-page-meta" style={{ bottom: Math.max(8, (g.top - 12) / 2), paddingInline: g.left }} aria-hidden="true">
        <span className="ml-auto tabular">{label}</span>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {label === "끝" ? `${episodeNo}화 끝` : `${label} 페이지`}
      </p>
    </>
  );
}
