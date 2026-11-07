/** 읽기(reader) shell: settings state (localStorage), theme root, 보기 설정 panel, dialog focus, read history, wake lock, icons. */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { READER_MODES } from "@ncs/shared";
import { cx } from "../../lib/cx.js";
import type { Tone } from "../../components/ui/index.js";
import {
  BRIGHTNESS_MIN,
  DEFAULT_READER_SETTINGS,
  READER_FONT_STEPS_PX,
  READER_LINE_HEIGHT,
  READER_MARGIN_PX,
  READER_MAX_EM,
  READER_MODE_LABELS,
  READER_PAGE_CHARS,
  READER_PAGE_CHARS_LABELS,
  READER_PAGE_CHAR_COUNT,
  READER_PARA_SPACING_EM,
  READER_SETTINGS_KEY,
  READER_STEPS3,
  READER_STEP3_LABELS,
  READER_THEMES,
  READER_THEME_LABELS,
  READER_VIEWS,
  READER_VIEW_LABELS,
  effectiveReaderTheme,
  fontPxOf,
  headerVisible,
  loadHistory,
  loadReaderSettings,
  markHistory,
  saveHistory,
  saveReaderSettings,
  stepFont,
  type KeyValueStore,
  type ReadHistory,
  type ReadState,
  type ReaderSettings,
  type ReaderSolidTheme,
  type TocRowKind,
} from "./reader-model.js";
import "./reader.css";

export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type UpdateSettings = (patch: Partial<ReaderSettings>) => void;

export function useReaderSettings(): [ReaderSettings, UpdateSettings] {
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

// ── icons ───────────────────────────────────────────────────────────────
const ICONS = {
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />,
  home: <path d="M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9" />,
  book: <path d="M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2ZM12 6.5v14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  scroll: <path d="M7 3h10v18H7zM10 8h4M10 12h4M10 16h4" />,
  pages: <path d="M3 5h8v15H3zM13 5h8v15h-8z" />,
  sun: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
} as const;
export type ReaderIconName = keyof typeof ICONS;

export function ReaderIcon({ name, size = 20 }: { name: ReaderIconName; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/** 44px tap target icon button / link styling */
export const ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent";

/** "가가" glyph of the 보기 설정 buttons */
export const SettingsGlyph = () => (
  <span aria-hidden="true" className="text-[15px] font-semibold">
    가<span className="text-[11px]">가</span>
  </span>
);

// ── dialogs ─────────────────────────────────────────────────────────────
/** set while a reader panel/drawer is open, so viewer shortcuts (←/→, Space) stand aside */
export const READER_PANEL_ATTR = "data-reader-panel";
export const isReaderPanelOpen = () => typeof document !== "undefined" && !!document.querySelector(`[${READER_PANEL_ATTR}]`);

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// last input kind: a panel opened by touch / mouse must not show a focus ring on its first control
let lastPointerAt = -Infinity;
let lastKeyAt = -Infinity;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => void (lastPointerAt = performance.now()), { capture: true, passive: true });
  window.addEventListener("keydown", () => void (lastKeyAt = performance.now()), { capture: true, passive: true });
}
/** the latest interaction was a pointer (touch / mouse), not the keyboard */
export const lastInputWasPointer = () => lastPointerAt > lastKeyAt;
/** the latest interaction was the keyboard (false before any interaction) */
export const lastInputWasKeyboard = () => lastKeyAt > lastPointerAt;

/**
 * focus moves into the panel, Tab stays inside, Esc closes; focus returns to the opener on close.
 * Opened by keyboard: the selected / first control gets focus; opened by touch or mouse: the panel itself
 * (give it tabIndex={-1} and `rv-panel-focus`), so no focus ring appears on a control nobody chose.
 */
export function useDialogFocus(panel: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initial?: string) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = (initial && panel.current?.querySelector<HTMLElement>(initial)) || panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]') || panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (lastInputWasPointer() && panel.current?.tabIndex === -1) panel.current.focus({ preventScroll: true });
    else first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const [head, tail] = [items[0]!, items[items.length - 1]!];
        const inside = panel.current.contains(document.activeElement) && document.activeElement !== panel.current;
        if (e.shiftKey && (document.activeElement === head || !inside)) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && (document.activeElement === tail || !inside)) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, panel, initial]);
}

