/**
 * 설계 추가 0023: 에피소드 묶음 제목. A story episode (에피소드 묶음) spans consecutive 화 of a plot; each 화 shows
 * "<묶음 제목> (n)" — the part number is omitted when the 묶음 has a single 화.
 */

/** 제목 방식: unit = 에피소드 묶음 "제목 (1)(2)", per_episode = 화마다 새 제목(이전 방식) */
export const EPISODE_TITLE_MODES = ["unit", "per_episode"] as const;
export type EpisodeTitleMode = (typeof EPISODE_TITLE_MODES)[number];

export const EPISODE_TITLE_MODE_LABELS: Record<EpisodeTitleMode, string> = {
  unit: "에피소드 묶음 (1)(2)",
  per_episode: "화별 제목",
};

export const EPISODE_UNIT_TITLE_MAX = 60;

const OPEN_QUOTES = "「『\"'“‘《〈[";
const CLOSE_OF: Record<string, string> = { "「": "」", "『": "』", '"': '"', "'": "'", "“": "”", "‘": "’", "《": "》", "〈": "〉", "[": "]" };
const QUOTE_CHARS = /[「」『』"'“”‘’《》〈〉[\]]/u;

/** strips one matching pair of quotes / brackets that wraps the whole title (and only when no other quote sits inside) */
function stripWrappingQuotes(s: string): string {
  const open = s[0];
  if (!open || !OPEN_QUOTES.includes(open) || s.length < 3) return s;
  if (s[s.length - 1] !== CLOSE_OF[open]) return s;
  const inner = s.slice(1, -1);
  return QUOTE_CHARS.test(inner) ? s : inner.trim();
}

/** a unit title as typed by a model or the author: trimmed, no trailing "(2)" / "제2화" / "- 2" part marker, bounded */
export function cleanUnitTitle(raw: string | null | undefined): string {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  s = stripWrappingQuotes(s);
  // trailing part markers: "(2)", "（2）", "- 2화", ": 2화", "제2화", "- 2", "#2", "part 2" — a bare "100화" stays (it can be the title)
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/\s*[(（]\s*\d{1,3}\s*[)）]\s*$/u, "")
      .replace(/\s*(?:[-–—:#]\s*(?:제\s*)?|제\s*)\d{1,3}\s*화\s*$/u, "")
      .replace(/\s*[-–—#]\s*\d{1,3}\s*$/u, "")
      .replace(/\s+part\s*\d{1,3}\s*$/iu, "")
      .trim();
    if (next === s || !next) break;
    s = next;
  }
  if (s.length > EPISODE_UNIT_TITLE_MAX) s = s.slice(0, EPISODE_UNIT_TITLE_MAX).trim();
  return s;
}

/** display title of a 화 in a story episode: "제목 (n)", or the bare title when the 묶음 has one 화 */
export function formatUnitEpisodeTitle(unitTitle: string, partNo: number, partCount: number): string {
  const t = cleanUnitTitle(unitTitle) || unitTitle.trim();
  return partCount > 1 ? `${t} (${partNo})` : t;
}

// ── story-episode assignment (shared by the server and the studio's 제목 정리 preview) ──

export interface StoryEpisodeGroupInput {
  title: string;
  from: number;
  to: number;
}

export interface GroupingEpisodeState {
  episodeNo: number;
  title: string | null;
  /** may the title be rewritten (plan: planned 화; 제목 정리: not published, or a published 화 the author picked) */
  renameable: boolean;
}

/** one unit to create: a story episode, or the part of it left after 화 that keep their title split it */
export interface StoryEpisodeSegment {
  title: string;
  from: number;
  to: number;
  /** 1-based order in the plot */
  ord: number;
  episodeNos: number[];
}

export type StoryEpisodeSlot =
  | { kind: "member"; segment: number; title: string; unitTitle: string; partNo: number; partCount: number; rename: boolean }
  /** keeps its title and its current 묶음 (a written / published 화 whose title does not fit its place in the new 묶음) */
  | { kind: "pinned" };

/** does a 화 that keeps its title fit part `partNo` of 묶음 `unitTitle` ("X", "X (1)" at part 1; "X (n)" at part n) */
export function titleFitsPart(title: string | null, unitTitle: string, partNo: number): boolean {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t || cleanUnitTitle(t) !== cleanUnitTitle(unitTitle)) return false;
  const m = /[(（]\s*(\d{1,3})\s*[)）]\s*$/u.exec(t);
  return m ? Number(m[1]) === partNo : partNo === 1;
}

/**
 * maps every 화 of the groups to its 묶음 and part number. A 화 that may not be renamed stays in the 묶음 only when its
 * current title already fits its place; otherwise it keeps its current 묶음 (pinned) and splits the group, so the
 * renamed 화 around it are numbered from (1) again — readers never see a "(2)" without a "(1)".
 * 화 numbers of a group with no state (not created yet) count as renameable.
 */
export function assignStoryEpisodes(
  groups: readonly StoryEpisodeGroupInput[],
  episodes: readonly GroupingEpisodeState[],
): { segments: StoryEpisodeSegment[]; slots: Map<number, StoryEpisodeSlot> } {
  const byNo = new Map(episodes.map((e) => [e.episodeNo, e]));
  const segments: StoryEpisodeSegment[] = [];
  const slots = new Map<number, StoryEpisodeSlot>();
  const pending: Array<{ no: number; segment: number }> = [];
  for (const g of [...groups].sort((a, b) => a.from - b.from)) {
    let cur: StoryEpisodeSegment | null = null;
    for (let no = g.from; no <= g.to; no++) {
      const e = byNo.get(no);
      const pos = (cur?.episodeNos.length ?? 0) + 1;
      const member = !e || e.renameable || titleFitsPart(e.title, g.title, pos);
      if (!member) {
        slots.set(no, { kind: "pinned" });
        cur = null;
        continue;
      }
      if (!cur) {
        cur = { title: g.title, from: no, to: no, ord: segments.length + 1, episodeNos: [] };
        segments.push(cur);
      }
      cur.episodeNos.push(no);
      cur.to = no;
      pending.push({ no, segment: segments.length - 1 });
    }
  }
  for (const { no, segment } of pending) {
    const seg = segments[segment]!;
    const partNo = seg.episodeNos.indexOf(no) + 1;
    const partCount = seg.episodeNos.length;
    const e = byNo.get(no);
    const fits = !!e && !e.renameable;
    const title = fits ? (e!.title ?? "") : formatUnitEpisodeTitle(seg.title, partNo, partCount);
    slots.set(no, { kind: "member", segment, title, unitTitle: seg.title, partNo, partCount, rename: !!e && e.renameable && e.title !== title });
  }
  return { segments, slots };
}

export interface RetitleEpisodeState<S extends string = string> {
  episodeNo: number;
  status: S;
  title: string | null;
}

export interface RetitlePlanItemView<S extends string = string> {
  episodeNo: number;
  status: S;
  before: string | null;
  /** title after the apply; for a published 화 that is kept: the title it would get when the author includes it */
  after: string;
  unitTitle: string | null;
  unitPartNo: number | null;
  unitPartCount: number | null;
  published: boolean;
  /** renamed by this apply */
  willRename: boolean;
  unchanged: boolean;
  /** a published 화 that keeps its title and stays out of the new 묶음 (the 묶음 restarts at (1) after it) */
  excluded: boolean;
}

/**
 * before → after of a 제목 정리: published 화 keep their title unless listed in `includePublished` (author's explicit
 * choice); a kept one that does not fit the new 묶음 is left out of it.
 */
export function planRetitle<S extends string>(
  groups: readonly StoryEpisodeGroupInput[],
  episodes: readonly RetitleEpisodeState<S>[],
  includePublished: ReadonlySet<number> = new Set(),
): RetitlePlanItemView<S>[] {
  const states = (inc: ReadonlySet<number>) => episodes.map((e) => ({ episodeNo: e.episodeNo, title: e.title, renameable: e.status !== "published" || inc.has(e.episodeNo) }));
  const { slots } = assignStoryEpisodes(groups, states(includePublished));
  const items: RetitlePlanItemView<S>[] = [];
  for (const e of [...episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
    const slot = slots.get(e.episodeNo);
    if (!slot) continue;
    const published = e.status === "published";
    if (slot.kind === "member") {
      items.push({
        episodeNo: e.episodeNo,
        status: e.status,
        before: e.title,
        after: slot.title,
        unitTitle: slot.unitTitle,
        unitPartNo: slot.partNo,
        unitPartCount: slot.partCount,
        published,
        willRename: slot.rename,
        unchanged: (e.title ?? "") === slot.title,
        excluded: false,
      });
      continue;
    }
    const alt = assignStoryEpisodes(groups, states(new Set([...includePublished, e.episodeNo]))).slots.get(e.episodeNo);
    items.push({
      episodeNo: e.episodeNo,
      status: e.status,
      before: e.title,
      after: alt?.kind === "member" ? alt.title : (e.title ?? ""),
      unitTitle: null,
      unitPartNo: null,
      unitPartCount: null,
      published,
      willRename: false,
      unchanged: false,
      excluded: true,
    });
  }
  return items;
}
