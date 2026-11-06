/**
 * Deterministic schema validator (06 §4.4, CR-05/09/10/11; SHACL ValidationReport shape). Pure.
 * Produces `schema_violation` findings that continuity turns into issues
 * (`kind=schema_violation`, `detector=schema_validator`, evidence `schema_rule_key` e.g. `base@1:spouse_of:max_per_subject`).
 */
import type { CanonStatus, FactKind } from "@ncs/shared";
import { lookupPredicate, type OntologySchemaData } from "./base-schema.js";
import { rangeContains, rangesOverlap, type Range } from "./facts.js";

export interface ValidatorFact {
  factId: string;
  factKind: FactKind;
  predicate: string;
  subjectEntityId: string | null;
  objectEntityId: string | null;
  objectFactId: string | null;
  objectNameId: string | null;
  value: unknown;
  timelineId: string;
  range: Range;
  canonStatus: CanonStatus;
  isNegation: boolean;
}

export type CrRule = "CR-05" | "CR-09" | "CR-10" | "CR-11";

export interface SchemaFinding {
  factId: string;
  /** e.g. "max_per_object", "domain", "no_new_after_subject_death" */
  rule: string;
  crRule: CrRule;
  /** `<schema>:<predicate>:<rule>` (continuity_issue_evidence.schema_rule_key) */
  schemaRuleKey: string;
  severity: "high" | "medium" | "low";
  message: string;
  relatedFactIds: string[];
}

export interface ValidatorContext {
  schema: OntologySchemaData;
  entityType: (entityId: string) => string | undefined;
  entityName: (entityId: string) => string;
  /** title.max_holders (default 1) */
  titleMaxHolders: (titleEntityId: string) => number | "unbounded";
}

const ACTIVE_STATUSES: CanonStatus[] = ["candidate", "approved", "published_locked"];