// ── settings panel ──────────────────────────────────────────────────────
function Segmented<V extends string>({ label, values, labels, value, onChange, renderLabel }: {
  label: string;
  values: readonly V[];
  labels: Record<V, string>;
  value: V;
  onChange: (v: V) => void;
  renderLabel?: (v: V) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <span id={id} className="text-[13px] font-semibold text-muted">
        {label}
      </span>
      <div role="group" aria-labelledby={id} className="flex rounded-[10px] border border-border bg-surface-2 p-0.5">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={cx(
              "min-h-10 min-w-0 flex-1 truncate rounded-[8px] px-1 text-[13px] font-semibold whitespace-nowrap",
              value === v ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
            )}
          >
            {renderLabel ? renderLabel(v) : labels[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-3">
      <span className="min-w-0 flex-1">
        <span id={id} className="block text-[14px] font-semibold text-text">
          {label}
        </span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("reader-switch relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-50", checked ? "border-accent bg-accent" : "border-border bg-surface-2")}
      >
        <span aria-hidden="true" className={cx("absolute top-0.5 size-[22px] rounded-full bg-white shadow transition-[left]", checked ? "left-[22px]" : "left-0.5")} />
      </button>
    </div>
  );
}

/** labelled range with − / + buttons */
function Stepper({ label, min, max, step = 1, value, onChange, format, minus, plus }: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  minus: ReactNode;
  plus: ReactNode;
}) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <label htmlFor={id} className="text-[13px] font-semibold text-muted">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <button type="button" className={cx(ICON_BTN, "size-10")} aria-label={`${label} 줄이기`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          {minus}
        </button>
        <input
          id={id}
          type="range"
          className="reader-range min-w-0 flex-1"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={format(value)}
          style={{ "--fill": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%` } as CSSProperties}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
        />
        <button type="button" className={cx(ICON_BTN, "size-10")} aria-label={`${label} 키우기`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
          {plus}
        </button>
        <span className="w-10 shrink-0 text-right text-[12px] font-semibold text-muted tabular" aria-hidden="true">
          {format(value)}
        </span>
      </div>
    </div>
  );
}

/** the swatch shows the theme's own background + text color */
const THEME_SWATCH: Record<(typeof READER_THEMES)[number], { bg: string; fg: string }> = {
  auto: { bg: "linear-gradient(135deg,#ffffff 50%,#0b0c0e 50%)", fg: "#7a7f87" },
  white: { bg: "#ffffff", fg: "#222529" },
  ivory: { bg: "#f6f0e1", fg: "#372c1f" },
  gray: { bg: "#dfe0e2", fg: "#23262a" },
  green: { bg: "#dcead3", fg: "#22301e" },
  black: { bg: "#0b0c0e", fg: "#cfccc4" },
};

const wakeLockSupported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

const PANEL_TABS = ["text", "view"] as const;
type PanelTab = (typeof PANEL_TABS)[number];
const PANEL_TAB_LABELS: Record<PanelTab, string> = { text: "글자·배경", view: "보기·화면" };

/**
 * 보기 설정 controls (live: every change applies immediately and is saved on this device).
 * `viewer`: the viewer's bottom sheet splits them into two short tabs (글자·배경 / 보기·화면) so the text stays visible.
 */
export function ReaderSettingsPanel({ settings, onChange, viewer = true }: { settings: ReaderSettings; onChange: UpdateSettings; viewer?: boolean }) {
  const themeLabel = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<PanelTab>("text");
  const showText = !viewer || tab === "text";
  const showView = viewer && tab === "view";
  const modeRow = <Segmented label="원고 범위" values={READER_MODES} labels={READER_MODE_LABELS} value={settings.mode} onChange={(mode) => onChange({ mode })} />;
  return (
    <div className="grid gap-3.5">
      {viewer && (
        <div role="tablist" aria-label="설정 종류" className="sticky -top-2 z-[1] -mx-1 -mt-1 flex gap-1 bg-surface px-1 pt-1 pb-1">
          {PANEL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`${tabsId}-${t}`}
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                e.stopPropagation();
                const next = PANEL_TABS[(PANEL_TABS.indexOf(t) + 1) % PANEL_TABS.length]!;
                setTab(next);
                document.getElementById(`${tabsId}-${next}`)?.focus();
              }}
              className={cx(
                "min-h-10 flex-1 rounded-full text-[13.5px] font-bold focus-visible:outline-2 focus-visible:outline-accent",
                tab === t ? "bg-text text-bg" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              {PANEL_TAB_LABELS[t]}
            </button>
          ))}
        </div>
      )}
      {showText && (
        <div role={viewer ? "tabpanel" : undefined} aria-labelledby={viewer ? `${tabsId}-text` : undefined} className="grid gap-3.5">
          <Stepper
            label="글자 크기"
            min={0}
            max={READER_FONT_STEPS_PX.length - 1}
            value={settings.fontStep}
            onChange={(fontStep) => onChange({ fontStep: stepFont(fontStep, 0) })}
            format={(v) => `${fontPxOf(v)}px`}
            minus={<span className="text-[13px] font-bold">가</span>}
            plus={<span className="text-[19px] font-bold">가</span>}
          />
          <div className="grid gap-2">
            <span id={themeLabel} className="text-[13px] font-semibold text-muted">
              배경
            </span>
            <div role="group" aria-labelledby={themeLabel} className="grid grid-cols-6 gap-1.5">
              {READER_THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={settings.theme === t}
                  onClick={() => onChange({ theme: t })}
                  className="group grid justify-items-center gap-1 rounded-[10px] py-1 text-[11.5px] font-semibold text-muted aria-pressed:text-text"
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      "grid size-10 place-items-center rounded-full border text-[14px] font-bold",
                      settings.theme === t ? "border-accent ring-2 ring-accent ring-offset-2 ring-offset-surface" : "border-border",
                    )}
                    style={{ background: THEME_SWATCH[t].bg, color: THEME_SWATCH[t].fg }}
                  >
                    {t === "auto" ? "" : "가"}
                  </span>
                  {READER_THEME_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          <Segmented label="줄 간격" values={READER_STEPS3} labels={READER_STEP3_LABELS} value={settings.lineHeight} onChange={(lineHeight) => onChange({ lineHeight })} />
          <Segmented label="문단 간격" values={READER_STEPS3} labels={READER_STEP3_LABELS} value={settings.paraSpacing} onChange={(paraSpacing) => onChange({ paraSpacing })} />
          <Segmented label="좌우 여백" values={READER_STEPS3} labels={READER_STEP3_LABELS} value={settings.margin} onChange={(margin) => onChange({ margin })} />
          <Switch label="문단 첫 줄 들여쓰기" checked={settings.indent} onChange={(indent) => onChange({ indent })} />
        </div>
      )}
      {showView && (
        <div role="tabpanel" aria-labelledby={`${tabsId}-view`} className="grid gap-3.5">
          <Segmented
            label="보기 방식"
            values={READER_VIEWS}
            labels={READER_VIEW_LABELS}
            value={settings.view}
            onChange={(view) => onChange({ view })}
            renderLabel={(v) => (
              <span className="inline-flex items-center gap-1.5">
                <ReaderIcon name={v === "scroll" ? "scroll" : "pages"} size={16} />
                {READER_VIEW_LABELS[v]}
              </span>
            )}
          />
          {settings.view === "page" && (
            <div className="grid gap-1">
              <Segmented label="글자 수" values={READER_PAGE_CHARS} labels={READER_PAGE_CHARS_LABELS} value={settings.pageChars} onChange={(pageChars) => onChange({ pageChars })} />
              <p className="m-0 pl-[5rem] text-[12px] text-muted">
                한 페이지에 약 {READER_PAGE_CHAR_COUNT[settings.pageChars].toLocaleString("ko-KR")}자 · 화면을 넘치면 그만큼 줄여 나눕니다
              </p>
            </div>
          )}
          {settings.view === "scroll" && (
            <Switch label="다음 화 이어 보기" hint="화 끝에서 다음 화를 이어서 불러옵니다" checked={settings.continuous} onChange={(continuous) => onChange({ continuous })} />
          )}
          <Stepper
            label="화면 밝기"
            min={BRIGHTNESS_MIN * 100}
            max={100}
            step={5}
            value={Math.round(settings.brightness * 100)}
            onChange={(v) => onChange({ brightness: v / 100 })}
            format={(v) => `${v}%`}
            minus={<ReaderIcon name="moon" size={17} />}
            plus={<ReaderIcon name="sun" size={18} />}
          />
          <Switch
            label="화면 꺼짐 방지"
            hint={wakeLockSupported() ? "읽는 동안 화면이 자동으로 꺼지지 않게 합니다" : "이 브라우저에서는 지원되지 않습니다"}
            checked={settings.keepAwake && wakeLockSupported()}
            disabled={!wakeLockSupported()}
            onChange={(keepAwake) => onChange({ keepAwake })}
          />
          {modeRow}
        </div>
      )}
      {!viewer && modeRow}
      <div className="flex justify-end">
        <button
          type="button"
          className="min-h-10 rounded-[8px] px-3 text-[13px] font-semibold text-muted hover:bg-surface-2 hover:text-text"
          onClick={() => onChange({ ...DEFAULT_READER_SETTINGS, view: settings.view, pageChars: settings.pageChars, mode: settings.mode, continuous: settings.continuous })}
        >
          글자·배경 초기화
        </button>
      </div>
    </div>
  );
}

/** 보기 설정 popover of the 목차 page (the viewer uses its own bottom sheet). `headerHidden`: the sticky header slid away — close. */
export function ReaderSettingsButton({ settings, onChange, headerHidden = false }: { settings: ReaderSettings; onChange: UpdateSettings; headerHidden?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDialogFocus(panel, open, close);
  useEffect(() => {
    if (open && headerHidden) close();
  }, [open, headerHidden, close]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  return (
    <div ref={wrap} className="relative">
      <button type="button" className={ICON_BTN} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" aria-label="보기 설정" onClick={() => setOpen((o) => !o)}>
        <SettingsGlyph />
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label="보기 설정"
          {...{ [READER_PANEL_ATTR]: "" }}
          className="fixed inset-x-2 top-[60px] z-40 max-h-[calc(100dvh-72px)] overflow-y-auto rounded-[14px] border border-border bg-surface p-4 shadow-[0_12px_40px_rgb(0_0_0/0.18)] sm:absolute sm:inset-x-auto sm:top-[calc(100%+6px)] sm:right-0 sm:w-[380px]"
        >
          <ReaderSettingsPanel settings={settings} onChange={onChange} viewer={false} />
        </div>
      )}
    </div>
  );
}

/** sticky header that slides away on scroll down (목차 page) */
export function useHideOnScroll(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let last = window.scrollY;
    let vis = true;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = window.scrollY;
        const nearBottom = top + window.innerHeight >= document.documentElement.scrollHeight - 24;
        const next = nearBottom || headerVisible(last, top, vis);
        if (Math.abs(top - last) >= 6 || top <= 64) last = top;
        if (next !== vis) {
          vis = next;
          setVisible(next);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return visible;
}

/** 화면 꺼짐 방지: hold a screen wake lock while enabled and visible (re-acquired when the tab comes back) */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !wakeLockSupported()) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* denied (battery saver, not focused): reading continues normally */
      }
    };
    void acquire();
    const onVisible = () => void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
  }, [enabled]);
}

/** prefers-reduced-motion (page turns jump instead of sliding) */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}
