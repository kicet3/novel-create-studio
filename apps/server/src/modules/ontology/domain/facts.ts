/**
 * Fact model helpers (06 §6.1, §6.6; INV-ONT-05/08/10). Pure.
 *  - story ranges are half-open [from,to), to=null = open-ended
 *  - slot_key: single-valued `s:<subject>|<predicate>`, multi-valued `s:<subject>|<predicate>|<object|value_hash>`;
 *    link-held facts put `?<mention_id>` in the NULL role
 *  - cardinality slots (fact_cardinality_slots rows) for max-1 relations / single-valued attributes
 */
import type { FactKind } from "@ncs/shared";
import { lookupPredicate, type OntologySchemaData, type PredicateDef } from "./base-schema.js";
import { valueHash } from "./normalize.js";

export interface Range {
  from: number;
  to: number | null;
}

export const rangeContains = (r: Range, p: number) => r.from <= p && (r.to === null || p < r.to);
export const rangesOverlap = (a: Range, b: Range) => (a.to === null || b.from < a.to) && (b.to === null || a.from < b.to);
/** overlapping or touching (06 §4.6 "겹치거나 맞닿으면") */
export const rangesTouch = (a: Range, b: Range) => (a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);
export const rangeLiteral = (r: Range) => `[${r.from},${r.to === null ? "" : r.to})`;
export function parseRange(text: string): Range {
  const m = /^\[(-?\d*),(-?\d*)\)$/.exec(text.trim());
  if (!m) {
    if (text.trim() === "empty") return { from: 0, to: 0 };
    throw new TypeError(`Unsupported int4range literal: ${text}`);
  }
  return { from: m[1] === "" ? Number.MIN_SAFE_INTEGER : Number(m[1]), to: m[2] === "" ? null : Number(m[2]) };
}
export function unionRange(a: Range, b: Range): Range {
  return { from: Math.min(a.from, b.from), to: a.to === null || b.to === null ? null : Math.max(a.to, b.to) };
}

export interface FactShape {
  factKind: FactKind;
  subjectEntityId: string | null;
  predicate: string;
  objectEntityId?: string | null;
  objectFactId?: string | null;
  objectNameId?: string | null;
  value?: unknown;
  isNegation?: boolean;
  argMentions?: { subject?: string | null; object?: string | null };
}

export function factKindFor(def: PredicateDef): FactKind {
  return def.kind === "relation" ? def.def.factKind : def.def.factKind;
}

/** INV-ONT-10: symmetric relations are stored with subject < object */
export function canonicalOrientation<T extends FactShape>(schema: OntologySchemaData, f: T): T {
  const p = lookupPredicate(schema, f.predicate);
  if (p?.kind === "relation" && p.def.symmetric && f.subjectEntityId && f.objectEntityId && f.subjectEntityId > f.objectEntityId) {
    return {
      ...f,
      subjectEntityId: f.objectEntityId,
      objectEntityId: f.subjectEntityId,
      argMentions: f.argMentions ? { subject: f.argMentions.object ?? null, object: f.argMentions.subject ?? null } : f.argMentions,
    };
  }
  return f;
}

function subjKey(f: FactShape): string {
  return f.subjectEntityId ?? `?${f.argMentions?.subject ?? "unknown"}`;
}
function objKey(f: FactShape): string {
  if (f.objectEntityId) return f.objectEntityId;
  if (f.objectFactId) return f.objectFactId;
  if (f.objectNameId) return f.objectNameId;
  if (f.argMentions?.object) return `?${f.argMentions.object}`;
  return `#${valueHash(f.value ?? null)}`;
}

export function isSingleValued(schema: OntologySchemaData, predicate: string): boolean {
  const p = lookupPredicate(schema, predicate);
  if (!p) return false;
  return p.kind === "attribute" ? p.def.singleValued : p.def.maxPerSubject === 1 && !p.def.symmetric;
}

export function computeSlotKey(schema: OntologySchemaData, f: FactShape): string {
  const s = subjKey(f);
  if (isSingleValued(schema, f.predicate)) return `s:${s}|${f.predicate}`;
  return `s:${s}|${f.predicate}|${objKey(f)}`;
}

/** true when a role is unresolved (link-held fact; never canon, never gets slot rows) */
export function isLinkHeld(f: FactShape): boolean {
  return f.subjectEntityId === null || (!!f.argMentions?.object && !f.objectEntityId && !f.objectFactId && !f.objectNameId && f.value === undefined);
}

/**
 * Cardinality slots enforced by `fact_cardinality_slots` EXCLUDE (INV-ONT-05). Only for canon facts.
 * `titleMaxHolders(titleId)` returns the title's max_holders (default 1; >1/unbounded → no DB slot, CR-09 checks).
 */
