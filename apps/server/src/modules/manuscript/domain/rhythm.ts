/**
 * 설계 추가 0024: 문장 리듬 지표 (pure). Korean narration that runs short declaratives ("~였다. ~다.") back to back
 * reads stiff; this module splits the text into paragraphs and sentences, keeps dialogue out of the narration stats
 * and flags the paragraphs a targeted rhythm pass should rewrite. Thresholds follow the novel's 문장 리듬 setting.
 *
 * Paragraph = one non-empty line (web-novel text puts one paragraph per line); scene separator lines are skipped.
 * A paragraph that opens with a quote mark is dialogue; inline quotes inside narration never split a sentence and a
 * sentence that carries a quote counts as dialogue (its tag "그가 말했다." is not a stiff narration beat).
 */
import { DEFAULT_PROSE_RHYTHM, type ProseRhythm } from "@ncs/shared";

export interface RhythmThresholds {
  /** a narration sentence shorter than this (chars incl. spaces, terminator included) is short */
  shortMaxChars: number;
  /** a run of this many consecutive short declaratives (…다.) is flagged */
  shortRunLimit: number;
  /** a run of this many consecutive narration sentences with the same ending (…었다.) is flagged */
  endingRunLimit: number;
  /** a paragraph with at least `paragraphMinSentences` narration sentences and this short ratio is flagged */
  paragraphShortRatio: number;
  paragraphMinSentences: number;
}

export const RHYTHM_THRESHOLDS: Record<ProseRhythm, RhythmThresholds> = {
  concise: { shortMaxChars: 20, shortRunLimit: 7, endingRunLimit: 9, paragraphShortRatio: 0.9, paragraphMinSentences: 8 },
  normal: { shortMaxChars: 25, shortRunLimit: 4, endingRunLimit: 6, paragraphShortRatio: 0.75, paragraphMinSentences: 4 },
  flowing: { shortMaxChars: 30, shortRunLimit: 3, endingRunLimit: 5, paragraphShortRatio: 0.6, paragraphMinSentences: 3 },
};

export interface RhythmParagraph {
  index: number;
  /** offsets in the text (end exclusive, no line break) */
  start: number;
  end: number;
  text: string;
  dialogue: boolean;
  /** a scene separator line (---, * * *, ◇ …) sits between this paragraph and the previous one */
  sceneBreakBefore: boolean;
}

export interface RhythmSentence {
  paragraph: number;
  text: string;
  /** chars incl. spaces (code points) */
  length: number;
  dialogue: boolean;
  /** ends with "다." (after closing marks) */
  declarative: boolean;
  /** last two syllables before the terminator ("었다", "했다") — "" when none */
  ending: string;
}

export interface RhythmMetric {
  setting: ProseRhythm;
  paragraphCount: number;
  narrationSentences: number;
  dialogueSentences: number;
  /** narration only, chars incl. spaces */
  avgSentenceLength: number;
  /** short narration sentences / narration sentences (0..1) */
  shortRatio: number;
  longestShortRun: number;
  longestEndingRun: number;
  /** paragraph indices (rhythmParagraphs order) a rhythm pass should rewrite */
  flaggedParagraphs: number[];
}

