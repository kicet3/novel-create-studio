/** 보기 설정 controls (live: every change applies immediately and is saved on this device by the app). */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BRIGHTNESS_MIN,
  DEFAULT_READER_SETTINGS,
  READER_FONTS,
  READER_FONT_LABELS,
  READER_FONT_STEPS_PX,
  READER_MODES,
  READER_MODE_LABELS,
  READER_PAGE_CHARS,
  READER_PAGE_CHARS_LABELS,
  READER_PAGE_CHAR_COUNT,
  READER_STEPS3,
  READER_STEP3_LABELS,
  READER_THEMES,
  READER_THEME_LABELS,
  READER_VIEWS,
  READER_VIEW_LABELS,
  fontPxOf,
  stepFont,
  type ReaderSettings,
} from "@ncs/reader-core/model";
import { cx } from "./cx.js";
import { ICON_BTN, ReaderIcon, SettingsGlyph } from "./icons.js";
import { READER_PANEL_ATTR, useDialogFocus } from "./dialog.js";
import { wakeLockSupported } from "./hooks.js";

export type UpdateSettings = (patch: Partial<ReaderSettings>) => void;

/** which optional rows an app offers: 원고 범위 (studio: 승인된 화만 / 초안 포함), 글꼴 (snowpage) */
export interface SettingsOptions {
  /** studio: the 원고 범위 row (default true) */
  showMode?: boolean;
  /** the 글꼴 row (고딕 / 명조 / 시스템; default false) */
  showFont?: boolean;
  /** 스크롤 보기: the 다음 화 이어 보기 switch (default true) */
  showContinuous?: boolean;
}

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

const PANEL_TABS = ["text", "view"] as const;
type PanelTab = (typeof PANEL_TABS)[number];
const PANEL_TAB_LABELS: Record<PanelTab, string> = { text: "글자·배경", view: "보기·화면" };

/**
 * 보기 설정 controls.
 * `viewer`: the viewer's sheet splits them into two short tabs (글자·배경 / 보기·화면) so the text stays visible.
 */
export function ReaderSettingsPanel({ settings, onChange, viewer = true, showMode = true, showFont = false, showContinuous = true }: { settings: ReaderSettings; onChange: UpdateSettings; viewer?: boolean } & SettingsOptions) {
  const themeLabel = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<PanelTab>("text");
  const showText = !viewer || tab === "text";
  const showView = viewer && tab === "view";
  const modeRow = showMode ? <Segmented label="원고 범위" values={READER_MODES} labels={READER_MODE_LABELS} value={settings.mode} onChange={(mode) => onChange({ mode })} /> : null;
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
          {showFont && <Segmented label="글꼴" values={READER_FONTS} labels={READER_FONT_LABELS} value={settings.font} onChange={(font) => onChange({ font })} />}
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
          {settings.view === "scroll" && showContinuous && (
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

/** 보기 설정 popover of the 목차 page (the viewer uses its own sheet). `headerHidden`: the sticky header slid away — close. */
export function ReaderSettingsButton({ settings, onChange, headerHidden = false, ...options }: { settings: ReaderSettings; onChange: UpdateSettings; headerHidden?: boolean } & SettingsOptions) {
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
          <ReaderSettingsPanel settings={settings} onChange={onChange} viewer={false} {...options} />
        </div>
      )}
    </div>
  );
}
