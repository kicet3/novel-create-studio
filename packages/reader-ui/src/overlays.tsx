/** 읽기 viewer overlays: top / bottom bars, 보기 설정 sheet, side drawers (목차, 댓글), first-time hint, 밝기 dimmer. */
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { dimOpacity, episodeLabel, skippedLabel, type ReaderSettings, type ReaderView } from "@ncs/reader-core/model";
import { pageRatio, percentLabel } from "@ncs/reader-core/layout";
import { pageCounter } from "@ncs/reader-core/pages";
import { cx } from "./cx.js";
import { ICON_BTN, ReaderIcon, SettingsGlyph } from "./icons.js";
import { panelAttr, useDialogFocus } from "./dialog.js";
import { ReaderSettingsPanel, type SettingsOptions, type UpdateSettings } from "./settings.js";
import { useProgress, type ProgressStore, type ViewHandle } from "./progress.js";

/** prev / next of the open episode as the bars need them */
export interface EpisodeNav {
  episodeNo: number;
  title: string | null | undefined;
  prev: { episodeNo: number; skipped?: readonly number[] } | null | undefined;
  next: { episodeNo: number; skipped?: readonly number[] } | null | undefined;
}

// ── bars ────────────────────────────────────────────────────────────────
/** `back`: the app's link to the 목차 / 작품 홈 (router Link), styled with ICON_BTN */
export function TopBar({ shown, novelTitle, episodeNo, ep, back, onToc, onSettings, actions }: {
  shown: boolean;
  novelTitle: string | undefined;
  episodeNo: number;
  ep: EpisodeNav | undefined;
  back: ReactNode;
  onToc: () => void;
  onSettings: () => void;
  /** extra buttons before 목차 (snowpage: 댓글) */
  actions?: ReactNode;
}) {
  const no = ep?.episodeNo ?? episodeNo;
  return (
    <header className="rv-bar rv-bar-top" data-hidden={!shown} aria-hidden={!shown || undefined} inert={!shown || undefined}>
      <div className="mx-auto flex h-14 max-w-[1100px] items-center gap-1 px-1.5 sm:px-4">
        {back}
        <div className="min-w-0 flex-1 px-1 leading-tight">
          <span className="block truncate text-[11.5px] font-medium text-muted">{novelTitle ?? " "}</span>
          <span className="block truncate text-[15px] font-semibold text-text">{ep ? episodeLabel(no, ep.title) : `${no}화`}</span>
        </div>
        {actions}
        <button type="button" className={ICON_BTN} aria-label="목차" onClick={onToc}>
          <ReaderIcon name="list" />
        </button>
        <button type="button" className={ICON_BTN} aria-label="보기 설정" onClick={onSettings}>
          <SettingsGlyph />
        </button>
      </div>
    </header>
  );
}

const navTitle = (base: string, target: EpisodeNav["prev"] | undefined) => {
  const skipped = skippedLabel(target?.skipped);
  return skipped ? `${base} · ${skipped} 건너뜀` : base;
};

export const BAR_BTN =
  "flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-[10px] px-2.5 text-[13.5px] font-semibold text-text hover:bg-surface-2 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent";

/** `extra`: more tool buttons in the lower row (snowpage: 댓글), same look as 목차 / 보기 설정 */
export function BottomBar({ shown, store, view, ep, handle, onGo, onToc, onSettings, onView, extra }: {
  shown: boolean;
  store: ProgressStore;
  view: ReaderView;
  ep: EpisodeNav | undefined;
  handle: RefObject<ViewHandle | null>;
  onGo: (no: number) => void;
  onToc: () => void;
  onSettings: () => void;
  onView: (v: ReaderView) => void;
  extra?: ReactNode;
}) {
  return (
    <nav className="rv-bar rv-bar-bottom" data-hidden={!shown} aria-label="읽기 메뉴" aria-hidden={!shown || undefined} inert={!shown || undefined}>
      <div className="mx-auto max-w-[760px] px-2 pt-1.5 sm:px-4">
        <div className="flex items-center gap-1">
          <button type="button" className={BAR_BTN} disabled={!ep?.prev} onClick={() => ep?.prev && onGo(ep.prev.episodeNo)} title={navTitle("이전 화", ep?.prev)}>
            <ReaderIcon name="back" size={18} />
            이전 화
          </button>
          <ProgressSlider store={store} view={view} episodeNo={ep?.episodeNo} handle={handle} />
          <button type="button" className={BAR_BTN} disabled={!ep?.next} onClick={() => ep?.next && onGo(ep.next.episodeNo)} title={navTitle("다음 화", ep?.next)}>
            다음 화
            <ReaderIcon name="next" size={18} />
          </button>
        </div>
        <div className={cx("grid border-t border-border py-1", extra ? "grid-cols-4" : "grid-cols-3")}>
          <button type="button" className={cx(BAR_BTN, "flex-col gap-0 text-[12px]")} onClick={onToc}>
            <ReaderIcon name="list" />
            목차
          </button>
          <button
            type="button"
            className={cx(BAR_BTN, "flex-col gap-0 text-[12px]")}
            onClick={() => onView(view === "scroll" ? "page" : "scroll")}
            aria-label={view === "scroll" ? "페이지 넘김으로 보기" : "스크롤 보기로 보기"}
          >
            <ReaderIcon name={view === "scroll" ? "pages" : "scroll"} />
            {view === "scroll" ? "페이지 넘김" : "스크롤 보기"}
          </button>
          {extra}
          <button type="button" className={cx(BAR_BTN, "flex-col gap-0 text-[12px]")} onClick={onSettings}>
            <ReaderIcon name="sliders" />
            보기 설정
          </button>
        </div>
      </div>
    </nav>
  );
}

