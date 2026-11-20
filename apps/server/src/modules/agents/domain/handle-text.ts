/**
 * 설계 추가 0025: entity handles (E1, E2 … — 04 §9.6) are reference marks for structured fields only. They must
 * never reach text a person reads (outline summaries, prose). Pure helpers:
 *  - `renderEntityRefs`: turns the `{{E:<id>}}` / `{{E!:<id>}}` placeholders of context sections into names / marks
 *  - `replaceHandleTokens`: rewrites handle tokens an LLM left inside a sentence into the entity's name
 *  - `findHandleTokens`: the handle-looking tokens of a text (detection)
 *
 * 설계 추가 0026: a handle never stays in a stored sentence. The only exemption is a "story token" — a handle-looking
 * token inside a real name / glossary term of the novel (`storyHandleTokens`), plus, for meta text, tokens a human
 * typed (`humanHandleTokens`). "The token already appears in the run's input" is NOT an exemption.
 *  - `isHandleShaped`: the whole text is a handle (never an entity name / alias / mention surface)
 *  - `leakedHandleTokens` / `rewriteHandlesDeep`: deep scan / rewrite of every string leaf of an output
 *  - `handleLeakIssue` / `handleLeakRepairIssues`: the Korean repair message for the producer
 *  - `assertNoHandleTokens`: last line of defence at a storage point (throws `HandleLeakError`)
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

/** the whole text is one handle, with or without the wrapper of a reference mark: "E6", " E11 ", "[E6]", "(E6)" */
const HANDLE_SHAPED = /^[[(（]?E\d{1,3}[\])）]?$/;

/** true when the whole trimmed text is a handle — such a text is never a name, an alias or a mention surface */
export function isHandleShaped(text: string | null | undefined): boolean {
  return typeof text === "string" && HANDLE_SHAPED.test(text.trim());
}

/** the name a handle may be rewritten to: null when it is missing, blank or itself handle-shaped */
function usableLabel(label: string | null | undefined): string | null {
  return label && label.trim() && !isHandleShaped(label) ? label : null;
}

/** handle-looking tokens ("E6", "E11") in reading order, deduplicated */
export function findHandleTokens(text: string): string[] {
  return [...new Set([...text.matchAll(HANDLE_TOKEN)].map((m) => m[0]))];
}

/** every handle-looking token with its position, in reading order (not deduplicated) */
export function handleTokenSpans(text: string): Array<{ token: string; start: number; end: number }> {
  return [...text.matchAll(HANDLE_TOKEN)].map((m) => ({ token: m[0], start: m.index!, end: m.index! + m[0].length }));
}

/**
 * True when a name / mention surface is a handle or carries a handle token that is not story text ("E7", "E12 일행").
 * Such a text never becomes an entity name or an alias (0026 P5 / P1): once stored it would exempt its own token.
 */
export function carriesHandle(text: string | null | undefined, story: ReadonlySet<string> = new Set()): boolean {
  return typeof text === "string" && (isHandleShaped(text) || findHandleTokens(text).some((t) => !story.has(t)));
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
 * Rewrites reference tokens `<prefix><n>` left in a sentence into names: "서이온(E6)" → "서이온", "E6은 물러났다" →
 * "서이온은 물러났다" (the following particle is re-agreed with the name). `nameAt(n)` = the name behind number `n`,
 * null → the token stays. Shared by the pack handles (E) and the resolver's batch-local handles (K).
 */
export function replaceRefTokens(text: string, prefix: string, nameAt: (n: string) => string | null): { text: string; replaced: number } {
  if (!text) return { text, replaced: 0 };
  let replaced = 0;
  // "이름(E6)" / "이름 [E6]" / "이름（E6）": the name is already there — drop the mark
  // (also after another word: an alias or short form — "이온(E6)" → "이온")
  let out = text.replace(new RegExp(`\\s?[([（]${prefix}(\\d{1,3})[)\\]）]`, "g"), (m, n: string, at: number) => {
    if (!nameAt(n) || !/[^\s()[\]（）,.!?:;"'“”‘’·…-]$/.test(text.slice(0, at))) return m;
    replaced++;
    return "";
  });
  // a bare token → the name, with the following particle re-agreed
  let result = "";
  let last = 0;
  for (const m of out.matchAll(new RegExp(`(?<![A-Za-z0-9_])${prefix}(\\d{1,3})(?![A-Za-z0-9_])`, "g"))) {
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
  return { text: out, replaced };
}

/**
 * Rewrites handle tokens left in a sentence: "서이온(E6)" → "서이온", "E6은 물러났다" → "서이온은 물러났다".
 * `labels[i]` is the name behind handle `E${i+1}` (ContextPack.handles.labels); tokens outside the table stay.
 * `keep`: tokens that are story text ("E3 구역"), left as they are.
 */
export function replaceHandleTokens(text: string, labels: readonly string[], keep: ReadonlySet<string> = new Set()): { text: string; replaced: number; unresolved: string[] } {
  if (!text || !labels.length) return { text, replaced: 0, unresolved: findHandleTokens(text ?? "") };
  const r = replaceRefTokens(text, "E", (n) => (keep.has(`E${n}`) ? null : usableLabel(labels[Number(n) - 1])));
  return { ...r, unresolved: findHandleTokens(r.text) };
}

type Texts = Iterable<string | null | undefined>;

/**
 * Story tokens (0026 P1): the handle-looking tokens inside real names / glossary terms of the novel ("E3 구역" → E3).
 * Names that are themselves handle-shaped ("E11", "[E6]") are ghosts and contribute nothing.
 */
export function storyHandleTokens(names: Texts): Set<string> {
  const out = new Set<string>();
  for (const n of names) if (n && !isHandleShaped(n)) for (const t of findHandleTokens(n)) out.add(t);
  return out;
}

/** Tokens a human typed (0026 P4 — meta text only): chat message, rejection reason … Never pass model-written text. */
export function humanHandleTokens(...texts: Array<string | null | undefined>): Set<string> {
  return new Set(texts.flatMap((t) => (t ? findHandleTokens(t) : [])));
}

export interface HandleLeak {
  /** where the string sits in the scanned value: "summary", "beats[2].text", "" for a bare string */
  path: string;
  token: string;
}

export interface HandleScanOptions {
  /** property names whose whole subtree is left alone: entity REFERENCE fields that carry handles and are resolved to ids */
  skipKeys?: Iterable<string>;
}

function mapStrings(value: unknown, path: string, skip: ReadonlySet<string>, fn: (text: string, path: string) => string): unknown {
  if (typeof value === "string") return fn(value, path);
  if (Array.isArray(value)) return value.map((v, i) => mapStrings(v, `${path}[${i}]`, skip, fn));
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, skip.has(k) ? v : mapStrings(v, path ? `${path}.${k}` : k, skip, fn)]));
  }
  return value;
}

