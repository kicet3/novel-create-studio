/**
 * 읽기(reader) — pure model: TOC grouping/filter, reading-text blocks, reader settings and resume position
 * (localStorage, injectable for tests), scroll progress.
 */
import { READER_SCENE_BREAK, type ReaderMode, type ReaderTocDto, type ReaderTocEpisodeDto } from "@ncs/shared";

// ── settings ────────────────────────────────────────────────────────────
/** 페이지 넘김 (default: pages of about N characters, flipped sideways) / 스크롤 보기 (vertical, continuous) */
export const READER_VIEWS = ["page", "scroll"] as const;
export type ReaderView = (typeof READER_VIEWS)[number];
export const READER_VIEW_LABELS: Record<ReaderView, string> = { scroll: "스크롤 보기", page: "페이지 넘김" };

/** 페이지 넘김: characters per page (a page that would overflow the screen is cut shorter) */
export const READER_PAGE_CHARS = ["few", "normal", "many"] as const;
export type ReaderPageChars = (typeof READER_PAGE_CHARS)[number];
export const READER_PAGE_CHARS_LABELS: Record<ReaderPageChars, string> = { few: "적게", normal: "보통", many: "많이" };
export const READER_PAGE_CHAR_COUNT: Record<ReaderPageChars, number> = { few: 400, normal: 700, many: 1000 };

/** 글자 크기 slider steps (px) */
export const READER_FONT_STEPS_PX = [14, 15, 16, 17, 18, 19, 20, 22, 24, 27] as const;
export const DEFAULT_FONT_STEP = 4;
export const fontPxOf = (step: number) => READER_FONT_STEPS_PX[clampStep(step)]!;
const clampStep = (n: number) => Math.min(READER_FONT_STEPS_PX.length - 1, Math.max(0, Math.round(Number.isFinite(n) ? n : DEFAULT_FONT_STEP)));
export function stepFont(step: number, delta: number): number {
  return clampStep(step + delta);
}

export const READER_FONTS = ["gothic", "myeongjo", "system"] as const;
export type ReaderFont = (typeof READER_FONTS)[number];
export const READER_FONT_LABELS: Record<ReaderFont, string> = { gothic: "고딕", myeongjo: "명조", system: "시스템" };

export const READER_STEPS3 = ["narrow", "normal", "wide"] as const;
export type ReaderStep3 = (typeof READER_STEPS3)[number];
export const READER_STEP3_LABELS: Record<ReaderStep3, string> = { narrow: "좁게", normal: "보통", wide: "넓게" };
/** 줄 간격 (line-height) */
export const READER_LINE_HEIGHT: Record<ReaderStep3, number> = { narrow: 1.6, normal: 1.85, wide: 2.1 };
/** 문단 간격 (em after each paragraph) */
export const READER_PARA_SPACING_EM: Record<ReaderStep3, number> = { narrow: 0.35, normal: 0.9, wide: 1.55 };
/** 좌우 여백: side padding (px, phones) and column max width (em, wide screens) */
export const READER_MARGIN_PX: Record<ReaderStep3, number> = { narrow: 14, normal: 22, wide: 34 };
export const READER_MAX_EM: Record<ReaderStep3, number> = { narrow: 42, normal: 35, wide: 29 };

/** 배경 테마. "auto" = 흰색 / 검정 following the app theme or the OS */
export const READER_THEMES = ["auto", "white", "ivory", "gray", "green", "black"] as const;
export type ReaderTheme = (typeof READER_THEMES)[number];
export type ReaderSolidTheme = Exclude<ReaderTheme, "auto">;
export const READER_THEME_LABELS: Record<ReaderTheme, string> = { auto: "자동", white: "흰색", ivory: "아이보리", gray: "회색", green: "연녹색", black: "검정" };

export const READER_MODE_LABELS: Record<ReaderMode, string> = { approved: "승인된 화만", draft: "초안 포함" };

export const BRIGHTNESS_MIN = 0.3;

