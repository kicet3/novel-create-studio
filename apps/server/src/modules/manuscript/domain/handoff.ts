/**
 * 설계 추가 0019: how one episode hands over to the next. Pure — no I/O.
 *
 * - `endTail`: the end of an episode's text for the next episode's `recent_text` (the last scene, bounded to
 *   END_TAIL_MAX chars and never shorter than END_TAIL_MIN chars when the text is long enough).
 * - `EpisodeHandoff` + 3–5 summary lines: produced once per episode version by `summarize_episode`
 *   (continuity_editor), stored in episode_recaps (layer canon).
 * - `handoffText` / `storySoFarText`: the context sections "직전 화 끝 상태" and "지금까지의 줄거리"
 *   (recent episodes in detail, older ones compressed to their first line, bounded).
 */
import { z } from "zod";

export const END_TAIL_MAX = 2000;
export const END_TAIL_MIN = 1200;

/** end of an episode text: the last scene [start, end), widened to END_TAIL_MIN and cut to END_TAIL_MAX chars */
export function endTail(content: string, lastScene?: { charStart: number; charEnd: number } | null): string {
  const end = lastScene ? Math.min(content.length, Math.max(lastScene.charEnd, 0)) : content.length;
  let start = lastScene ? Math.max(0, lastScene.charStart) : Math.max(0, end - END_TAIL_MAX);
  start = Math.min(start, Math.max(0, end - END_TAIL_MIN));
  if (end - start > END_TAIL_MAX) {
    start = end - END_TAIL_MAX;
    // start at a paragraph / line boundary when one is close (no half sentence at the top)
    const nl = content.indexOf("\n", start);
    if (nl >= 0 && nl < start + 200 && end - (nl + 1) >= END_TAIL_MIN) start = nl + 1;
  }
  return content.slice(start, end).trim();
}

/** last non-empty line of a text (scene separators skipped), clipped */
export function lastLineOf(content: string, max = 200): string {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[*\-=\s]+$/.test(l));
  const last = lines.at(-1) ?? "";
  return last.length > max ? `…${last.slice(-max)}` : last;
}

export const episodeHandoffSchema = z.object({
  /** where the last scene takes place */
  place: z.string().max(300),
  /** when (time of day / relative time) */
  time: z.string().max(300),
  /** who is present at the end */
  present: z.array(z.string().max(200)).max(12),
  physical_state: z.string().max(600),
  emotional_state: z.string().max(600),
  /** unfinished action / cliffhanger the next episode must pick up */
  open_hook: z.string().max(600),
  /** last line of the episode (verbatim) */
  last_line: z.string().max(600),
});
export type EpisodeHandoff = z.infer<typeof episodeHandoffSchema>;

export const episodeRecapProposalSchema = z.object({
  handoff: episodeHandoffSchema,
  /** 3–5 lines of what happened in the episode */
  summary_lines: z.array(z.string().max(400)).max(8),
});
export type EpisodeRecapProposal = z.infer<typeof episodeRecapProposalSchema>;

const squash = (s: string) => s.replace(/\s+/g, "");

/** deterministic check of a summarize_episode answer (repair dialogue) */
export function validateRecap(p: EpisodeRecapProposal, content: string): Array<{ item: string; problem: string; excerpt?: string }> {
  const issues: Array<{ item: string; problem: string; excerpt?: string }> = [];
  const lines = p.summary_lines.map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 5) issues.push({ item: "summary_lines", problem: `줄거리는 3~5줄이어야 합니다(지금 ${lines.length}줄).` });
  for (const k of ["place", "time", "open_hook"] as const) {
    if (!p.handoff[k].trim()) issues.push({ item: `handoff.${k}`, problem: "비어 있습니다. 원고 마지막 장면에서 찾아 적으세요." });
  }
  if (!p.handoff.present.some((x) => x.trim())) issues.push({ item: "handoff.present", problem: "마지막 장면에 있는 인물을 1명 이상 적으세요." });
  const ll = squash(p.handoff.last_line.replace(/^…/, ""));
  if (ll && !squash(content).includes(ll)) issues.push({ item: "handoff.last_line", problem: "원고에 없는 문장입니다. 마지막 문장을 원문 그대로 옮기세요.", excerpt: lastLineOf(content) });
  return issues;
}