/**
 * Deep scan: every handle token in every string leaf of a JSON-like value (a string, an array, a plain object) that is
 * not in `allow`. One entry per (path, token), in reading order; [] = clean.
 */
export function leakedHandleTokens(value: unknown, allow: ReadonlySet<string> = new Set(), opts: HandleScanOptions = {}): HandleLeak[] {
  const leaks: HandleLeak[] = [];
  mapStrings(value, "", new Set(opts.skipKeys ?? []), (text, path) => {
    for (const token of findHandleTokens(text)) if (!allow.has(token)) leaks.push({ path, token });
    return text;
  });
  return leaks;
}

/**
 * Deep `replaceHandleTokens` (0026 P2): rewrites every string leaf with the pack's labels and returns a copy.
 * `unresolved` = what is still there and not in `keep` (unlike `replaceHandleTokens().unresolved`) — non-empty → reject.
 */
export function rewriteHandlesDeep<T>(value: T, labels: readonly string[], keep: ReadonlySet<string> = new Set(), opts: HandleScanOptions = {}): { value: T; replaced: number; unresolved: HandleLeak[] } {
  let replaced = 0;
  const unresolved: HandleLeak[] = [];
  const out = mapStrings(value, "", new Set(opts.skipKeys ?? []), (text, path) => {
    const r = replaceHandleTokens(text, labels, keep);
    replaced += r.replaced;
    for (const token of r.unresolved) if (!keep.has(token)) unresolved.push({ path, token });
    return r.text;
  });
  return { value: out as T, replaced, unresolved };
}

const leakTokens = (leaks: ReadonlyArray<string | HandleLeak>) => [...new Set(leaks.map((l) => (typeof l === "string" ? l : l.token)))];

/** The Korean issue / repair message for the producer (0026 P3); takes tokens or leaks, quotes up to 3 of them */
export function handleLeakIssue(leaks: ReadonlyArray<string | HandleLeak>): string {
  const tokens = leakTokens(leaks);
  const shown = tokens.slice(0, 3).map((t) => `'${t}'`).join(", ") || "'E7'";
  return `문장에 ${shown} 같은 기호가 남아 있습니다. 'E숫자' 기호는 이름이 아닙니다. 기호 대신 인물·장소의 실제 이름을 쓰세요.`;
}

/** One repair issue per leaking field, shaped like `RepairIssue` ({ item, problem }) for `callWithRepair` */
export function handleLeakRepairIssues(leaks: readonly HandleLeak[], label = "문장"): Array<{ item: string; problem: string }> {
  const byPath = new Map<string, string[]>();
  for (const l of leaks) byPath.set(l.path, [...(byPath.get(l.path) ?? []), l.token]);
  return [...byPath].map(([path, tokens]) => ({ item: path ? `${label} ${path}` : label, problem: handleLeakIssue(tokens) }));
}

/** One short prompt rule (0026 P7) for prose / plan instructions that have no wording of their own */
export const NO_HANDLE_RULE = "'E7'처럼 E와 숫자로 된 기호는 이름이 아닙니다. 문장에는 절대 쓰지 말고 반드시 인물·장소의 이름으로 쓰세요.";

/** A handle token reached a storage point for agent-authored text (0026 P6) — a bug upstream, never shown to a user */
export class HandleLeakError extends Error {
  readonly leaks: HandleLeak[];
  readonly what: string;
  constructor(what: string, leaks: HandleLeak[]) {
    super(`entity handle left in stored text (${what}): ${leaks.slice(0, 5).map((l) => (l.path ? `${l.path}=${l.token}` : l.token)).join(", ")}`);
    this.name = "HandleLeakError";
    this.what = what;
    this.leaks = leaks;
  }
}

/** Last line of defence (0026 P6): throws `HandleLeakError` when agent-authored `value` still has a non-exempt token */
export function assertNoHandleTokens(value: unknown, what: string, allow: ReadonlySet<string> = new Set(), opts: HandleScanOptions = {}): void {
  const leaks = leakedHandleTokens(value, allow, opts);
  if (leaks.length) throw new HandleLeakError(what, leaks);
}
