/**
 * 페이지 넘김: pages of about N characters (paginateBlocks from @ncs/reader-core), measured against a hidden twin of
 * the page box. One page on phones / cover screens, two pages side by side (book spread) on wide near-square screens
 * (Galaxy Z Fold inner screen, tablets) or around a vertical hinge; a horizontal fold keeps the text in the top half.
 * The reading anchor ({para, offset}) survives re-pagination (fold / unfold, rotation, font changes).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  READER_MARGIN_PX,
  READER_MAX_EM,
  READER_PAGE_CHAR_COUNT,
  anchorForPage,
  fontPxOf,
  keyAction,
  pageCounter,
  pageFinished,
  pageForAnchor,
  pageForRatio,
  pageRatio,
  paginateBlocks,
  screenStep,
  spreadLayout,
  spreadStart,
  swipeAction,
  tapZone,
  typographyKey,
  type PageItem,
  type ReaderPage,
  type ReaderSettings,
  type ReadingAnchor,
  type ReadingBlock,
} from "@ncs/reader-core";
import type { ViewportInfo } from "../lib/hooks.js";

export type InitialPosition = { kind: "start" } | { kind: "end" } | { kind: "anchor"; anchor: ReadingAnchor } | { kind: "ratio"; ratio: number };

export interface Position {
  anchor: ReadingAnchor;
  ratio: number;
  finished: boolean;
  atEnd: boolean;
}

/** room for the top / bottom bars (52 / 60px + safe areas): shown bars never cover the text */
const TOP_PAD = 58;
const BOTTOM_PAD = 66;

export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** page boxes for the current screen (exported for tests) */
export function pageBoxes(vp: ViewportInfo, s: ReaderSettings): { spread: boolean; boxes: PageBox[]; areaLeft: number; areaWidth: number; folded: string } {
  const layout = spreadLayout({ viewportWidth: vp.width, viewportHeight: vp.height, segments: vp.segments });
  const { area } = layout;
  const pad = READER_MARGIN_PX[s.margin];
  const fontPx = fontPxOf(s.fontStep);
  const maxW = READER_MAX_EM[s.margin] * fontPx;
  // a horizontal fold keeps the text in the top segment; the bars sit at the screen edges
  const topPad = TOP_PAD + (area.top === 0 ? vp.safeTop : 0);
  const bottomPad = area.top + area.height >= vp.height ? BOTTOM_PAD + vp.safeBottom : 16;
  const top = area.top + topPad;
  const height = Math.max(120, Math.floor(area.height - topPad - bottomPad));
  if (layout.mode === "spread") {
    const col = (area.width - layout.gap) / 2;
    const width = Math.max(120, Math.floor(Math.min(col - 2 * pad, maxW)));
    const inset = Math.floor((col - width) / 2);
    return {
      spread: true,
      boxes: [
        { left: Math.floor(area.left + inset), top, width, height },
        { left: Math.floor(area.left + col + layout.gap + inset), top, width, height },
      ],
      areaLeft: area.left,
      areaWidth: area.width,
      folded: layout.folded,
    };
  }
  const width = Math.max(120, Math.floor(Math.min(area.width - 2 * pad, maxW)));
  return { spread: false, boxes: [{ left: Math.floor(area.left + (area.width - width) / 2), top, width, height }], areaLeft: area.left, areaWidth: area.width, folded: layout.folded };
}

/** DOM for a page (used for both the hidden measurement and — via React — the visible page) */
function fillMeasure(el: HTMLElement, items: readonly PageItem[], pageIndex: number, heading: string): void {
  el.replaceChildren();
  if (pageIndex === 0) {
    const h = document.createElement("h1");
    h.className = "pr-ep-title";
    h.textContent = heading;
    el.appendChild(h);
  }
  for (const it of items) {
    if (it.type === "text") {
      const p = document.createElement("p");
      if (it.start > 0) p.className = "pr-cont";
      if (it.end < it.len) p.classList.add("pr-split");
      p.textContent = it.text;
      el.appendChild(p);
    } else if (it.type === "break") {
      const d = document.createElement("div");
      d.className = "pr-break";
      d.textContent = "* * *";
      el.appendChild(d);
    }
  }
}

