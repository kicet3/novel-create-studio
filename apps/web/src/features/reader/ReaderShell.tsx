/**
 * 읽기(reader) shell: settings state (localStorage), theme root, read history. The presentational pieces (icons,
 * 보기 설정 panel, dialog focus, wake lock, reader.css) live in @ncs/reader-ui (shared with snowpage) and are re-exported here.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import type { Tone } from "../../components/ui/index.js";
import {
  READER_LINE_HEIGHT,
  READER_MARGIN_PX,
  READER_MAX_EM,
  READER_PARA_SPACING_EM,
  READER_SETTINGS_KEY,
  effectiveReaderTheme,
  fontPxOf,
  loadHistory,
  loadReaderSettings,
  markHistory,
  saveHistory,
  saveReaderSettings,
  type KeyValueStore,
  type ReadHistory,
  type ReadState,
  type ReaderSettings,
  type ReaderSolidTheme,
  type TocRowKind,
} from "./reader-model.js";
import "@ncs/reader-core/themes.css";
import "@ncs/reader-ui/reader.css";

export {
  ICON_BTN,
  READER_PANEL_ATTR,
  ReaderIcon,
  ReaderSettingsButton,
  ReaderSettingsPanel,
  SettingsGlyph,
  isReaderPanelOpen,
  lastInputWasKeyboard,
  lastInputWasPointer,
  useDialogFocus,
  useHideOnScroll,
  useReducedMotion,
  useWakeLock,
  type ReaderIconName,
  type UpdateSettings,
} from "@ncs/reader-ui";

export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function useReaderSettings(): [ReaderSettings, (patch: Partial<ReaderSettings>) => void] {
  const [settings, setSettings] = useState<ReaderSettings>(() => loadReaderSettings(browserStore()));
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === READER_SETTINGS_KEY) setSettings(loadReaderSettings(browserStore()));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const latest = useRef(settings);
  latest.current = settings;
  // persist eagerly (not inside the state updater): an update made right before navigating away
  // (e.g. 이어 읽기 switching the mode) must reach the next page, which reads localStorage on mount
  const update = useCallback((patch: Partial<ReaderSettings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    saveReaderSettings(browserStore(), next);
    setSettings(next);
  }, []);
  return [settings, update];
}

/** read / opened episodes of a novel on this device */
export function useReadHistory(novelId: string): [ReadHistory, (episodeNo: number, state: ReadState) => void] {
  const [history, setHistory] = useState<ReadHistory>(() => loadHistory(browserStore(), novelId));
  useEffect(() => {
    setHistory(loadHistory(browserStore(), novelId));
  }, [novelId]);
  const mark = useCallback(
    (episodeNo: number, state: ReadState) => {
      setHistory((h) => {
        // re-read storage: another tab / page may have written since
        const next = markHistory({ ...loadHistory(browserStore(), novelId), ...h }, episodeNo, state);
        if (next[episodeNo] !== h[episodeNo]) saveHistory(browserStore(), novelId, next);
        return next[episodeNo] === h[episodeNo] ? h : next;
      });
    },
    [novelId],
  );
  return [history, mark];
}

function subscribeScheme(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  mq.addEventListener("change", cb);
  return () => {
    mq.removeEventListener("change", cb);
    obs.disconnect();
  };
}
const schemeSnapshot = () => `${document.documentElement.getAttribute("data-theme") ?? ""}|${window.matchMedia("(prefers-color-scheme: dark)").matches ? 1 : 0}`;

export function useEffectiveTheme(settings: ReaderSettings): ReaderSolidTheme {
  const scheme = useSyncExternalStore(subscribeScheme, schemeSnapshot, () => "|0");
  const [appTheme, dark] = scheme.split("|");
  return effectiveReaderTheme(settings.theme, appTheme || null, dark === "1");
}

/** typography as CSS variables (consumed by reader.css): changing a setting re-styles without re-rendering the text */
export function readerStyleVars(s: ReaderSettings): CSSProperties {
  return {
    "--reader-fs": `${fontPxOf(s.fontStep)}px`,
    "--reader-lh": String(READER_LINE_HEIGHT[s.lineHeight]),
    "--reader-ps": `${READER_PARA_SPACING_EM[s.paraSpacing]}em`,
    "--reader-pad": `${READER_MARGIN_PX[s.margin]}px`,
    "--reader-max": `${READER_MAX_EM[s.margin]}em`,
    "--reader-indent": s.indent ? "1em" : "0",
  } as CSSProperties;
}

/** theme root: data attributes + CSS variables drive reader.css; body background follows so overscroll matches */
export function ReaderRoot({ settings, children, className }: { settings: ReaderSettings; children: ReactNode; className?: string }) {
  const theme = useEffectiveTheme(settings);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    if (ref.current) document.body.style.backgroundColor = getComputedStyle(ref.current).backgroundColor;
    return () => {
      document.body.style.backgroundColor = prev;
    };
  }, [theme]);
  return (
    <div ref={ref} className={cx("reader", className)} data-reader-theme={theme} style={readerStyleVars(settings)}>
      {children}
    </div>
  );
}

/** badge of the text being read: 공개 / 승인 / 초안 */
export const KIND_BADGE: Record<TocRowKind, { label: string; tone: Tone }> = {
  published: { label: "공개", tone: "ok" },
  approved: { label: "승인", tone: "accent" },
  draft: { label: "초안", tone: "violet" },
};