export interface ReaderSettings {
  view: ReaderView;
  /** 페이지 넘김: about how many characters one page holds */
  pageChars: ReaderPageChars;
  /** 스크롤 보기: append the next episode at the end (다음 화 이어 보기) */
  continuous: boolean;
  /** index into READER_FONT_STEPS_PX */
  fontStep: number;
  font: ReaderFont;
  lineHeight: ReaderStep3;
  paraSpacing: ReaderStep3;
  margin: ReaderStep3;
  theme: ReaderTheme;
  /** 문단 첫 줄 들여쓰기 */
  indent: boolean;
  /** 화면 밝기 0.3..1 (dimmer overlay; 1 = off) */
  brightness: number;
  /** 화면 꺼짐 방지 (Wake Lock API when available) */
  keepAwake: boolean;
  /** TOC filter / which text the reader opens */
  mode: ReaderMode;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  view: "page",
  pageChars: "normal",
  continuous: false,
  fontStep: DEFAULT_FONT_STEP,
  font: "gothic",
  lineHeight: "normal",
  paraSpacing: "normal",
  margin: "normal",
  theme: "auto",
  indent: false,
  brightness: 1,
  keepAwake: false,
  mode: "approved",
};
/** v2: 페이지 넘김 became the default (settings saved under the v1 key are migrated with view reset to "page") */
export const READER_SETTINGS_KEY = "ncs.reader.settings.v2";
export const LEGACY_READER_SETTINGS_KEY = "ncs.reader.settings";

/** minimal Storage subset (localStorage or a test double) */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const pick = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

// settings saved by the first reader version (fontSize / width / light·sepia·dark)
const LEGACY_FONT_STEP: Record<string, number> = { sm: 2, md: 4, lg: 6, xl: 7 };
const LEGACY_WIDTH_MARGIN: Record<string, ReaderStep3> = { narrow: "wide", normal: "normal", wide: "narrow" };
const LEGACY_THEME: Record<string, ReaderTheme> = { light: "white", sepia: "ivory", dark: "black" };

/** unknown JSON → valid settings (unknown / invalid fields fall back to defaults; v1 fields are migrated) */
export function parseReaderSettings(raw: string | null | undefined): ReaderSettings {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    /* corrupted → defaults */
  }
  const d = DEFAULT_READER_SETTINGS;
  const legacyStep = typeof o.fontSize === "string" ? LEGACY_FONT_STEP[o.fontSize] : undefined;
  const legacyMargin = typeof o.width === "string" ? LEGACY_WIDTH_MARGIN[o.width] : undefined;
  const theme = typeof o.theme === "string" && LEGACY_THEME[o.theme] ? LEGACY_THEME[o.theme]! : pick(READER_THEMES, o.theme, d.theme);
  return {
    view: pick(READER_VIEWS, o.view, d.view),
    pageChars: pick(READER_PAGE_CHARS, o.pageChars, d.pageChars),
    continuous: bool(o.continuous, d.continuous),
    fontStep: typeof o.fontStep === "number" ? clampStep(o.fontStep) : (legacyStep ?? d.fontStep),
    font: pick(READER_FONTS, o.font, d.font),
    lineHeight: pick(READER_STEPS3, o.lineHeight, d.lineHeight),
    paraSpacing: pick(READER_STEPS3, o.paraSpacing, d.paraSpacing),
    margin: pick(READER_STEPS3, o.margin, legacyMargin ?? d.margin),
    theme,
    indent: bool(o.indent, d.indent),
    brightness: typeof o.brightness === "number" && Number.isFinite(o.brightness) ? Math.min(1, Math.max(BRIGHTNESS_MIN, o.brightness)) : d.brightness,
    keepAwake: bool(o.keepAwake, d.keepAwake),
    mode: pick(["approved", "draft"] as const, o.mode, d.mode),
  };
}

export function loadReaderSettings(store: KeyValueStore | null): ReaderSettings {
  try {
    const raw = store?.getItem(READER_SETTINGS_KEY);
    if (raw == null) {
      // first run after 페이지 넘김 became the default: keep the old typography, switch the view
      const legacy = store?.getItem(LEGACY_READER_SETTINGS_KEY);
      if (legacy != null) return { ...parseReaderSettings(legacy), view: DEFAULT_READER_SETTINGS.view };
    }
    return parseReaderSettings(raw);
  } catch {
    return { ...DEFAULT_READER_SETTINGS };
  }
}