/** progress of the current episode: 스크롤 = %, 페이지 = "12 / 48" (the end card = "끝"); dragging seeks live */
function ProgressSlider({ store, view, episodeNo, handle }: { store: ProgressStore; view: ReaderView; episodeNo: number | undefined; handle: RefObject<ViewHandle | null> }) {
  const p = useProgress(store);
  const paged = view === "page" && p.pageCount > 0;
  const max = paged ? Math.max(1, p.pageCount - 1) : 1000;
  const value = paged ? p.page : Math.round(p.ratio * 1000);
  const ratio = paged ? pageRatio(p.page, p.pageCount) : p.ratio;
  const label = paged ? pageCounter(p.page, p.pageCount) : percentLabel(p.ratio);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
      <input
        type="range"
        className="reader-range min-w-0 flex-1"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={!episodeNo}
        aria-label={paged ? "페이지 이동" : "읽은 위치"}
        aria-valuetext={paged ? (label === "끝" ? "화 끝" : `${label} 페이지`) : `${label} 읽음`}
        style={{ "--fill": `${ratio * 100}%` } as CSSProperties}
        onChange={(e) => {
          const v = Number(e.target.value);
          handle.current?.seek(paged ? pageRatio(v, p.pageCount) : v / 1000);
        }}
      />
      <span className="w-[4.6rem] shrink-0 text-right text-[12.5px] font-semibold text-muted tabular">
        {label}
        {paged && <span className="block text-[11px] font-medium">{percentLabel(ratio)}</span>}
      </span>
    </div>
  );
}

// ── 보기 설정 sheet ──────────────────────────────────────────────────────
export function SettingsSheet({ open, onClose, settings, onChange, ...options }: { open: boolean; onClose: () => void; settings: ReaderSettings; onChange: UpdateSettings } & SettingsOptions) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, open, onClose);
  if (!open) return null;
  return (
    <>
      {/* clear backdrop: the text stays visible for live preview; a tap outside closes */}
      <div className="rv-backdrop" data-clear="true" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="보기 설정" tabIndex={-1} className="rv-sheet rv-panel-focus" {...panelAttr}>
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-border sm:hidden" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-bold">보기 설정</h2>
          <button type="button" className={cx(ICON_BTN, "-mr-2")} aria-label="닫기" onClick={onClose}>
            <ReaderIcon name="close" />
          </button>
        </div>
        <ReaderSettingsPanel settings={settings} onChange={onChange} {...options} />
      </div>
    </>
  );
}

// ── side drawer (목차, 댓글) ─────────────────────────────────────────────
/**
 * right-side drawer over a dimmed page. `initial`: selector of the element focused (keyboard) and scrolled into view
 * on open (e.g. the current episode). `bodyRef`: the scrolling body (e.g. to keep a comment list at a position).
 */
export function ReaderDrawer({ open, onClose, title, titleId, subtitle, closeLabel = "닫기", initial, scrollKey, children, footer, className }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  titleId: string;
  subtitle?: ReactNode;
  closeLabel?: string;
  initial?: string;
  /** re-run the scroll-into-view of `initial` when this changes (e.g. the list loaded) */
  scrollKey?: unknown;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, open, onClose, initial);
  useEffect(() => {
    if (open && initial) ref.current?.querySelector(initial)?.scrollIntoView({ block: "center" });
  }, [open, initial, scrollKey]);
  if (!open) return null;
  return (
    <>
      <div className="rv-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cx("rv-drawer rv-panel-focus", className)} {...panelAttr}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] font-bold">
              {title}
            </h2>
            {subtitle && <p className="text-[12.5px] text-muted tabular">{subtitle}</p>}
          </div>
          <button type="button" className={cx(ICON_BTN, "-mr-2")} aria-label={closeLabel} onClick={onClose}>
            <ReaderIcon name="close" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">{children}</div>
        {footer && <div className="border-t border-border p-3">{footer}</div>}
      </div>
    </>
  );
}

