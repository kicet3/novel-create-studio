/**
 * 설계 추가 0015: entity resolver agent (world_keeper, purpose `resolve_entities`). One LLM call per batch of unresolved
 * surfaces (with their context excerpts and the existing entity list incl. aliases) returns, per surface, one of
 * link_existing / add_alias / create_entity / ignore / merge / keep_distinct with a confidence 0..1 and a short rationale.
 * Format problems (unknown handles, schema-external types, missing items) go back to the producer through the
 * agent-to-agent repair dialogue (agents.callWithRepair), recorded on the run like every other agent dialogue.
 * 설계 추가 0026: the entity list of a batch has its own handles K1, K2 … (never E — "E7" is the shape of a context-pack
 * entity handle, and one left in a manuscript excerpt must not be confused with an entry of this list). Handles are
 * reference marks of the structured fields only: `rationale` has its batch-local references rewritten to names, and
 * neither `rationale` nor `canonical_name` is stored with an entity handle in it.
 * Model errors never fail the caller: the result is `failed` and the caller keeps its deterministic / old behaviour.
 */
import { defaultValue, type RepairIssueDto } from "@ncs/shared";
import { NotImplementedError, type Logger } from "../../../platform/index.js";
import { callWithRepair, handleLeakIssue, isHandleShaped, leakedHandleTokens, replaceRefTokens } from "../../agents/index.js";
import type { LlmMessage, ModelCallPort } from "../../llm/index.js";
import { RunStop, type RunHandle } from "../../orchestration/index.js";
import { entityResolutionSchema, type EntityResolution, type EntityResolutionAction } from "../domain/schemas.js";
import { normalizeEntityType } from "../domain/extraction-check.js";
import type { SurfaceClass } from "../domain/salience.js";

export interface ResolverEntity {
  entityId: string;
  entityType: string;
  status: string;
  /** preferred name first, then aliases */
  names: string[];
  summary?: string | null;
  disambiguator?: string | null;
}

export interface ResolverItem {
  /** caller key (one decision per item) */
  key: string;
  surface: string;
  mentionKind: string;
  typeHint?: string | null;
  episodeNo?: number | null;
  /** short context excerpts (≤ 3 used) */
  contexts: string[];
  /** linker candidates (entity ids) */
  candidateIds: string[];
  salience: SurfaceClass;
  /** duplicate check: are these two entities the same? (merge / keep_distinct) */
  pair?: { a: string; b: string } | null;
  note?: string | null;
}

export interface ResolverDecision {
  action: EntityResolutionAction;
  entityId: string | null;
  entityType: string | null;
  canonicalName: string | null;
  mergeWithId: string | null;
  confidence: number;
  rationale: string;
}

export interface ResolverOutcome {
  decisions: Map<string, ResolverDecision>;
  calls: number;
  /** a model call failed (or no model port): decisions of that batch are missing */
  failed: boolean;
}

export const RESOLVE_SYSTEM = [
  "당신은 웹소설 세계관 관리자(world_keeper)의 엔티티 판정 담당입니다. 원고에서 나온 표기(<mentions>의 M 핸들)마다 그것이 이야기 속 엔티티인지, 어느 엔티티인지 정합니다.",
  "행동(action) 가운데 하나만 고릅니다:",
  "- link_existing: 기존 엔티티(<entities>의 K 핸들)를 가리킵니다. 대명사·호칭(그, 그녀, 선생님, 판정관님 …)은 문맥으로 가리키는 인물을 찾으면 이것을 씁니다.",
  "- add_alias: 기존 엔티티의 다른 이름·애칭·호칭(예: '이온 씨' → 서이온)입니다. 다음부터 같은 표기는 자동으로 연결됩니다. 대명사·일반 호칭에는 쓰지 않습니다.",
  "- create_entity: 이름이 있거나 이야기에서 반복되어 중요한 새 대상만 만듭니다. entity_type(<entity_types>의 키)과 canonical_name을 냅니다.",
  "- ignore: 배경용 일반 명사·일회성 장소·사물·사건(화면, 결승전, 구립 체육관, 센터 …)처럼 엔티티로 관리할 필요가 없는 표기입니다.",
  "- merge: [중복 확인] 항목에서 두 엔티티가 같은 대상일 때 씁니다. merge_with에 남길 엔티티 핸들을 냅니다.",
  "- keep_distinct: [중복 확인] 항목에서 두 엔티티가 서로 다른 대상일 때 씁니다.",
  "confidence는 0~1의 확신도입니다. 문맥만으로 확신할 수 없으면 낮게 냅니다(둘 이상의 인물이 똑같이 그럴듯하면 0.5 이하). rationale은 한국어 한 문장입니다.",
  "모든 M 핸들에 대해 정확히 하나씩 답합니다. 목록에 없는 핸들은 쓰지 않습니다.",
  // 설계 추가 0026
  "핸들(K1, M1 …)은 entity·merge_with·mention 필드에만 씁니다. rationale과 canonical_name에는 핸들이나 'E7' 같은 기호를 쓰지 않고 이름으로 씁니다. 문맥에 'E7' 같은 기호가 남아 있어도 그것은 이름이 아니며 <entities>의 핸들과도 무관합니다.",
].join("\n");