export function cardinalitySlotKeys(schema: OntologySchemaData, f: FactShape, titleMaxHolders?: (titleId: string) => number | "unbounded"): string[] {
  if (f.isNegation || isLinkHeld(f)) return [];
  const p = lookupPredicate(schema, f.predicate);
  if (!p) return [];
  const keys: string[] = [];
  if (p.kind === "attribute") {
    if (p.def.singleValued) keys.push(`s:${f.subjectEntityId}|${f.predicate}`);
    return keys;
  }
  const d = p.def;
  if (d.symmetric) {
    if (d.maxPerSubject === 1 && f.subjectEntityId) keys.push(`s:${f.subjectEntityId}|${d.key}`);
    if (d.maxPerObject === 1 && f.objectEntityId) keys.push(`s:${f.objectEntityId}|${d.key}`);
    return [...new Set(keys)];
  }
  if (d.maxPerSubject === 1 && f.subjectEntityId) keys.push(`s:${f.subjectEntityId}|${d.key}`);
  if (d.maxPerObject === 1 && f.objectEntityId) keys.push(`o:${f.objectEntityId}|${d.key}`);
  if (d.maxPerObject === "title.max_holders" && f.objectEntityId) {
    const max = titleMaxHolders ? titleMaxHolders(f.objectEntityId) : 1;
    if (max === 1) keys.push(`o:${f.objectEntityId}|${d.key}`);
  }
  return keys;
}

/** 06 §6.6 / 07 §4.4 classification against existing (non-rejected) facts of the same timeline */
export type FactDiffKind = "new" | "duplicate" | "transition" | "conflict";

export interface ExistingFactForDiff {
  id: string;
  slotKey: string;
  cardSlots: string[];
  range: Range;
  valueKey: string;
  canon: boolean;
}

export function factValueKey(f: FactShape): string {
  return `${f.objectEntityId ?? ""}|${f.objectFactId ?? ""}|${f.objectNameId ?? ""}|${valueHash(f.value ?? null)}|${f.isNegation ? 1 : 0}`;
}

export function classifyFact(
  schema: OntologySchemaData,
  f: FactShape,
  range: Range,
  existing: ExistingFactForDiff[],
  titleMaxHolders?: (titleId: string) => number | "unbounded",
): { kind: FactDiffKind; againstFactId?: string } {
  if (isLinkHeld(f)) return { kind: "new" };
  const slot = computeSlotKey(schema, f);
  const vk = factValueKey(f);
  const dup = existing.find((e) => e.slotKey === slot && e.valueKey === vk && rangesTouch(e.range, range));
  if (dup) return { kind: "duplicate", againstFactId: dup.id };
  const cards = cardinalitySlotKeys(schema, f, titleMaxHolders);
  if (cards.length === 0) return { kind: "new" };
  const competitors = existing.filter(
    (e) => (e.slotKey !== slot || e.valueKey !== vk) && e.cardSlots.some((k) => cards.includes(k)) && rangesOverlap(e.range, range),
  );
  if (competitors.length === 0) return { kind: "new" };
  // value change that starts after an open-ended prior fact → transition (range_close in the same promotion unit)
  if (competitors.length === 1 && competitors[0]!.range.from < range.from && competitors[0]!.range.to === null) {
    return { kind: "transition", againstFactId: competitors[0]!.id };
  }
  return { kind: "conflict", againstFactId: competitors[0]!.id };
}

/** rendered sentence for prompts / UI (Korean, deterministic) */
export function renderFactText(
  schema: OntologySchemaData,
  f: FactShape & { knowledgeStance?: string | null },
  nameOf: (entityId: string) => string,
  range: Range,
): string {
  const p = lookupPredicate(schema, f.predicate);
  const label = p ? (p.def.key === "appearance" ? `외형(${f.predicate.slice("appearance.".length)})` : p.def.labelKo) : f.predicate;
  const subj = f.subjectEntityId ? nameOf(f.subjectEntityId) : "(미정)";
  let obj: string;
  if (f.objectEntityId) obj = nameOf(f.objectEntityId);
  else if (f.objectFactId) obj = `사실 ${f.objectFactId}`;
  else if (f.objectNameId) obj = `이름 ${f.objectNameId}`;
  else if (f.argMentions?.object) obj = "(미정)";
  else obj = typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? null);
  const neg = f.isNegation ? " (부정)" : "";
  const stance = f.knowledgeStance ? ` [${f.knowledgeStance}]` : "";
  const when = range.to === null ? `${range.from}~` : `${range.from}~${range.to}`;
  return `${subj} — ${label}: ${obj}${stance}${neg} (${when})`;
}