export function saveReaderSettings(store: KeyValueStore | null, s: ReaderSettings): void {
  try {
    store?.setItem(READER_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable: keep for this session only */
  }
}

/** "auto" follows the app theme (`data-theme` on <html>) or else the OS preference */
export function effectiveReaderTheme(theme: ReaderTheme, appTheme: string | null, prefersDark: boolean): ReaderSolidTheme {
  if (theme !== "auto") return theme;
  if (appTheme === "dark") return "black";
  if (appTheme === "light") return "white";
  return prefersDark ? "black" : "white";
}

/** settings that change the text layout (re-pagination / anchor restore when they change) */
export const typographyKey = (s: ReaderSettings) => [s.fontStep, s.font, s.lineHeight, s.paraSpacing, s.margin, s.indent ? 1 : 0].join("|");

/** opacity of the black 화면 밝기 overlay */
export const dimOpacity = (brightness: number) => Math.round((1 - Math.min(1, Math.max(BRIGHTNESS_MIN, brightness))) * 0.85 * 1000) / 1000;

// ── reading position ────────────────────────────────────────────────────
/**
 * position inside an episode, valid for both views: paragraph index (text paragraphs only — scene breaks and
 * illustrations do not count, so inserting images later keeps saved positions) + fraction (0..1) of its height
 */
export interface ReadingAnchor {
  para: number;
  offset: number;
}
export const START_ANCHOR: ReadingAnchor = { para: 0, offset: 0 };
export const isStartAnchor = (a: ReadingAnchor | null | undefined) => !a || (a.para <= 0 && a.offset <= 0);

function parseAnchor(v: unknown): ReadingAnchor | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // `{ block }` (block index incl. scene breaks, first viewer version) is not comparable → null (the ratio is used)
  if (typeof o.para !== "number" || !Number.isInteger(o.para) || o.para < 0) return null;
  return { para: o.para, offset: clamp01(typeof o.offset === "number" ? o.offset : 0) };
}

// ── resume ("이어 읽기") ─────────────────────────────────────────────────
export interface ReaderResume {
  episodeNo: number;
  mode: ReaderMode;
  /** progress 0..1 within the episode (display only) */
  ratio: number;
  /** exact position (null: saved by an older version → fall back to ratio) */
  anchor: ReadingAnchor | null;
  /** epoch ms */
  at: number;
}

export const resumeKey = (novelId: string) => `ncs.reader.resume.${novelId}`;

export function loadResume(store: KeyValueStore | null, novelId: string): ReaderResume | null {
  try {
    const v: unknown = JSON.parse(store?.getItem(resumeKey(novelId)) ?? "null");
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.episodeNo !== "number" || !Number.isInteger(o.episodeNo) || o.episodeNo < 1) return null;
    return {
      episodeNo: o.episodeNo,
      mode: o.mode === "draft" ? "draft" : "approved",
      ratio: clamp01(typeof o.ratio === "number" ? o.ratio : 0),
      anchor: parseAnchor(o.anchor),
      at: typeof o.at === "number" ? o.at : 0,
    };
  } catch {
    return null;
  }
}

const round4 = (n: number) => Math.round(clamp01(n) * 10_000) / 10_000;

export function saveResume(store: KeyValueStore | null, novelId: string, r: ReaderResume): void {
  try {
    const anchor = r.anchor ? { para: Math.max(0, Math.floor(r.anchor.para)), offset: round4(r.anchor.offset) } : null;
    store?.setItem(resumeKey(novelId), JSON.stringify({ ...r, ratio: round4(r.ratio), anchor }));
  } catch {
    /* ignore */
  }
}

/** where an episode opens: the saved position when it belongs to this episode + text mode and is not finished */
export function resumeAnchorFor(resume: ReaderResume | null, episodeNo: number, mode: ReaderMode, explicit: boolean): ReadingAnchor | "ratio" | null {
  if (!resume || resume.episodeNo !== episodeNo || resume.mode !== mode) return null;
  if (!explicit && resume.ratio >= FINISHED_RATIO) return null;
  if (resume.anchor) return resume.anchor;
  return resume.ratio > 0 ? "ratio" : null;
}

// ── read history (읽음 표시, per device) ─────────────────────────────────
export type ReadState = "open" | "read";
export type ReadHistory = Readonly<Record<number, ReadState>>;
export const historyKey = (novelId: string) => `ncs.reader.history.${novelId}`;
export const FINISHED_RATIO = 0.97;
const HISTORY_MAX = 5000;

export function parseHistory(raw: string | null | undefined): ReadHistory {
  const out: Record<number, ReadState> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      const no = Number(k);
      if (Number.isInteger(no) && no >= 1 && (s === "open" || s === "read")) out[no] = s;
    }
  } catch {
    /* corrupted → empty */
  }
  return out;
}

/** a read episode stays read (re-opening it does not downgrade it); unchanged input is returned as is */
export function markHistory(h: ReadHistory, episodeNo: number, state: ReadState): ReadHistory {
  if (h[episodeNo] === state || (h[episodeNo] === "read" && state === "open")) return h;
  const next: Record<number, ReadState> = { ...h, [episodeNo]: state };
  const keys = Object.keys(next);
  if (keys.length > HISTORY_MAX) for (const k of keys.slice(0, keys.length - HISTORY_MAX)) delete next[Number(k)];
  return next;
}

