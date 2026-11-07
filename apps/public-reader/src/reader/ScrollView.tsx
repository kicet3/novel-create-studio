/** 스크롤 보기: the whole episode in one column; the reading anchor is the paragraph at the top of the screen. */
import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import {
  FINISHED_RATIO,
  scrollAnchorAt,
  scrollProgress,
  scrollTopFor,
  scrollYForAnchor,
  typographyKey,
  type ReaderSettings,
  type ReadingAnchor,
  type ReadingBlock,
} from "@ncs/reader-core";
import type { ViewportInfo } from "../lib/hooks.js";
import type { InitialPosition, Position } from "./PagedView.js";

const TOP_OFFSET = 56;

export function ScrollView({
  blocks,
  heading,
  settings,
  vp,
  initial,
  endCard,
  onPosition,
  onMenu,
}: {
  blocks: ReadingBlock[];
  heading: string;
  settings: ReaderSettings;
  vp: ViewportInfo;
  initial: InitialPosition;
  endCard: ReactNode;
  onPosition: (p: Position) => void;
  onMenu: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const initialRef = useRef<InitialPosition | null>(initial);
  const typo = typographyKey(settings);

  const rects = () => {
    const els = rootRef.current?.querySelectorAll<HTMLElement>("p[data-p]") ?? [];
    return Array.from(els, (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height };
    });
  };

  // restore: the initial position once, then the current anchor after typography / screen changes
  useLayoutEffect(() => {
    const init = initialRef.current;
    initialRef.current = null;
    const h = document.documentElement.scrollHeight;
    // (never return scrollTo's value from an effect: newer Chrome returns a Promise and React would call it as cleanup)
    if (init?.kind === "end") {
      window.scrollTo(0, h);
      return;
    }
    if (init?.kind === "ratio") {
      window.scrollTo(0, scrollTopFor(init.ratio, h, window.innerHeight));
      return;
    }
    const a = init?.kind === "anchor" ? init.anchor : anchorRef.current;
    if (!a) {
      if (init) window.scrollTo(0, 0);
      return;
    }
    const r = rects()[a.para];
    if (r) window.scrollTo(0, Math.max(0, scrollYForAnchor(r, a.offset) - TOP_OFFSET));
  }, [typo, vp.width, vp.height]);

  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const anchor = scrollAnchorAt(rects(), window.scrollY + TOP_OFFSET);
        anchorRef.current = anchor;
        const ratio = scrollProgress(window.scrollY, document.documentElement.scrollHeight, window.innerHeight);
        onPosition({ anchor, ratio, finished: ratio >= FINISHED_RATIO, atEnd: ratio >= 0.999 });
      });
    };
    window.addEventListener("scroll", on, { passive: true });
    on();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [onPosition]);

  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, label")) return;
    if (window.getSelection()?.toString()) return;
    onMenu();
  };

  let p = 0;
  return (
    <div ref={rootRef} className="pr-scroll" onClick={onClick}>
      <article className="pr-prose pr-column">
        <h1 className="pr-ep-title">{heading}</h1>
        {blocks.map((b, i) =>
          b.type === "p" ? (
            <p key={i} data-p={p++}>
              {b.text}
            </p>
          ) : b.type === "break" ? (
            <div key={i} className="pr-break">
              * * *
            </div>
          ) : null,
        )}
      </article>
      <div className="pr-column pr-scroll-end">{endCard}</div>
    </div>
  );
}