/** one episode row of the 목차 drawer */
export function TocDrawerItem({ episodeNo, title, charCount, note, current, state, onJump }: {
  episodeNo: number;
  title: string | null | undefined;
  /** omitted → no character count (snowpage never shows it) */
  charCount?: number | null;
  /** e.g. "초안" */
  note?: string | null;
  current: boolean;
  state: "open" | "read" | undefined;
  onJump: (no: number) => void;
}) {
  const read = state === "read";
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(episodeNo)}
        aria-current={current ? "page" : undefined}
        className={cx("flex min-h-[52px] w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left", current ? "bg-accent-soft" : "hover:bg-surface-2")}
      >
        <span className={cx("w-11 shrink-0 text-[13px] font-semibold tabular", current ? "text-accent" : "text-muted")}>{episodeNo}화</span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-[14.5px]", current ? "font-bold text-text" : read ? "font-medium text-muted" : "font-medium text-text")}>{title?.trim() || "제목 없음"}</span>
          {(charCount != null || note) && (
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
              {charCount != null && <span className="tabular">{charCount.toLocaleString("ko-KR")}자</span>}
              {note && <span>{charCount != null ? "· " : ""}{note}</span>}
            </span>
          )}
        </span>
        {current ? (
          <span className="shrink-0 text-[12px] font-bold text-accent">보는 중</span>
        ) : read ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[12px] font-semibold text-muted">
            <ReaderIcon name="check" size={15} />
            읽음
          </span>
        ) : state === "open" ? (
          <span className="shrink-0 text-[12px] font-semibold text-muted">읽는 중</span>
        ) : null}
      </button>
    </li>
  );
}

/** drawer footer link styling (작품 목차 / 이 화 편집) */
export const DRAWER_LINK =
  "flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] border border-border text-[13.5px] font-semibold text-text no-underline hover:bg-surface-2";

// ── first-time hint ─────────────────────────────────────────────────────
/** touch-first device (phones / tablets): no keyboard shortcuts in the hint */
const isTouchDevice = () => typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;

export function TapHint({ view, onClose }: { view: ReaderView; onClose: () => void }) {
  const touch = useMemo(isTouchDevice, []);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    btn.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const zone = (title: string, sub: ReactNode, icon?: ReactNode) => (
    <div className="rv-hint-zone">
      {icon}
      <span>{title}</span>
      <span className="text-[12px] font-medium opacity-80">{sub}</span>
    </div>
  );
  return (
    <div className="rv-hint" role="dialog" aria-modal="true" aria-label="읽기 안내" onClick={onClose} {...panelAttr}>
      {view === "page" ? (
        <div className="grid h-full grid-cols-[3fr_4fr_3fr] gap-2 p-3 pt-16 pb-36">
          {zone("이전 페이지", "왼쪽 탭", <ReaderIcon name="back" size={26} />)}
          {zone("메뉴 열기·닫기", "가운데 탭")}
          {zone("다음 페이지", "오른쪽 탭", <ReaderIcon name="next" size={26} />)}
        </div>
      ) : (
        <div className="grid h-full place-items-center p-6 pb-44">
          <div className="rv-hint-zone aspect-square w-[min(72vw,320px)] rounded-full">
            <span aria-hidden="true" className="mb-1 grid size-12 place-items-center rounded-full border-2 border-white/70">
              <span className="size-4 rounded-full bg-white/80" />
            </span>
            <span>화면을 탭하면 메뉴가 열리고 닫힙니다</span>
            <span className="text-[12px] font-medium opacity-80">위아래로 스크롤해 읽으세요</span>
          </div>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 grid justify-items-center gap-3 px-6 pb-[calc(28px+env(safe-area-inset-bottom))] text-center">
        <p className="m-0 text-[13.5px] leading-relaxed opacity-90">
          {view === "page"
            ? touch
              ? "화면을 좌우로 밀어서 넘길 수도 있습니다. 마지막 쪽에서 더 넘기면 다음 화로 넘어갑니다."
              : "←/→·PageDown·스페이스 키나 마우스 휠로도 넘길 수 있습니다. 마지막 쪽에서 더 넘기면 다음 화로 넘어갑니다. Enter 키로 메뉴를 엽니다."
            : touch
              ? "화 끝에서 다음화로 바로 넘어갈 수 있습니다."
              : "←/→ 키로 이전화·다음화로, Enter 키로 메뉴를 엽니다."}
          <br />
          글자 크기·배경은 메뉴의 ‘보기 설정’에서 바꿀 수 있습니다.
        </p>
        <button ref={btn} type="button" className="min-h-12 rounded-full bg-white px-8 text-[15px] font-bold text-[#111318]" onClick={onClose}>
          알겠어요
        </button>
      </div>
    </div>
  );
}

/** 화면 밝기: a black overlay above everything (pointer events pass through) */
export function Dimmer({ brightness }: { brightness: number }) {
  const o = dimOpacity(brightness);
  if (o <= 0) return null;
  return <div className="rv-dimmer" style={{ opacity: o }} aria-hidden="true" />;
}
