/**
 * Surface normalization (06 §3.4 N1–N8). Pure, deterministic. Never strips Hangul.
 *
 *  - normalizedKey: NFC → remove spaces/middle dots/hyphens/quotes → full-width → half-width → latin lower case.
 *  - jamoKey: normalizedKey with Hangul syllables decomposed into compatibility jamo (edit distance runs here).
 *  - translitKey: coarse phonetic key shared by Latin and Hangul spellings (assumption: simplified table,
 *    06 §3.4 N8 "국립국어원 외래어 표기 규칙의 단순화 표"). Candidate generation only (L2 2nd pass).
 *
 * Embedded PG has no Korean-aware trigram; jamo edit distance (computed in TS) is the fuzzy fallback.
 */

const STRIP_RE = /[\s·・‧∙ㆍ\-‐-―'"`‘’“”「」『』«».,!?~]/gu;

function fullToHalf(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
}

/** N4: "천마(天魔)" → { main: "천마", variants: ["天魔"] } */
export function splitParenthetical(surface: string): { main: string; variants: string[] } {
  const variants: string[] = [];
  const main = surface.replace(/[(（]([^)）]*)[)）]/g, (_m, inner: string) => {
    const v = inner.trim();
    if (v) variants.push(v);
    return "";
  });
  return { main: main.trim() || surface.trim(), variants };
}

export function normalizedKey(surface: string): string {
  const { main } = splitParenthetical(surface.normalize("NFC"));
  return fullToHalf(main).normalize("NFC").replace(STRIP_RE, "").toLowerCase();
}

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JUNG = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

function decompose(ch: string): [number, number, number] | null {
  const code = ch.codePointAt(0)!;
  if (code < 0xac00 || code > 0xd7a3) return null;
  const s = code - 0xac00;
  return [Math.floor(s / 588), Math.floor((s % 588) / 28), s % 28];
}

export function jamoKey(surface: string): string {
  let out = "";
  for (const ch of normalizedKey(surface)) {
    const d = decompose(ch);
    out += d ? CHO[d[0]]! + JUNG[d[1]]! + JONG[d[2]]! : ch;
  }
  return out;
}

// simplified Revised Romanization (assumption) — consonant skeleton used for the coarse translit key
const CHO_ROM = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const JUNG_ROM = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const JONG_ROM = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

function romanize(key: string): string {
  let out = "";
  for (const ch of key) {
    const d = decompose(ch);
    out += d ? CHO_ROM[d[0]]! + JUNG_ROM[d[1]]! + JONG_ROM[d[2]]! : ch;
  }
  return out;
}

/** coarse phonetic skeleton: unify voicing/aspiration pairs, drop vowels and epenthetic sounds */
function skeleton(latin: string): string {
  return latin
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "p")
    .replace(/th/g, "t")
    .replace(/ch/g, "c")
    .replace(/ng/g, "n")
    .replace(/[gkq]/g, "k")
    .replace(/[dt]/g, "t")
    .replace(/[bpfv]/g, "p")
    .replace(/[szjcx]/g, "s")
    .replace(/[rl]/g, "l")
    .replace(/[aeiouyw]/g, "")
    .replace(/(.)\1+/g, "$1");
}

export function translitKey(surface: string): string {
  const key = normalizedKey(surface);
  const isLatin = /^[a-z0-9]+$/.test(key);
  // Latin: English /r/ is usually not written in Korean loans ("Iron" → "아이언"); Hangul: drop epenthetic ㅡ ("하트" → "hat")
  const roman = isLatin ? key.replace(/r/g, "") : romanize(key).replace(/eu(?=[^aeiou]|$)/g, "");
  const s = skeleton(roman);
  return s.length > 0 ? s : key;
}

/** Levenshtein distance over code points */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** syllable count used by dedup.short_name_max_syllables (Hangul syllable = 1, latin word = 1 per 3 letters, assumption) */
export function syllableCount(surface: string): number {
  const key = normalizedKey(surface);
  let n = 0;
  let latin = 0;
  for (const ch of key) {
    if (decompose(ch)) n++;
    else if (/[a-z]/.test(ch)) latin++;
    else n++;
  }
  return n + Math.ceil(latin / 3);
}

/** translit keys are only comparable across scripts (Latin ↔ Hangul); same-script similarity is the jamo distance's job */
export function isCrossScript(a: string, b: string): boolean {
  const latin = (x: string) => /[a-z]/i.test(x) && !/[\uac00-\ud7a3]/.test(x);
  const hangul = (x: string) => /[\uac00-\ud7a3]/.test(x);
  return (latin(a) && hangul(b)) || (hangul(a) && latin(b));
}

export function nameKeys(surface: string): { normalizedKey: string; jamoKey: string; translitKey: string } {
  return { normalizedKey: normalizedKey(surface), jamoKey: jamoKey(surface), translitKey: translitKey(surface) };
}

/** stable JSON (sorted keys) + FNV-1a 32 → hex; used for value hashes in slot keys */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

export function valueHash(v: unknown): string {
  const s = stableJson(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