export function loadHistory(store: KeyValueStore | null, novelId: string): ReadHistory {
  try {
    return parseHistory(store?.getItem(historyKey(novelId)));
  } catch {
    return {};
  }
}

export function saveHistory(store: KeyValueStore | null, novelId: string, h: ReadHistory): void {
  try {
    store?.setItem(historyKey(novelId), JSON.stringify(h));
  } catch {
    /* ignore */
  }
}

// ── first-time hint ─────────────────────────────────────────────────────
export const hintKey = (view: ReaderView) => `ncs.reader.hint.${view}`;
export function hintSeen(store: KeyValueStore | null, view: ReaderView): boolean {
  try {
    return store ? store.getItem(hintKey(view)) === "1" : true;
  } catch {
    return true;
  }
}
export function markHintSeen(store: KeyValueStore | null, view: ReaderView): void {
  try {
    store?.setItem(hintKey(view), "1");
  } catch {
    /* ignore */
  }
}

// ── progress ────────────────────────────────────────────────────────────
export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 0..1 of the scrollable distance; a page that fits the viewport counts as fully read */
export function scrollProgress(scrollTop: number, scrollHeight: number, viewportHeight: number): number {
  const max = scrollHeight - viewportHeight;
  if (max <= 0) return 1;
  return clamp01(scrollTop / max);
}

/** scrollTop that restores a saved ratio */
export function scrollTopFor(ratio: number, scrollHeight: number, viewportHeight: number): number {
  return Math.round(clamp01(ratio) * Math.max(0, scrollHeight - viewportHeight));
}

/** header visibility on scroll: hide when scrolling down past the header, show when scrolling up or near the top */
export function headerVisible(prevTop: number, top: number, wasVisible: boolean, threshold = 64): boolean {
  if (top <= threshold) return true;
  const delta = top - prevTop;
  if (Math.abs(delta) < 6) return wasVisible;
  return delta < 0;
}

// ── reading text ────────────────────────────────────────────────────────
/**
 * What the viewer renders, in order. Paragraphs are the anchor targets (`data-p` = paragraph index);
 * `image` is the extension point for mid-episode illustrations (not produced by the server yet):
 * place them with `insertBlocks` and hand the result to the views through their `blocksOf` prop.
 */
export type ReadingBlock =
  | { type: "p"; text: string }
  | { type: "break" }
  | { type: "image"; src: string; alt: string; caption?: string | null; width?: number | null; height?: number | null };

/** one non-empty line = one paragraph; a `* * *` line = scene break (merged, never first/last) */
export function readingBlocks(text: string): ReadingBlock[] {
  const out: ReadingBlock[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === READER_SCENE_BREAK) {
      if (out.length && out[out.length - 1]!.type !== "break") out.push({ type: "break" });
      continue;
    }
    out.push({ type: "p", text: line });
  }
  while (out.length && out[out.length - 1]!.type === "break") out.pop();
  return out;
}

/** paragraph index of each block (the anchor unit, `data-p`); null for scene breaks / images */
export function paragraphIndexes(blocks: readonly ReadingBlock[]): Array<number | null> {
  let n = 0;
  return blocks.map((b) => (b.type === "p" ? n++ : null));
}

/** what a view renders for an episode; the default is the text alone (illustrations: wrap with `insertBlocks`) */
export type BlocksOf = (ep: { text: string }) => ReadingBlock[];
export const textBlocks: BlocksOf = (ep) => readingBlocks(ep.text);

/** insert blocks (e.g. illustrations) after the n-th paragraph (0 = before the first one; past the end = appended) */
export function insertBlocks(blocks: readonly ReadingBlock[], inserts: ReadonlyArray<{ afterParagraph: number; block: ReadingBlock }>): ReadingBlock[] {
  if (!inserts.length) return [...blocks];
  const sorted = [...inserts].sort((a, b) => a.afterParagraph - b.afterParagraph);
  const out: ReadingBlock[] = [];
  let k = 0;
  let paragraphs = 0;
  const flush = () => {
    while (k < sorted.length && sorted[k]!.afterParagraph <= paragraphs) out.push(sorted[k++]!.block);
  };
  flush();
  for (const b of blocks) {
    out.push(b);
    if (b.type === "p") {
      paragraphs++;
      flush();
    }
  }
  while (k < sorted.length) out.push(sorted[k++]!.block);
  return out;
}

// ── TOC ─────────────────────────────────────────────────────────────────
export type TocRowKind = "published" | "approved" | "draft";

export interface TocRow {
  episodeNo: number;
  title: string | null;
  status: ReaderTocEpisodeDto["status"];
  /** what the reader opens in the current mode */
  kind: TocRowKind;
  charCount: number;
}