const OPEN_QUOTES = new Set(['"', "“", "「", "『", "'", "‘", "《", "〈"]);
const CLOSE_OF: Record<string, string> = { '"': '"', "“": "”", "「": "」", "『": "』", "'": "'", "‘": "’", "《": "》", "〈": "〉" };
const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);
const TRAILING_CLOSERS = new Set([")", "）", "]", "”", "’", "」", "』", '"', "'"]);
const SEPARATOR_LINE = /^\s*(?:\*\s*){3,}\s*$|^\s*(?:[-=~＊#]\s*){3,}\s*$|^\s*◇+\s*$|^\s*◆+\s*$/u;
/** a scene separator line (---, ===, * * *, ◇ …) */
export const isSeparatorLine = (line: string): boolean => SEPARATOR_LINE.test(line);
/** does any line of the text look like a scene separator */
export const hasSeparatorLine = (text: string): boolean => text.split("\n").some(isSeparatorLine);
/** a syllable that closes a Korean sentence ("…했다…", "…요…") — an ellipsis after it ends the sentence */
const FINAL_SYLLABLE = /[다요죠까네군지]$/u;
const len = (s: string) => [...s].length;

/** non-empty lines of the text with their offsets (scene separators skipped) */
export function rhythmParagraphs(text: string): RhythmParagraph[] {
  const out: RhythmParagraph[] = [];
  let pos = 0;
  let pendingBreak = false;
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    if (!line.trim()) continue;
    if (SEPARATOR_LINE.test(line)) {
      if (out.length) pendingBreak = true;
      continue;
    }
    const lead = line.length - line.trimStart().length;
    const body = line.trim();
    out.push({ index: out.length, start: start + lead, end: start + lead + body.length, text: body, dialogue: OPEN_QUOTES.has(body[0]!), sceneBreakBefore: pendingBreak });
    pendingBreak = false;
  }
  return out;
}

/**
 * sentences of one paragraph: a run of terminators (plus closing marks) followed by whitespace / end ends a sentence;
 * nothing inside quotes ends one. A dialogue paragraph yields dialogue sentences only.
 */
export function splitSentences(paragraph: string, paragraphIndex = 0, dialogueParagraph = OPEN_QUOTES.has(paragraph.trim()[0] ?? "")): RhythmSentence[] {
  const chars = [...paragraph];
  const out: RhythmSentence[] = [];
  let buf = "";
  let quote: string | null = null;
  let hadQuote = false;
  const flush = () => {
    const text = buf.trim();
    buf = "";
    if (!text) return;
    const core = text.replace(/[)）\]”’」』"'\s]+$/u, "");
    const declarative = /다[.。]$/u.test(core);
    const m = /([가-힣]{1,2})[.。!?！？…]+$/u.exec(core);
    out.push({ paragraph: paragraphIndex, text, length: len(text), dialogue: dialogueParagraph || hadQuote, declarative, ending: m ? m[1]!.slice(-2) : "" });
    hadQuote = false;
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    buf += c;
    if (quote) {
      if (c === CLOSE_OF[quote]) quote = null;
      continue;
    }
    if (OPEN_QUOTES.has(c)) {
      // an apostrophe between letters is not a quote
      if ((c === "'" || c === "’") && /\p{L}/u.test(chars[i - 1] ?? "") && /\p{L}/u.test(chars[i + 1] ?? "")) continue;
      quote = c;
      hadQuote = true;
      continue;
    }
    if (!TERMINATORS.has(c)) continue;
    const before = buf.slice(0, -1);
    let j = i + 1;
    let run = c;
    while (j < chars.length && (TERMINATORS.has(chars[j]!) || TRAILING_CLOSERS.has(chars[j]!))) {
      if (TERMINATORS.has(chars[j]!)) run += chars[j]!;
      buf += chars[j++]!;
    }
    // an ellipsis ("그는... 아무 말도") ends a sentence only after a sentence-final syllable or at the paragraph end
    const ellipsis = /^[.…]+$/u.test(run) && (run.length >= 2 || run === "…");
    const atEnd = chars.slice(j).every((x) => /\s/u.test(x));
    if (ellipsis && !atEnd && !FINAL_SYLLABLE.test(before.trimEnd())) {
      i = j - 1;
      continue;
    }
    if (j >= chars.length || /\s/u.test(chars[j]!)) {
      i = j - 1;
      flush();
    } else {
      i = j - 1;
    }
  }
  flush();
  return out;
}

export function rhythmSentences(text: string): RhythmSentence[] {
  return rhythmParagraphs(text).flatMap((p) => splitSentences(p.text, p.index, p.dialogue));
}

export function rhythmThresholds(setting: ProseRhythm | null | undefined): RhythmThresholds {
  return RHYTHM_THRESHOLDS[setting ?? DEFAULT_PROSE_RHYTHM] ?? RHYTHM_THRESHOLDS[DEFAULT_PROSE_RHYTHM];
}

/** the rhythm metric of a text under a setting (pure, deterministic) */
export function measureRhythm(text: string, setting: ProseRhythm | null | undefined = DEFAULT_PROSE_RHYTHM): RhythmMetric {
  const mode = setting ?? DEFAULT_PROSE_RHYTHM;
  const th = rhythmThresholds(mode);
  const paragraphs = rhythmParagraphs(text);
  const sentences = paragraphs.flatMap((p) => splitSentences(p.text, p.index, p.dialogue));
  const narration = sentences.filter((s) => !s.dialogue);
  const isShort = (s: RhythmSentence) => s.length < th.shortMaxChars;
  const flagged = new Set<number>();

  // runs over the sentence sequence: dialogue breaks a run (narration on both sides is not "in a row")
  let longestShortRun = 0;
  let longestEndingRun = 0;
  let shortRun: RhythmSentence[] = [];
  let endingRun: RhythmSentence[] = [];
  const closeShort = () => {
    longestShortRun = Math.max(longestShortRun, shortRun.length);
    if (shortRun.length >= th.shortRunLimit) for (const s of shortRun) flagged.add(s.paragraph);
    shortRun = [];
  };
  const closeEnding = () => {
    longestEndingRun = Math.max(longestEndingRun, endingRun.length);
    if (endingRun.length >= th.endingRunLimit) for (const s of endingRun) flagged.add(s.paragraph);
    endingRun = [];
  };
  const breakAt = new Set(paragraphs.filter((p) => p.sceneBreakBefore).map((p) => p.index));
  let lastParagraph = -1;
  for (const s of sentences) {
    // a scene break ends both runs (the sentences on either side are not "in a row")
    if (s.paragraph !== lastParagraph && breakAt.has(s.paragraph)) {
      closeShort();
      closeEnding();
    }
    lastParagraph = s.paragraph;
    if (s.dialogue) {
      closeShort();
      closeEnding();
      continue;
    }
    if (isShort(s) && s.declarative) shortRun.push(s);
    else closeShort();
    if (s.ending && endingRun.length && endingRun[0]!.ending === s.ending) endingRun.push(s);
    else {
      closeEnding();
      if (s.ending) endingRun.push(s);
    }
  }
  closeShort();
  closeEnding();

  // dense paragraphs: mostly short narration sentences
  const byParagraph = new Map<number, RhythmSentence[]>();
  for (const s of narration) byParagraph.set(s.paragraph, [...(byParagraph.get(s.paragraph) ?? []), s]);
  for (const [idx, list] of byParagraph) {
    if (list.length < th.paragraphMinSentences) continue;
    if (list.filter(isShort).length / list.length >= th.paragraphShortRatio) flagged.add(idx);
  }

  const total = narration.reduce((a, s) => a + s.length, 0);
  return {
    setting: mode,
    paragraphCount: paragraphs.length,
    narrationSentences: narration.length,
    dialogueSentences: sentences.length - narration.length,
    avgSentenceLength: narration.length ? Math.round((total / narration.length) * 10) / 10 : 0,
    shortRatio: narration.length ? Math.round((narration.filter(isShort).length / narration.length) * 1000) / 1000 : 0,
    longestShortRun,
    longestEndingRun,
    flaggedParagraphs: [...flagged].sort((a, b) => a - b),
  };
}

export interface RhythmBlock {
  /** 1-based block number in the rewrite request */
  no: number;
  paragraphs: number[];
  start: number;
  end: number;
  text: string;
}

/**
 * consecutive flagged paragraphs grouped into blocks (a run of one-sentence lines is rewritten as one block so the
 * pass may join its sentences). Paragraphs overlapping `protectedRanges` (human-written text) are never included.
 */
export function rhythmBlocks(text: string, flagged: readonly number[], protectedRanges: ReadonlyArray<{ start: number; end: number }> = []): RhythmBlock[] {
  const paragraphs = rhythmParagraphs(text);
  const want = new Set(flagged);
  const blocks: RhythmBlock[] = [];
  let cur: RhythmParagraph[] = [];
  const close = () => {
    if (!cur.length) return;
    const start = cur[0]!.start;
    const end = cur[cur.length - 1]!.end;
    blocks.push({ no: blocks.length + 1, paragraphs: cur.map((p) => p.index), start, end, text: text.slice(start, end) });
    cur = [];
  };
  for (const p of paragraphs) {
    const ok = want.has(p.index) && !protectedRanges.some((h) => h.start < p.end && p.start < h.end);
    if (!ok) {
      close();
      continue;
    }
    const prev = cur[cur.length - 1];
    // a block never spans a scene break
    if (prev && (prev.index !== p.index - 1 || p.sceneBreakBefore)) close();
    cur.push(p);
  }
  close();
  return blocks;
}

/** chars without whitespace — the line breaks a rhythm pass joins away do not count as length */
export const rhythmChars = (s: string): number => len(s.replace(/\s+/gu, ""));

/**
 * is a rewritten block inside the length bound of the original (±ratio, at least `minSlack` chars). Whitespace is
 * not counted: joining one-sentence lines removes line breaks and must not eat the slack.
 */
export function withinLengthBound(original: string, rewritten: string, ratio = 0.05, minSlack = 6): boolean {
  const a = rhythmChars(original);
  const b = rhythmChars(rewritten);
  return Math.abs(b - a) <= Math.max(minSlack, Math.round(a * ratio));
}

/** replaces blocks (by offsets of `text`, any order) */
export function applyBlocks(text: string, replacements: ReadonlyArray<{ start: number; end: number; text: string }>): string {
  let out = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}
