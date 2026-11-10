/**
 * 설계 추가 0023: 에피소드 묶음 (story episodes) — pure.
 * A plot's 화 range is split into consecutive groups (usually 2–5 화, 1 for a standalone event) that share one title;
 * each 화 shows "<묶음 제목> (n)" (bare title for a single-화 묶음). Planner / retitle outputs are checked here
 * (contiguous coverage, no gaps / overlaps — repair dialogue) and normalized deterministically when still broken.
 */
import { cleanUnitTitle, formatUnitEpisodeTitle, titleFitsPart } from "@ncs/shared";
import type { RepairIssueDto } from "@ncs/shared";

export interface StoryEpisodeDraft {
  title: string;
  from: number;
  to: number;
}

export interface StoryEpisodeGroup extends StoryEpisodeDraft {
  /** 1-based order inside the plot */
  ord: number;
}

/** the usual upper bound of a 묶음 (longer ones are allowed for the author, flagged for the planner) */
export const STORY_EPISODE_MAX_PARTS = 8;

/** validator issues of a planner / retitle answer (empty = accepted): coverage of [from, to] without gaps or overlaps */
export function storyEpisodeIssues(raw: readonly StoryEpisodeDraft[], from: number, to: number): RepairIssueDto[] {
  const issues: RepairIssueDto[] = [];
  if (!raw.length) {
    issues.push({ item: "story_episodes", problem: `비어 있습니다. ${from}~${to}화를 빠짐없이 연속된 에피소드 묶음으로 나누세요.` });
    return issues;
  }
  const sorted = [...raw].sort((a, b) => a.from - b.from || a.to - b.to);
  let expect = from;
  for (const [i, u] of sorted.entries()) {
    const label = `story_episodes[${i}] 「${u.title || "(제목 없음)"}」 ${u.from}~${u.to}화`;
    if (!cleanUnitTitle(u.title)) issues.push({ item: label, problem: "묶음 제목이 비어 있습니다." });
    if (!Number.isInteger(u.from) || !Number.isInteger(u.to) || u.to < u.from) {
      issues.push({ item: label, problem: "from은 to 이하의 화 번호여야 합니다." });
      continue;
    }
    if (u.from < from || u.to > to) issues.push({ item: label, problem: `플롯 범위(${from}~${to}화)를 벗어납니다.` });
    if (u.from > expect) issues.push({ item: label, problem: `${expect}~${u.from - 1}화가 어느 묶음에도 들어 있지 않습니다(빈틈).` });
    if (u.from < expect) issues.push({ item: label, problem: `${u.from}~${Math.min(u.to, expect - 1)}화가 앞 묶음과 겹칩니다.` });
    if (u.to - u.from + 1 > STORY_EPISODE_MAX_PARTS) issues.push({ item: label, problem: `한 묶음이 ${u.to - u.from + 1}화로 너무 깁니다(보통 2~5화, 최대 ${STORY_EPISODE_MAX_PARTS}화).` });
    expect = Math.max(expect, u.to + 1);
  }
  if (expect <= to) issues.push({ item: "story_episodes", problem: `${expect}~${to}화가 어느 묶음에도 들어 있지 않습니다(빈틈).` });
  // 화마다 묶음 하나 = 예전 화별 제목과 같음: 범위가 4화 이상인데 1화짜리 묶음이 절반을 넘으면 다시 묶게 한다
  const singles = sorted.filter((u) => u.from === u.to && u.from >= from && u.to <= to).length;
  if (to - from + 1 >= 4 && singles * 2 > sorted.length) {
    issues.push({ item: "story_episodes", problem: `1화짜리 묶음이 너무 많습니다(${sorted.length}개 중 ${singles}개). 같은 사건·장소·목표가 이어지는 화는 보통 2~5화로 묶으세요.` });
  }
  return issues;
}

/**
 * always-valid groups covering [from, to] contiguously: clipped to the range, overlaps cut, gaps joined to the previous
 * group (or a new group titled by `fallbackTitle`), empty titles filled. Without usable groups: consecutive 화 with the
 * same per-episode title are grouped, otherwise each 화 is its own group (old behaviour, titles unchanged).
 */