/** an episode as listed in a mode (null = hidden: nothing readable in that mode) */
export function tocRow(e: ReaderTocEpisodeDto, mode: ReaderMode): TocRow | null {
  if (mode === "draft" && e.draft) return { episodeNo: e.episodeNo, title: e.title, status: e.status, kind: "draft", charCount: e.draft.charCount };
  if (e.approved) return { episodeNo: e.episodeNo, title: e.title, status: e.status, kind: e.approved.source, charCount: e.approved.charCount };
  return null;
}

export interface TocPlotGroup {
  plot: { id: string; ord: number; title: string } | null;
  rows: TocRow[];
}
export interface TocPartGroup {
  part: { id: string; ord: number; title: string } | null;
  plots: TocPlotGroup[];
}

/**
 * 부 → 플롯 → 화. Without parts the plots are the top level (one part group with `part: null`);
 * with ≤ 1 plot and no parts the list is flat (one group, `plot: null`). Empty groups are dropped.
 */
export function groupToc(toc: Pick<ReaderTocDto, "parts" | "plots" | "episodes">, mode: ReaderMode): TocPartGroup[] {
  const rowsByArc = new Map<string, TocRow[]>();
  const rows: Array<{ arcId: string; row: TocRow }> = [];
  for (const e of [...toc.episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
    const row = tocRow(e, mode);
    if (!row) continue;
    rows.push({ arcId: e.arcId, row });
    rowsByArc.set(e.arcId, [...(rowsByArc.get(e.arcId) ?? []), row]);
  }
  if (!rows.length) return [];
  const plots = [...toc.plots].sort((a, b) => a.ord - b.ord);
  if (!toc.parts.length && plots.length <= 1) return [{ part: null, plots: [{ plot: null, rows: rows.map((r) => r.row) }] }];

  const plotIds = new Set(plots.map((p) => p.id));
  const orphanRows = rows.filter((r) => !plotIds.has(r.arcId)).map((r) => r.row);
  const plotGroup = (p: (typeof plots)[number]): TocPlotGroup => ({ plot: { id: p.id, ord: p.ord, title: p.title }, rows: rowsByArc.get(p.id) ?? [] });
  const nonEmpty = (gs: TocPlotGroup[]) => gs.filter((g) => g.rows.length);
  const out: TocPartGroup[] = [];
  const partIds = new Set(toc.parts.map((p) => p.id));
  for (const part of [...toc.parts].sort((a, b) => a.ord - b.ord)) {
    const gs = nonEmpty(plots.filter((p) => p.partId === part.id).map(plotGroup));
    if (gs.length) out.push({ part: { id: part.id, ord: part.ord, title: part.title }, plots: gs });
  }
  const rest = nonEmpty(plots.filter((p) => !p.partId || !partIds.has(p.partId)).map(plotGroup));
  if (orphanRows.length) rest.push({ plot: null, rows: orphanRows });
  if (rest.length) out.push({ part: null, plots: rest });
  return out;
}

/** readable episode numbers in order (jump select, first episode) */
export function readableEpisodes(toc: Pick<ReaderTocDto, "episodes">, mode: ReaderMode): TocRow[] {
  return toc.episodes
    .map((e) => tocRow(e, mode))
    .filter((r): r is TocRow => !!r)
    .sort((a, b) => a.episodeNo - b.episodeNo);
}

export const episodeLabel = (no: number, title: string | null | undefined) => (title?.trim() ? `${no}화 · ${title.trim()}` : `${no}화`);

/** "1부 · 각성" (titles may already start with "1부") */
export function partLabel(part: { ord: number; title: string }): string {
  const t = part.title.trim();
  return !t ? `${part.ord}부` : /^\d+\s*부/.test(t) ? t : `${part.ord}부 · ${t}`;
}

/** reading time at ~500 Korean chars / minute */
export const readingMinutes = (chars: number) => Math.max(1, Math.round(chars / 500));

/** unreadable episodes jumped over by 이전화/다음화: "4화", "4·6화", "4–7화" (3개 이상 연속), "4·6·9화 등 5개 화"; null when none */
export function skippedLabel(nos: readonly number[] | undefined): string | null {
  if (!nos?.length) return null;
  const sorted = [...nos].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  if (sorted.length > 2 && contiguous) return `${sorted[0]}–${sorted[sorted.length - 1]}화`;
  if (sorted.length > 3) return `${sorted.slice(0, 3).join("·")}화 등 ${sorted.length}개 화`;
  return `${sorted.join("·")}화`;
}