/** prefix of the batch-local entity handles (K1, K2 …) — see the file comment */
export const RESOLVER_ENTITY_PREFIX = "K";
export const resolverHandle = (index: number): string => `${RESOLVER_ENTITY_PREFIX}${index + 1}`;

const LOCAL_REF = /(?<![A-Za-z0-9_])K(\d{1,3})(?![A-Za-z0-9_])/g;
/**
 * A rationale is read by people (mention rationale, audit reason, question body): the batch-local references the model
 * left in it become names — "'판정실'(K24)과 같은 곳" → "'판정실'과 같은 곳", "K3은 …" → "서이온은 …" (the particle
 * follows the name — agents.replaceRefTokens). `nameOf`: handle (upper case) → preferred name; a reference outside the
 * table stays (and is reported by the check). `bare`: when given, only these handles are rewritten where they stand
 * alone (the entities this judgement is about) — "K2 소총" of the story is not the 2nd entity of the list.
 */
export function rewriteLocalRefs(text: string, nameOf: ReadonlyMap<string, string>, bare?: ReadonlySet<string>): string {
  if (!text || nameOf.size === 0) return text;
  const name = (n: string) => {
    const v = nameOf.get(`${RESOLVER_ENTITY_PREFIX}${Number(n)}`)?.trim();
    return v && !isHandleShaped(v) ? v : null;
  };
  // "이름(K3)" / "'이름' [K3]": the name is already there (also in quotes) — drop the mark; then the bare references
  const marks = text.replace(/\s?[([（]K(\d{1,3})[)\]）]/g, (m, n: string, at: number) => (name(n) && /[^\s()[\]（）,.!?:;·…-]$/.test(text.slice(0, at)) ? "" : m));
  return replaceRefTokens(marks, RESOLVER_ENTITY_PREFIX, (n) => (!bare || bare.has(`${RESOLVER_ENTITY_PREFIX}${Number(n)}`) ? name(n) : null)).text;
}