/** keep what is usable after the repair rounds (never fails a cheap summary over formatting) */
export function normalizeRecap(p: EpisodeRecapProposal, content: string): EpisodeRecapProposal {
  const lines = p.summary_lines.map((l) => l.trim()).filter(Boolean).slice(0, 5);
  const ll = squash(p.handoff.last_line.replace(/^…/, ""));
  const lastLine = ll && squash(content).includes(ll) ? p.handoff.last_line.trim() : lastLineOf(content);
  return {
    summary_lines: lines,
    handoff: {
      place: p.handoff.place.trim(),
      time: p.handoff.time.trim(),
      present: p.handoff.present.map((x) => x.trim()).filter(Boolean),
      physical_state: p.handoff.physical_state.trim(),
      emotional_state: p.handoff.emotional_state.trim(),
      open_hook: p.handoff.open_hook.trim(),
      last_line: lastLine,
    },
  };
}

/** the "직전 화 끝 상태" section text */
export function handoffText(episodeNo: number, h: EpisodeHandoff, opts: { stale?: boolean } = {}): string {
  const lines = [
    `${episodeNo}화가 끝난 상태 — 이번 화 첫 장면은 여기서 이어집니다.`,
    opts.stale ? `(주의: 이 정리 뒤에 ${episodeNo}화 원고가 바뀌었습니다. 어긋나면 '직전 내용'의 원문을 따릅니다.)` : "",
    h.place ? `- 장소: ${h.place}` : "",
    h.time ? `- 시간: ${h.time}` : "",
    h.present.length ? `- 함께 있는 인물: ${h.present.join(", ")}` : "",
    h.physical_state ? `- 몸 상태: ${h.physical_state}` : "",
    h.emotional_state ? `- 마음 상태: ${h.emotional_state}` : "",
    h.open_hook ? `- 이어받을 행동·훅: ${h.open_hook}` : "",
    h.last_line ? `- 마지막 문장: ${h.last_line}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface StoryEntry {
  episodeNo: number;
  lines: string[];
}

export const STORY_RECENT_EPISODES = 3;
export const STORY_MAX_CHARS = 2400;

/**
 * "지금까지의 줄거리": the last `recent` episodes with every line, older episodes compressed to their first line
 * (oldest dropped first when over `maxChars`; the dropped range is named). Recent episodes are kept even when
 * they alone exceed the bound (their lines are clipped instead).
 */
export function storySoFarText(entries: StoryEntry[], opts: { recent?: number; maxChars?: number } = {}): string {
  const recentN = opts.recent ?? STORY_RECENT_EPISODES;
  const maxChars = opts.maxChars ?? STORY_MAX_CHARS;
  const sorted = [...entries].filter((e) => e.lines.length).sort((a, b) => a.episodeNo - b.episodeNo);
  if (!sorted.length) return "";
  const recent = sorted.slice(-recentN);
  const older = sorted.slice(0, Math.max(0, sorted.length - recentN));
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const recentBudget = Math.floor(maxChars * 0.7);
  const perLine = Math.max(60, Math.floor(recentBudget / Math.max(1, recent.reduce((n, e) => n + e.lines.length, 0))));
  const recentBlock = recent.map((e) => [`${e.episodeNo}화`, ...e.lines.map((l) => `- ${clip(l, perLine)}`)].join("\n"));
  const recentLen = recentBlock.join("\n").length;
  let olderLines = older.map((e) => `- ${e.episodeNo}화: ${clip(e.lines[0]!, 120)}`);
  const skipped: number[] = [];
  const budget = Math.max(0, maxChars - recentLen - 40);
  while (olderLines.length && olderLines.join("\n").length > budget) {
    skipped.push(older[skipped.length]!.episodeNo);
    olderLines = olderLines.slice(1);
  }
  const parts: string[] = [];
  if (older.length) {
    parts.push("이전 화(압축)");
    if (skipped.length) parts.push(`- ${skipped[0]}~${skipped.at(-1)}화: (분량 때문에 생략)`);
    parts.push(...olderLines);
  }
  parts.push(...recentBlock);
  return parts.join("\n");
}