function PageContent({ items, pageIndex, heading }: { items: readonly PageItem[]; pageIndex: number; heading: string }) {
  return (
    <>
      {pageIndex === 0 && <h1 className="pr-ep-title">{heading}</h1>}
      {items.map((it, i) =>
        it.type === "text" ? (
          <p key={i} className={[it.start > 0 ? "pr-cont" : "", it.end < it.len ? "pr-split" : ""].join(" ").trim() || undefined}>
            {it.text}
          </p>
        ) : it.type === "break" ? (
          <div key={i} className="pr-break">
            * * *
          </div>
        ) : null,
      )}
    </>
  );
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded");
  useEffect(() => {
    if (ready || !document.fonts) return;
    let alive = true;
    void document.fonts.ready.then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [ready]);
  return ready;
}

export function PagedView({
  blocks,
  heading,
  settings,
  vp,
  initial,
  endCard,
  onPosition,
  onLeave,
  onMenu,
}: {
  blocks: ReadingBlock[];
  heading: string;
  settings: ReaderSettings;
  vp: ViewportInfo;
  initial: InitialPosition;
  endCard: ReactNode;
  onPosition: (p: Position) => void;
  onLeave: (dir: "prev" | "next") => void;
  onMenu: () => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const geo = useMemo(() => pageBoxes(vp, settings), [vp, settings]);
  const box = geo.boxes[0]!;
  const fontsReady = useFontsReady();
  const [pages, setPages] = useState<ReaderPage[] | null>(null);
  const [start, setStart] = useState(0);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const atEndRef = useRef(false);
  /** the last start was set by re-pagination (keep the reading anchor; a spread-aligned start would drift it) */
  const repaginatedRef = useRef<{ pages: ReaderPage[]; start: number } | null>(null);
  const initialRef = useRef<InitialPosition | null>(initial);
  const typo = typographyKey(settings);

  // paginate whenever the page box, typography or text changes (fold / unfold, rotation, settings)
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const fits = (items: readonly PageItem[], pageIndex: number) => {
      fillMeasure(el, items, pageIndex, heading);
      return el.scrollHeight <= el.clientHeight + 1;
    };
    const next = paginateBlocks(blocks, { maxChars: READER_PAGE_CHAR_COUNT[settings.pageChars], fits });
    el.replaceChildren();
    const count = next.length + 1;
    let page: number;
    const init = initialRef.current;
    if (init) {
      initialRef.current = null;
      page = init.kind === "end" ? next.length : init.kind === "anchor" ? pageForAnchor(next, init.anchor) : init.kind === "ratio" ? pageForRatio(init.ratio, count) : 0;
      if (init.kind === "end") atEndRef.current = true;
      if (init.kind === "anchor") anchorRef.current = init.anchor;
    } else if (atEndRef.current) page = next.length;
    else page = anchorRef.current ? pageForAnchor(next, anchorRef.current) : 0;
    const s = spreadStart(Math.min(page, count - 1), geo.spread);
    repaginatedRef.current = { pages: next, start: s };
    setPages(next);
    setStart(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, heading, box.width, box.height, typo, settings.pageChars, geo.spread, fontsReady]);

  const count = (pages?.length ?? 0) + 1;
  const step = screenStep(geo.spread);
  const endIndex = count - 1;

  // report the position (resume, read marks)
  useEffect(() => {
    if (!pages) return;
    const lastVisible = Math.min(endIndex, start + (geo.spread ? 1 : 0));
    const atEnd = lastVisible >= endIndex;
    const rp = repaginatedRef.current;
    // a commit still showing the previous pagination (the new one is queued): its start is not a reading position
    if (rp && rp.pages !== pages) return;
    atEndRef.current = atEnd;
    const fromRepagination = !!rp && rp.start === start;
    if (rp) repaginatedRef.current = { pages: rp.pages, start: -1 }; // consumed: later moves are the reader's
    if (!fromRepagination && start < pages.length) anchorRef.current = anchorForPage(pages, start);
    if (!anchorRef.current && start < pages.length) anchorRef.current = anchorForPage(pages, start);
    onPosition({ anchor: anchorRef.current ?? { para: 0, offset: 0 }, ratio: pageRatio(lastVisible, count), finished: pageFinished(lastVisible, count), atEnd });
  }, [pages, start, count, endIndex, geo.spread, onPosition]);

  const go = useCallback(
    (dir: "prev" | "next") => {
      if (!pages) return;
      if (dir === "next") {
        if (start + step <= endIndex) {
          atEndRef.current = false;
          setStart(spreadStart(start + step, geo.spread));
        } else onLeave("next");
      } else if (start > 0) {
        atEndRef.current = false;
        setStart(spreadStart(Math.max(0, start - step), geo.spread));
      } else onLeave("prev");
    },
    [pages, start, step, endIndex, geo.spread, onLeave],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [role=dialog]")) return;
      const a = keyAction(e.key, e.shiftKey, "page");
      if (a === "nextPage") go("next");
      else if (a === "prevPage") go("prev");
      else if (a === "menu") onMenu();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onMenu]);

  const down = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!e.isPrimary) return;
    down.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const swipe = swipeAction(dx, dy, e.timeStamp - d.t, geo.areaWidth);
    if (swipe) return go(swipe);
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, label")) return;
    if (window.getSelection()?.toString()) return;
    const zone = tapZone(e.clientX - geo.areaLeft, geo.areaWidth, "page");
    if (zone === "menu") onMenu();
    else go(zone);
  };

  const visible = geo.spread ? [start, start + 1] : [start];
  return (
    <div className="pr-pages" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (down.current = null)} data-spread={geo.spread} data-folded={geo.folded}>
      <div ref={measureRef} className="pr-prose pr-measure" style={{ width: box.width, height: box.height }} aria-hidden="true" />
      {pages &&
        visible.map((p, i) => {
          const b = geo.boxes[i]!;
          if (p > endIndex) return null;
          const isEnd = p === endIndex;
          return (
            <section key={`${i}`} className={`pr-page ${isEnd ? "pr-page-end" : "pr-prose"}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} aria-label={isEnd ? "이 화 끝" : `${p + 1}쪽`}>
              {isEnd ? endCard : <PageContent items={pages[p]!.items} pageIndex={p} heading={heading} />}
            </section>
          );
        })}
      {pages && (
        <div className="pr-page-meta" style={{ top: geo.boxes[0]!.top + geo.boxes[0]!.height + 24, left: geo.areaLeft, width: geo.areaWidth }} aria-live="polite">
          {pageCounter(Math.min(start + (geo.spread ? 1 : 0), endIndex), count)}
        </div>
      )}
    </div>
  );
}