export interface ResolutionTextGuard {
  /** batch handle (K1 …) → the entity's preferred name */
  names?: ReadonlyMap<string, string>;
  /** story tokens of the novel (ontology.storyHandleTokens) — never the surfaces being judged (0026 P1) */
  story?: ReadonlySet<string>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function entityLine(e: ResolverEntity, h: string): string {
  const [pref, ...rest] = e.names;
  const alias = rest.length ? ` | 별칭: ${rest.slice(0, 8).join(", ")}` : "";
  return `${h} | ${pref ?? e.entityId}${e.disambiguator ? `(${e.disambiguator})` : ""} | ${e.entityType}${e.status === "candidate" ? " | 후보" : ""}${alias}${e.summary ? ` | ${clip(e.summary, 60)}` : ""}`;
}

const SALIENCE_LABEL: Record<SurfaceClass, string> = {
  pronoun: "대명사",
  address: "일반 호칭",
  generic: "일반 명사",
  generic_hint: "일반 명사일 수 있음",
  candidate: "",
};

export function resolverPrompt(items: ResolverItem[], entities: ResolverEntity[], handleOf: Map<string, string>, entityTypes: Iterable<string>): string {
  const ents = entities.map((e) => entityLine(e, handleOf.get(e.entityId)!)).join("\n");
  const ms = items
    .map((it, i) => {
      const h = `M${i + 1}`;
      if (it.pair) {
        return `${h} [중복 확인] ${handleOf.get(it.pair.a) ?? "(목록에 없음)"} 와 ${handleOf.get(it.pair.b) ?? "(목록에 없음)"} 가 같은 대상인가?${it.note ? ` (${it.note})` : ""}`;
      }
      const tags = [
        it.mentionKind,
        it.episodeNo ? `${it.episodeNo}화` : "",
        it.typeHint ? `유형 힌트 ${it.typeHint}` : "",
        SALIENCE_LABEL[it.salience] ? `분류 힌트: ${SALIENCE_LABEL[it.salience]}` : "",
        it.candidateIds.length ? `후보: ${it.candidateIds.map((id) => handleOf.get(id)).filter(Boolean).join(", ")}` : "",
      ].filter(Boolean);
      const ctx = it.contexts.slice(0, 3).map((c) => `   문맥: ${clip(c.replace(/\s+/g, " "), 160)}`);
      return [`${h} "${it.surface}" (${tags.join(", ")})`, ...ctx].join("\n");
    })
    .join("\n");
  return `<entities>\n${ents || "(없음)"}\n</entities>\n\n<entity_types>${[...entityTypes].join(", ")}</entity_types>\n\n<mentions>\n${ms}\n</mentions>`;
}

interface Checked {
  decisions: Map<number, ResolverDecision>;
}

/** deterministic check of one answer: handles, types, coverage, and (설계 추가 0026) no handle in the sentences */
export function checkResolution(value: EntityResolution, items: ResolverItem[], entityByHandle: Map<string, string>, entityTypes: ReadonlySet<string>, guard: ResolutionTextGuard = {}): { result: Checked; issues: RepairIssueDto[] } {
  const issues: RepairIssueDto[] = [];
  const story = guard.story ?? new Set<string>();
  const decisions = new Map<number, ResolverDecision>();
  const ent = (h: string | null | undefined) => (h ? (entityByHandle.get(h.trim().toUpperCase()) ?? null) : null);
  const handleOfId = new Map([...entityByHandle].map(([h, id]) => [id, h]));
  for (const r of value.resolutions) {
    const m = /^M(\d+)$/i.exec(r.mention.trim());
    const idx = m ? Number(m[1]) - 1 : -1;
    const item = items[idx];
    const label = `${r.mention} ${r.action}`;
    if (!item) {
      issues.push({ item: label, problem: `없는 언급 핸들입니다(M1~M${items.length}).` });
      continue;
    }
    if (decisions.has(idx)) continue;
    // 설계 추가 0026: batch-local references → names; a handle still in the rationale (an "E7" copied from the excerpt,
    // a reference of the list that has no usable name) is asked to be rewritten — the decision itself stands, with an
    // empty rationale if the producer does not fix it
    // the entities this judgement is about; a K token of the excerpt itself ("K2 소총") is story text, not a reference
    const own = new Set([r.entity, r.merge_with].map((h) => h?.trim().toUpperCase() ?? "").concat([...item.candidateIds, ...(item.pair ? [item.pair.a, item.pair.b] : [])].map((id) => handleOfId.get(id) ?? "")).filter(Boolean));
    const quoted = new Set([item.surface, ...item.contexts].flatMap((t) => [...t.matchAll(LOCAL_REF)].map((x) => x[0])).filter((h) => !own.has(h)));
    let rationale = rewriteLocalRefs(r.rationale ?? "", guard.names ?? new Map(), new Set([...entityByHandle.keys()].filter((h) => !quoted.has(h))));
    const leaked = [...new Set([...leakedHandleTokens(rationale, story).map((l) => l.token), ...[...rationale.matchAll(LOCAL_REF)].map((x) => x[0]).filter((h) => entityByHandle.has(h) && !quoted.has(h))])];
    if (leaked.length) {
      issues.push({ item: `${label} rationale`, problem: handleLeakIssue(leaked) });
      rationale = "";
    }
    const base: ResolverDecision = { action: r.action, entityId: null, entityType: null, canonicalName: null, mergeWithId: null, confidence: r.confidence, rationale: clip(rationale, 300) };
    if (item.pair) {
      if (r.action !== "merge" && r.action !== "keep_distinct") {
        issues.push({ item: label, problem: "[중복 확인] 항목은 merge 또는 keep_distinct로 답합니다." });
        continue;
      }
      if (r.action === "merge") {
        const keep = ent(r.merge_with) ?? ent(r.entity) ?? item.pair.a;
        if (keep !== item.pair.a && keep !== item.pair.b) {
          issues.push({ item: label, problem: "merge_with는 두 엔티티 가운데 하나여야 합니다." });
          continue;
        }
        base.mergeWithId = keep;
      }
      decisions.set(idx, base);
      continue;
    }
    if (r.action === "keep_distinct") {
      issues.push({ item: label, problem: "keep_distinct는 [중복 확인] 항목에만 씁니다." });
      continue;
    }
    if (r.action === "link_existing" || r.action === "add_alias" || r.action === "merge") {
      const id = ent(r.entity) ?? ent(r.merge_with);
      if (!id) {
        issues.push({ item: label, problem: `entity에 <entities>의 핸들(${resolverHandle(0)}~${resolverHandle(Math.max(0, entityByHandle.size - 1))})을 지정해야 합니다.` });
        continue;
      }
      base.entityId = id;
      if (r.action === "merge") base.action = "add_alias";
    }
    if (r.action === "create_entity") {
      const t = normalizeEntityType(r.entity_type ?? item.typeHint ?? null, entityTypes);
      if (!t) {
        issues.push({ item: label, problem: `entity_type은 <entity_types>의 키(${[...entityTypes].join(", ")}) 가운데 하나여야 합니다.` });
        continue;
      }
      base.entityType = t;
      // 설계 추가 0026 (P5 / P3): a handle is never the name of a new entity, nor part of it
      const canonical = r.canonical_name?.trim() || item.surface;
      // (the judged surface is no exemption: "E12 일행" copied from leaked prose would whitelist E12 for the whole novel)
      const inName = isHandleShaped(canonical) ? [canonical.trim()] : leakedHandleTokens(canonical, story).map((l) => l.token);
      if (inName.length) {
        issues.push({ item: `${label} canonical_name`, problem: `${handleLeakIssue(inName)} 실제 이름을 알 수 없으면 create_entity 대신 link_existing 또는 ignore로 답하세요.` });
        continue;
      }
      base.canonicalName = canonical;
    }
    decisions.set(idx, base);
  }
  items.forEach((it, i) => {
    if (!decisions.has(i) && !issues.some((x) => x.item.startsWith(`M${i + 1} `))) issues.push({ item: `M${i + 1} "${it.surface}"`, problem: "판정이 없습니다." });
  });
  return { result: { decisions }, issues };
}

/** batches of ≤ `linking.agent_resolution_batch_max` items, one model call (+ repair rounds) each */
export async function resolveMentions(o: {
  llm: ModelCallPort | null;
  run: RunHandle;
  items: ResolverItem[];
  entities: ResolverEntity[];
  entityTypes: ReadonlySet<string>;
  /** stable context prefix (ContextPack) */
  system?: string;
  messages?: LlmMessage[];
  /** story tokens of the novel (ontology.storyHandleTokens) */
  story?: ReadonlySet<string>;
  log?: Logger;
}): Promise<ResolverOutcome> {
  const out: ResolverOutcome = { decisions: new Map(), calls: 0, failed: false };
  if (o.items.length === 0) return out;
  if (!o.llm) return { ...out, failed: true };
  const max = Math.max(1, defaultValue("linking.agent_resolution_batch_max"));
  // a [중복 확인] pair with an entity that is not offered (a ghost named after a leaked handle — resolverEntities) has
  // no handle to show: it is not judged (no decision → the question stays open for a person), never merged blind
  const listed = new Set(o.entities.map((e) => e.entityId));
  const items = o.items.filter((it) => !it.pair || (listed.has(it.pair.a) && listed.has(it.pair.b)));
  for (let start = 0; start < items.length; start += max) {
    const batch = items.slice(start, start + max);
    // the entities the batch points at first, then the rest of the dictionary (bounded)
    const wanted = new Set(batch.flatMap((b) => [...b.candidateIds, ...(b.pair ? [b.pair.a, b.pair.b] : [])]));
    const ents = [...o.entities.filter((e) => wanted.has(e.entityId)), ...o.entities.filter((e) => !wanted.has(e.entityId))].slice(0, Math.max(150, wanted.size));
    const handleOf = new Map(ents.map((e, i) => [e.entityId, resolverHandle(i)]));
    const byHandle = new Map(ents.map((e, i) => [resolverHandle(i), e.entityId]));
    const guard: ResolutionTextGuard = {
      names: new Map(ents.map((e, i) => [resolverHandle(i), e.names[0] ?? ""])),
      story: o.story ?? new Set(),
    };
    try {
      out.calls++;
      const r = await callWithRepair({
        llm: o.llm,
        request: {
          run: o.run,
          purpose: "resolve_entities",
          system: `${o.system ? `${o.system}\n\n` : ""}${RESOLVE_SYSTEM}`,
          messages: [...(o.messages ?? []), { role: "user", content: resolverPrompt(batch, ents, handleOf, o.entityTypes) }],
          output: { kind: "object", schemaName: "linking_entity_resolution", schema: entityResolutionSchema },
        },
        validate: (v) => checkResolution(v, batch, byHandle, o.entityTypes, guard),
        label: "엔티티 판정 검증",
        instruction: "각 M 핸들에 대해 하나씩, <entities>에 있는 K 핸들과 <entity_types>의 키만 써서 다시 판정하세요. rationale과 canonical_name에는 핸들·기호 대신 이름을 쓰세요.",
      });
      for (const [i, d] of r.result.decisions) out.decisions.set(batch[i]!.key, d);
    } catch (err) {
      if (err instanceof RunStop || (err as { name?: string }).name === "AbortError") throw err; // stop / pause at a safe point
      out.failed = true;
      if (!(err instanceof NotImplementedError)) o.log?.warn({ runId: o.run.runId, err: (err as Error).message }, "entity resolver call failed; keeping the deterministic path");
    }
  }
  return out;
}