export function normalizeStoryEpisodes(
  raw: readonly StoryEpisodeDraft[],
  from: number,
  to: number,
  fallback: { titleOf: (episodeNo: number) => string | null; plotTitle: string },
): StoryEpisodeGroup[] {
  const groups: StoryEpisodeDraft[] = [];
  const clipped = raw
    .filter((u) => Number.isInteger(u.from) && Number.isInteger(u.to))
    .map((u) => ({ title: cleanUnitTitle(u.title), from: Math.max(from, Math.min(u.from, u.to)), to: Math.min(to, Math.max(u.from, u.to)) }))
    .filter((u) => u.from <= u.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  let next = from;
  for (const u of clipped) {
    const start = Math.max(u.from, next);
    if (start > u.to) continue; // fully overlapped
    if (start > next) {
      // gap: the previous group continues (or a group of its own at the very start)
      const prev = groups[groups.length - 1];
      if (prev) prev.to = start - 1;
      else groups.push({ title: "", from: next, to: start - 1 });
    }
    groups.push({ title: u.title, from: start, to: u.to });
    next = u.to + 1;
  }
  if (!groups.length) return fallbackGroups(from, to, fallback);
  if (next <= to) groups[groups.length - 1]!.to = to;
  return groups.map((g, i) => ({ ...g, title: g.title || cleanUnitTitle(fallback.titleOf(g.from)) || cleanUnitTitle(fallback.plotTitle) || `${g.from}화`, ord: i + 1 }));
}

function fallbackGroups(from: number, to: number, fallback: { titleOf: (episodeNo: number) => string | null; plotTitle: string }): StoryEpisodeGroup[] {
  const out: StoryEpisodeGroup[] = [];
  for (let no = from; no <= to; no++) {
    const title = cleanUnitTitle(fallback.titleOf(no)) || `${no}화`;
    const last = out[out.length - 1];
    if (last && last.title === title && last.to === no - 1 && last.to - last.from + 1 < STORY_EPISODE_MAX_PARTS) last.to = no;
    else out.push({ title, from: no, to: no, ord: out.length + 1 });
  }
  return out;
}

/** display title of every 화 of the groups (episode no → title / part) */
export function titlesOfGroups(groups: readonly StoryEpisodeGroup[]): Map<number, { title: string; unitTitle: string; partNo: number; partCount: number; ord: number }> {
  const out = new Map<number, { title: string; unitTitle: string; partNo: number; partCount: number; ord: number }>();
  for (const g of groups) {
    const count = g.to - g.from + 1;
    for (let no = g.from; no <= g.to; no++) {
      const partNo = no - g.from + 1;
      out.set(no, { title: formatUnitEpisodeTitle(g.title, partNo, count), unitTitle: g.title, partNo, partCount: count, ord: g.ord });
    }
  }
  return out;
}

export { assignStoryEpisodes, planRetitle, titleFitsPart, type RetitleEpisodeState, type RetitlePlanItemView as RetitlePlanItem, type StoryEpisodeSlot, type StoryEpisodeSegment } from "@ncs/shared";

/**
 * re-plan in the 묶음 title mode: 화 already written (not planned) keep their title, so the planner must keep each of
 * them at its current place in a 묶음 of the same title ("A (2)" stays the 2nd 화 of 「A」).
 */
export function pinnedGroupIssues(raw: readonly StoryEpisodeDraft[], written: ReadonlyArray<{ episodeNo: number; title: string | null }>): RepairIssueDto[] {
  const issues: RepairIssueDto[] = [];
  for (const w of written) {
    const g = raw.find((u) => u.from <= w.episodeNo && w.episodeNo <= u.to);
    if (!g) continue; // coverage is reported by storyEpisodeIssues
    if (!titleFitsPart(w.title, g.title, w.episodeNo - g.from + 1)) {
      issues.push({
        item: `story_episodes 「${g.title || "(제목 없음)"}」 ${g.from}~${g.to}화`,
        problem: `${w.episodeNo}화는 이미 쓴 화라 제목 「${w.title ?? ""}」을 바꿀 수 없습니다. 그 화가 지금 묶음(같은 제목, 같은 몇 번째 화)에 그대로 있도록 나누고, 계획 화만 이어 붙이거나 새 묶음으로 나누세요.`,
      });
    }
  }
  return issues;
}
