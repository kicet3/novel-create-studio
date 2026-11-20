/**
 * 설계 추가 0025: entity handles (E1, E2 … — 04 §9.6) are reference marks for structured fields only. They must
 * never reach text a person reads (outline summaries, prose). Pure helpers:
 *  - `renderEntityRefs`: turns the `{{E:<id>}}` / `{{E!:<id>}}` placeholders of context sections into names / marks
 *  - `replaceHandleTokens`: rewrites handle tokens an LLM left inside a sentence into the entity's name
 *  - `findHandleTokens`: the handle-looking tokens of a text (detection)
 */

/** `{{E:<id>}}` = the entity inside a sentence (rendered as its name); `{{E!:<id>}}` = its reference mark (handle) */
export const ENTITY_REF = /\{\{E(!?):([^}]+)\}\}/g;
/** a reference mark with the wrapper a provider put around it: ` ({{E!:id}})`, ` [{{E!:id}}]`, `{{E!:id}} ` */
const WRAPPED_MARK = / ?\(\{\{E!:[^}]+\}\}\)| ?\[\{\{E!:[^}]+\}\}\]|\{\{E!:[^}]+\}\} ?/g;

export const UNNAMED_ENTITY = "이름 없는 대상";

export function entityRefIds(text: string): string[] {
  return [...text.matchAll(ENTITY_REF)].map((m) => m[2]!);
}

/**
 * @param marks  false → reference marks are removed (roles that write prose never see a handle)
 */
export function renderEntityRefs(text: string, o: { nameOf: (id: string) => string; handleOf: (id: string) => string; marks: boolean }): string {
  const t = o.marks ? text : text.replace(WRAPPED_MARK, "");
  return t.replace(ENTITY_REF, (_m, mark: string, id: string) => (mark ? o.handleOf(id) : o.nameOf(id)));
}

const HANDLE_TOKEN = /(?<![A-Za-z0-9_])E(\d{1,3})(?![A-Za-z0-9_])/g;

/** handle-looking tokens ("E6", "E11") in reading order, deduplicated */
export function findHandleTokens(text: string): string[] {
  return [...new Set([...text.matchAll(HANDLE_TOKEN)].map((m) => m[0]))];
}

/** true / false for a Hangul syllable with / without a final consonant; null when the last letter is not Hangul */
function finalConsonant(word: string): { has: boolean; rieul: boolean } | null {
  const c = word.trim().codePointAt(word.trim().length - 1);
  if (c === undefined || c < 0xac00 || c > 0xd7a3) return null;
  const jong = (c - 0xac00) % 28;
  return { has: jong !== 0, rieul: jong === 8 };
}

/** [after a final consonant, after a vowel] */
const PARTICLES: ReadonlyArray<readonly [string, string]> = [
  ["으로", "로"],
  ["은", "는"],
  ["을", "를"],
  ["과", "와"],
  ["이", "가"],
];
const AFTER_PARTICLE = /^(?:[\s.,!?…"'“”‘’)\]}~—-]|$)/;
/** particles that may follow 은/는·을/를·과/와·으로/로 directly ("E11과는", "E6으로도") */
const STACKED = /^[는도의만]/;

/** the particle right after a replaced handle agreed with how the handle is read aloud ("E6은"); re-agree it with the name */
function agreeParticle(name: string, rest: string): { consumed: number; emit: string } | null {
  const fc = finalConsonant(name);
  if (!fc) return null;
  // copula / quotative: 서이온이라는·민지라는, 서이온이었다·민지였다, 서이온이다·민지다
  const c = /^(이?)(라고|라는|라며|라면|라서|라도|었|였)/.exec(rest) ?? /^(이?)(다|야|랑)(?=[\s.,!?…"'”’)\]]|$)/.exec(rest);
  if (c) {
    const ending = c[2] === "었" || c[2] === "였" ? (fc.has ? "이었" : "였") : (fc.has ? "이" : "") + c[2];
    return { consumed: c[0].length, emit: ending };
  }
  // 로서/로써/로부터 follow the 으로/로 rule
  const ro = /^(으?)로(?=서|써|부터)/.exec(rest);
  if (ro) return { consumed: ro[0].length, emit: fc.has && !fc.rieul ? "으로" : "로" };
  for (const [closed, open] of PARTICLES) {
    for (const used of [closed, open]) {
      if (!rest.startsWith(used)) continue;
      const tail = rest.slice(used.length);
      // 이/가 only as a particle of its own ("E6이 말했다"), never the copula ("E6이었다", "E6이다")
      const ok = closed === "이" ? AFTER_PARTICLE.test(tail) : AFTER_PARTICLE.test(tail) || STACKED.test(tail);
      if (!ok) continue;
      const want = closed === "으로" ? (fc.has && !fc.rieul ? closed : open) : fc.has ? closed : open;
      return { consumed: used.length, emit: want };
    }
  }
  return null;
}

/**
 * Rewrites handle tokens left in a sentence: "서이온(E6)" → "서이온", "E6은 물러났다" → "서이온은 물러났다".
 * `labels[i]` is the name behind handle `E${i+1}` (ContextPack.handles.labels); tokens outside the table stay.
 * `keep`: tokens that are story text ("E3 구역"), left as they are.
 */
export function replaceHandleTokens(text: string, labels: readonly string[], keep: ReadonlySet<string> = new Set()): { text: string; replaced: number; unresolved: string[] } {
  if (!text || !labels.length) return { text, replaced: 0, unresolved: findHandleTokens(text ?? "") };
  let replaced = 0;
  const nameAt = (n: string) => (keep.has(`E${n}`) ? null : labels[Number(n) - 1] || null);
  // "이름(E6)" / "이름 [E6]" / "이름（E6）": the name is already there — drop the mark
  // (also after another word: an alias or short form — "이온(E6)" → "이온")
  let out = text.replace(/\s?[([（]E(\d{1,3})[)\]）]/g, (m, n: string, at: number) => {
    if (!nameAt(n) || !/[^\s()[\]（）,.!?:;"'“”‘’·…-]$/.test(text.slice(0, at))) return m;
    replaced++;
    return "";
  });
  // a bare token → the name, with the following particle re-agreed
  let result = "";
  let last = 0;
  for (const m of out.matchAll(HANDLE_TOKEN)) {
    const name = nameAt(m[1]!);
    if (!name) continue;
    const start = m.index!;
    result += out.slice(last, start) + name;
    last = start + m[0].length;
    const p = agreeParticle(name, out.slice(last, last + 8));
    if (p) {
      result += p.emit;
      last += p.consumed;
    }
    replaced++;
  }
  out = result + out.slice(last);
  return { text: out, replaced, unresolved: findHandleTokens(out) };
}
