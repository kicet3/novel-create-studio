/** Reader settings (localStorage via @ncs/reader-core), theme, viewport + fold segments, document meta. */
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  READER_LINE_HEIGHT,
  READER_MARGIN_PX,
  READER_MAX_EM,
  READER_PARA_SPACING_EM,
  effectiveReaderTheme,
  fontPxOf,
  loadReaderSettings,
  saveReaderSettings,
  type KeyValueStore,
  type ReaderSettings,
  type ReaderSolidTheme,
  type ViewportSegment,
} from "@ncs/reader-core";

export function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// settings are shared by every screen (one store, many subscribers)
let current: ReaderSettings | null = null;
const subs = new Set<() => void>();
const getSettings = () => (current ??= loadReaderSettings(browserStore()));

export function useReaderSettings(): [ReaderSettings, (patch: Partial<ReaderSettings>) => void] {
  const s = useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSettings,
    getSettings,
  );
  const update = useCallback((patch: Partial<ReaderSettings>) => {
    current = { ...getSettings(), ...patch };
    saveReaderSettings(browserStore(), current);
    for (const fn of subs) fn();
  }, []);
  return [s, update];
}

function usePrefersDark(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
}

export function useTheme(s: ReaderSettings): ReaderSolidTheme {
  return effectiveReaderTheme(s.theme, null, usePrefersDark());
}

const FONT_FAMILY: Record<ReaderSettings["font"], string> = {
  gothic: "var(--font-sans)",
  myeongjo: '"Noto Serif KR", "Nanum Myeongjo", "AppleMyungjo", "Batang", serif',
  system: 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
};

/** typography as CSS custom properties (set through CSSOM: allowed by the strict CSP) */
export function readerVars(s: ReaderSettings): CSSProperties {
  return {
    "--reader-fs": `${fontPxOf(s.fontStep)}px`,
    "--reader-lh": String(READER_LINE_HEIGHT[s.lineHeight]),
    "--reader-ps": `${READER_PARA_SPACING_EM[s.paraSpacing]}em`,
    "--reader-pad": `${READER_MARGIN_PX[s.margin]}px`,
    "--reader-max": `${READER_MAX_EM[s.margin]}em`,
    "--reader-indent": s.indent ? "1em" : "0",
    "--reader-font": FONT_FAMILY[s.font],
  } as CSSProperties;
}

// ── viewport (+ Viewport Segments API on foldables) ──────────────────────
export interface ViewportInfo {
  width: number;
  height: number;
  segments: ViewportSegment[] | null;
  /** env(safe-area-inset-top / bottom) in px (notches, home indicator) */
  safeTop: number;
  safeBottom: number;
}

let probe: HTMLDivElement | null = null;
function safeAreas(): { safeTop: number; safeBottom: number } {
  if (typeof document === "undefined") return { safeTop: 0, safeBottom: 0 };
  if (!probe) {
    probe = document.createElement("div");
    probe.className = "pr-safe-probe";
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { safeTop: parseFloat(cs.paddingTop) || 0, safeBottom: parseFloat(cs.paddingBottom) || 0 };
}

function readViewport(): ViewportInfo {
  const vp = (window as unknown as { viewport?: { segments?: ArrayLike<{ x: number; y: number; width: number; height: number }> | null } }).viewport;
  const raw = vp?.segments ? Array.from(vp.segments) : null;
  const segments = raw && raw.length > 1 ? raw.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })) : null;
  return { width: window.innerWidth, height: window.innerHeight, segments, ...safeAreas() };
}

const sameVp = (a: ViewportInfo, b: ViewportInfo) =>
  a.width === b.width && a.height === b.height && a.safeTop === b.safeTop && a.safeBottom === b.safeBottom && JSON.stringify(a.segments) === JSON.stringify(b.segments);

/** re-renders on resize / rotation / fold-unfold (segment changes) */
export function useViewport(): ViewportInfo {
  const [vp, setVp] = useState(readViewport);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setVp((prev) => (sameVp(prev, readViewport()) ? prev : readViewport())));
    };
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    window.visualViewport?.addEventListener("resize", on);
    const mqs = ["(horizontal-viewport-segments: 2)", "(vertical-viewport-segments: 2)"].map((q) => window.matchMedia(q));
    for (const mq of mqs) mq.addEventListener?.("change", on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
      window.visualViewport?.removeEventListener("resize", on);
      for (const mq of mqs) mq.removeEventListener?.("change", on);
    };
  }, []);
  return vp;
}

/** <title> + meta description per screen */
export function useDocumentMeta(title: string | null, description?: string | null): void {
  useEffect(() => {
    if (!title) return;
    document.title = title;
    const desc = (description ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    if (desc) meta.content = desc;
  }, [title, description]);
}

export const SITE_NAME = "연재 읽기";