export function validateFacts(all: ValidatorFact[], ctx: ValidatorContext, targetIds?: Set<string>): SchemaFinding[] {
  const facts = all.filter((f) => ACTIVE_STATUSES.includes(f.canonStatus) && !f.isNegation && f.subjectEntityId);
  const out: SchemaFinding[] = [];
  const key = ctx.schema.key;
  const n = ctx.entityName;
  const push = (f: SchemaFinding) => {
    if (!targetIds || targetIds.has(f.factId) || f.relatedFactIds.some((id) => targetIds.has(id))) out.push(f);
  };

  // death points per entity & timeline (earliest `life_status=dead`)
  const deathAt = new Map<string, number>();
  for (const f of facts) {
    if (f.predicate === "life_status" && f.value === "dead") {
      const k = `${f.timelineId}|${f.subjectEntityId}`;
      deathAt.set(k, Math.min(deathAt.get(k) ?? Number.POSITIVE_INFINITY, f.range.from));
    }
  }
  const death = (tl: string, e: string | null) => (e ? deathAt.get(`${tl}|${e}`) : undefined);

  for (const f of facts) {
    const p = lookupPredicate(ctx.schema, f.predicate);
    if (!p) {
      push({ factId: f.factId, rule: "unknown_predicate", crRule: "CR-10", schemaRuleKey: `${key}:${f.predicate}:unknown`, severity: "high", message: `스키마에 없는 술어 '${f.predicate}'입니다.`, relatedFactIds: [] });
      continue;
    }
    const d = p.def;
    const sev = d.defaultSeverity;
    const stype = ctx.entityType(f.subjectEntityId!);
    if (stype && !d.domain.includes(stype)) {
      push({ factId: f.factId, rule: "domain", crRule: "CR-10", schemaRuleKey: `${key}:${d.key}:domain`, severity: sev, message: `'${d.labelKo}'의 주어는 ${d.domain.join("·")} 유형이어야 하는데 ${n(f.subjectEntityId!)}은(는) ${stype}입니다.`, relatedFactIds: [] });
    }
    if (p.kind === "relation") {
      const r = p.def;
      if (Array.isArray(r.range)) {
        if (!f.objectEntityId) {
          push({ factId: f.factId, rule: "range", crRule: "CR-10", schemaRuleKey: `${key}:${r.key}:range`, severity: sev, message: `'${r.labelKo}'에는 대상 엔티티가 필요합니다.`, relatedFactIds: [] });
        } else {
          const otype = ctx.entityType(f.objectEntityId);
          if (otype && !r.range.includes(otype)) {
            push({ factId: f.factId, rule: "range", crRule: "CR-10", schemaRuleKey: `${key}:${r.key}:range`, severity: sev, message: `'${r.labelKo}'의 대상은 ${r.range.join("·")} 유형이어야 하는데 ${n(f.objectEntityId)}은(는) ${otype}입니다.`, relatedFactIds: [] });
          }
          if (r.irreflexive && f.objectEntityId === f.subjectEntityId) {
            push({ factId: f.factId, rule: "irreflexive", crRule: "CR-10", schemaRuleKey: `${key}:${r.key}:irreflexive`, severity: "medium", message: `${n(f.subjectEntityId!)}이(가) 자기 자신과 '${r.labelKo}' 관계일 수 없습니다.`, relatedFactIds: [] });
          }
        }
      } else if (r.range === "fact" && !f.objectFactId) {
        push({ factId: f.factId, rule: "range", crRule: "CR-10", schemaRuleKey: `${key}:${r.key}:range`, severity: sev, message: `'${r.labelKo}'에는 대상 사실이 필요합니다.`, relatedFactIds: [] });
      } else if (r.range === "entity_name" && !f.objectNameId) {
        push({ factId: f.factId, rule: "range", crRule: "CR-10", schemaRuleKey: `${key}:${r.key}:range`, severity: sev, message: `'${r.labelKo}'에는 대상 이름이 필요합니다.`, relatedFactIds: [] });
      }
      // temporal rules (CR-11)
      const sd = death(f.timelineId, f.subjectEntityId);
      const od = death(f.timelineId, f.objectEntityId);
      for (const t of r.temporal) {
        if (t === "no_new_after_subject_death" && sd !== undefined && f.range.from > sd && !r.posthumousAllowed) {
          push({ factId: f.factId, rule: t, crRule: "CR-11", schemaRuleKey: `${key}:${r.key}:${t}`, severity: sev, message: `${n(f.subjectEntityId!)}은(는) ${sd} 지점에 사망했는데 그 뒤에 '${r.labelKo}' 관계가 새로 시작됩니다.`, relatedFactIds: [] });
        }
        if (t === "no_new_after_object_death" && od !== undefined && f.range.from > od && !r.posthumousAllowed) {
          push({ factId: f.factId, rule: t, crRule: "CR-11", schemaRuleKey: `${key}:${r.key}:${t}`, severity: sev, message: `${n(f.objectEntityId!)}은(는) ${od} 지점에 사망했는데 그 뒤에 '${r.labelKo}' 관계가 새로 시작됩니다.`, relatedFactIds: [] });
        }
        if ((t === "end_at_or_before_subject_death" || t === "range_within_subject_life") && sd !== undefined && (f.range.to === null || f.range.to > sd)) {
          push({ factId: f.factId, rule: t, crRule: "CR-11", schemaRuleKey: `${key}:${r.key}:${t}`, severity: sev, message: `${n(f.subjectEntityId!)}의 '${r.labelKo}'은(는) 사망 지점(${sd}) 이전에 끝나야 합니다.`, relatedFactIds: [] });
        }
      }
    }
  }

  // pairwise rules: cardinality (CR-09), asymmetric (CR-10), disjoint (CR-05), monotonic (CR-11)
  const byPred = new Map<string, ValidatorFact[]>();
  for (const f of facts) {
    const list = byPred.get(f.predicate) ?? [];
    list.push(f);
    byPred.set(f.predicate, list);
  }
  const seen = new Set<string>();
  const pairOnce = (a: string, b: string, rule: string) => {
    const k = [a, b].sort().join("|") + rule;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  for (const [pred, list] of byPred) {
    const p = lookupPredicate(ctx.schema, pred);
    if (!p) continue;
    if (p.kind === "attribute") {
      const a = p.def;
      if (a.singleValued) {
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++) {
            const x = list[i]!;
            const y = list[j]!;
            if (x.subjectEntityId !== y.subjectEntityId || x.timelineId !== y.timelineId || !rangesOverlap(x.range, y.range)) continue;
            if (JSON.stringify(x.value) === JSON.stringify(y.value)) continue;
            // a state change (life_status, located_at…) is a transition when one starts inside the other open range → CR-09 only when both started at same point or both closed-overlap
            if (x.range.from !== y.range.from && (x.range.to === null || y.range.to === null)) continue;
            if (!pairOnce(x.factId, y.factId, "single")) continue;
            push({ factId: y.factId, rule: "single_valued", crRule: "CR-09", schemaRuleKey: `${ctx.schema.key}:${pred}:single_valued`, severity: a.defaultSeverity, message: `${n(x.subjectEntityId!)}의 '${a.labelKo}' 값이 같은 시점에 둘 이상입니다.`, relatedFactIds: [x.factId] });
          }
        if (a.temporal.includes("monotonic_non_decreasing")) {
          const bySubj = new Map<string, ValidatorFact[]>();
          for (const f of list) bySubj.set(`${f.timelineId}|${f.subjectEntityId}`, [...(bySubj.get(`${f.timelineId}|${f.subjectEntityId}`) ?? []), f]);
          for (const fs of bySubj.values()) {
            const sorted = [...fs].sort((u, v) => u.range.from - v.range.from);
            for (let i = 1; i < sorted.length; i++) {
              const prev = sorted[i - 1]!;
              const cur = sorted[i]!;
              if (typeof prev.value === "number" && typeof cur.value === "number" && cur.value < prev.value) {
                push({ factId: cur.factId, rule: "monotonic_non_decreasing", crRule: "CR-11", schemaRuleKey: `${ctx.schema.key}:${pred}:monotonic_non_decreasing`, severity: a.defaultSeverity, message: `${n(cur.subjectEntityId!)}의 '${a.labelKo}'이(가) 줄어듭니다(${prev.value} → ${cur.value}).`, relatedFactIds: [prev.factId] });
              }
            }
          }
        }
      }
      continue;
    }
    const r = p.def;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!;
        const y = list[j]!;
        if (x.timelineId !== y.timelineId || !rangesOverlap(x.range, y.range)) continue;
        // per subject (for symmetric: either end)
        const ends = (f: ValidatorFact) => (r.symmetric ? [f.subjectEntityId, f.objectEntityId] : [f.subjectEntityId]);
        if (r.maxPerSubject === 1) {
          const shared = ends(x).find((e) => e && ends(y).includes(e));
          const sameFact = x.subjectEntityId === y.subjectEntityId && x.objectEntityId === y.objectEntityId;
          if (shared && !sameFact && pairOnce(x.factId, y.factId, "mps")) {
            push({ factId: y.factId, rule: "max_per_subject", crRule: "CR-09", schemaRuleKey: `${ctx.schema.key}:${r.key}:max_per_subject`, severity: r.defaultSeverity, message: `${n(shared)}의 '${r.labelKo}' 관계가 같은 기간에 둘 이상입니다.`, relatedFactIds: [x.factId] });
          }
        }
        if (r.maxPerObject === 1 && !r.symmetric && x.objectEntityId && x.objectEntityId === y.objectEntityId && x.subjectEntityId !== y.subjectEntityId && pairOnce(x.factId, y.factId, "mpo")) {
          push({ factId: y.factId, rule: "max_per_object", crRule: "CR-09", schemaRuleKey: `${ctx.schema.key}:${r.key}:max_per_object`, severity: r.defaultSeverity, message: `${n(x.objectEntityId)}의 '${r.labelKo}'이(가) 같은 기간에 둘 이상입니다(${n(x.subjectEntityId!)}, ${n(y.subjectEntityId!)}).`, relatedFactIds: [x.factId] });
        }
        if (r.asymmetric && x.subjectEntityId === y.objectEntityId && x.objectEntityId === y.subjectEntityId && pairOnce(x.factId, y.factId, "asym")) {
          push({ factId: y.factId, rule: "asymmetric", crRule: "CR-10", schemaRuleKey: `${ctx.schema.key}:${r.key}:asymmetric`, severity: "medium", message: `${n(x.subjectEntityId!)}와(과) ${n(x.objectEntityId!)} 사이의 '${r.labelKo}' 관계가 양방향으로 함께 성립합니다.`, relatedFactIds: [x.factId] });
        }
      }
    }
    // title max_holders > 1 → count overlapping holders (CR-09); unbounded skips
    if (r.maxPerObject === "title.max_holders") {
      const byTitle = new Map<string, ValidatorFact[]>();
      for (const f of list) if (f.objectEntityId) byTitle.set(`${f.timelineId}|${f.objectEntityId}`, [...(byTitle.get(`${f.timelineId}|${f.objectEntityId}`) ?? []), f]);
      for (const fs of byTitle.values()) {
        const max = ctx.titleMaxHolders(fs[0]!.objectEntityId!);
        if (max === "unbounded") continue;
        for (const f of fs) {
          const at = fs.filter((g) => rangeContains(g.range, f.range.from));
          const holders = new Set(at.map((g) => g.subjectEntityId));
          if (holders.size > max && pairOnce(f.factId, at.map((g) => g.factId).join(","), "holders")) {
            push({ factId: f.factId, rule: "max_holders", crRule: "CR-09", schemaRuleKey: `${ctx.schema.key}:${r.key}:max_holders`, severity: r.defaultSeverity, message: `${n(f.objectEntityId!)} 칭호의 보유자가 ${f.range.from} 지점에 ${holders.size}명으로 최대 ${max}명을 넘습니다.`, relatedFactIds: at.filter((g) => g.factId !== f.factId).map((g) => g.factId) });
          }
        }
      }
    }
    // disjoint_with (CR-05)
    for (const other of r.disjointWith) {
      for (const x of list)
        for (const y of byPred.get(other) ?? []) {
          if (x.timelineId !== y.timelineId || !rangesOverlap(x.range, y.range)) continue;
          const samePair =
            (x.subjectEntityId === y.subjectEntityId && x.objectEntityId === y.objectEntityId) || (x.subjectEntityId === y.objectEntityId && x.objectEntityId === y.subjectEntityId);
          if (samePair && pairOnce(x.factId, y.factId, "disjoint")) {
            push({ factId: x.factId, rule: "disjoint_with", crRule: "CR-05", schemaRuleKey: `${ctx.schema.key}:${r.key}:disjoint_with:${other}`, severity: r.defaultSeverity, message: `${n(x.subjectEntityId!)}와(과) ${n(x.objectEntityId!)}이(가) 같은 기간에 '${r.labelKo}'이면서 '${other}' 관계입니다.`, relatedFactIds: [y.factId] });
          }
        }
    }
  }
  return out;
}
