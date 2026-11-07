/**
 * Text patches of the revision chat (pure). A patch = {quote, replacement, reason}: `quote` must occur EXACTLY ONCE in
 * the (NFC/LF-normalized) episode text, patches must not overlap, and together they may cover at most `maxRatio` of the
 * episode — measured on both the quotes and the replacements (minimal scope — never a whole-episode rewrite). New content is always built here from validated patches.
 * Offsets are JS string (UTF-16) indices, the same as the web viewer's line offsets.
 */
export interface TextPatch {
  quote: string;
  replacement: string;
  reason: string;
}

export interface LocatedPatch extends TextPatch {
  idx: number;
  start: number;
  end: number;
}

export interface PatchIssue {
  idx: number;
  code: "quote_missing" | "quote_not_unique" | "overlap" | "too_large" | "empty" | "no_change";
  message: string;
}

export const DEFAULT_MAX_PATCH_RATIO = 0.25;

export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

/** locate every patch; returns the located ones and per-patch issues (a patch with an issue is not located) */
export function locatePatches(content: string, patches: readonly TextPatch[], opts: { maxRatio?: number } = {}): { located: LocatedPatch[]; issues: PatchIssue[] } {
  const text = normalizeText(content);
  const maxRatio = opts.maxRatio ?? DEFAULT_MAX_PATCH_RATIO;
  const issues: PatchIssue[] = [];
  const located: LocatedPatch[] = [];
  patches.forEach((p, idx) => {
    const quote = normalizeText(p.quote);
    const replacement = normalizeText(p.replacement);
    if (!quote.trim()) return void issues.push({ idx, code: "empty", message: "quote가 비어 있습니다." });
    if (quote === replacement) return void issues.push({ idx, code: "no_change", message: "quote와 replacement가 같습니다." });
    const at = text.indexOf(quote);
    if (at < 0) return void issues.push({ idx, code: "quote_missing", message: "quote가 이번 화 원고에 그대로 나오지 않습니다. 원문을 한 글자도 바꾸지 말고 인용하세요." });
    if (text.indexOf(quote, at + 1) >= 0) return void issues.push({ idx, code: "quote_not_unique", message: "quote가 원고에 두 번 이상 나옵니다. 앞뒤 문맥을 더 넣어 한 곳만 가리키게 하세요." });
    located.push({ idx, quote, replacement, reason: p.reason, start: at, end: at + quote.length });
  });
  // overlaps: keep the earlier patch
  located.sort((a, b) => a.start - b.start);
  const kept: LocatedPatch[] = [];
  for (const p of located) {
    const prev = kept[kept.length - 1];
    if (prev && p.start < prev.end) issues.push({ idx: p.idx, code: "overlap", message: `다른 수정(${prev.idx + 1}번)과 겹칩니다.` });
    else kept.push(p);
  }
  // scope = the larger of what is removed and what is written (a short quote with a huge replacement is a rewrite too)
  const covered = kept.reduce((n, p) => n + (p.end - p.start), 0);
  const written = kept.reduce((n, p) => n + p.replacement.length, 0);
  if (text.length > 0 && Math.max(covered, written) > text.length * maxRatio) {
    // too large as a whole: flag every patch (the producer must narrow the scope)
    for (const p of kept) issues.push({ idx: p.idx, code: "too_large", message: `수정 범위가 원고의 ${Math.round(maxRatio * 100)}%를 넘습니다. 문장·문단 단위로 줄이세요.` });
    return { located: [], issues: issues.sort((a, b) => a.idx - b.idx) };
  }
  return { located: kept.sort((a, b) => a.idx - b.idx), issues: issues.sort((a, b) => a.idx - b.idx) };
}

/** apply located patches right to left (offsets stay valid) */
export function applyPatches(content: string, located: readonly LocatedPatch[]): string {
  let text = normalizeText(content);
  for (const p of [...located].sort((a, b) => b.start - a.start)) text = text.slice(0, p.start) + p.replacement + text.slice(p.end);
  return text;
}

/** the window of `text` around [start, end) (± `pad` chars), for prompts */
export function excerptAround(text: string, start: number, end: number, pad = 600): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  return `${s > 0 ? "…" : ""}${text.slice(s, e)}${e < text.length ? "…" : ""}`;
}
