/**
 * 전체 구성(1~4부 + 결말) rules (설계 추가). Pure — no I/O.
 *  - exactly STRUCTURE_PART_COUNT parts whose planned ranges cover 1..total contiguously
 *  - each part's plot outline (큰 사건 목록) sums to the part's range
 *  - provenance: `user` fields are never overwritten by an agent proposal (same rule as cast `agentWritable`)
 *  - status machine ST1–ST5 (story_structure_status)
 */
import {
  STRUCTURE_PART_COUNT,
  storyEndingSchema,
  type StoryEnding,
  type StoryStructureDto,
  type StoryStructureStatus,
  type StructurePendingChanges,
} from "@ncs/shared";
import type { StoryPartsRow, StoryStructuresRow } from "@ncs/db/schema";
import { DomainValidationError } from "../../../platform/errors.js";
import { findTransition, type TransitionRule } from "./transitions.js";

export type FieldOrigins = Record<string, "user" | "agent">;

export interface StructureCharacterState {
  characterId: string;
  state: string;
}
export interface PlotOutline {
  title: string;
  coreEvent: string;
  episodeCount: number;
}
export interface PartDraft {
  ord: number;
  title: string;
  goalText: string;
  turningPoints: string[];
  plannedEpisodeFrom: number;
  plannedEpisodeTo: number;
  characterStates: StructureCharacterState[];
  plotOutline: PlotOutline[];
}
export interface StructureProposalInput {
  ending: Partial<StoryEnding>;
  parts: PartDraft[];
  firstAppearances: Array<{ characterId: string; episodeNo: number }>;
  /** which half of the proposal to apply (re-generation by scope) */
  scope?: "all" | "ending" | "parts";
  sourceBibleId?: string | null;
  modelId?: string | null;
}

export const STRUCTURE_TRANSITIONS: readonly TransitionRule<StoryStructureStatus>[] = [
  { id: "ST1", from: ["draft"], to: "awaiting_approval", trigger: "plan_structure commit / 구성 결정 요청 — story_structure 승인 요청" },
  { id: "ST2", from: ["awaiting_approval"], to: "approved", trigger: "story_structure 승인(사용자만)" },
  { id: "ST3", from: ["awaiting_approval"], to: "draft", trigger: "반려 — 사유와 함께 다시 생성" },
  { id: "ST4", from: ["approved"], to: "draft", trigger: "승인된 부·결말 편집, 재생성, 목표 결말 방향 변경 승인" },
  { id: "ST5", from: ["awaiting_approval"], to: "draft", trigger: "승인 대기 중 사용자 편집·재생성 — 대기 승인 취소" },
];
/** guarded transition; `ruleId` picks between rules with the same from/to (ST3 반려 vs ST5 편집) */
export function assertStructureTransition(from: StoryStructureStatus, to: StoryStructureStatus, ruleId?: string): TransitionRule<StoryStructureStatus> {
  const rule = findTransition(STRUCTURE_TRANSITIONS, "story_structure", from, to);
  if (!ruleId) return rule;
  return STRUCTURE_TRANSITIONS.find((r) => r.id === ruleId && r.to === to && r.from.includes(from)) ?? rule;
}

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isEmptyValue);
  return false;
}

/**
 * Agent proposal merge: a field whose origin is `user` and which is not empty is kept; every other non-empty proposed
 * value is taken (origin `agent`). Returns the merged values, origins and the fields skipped because the user set them.
 */
export function mergeAgentFields<T extends Record<string, unknown>>(current: T, origins: FieldOrigins, proposal: Partial<T>): { values: T; origins: FieldOrigins; skipped: string[]; changed: string[] } {
  const values = { ...current };
  const out: FieldOrigins = { ...origins };
  const skipped: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of Object.entries(proposal)) {
    if (v === undefined || isEmptyValue(v)) continue;
    if (origins[k] === "user" && !isEmptyValue(current[k])) {
      skipped.push(k);
      continue;
    }
    if (JSON.stringify(current[k]) === JSON.stringify(v)) continue;
    (values as Record<string, unknown>)[k] = v;
    out[k] = "agent";
    changed.push(k);
  }
  return { values, origins: out, skipped, changed };
}

/** total episodes the structure covers: goal max, else goal min */
export function structureTotal(goal: { totalEpisodesMin: number; totalEpisodesMax: number | null }): number {
  return goal.totalEpisodesMax ?? goal.totalEpisodesMin;
}

const clampInt = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

/** proportional split of `size` episodes over `weights` (each ≥ 1, largest remainder) */
export function distribute(size: number, weights: number[]): number[] {
  const n = Math.min(weights.length, size);
  if (n <= 0) return [];
  const w = weights.slice(0, n).map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  const spare = size - n; // each plot gets 1, the rest proportionally
  const raw = w.map((x) => (spare * x) / sum);
  const out = raw.map((x) => 1 + Math.floor(x));
  let left = size - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k]!.i]! += 1;
  return out;
}

/**
 * Deterministic clean-up of a structure proposal: exactly 4 parts, ranges contiguous over 1..total, plot episode
 * counts summing to each part's range, unknown character ids dropped. Throws `structure_too_short` when total < 4.
 */
export function normalizeStructure(input: StructureProposalInput, ctx: { total: number; characterIds: readonly string[] }): StructureProposalInput {
  const total = ctx.total;
  if (total < STRUCTURE_PART_COUNT) {
    throw new DomainValidationError("structure_too_short", `전체 구성은 ${STRUCTURE_PART_COUNT}부로 나눕니다. 목표 총 화수를 ${STRUCTURE_PART_COUNT}화 이상으로 정하세요.`);
  }
  const known = new Set(ctx.characterIds);
  const byOrd = new Map<number, PartDraft>();
  for (const p of [...input.parts].sort((a, b) => a.ord - b.ord)) {
    const ord = clampInt(p.ord, 1, STRUCTURE_PART_COUNT, 1);
    if (!byOrd.has(ord)) byOrd.set(ord, p);
  }
  // parts given without a usable ord fill the gaps in order
  const rest = input.parts.filter((p) => ![...byOrd.values()].includes(p));
  for (let ord = 1; ord <= STRUCTURE_PART_COUNT; ord++) if (!byOrd.has(ord) && rest.length) byOrd.set(ord, rest.shift()!);
  const parts: PartDraft[] = [];
  let from = 1;
  for (let ord = 1; ord <= STRUCTURE_PART_COUNT; ord++) {
    const p = byOrd.get(ord);
    const remainingParts = STRUCTURE_PART_COUNT - ord;
    const even = Math.round((total * ord) / STRUCTURE_PART_COUNT);
    const to = ord === STRUCTURE_PART_COUNT ? total : clampInt(p?.plannedEpisodeTo, from, total - remainingParts, Math.max(from, Math.min(even, total - remainingParts)));
    const size = to - from + 1;
    const title = (p?.title ?? "").trim();
    const goalText = (p?.goalText ?? "").trim();
    let plots = (p?.plotOutline ?? []).filter((x) => x && (x.title ?? "").trim()).slice(0, 20);
    if (!plots.length) plots = [{ title: title || `${ord}부 핵심 사건`, coreEvent: goalText, episodeCount: size }];
    const counts = distribute(size, plots.map((x) => x.episodeCount));
    plots = plots.slice(0, counts.length).map((x, i) => ({ title: x.title.trim().slice(0, 200), coreEvent: (x.coreEvent ?? "").trim().slice(0, 1000), episodeCount: counts[i]! }));
    const seen = new Set<string>();
    const characterStates = (p?.characterStates ?? []).filter((c) => known.has(c.characterId) && !seen.has(c.characterId) && seen.add(c.characterId) && !!c.state?.trim());
    parts.push({
      ord,
      title: title.slice(0, 200),
      goalText: goalText.slice(0, 2000),
      turningPoints: (p?.turningPoints ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 10),
      plannedEpisodeFrom: from,
      plannedEpisodeTo: to,
      characterStates,
      plotOutline: plots,
    });
    from = to + 1;
  }
  const e = input.ending ?? {};
  const seenFinal = new Set<string>();
  const ending: Partial<StoryEnding> = {
    ...e,
    ...(e.characterFinalStates ? { characterFinalStates: e.characterFinalStates.filter((c) => known.has(c.characterId) && !seenFinal.has(c.characterId) && seenFinal.add(c.characterId) && !!c.finalState?.trim()) } : {}),
    ...(e.foreshadowPayoffs ? { foreshadowPayoffs: e.foreshadowPayoffs.filter((f) => f.setup?.trim()).slice(0, 40) } : {}),
  };
  const seenFirst = new Set<string>();
  const firstAppearances = input.firstAppearances.filter(
    (f) => known.has(f.characterId) && Number.isInteger(f.episodeNo) && f.episodeNo >= 1 && f.episodeNo <= total && !seenFirst.has(f.characterId) && seenFirst.add(f.characterId),
  );
  return { ...input, ending, parts, firstAppearances };
}

export interface PartRange {
  id?: string;
  ord: number;
  plannedEpisodeFrom: number;
  plannedEpisodeTo: number;
}

/** Korean reason when ranges are not 1..n contiguous (null = valid) */
export function validatePartRanges(parts: readonly PartRange[]): string | null {
  const sorted = [...parts].sort((a, b) => a.ord - b.ord);
  if (sorted.length !== STRUCTURE_PART_COUNT) return `부는 ${STRUCTURE_PART_COUNT}개여야 합니다.`;
  let next = 1;
  for (const p of sorted) {
    if (p.plannedEpisodeFrom !== next || p.plannedEpisodeTo < p.plannedEpisodeFrom) return "부의 화 범위는 겹치거나 비지 않고 1화부터 이어져야 합니다.";
    next = p.plannedEpisodeTo + 1;
  }
  return null;
}

/**
 * User range edit of one part: the neighbour boundary moves with it (part i's end → part i+1's start, part i's start
 * → part i-1's end) so the ranges stay contiguous. Throws `part_range_invalid` when the result is not valid.
 */
export function applyPartRangeEdit<T extends PartRange & { id: string }>(parts: readonly T[], partId: string, edit: { from?: number; to?: number }): T[] {
  const sorted = [...parts].sort((a, b) => a.ord - b.ord).map((p) => ({ ...p }));
  const i = sorted.findIndex((p) => p.id === partId);
  if (i < 0) return sorted;
  const p = sorted[i]!;
  if (edit.from !== undefined) {
    p.plannedEpisodeFrom = edit.from;
    if (i > 0) sorted[i - 1]!.plannedEpisodeTo = edit.from - 1;
  }
  if (edit.to !== undefined) {
    p.plannedEpisodeTo = edit.to;
    if (i < sorted.length - 1) sorted[i + 1]!.plannedEpisodeFrom = edit.to + 1;
  }
  const reason = validatePartRanges(sorted);
  if (reason) throw new DomainValidationError("part_range_invalid", "부의 화 범위는 겹치거나 비지 않고 1화부터 이어져야 합니다.");
  return sorted;
}

export interface CompletenessPart extends PartRange {
  title: string;
  goalText: string;
  plotOutline: PlotOutline[];
}

/** Korean reasons the structure cannot be approved yet (empty = complete) */
export function structureCompleteness(
  s: { ending: Partial<StoryEnding>; parts: readonly CompletenessPart[] },
  ctx: { mainCharacters: ReadonlyArray<{ id: string; name: string }>; totalMin: number; totalMax: number | null },
): string[] {
  const out: string[] = [];
  const parts = [...s.parts].sort((a, b) => a.ord - b.ord);
  const rangeReason = validatePartRanges(parts);
  if (rangeReason) out.push(rangeReason);
  for (const p of parts) {
    if (!p.title.trim()) out.push(`${p.ord}부 제목이 비어 있습니다.`);
    if (!p.goalText.trim()) out.push(`${p.ord}부 목표가 비어 있습니다.`);
    if (!p.plotOutline.length) out.push(`${p.ord}부에 플롯(큰 사건)이 없습니다.`);
    else {
      const sum = p.plotOutline.reduce((n, x) => n + x.episodeCount, 0);
      const size = p.plannedEpisodeTo - p.plannedEpisodeFrom + 1;
      if (sum !== size) out.push(`${p.ord}부 플롯 화 수 합계(${sum}화)가 부의 화 범위(${size}화)와 다릅니다.`);
    }
  }
  const last = parts[parts.length - 1];
  if (last && !rangeReason) {
    if (last.plannedEpisodeTo < ctx.totalMin || (ctx.totalMax !== null && last.plannedEpisodeTo > ctx.totalMax)) {
      out.push(`마지막 부의 끝 화(${last.plannedEpisodeTo}화)가 연재 목표의 총 화수(${ctx.totalMax !== null && ctx.totalMax !== ctx.totalMin ? `${ctx.totalMin}~${ctx.totalMax}` : ctx.totalMin}화)와 맞지 않습니다.`);
    }
  }
  const e = storyEndingSchema.parse(s.ending ?? {});
  if (!e.worldState.trim()) out.push("결말: 세계·갈등의 최종 상태가 비어 있습니다.");
  if (!e.conflictResolution.trim()) out.push("결말: 갈등이 어떻게 끝나는지 비어 있습니다.");
  if (!e.protagonistChange.from.trim() || !e.protagonistChange.to.trim()) out.push("결말: 주인공의 변화(시작 → 끝)가 비어 있습니다.");
  const finals = new Map(e.characterFinalStates.map((c) => [c.characterId, c.finalState]));
  for (const c of ctx.mainCharacters) if (!finals.get(c.id)?.trim()) out.push(`결말: ${c.name}의 최종 상태가 없습니다.`);
  return out;
}

export function mergePending(a: StructurePendingChanges, b: StructurePendingChanges): StructurePendingChanges {
  const out: StructurePendingChanges = { ...a };
  if (b.ending) out.ending = true;
  if (b.goalEndingChanged) out.goalEndingChanged = true;
  if (b.regenerated) out.regenerated = true;
  if (b.partIds?.length) out.partIds = [...new Set([...(a.partIds ?? []), ...b.partIds])];
  return out;
}

export type StoryStructureWithParts = StoryStructuresRow & { parts: StoryPartsRow[] };

/** DB rows → API DTO (camelCase, ISO times, ending defaults) */
export function toStoryStructureDto(s: StoryStructureWithParts): StoryStructureDto {
  return {
    id: s.id,
    novelId: s.novelId,
    status: s.status,
    revision: s.revision,
    approvedRevision: s.approvedRevision,
    ending: storyEndingSchema.parse(s.ending ?? {}),
    endingFieldOrigins: s.endingFieldOrigins ?? {},
    firstAppearances: s.firstAppearances ?? [],
    parts: [...s.parts]
      .sort((a, b) => a.ord - b.ord)
      .map((p) => ({
        id: p.id,
        ord: p.ord,
        title: p.title,
        goalText: p.goalText,
        turningPoints: p.turningPoints ?? [],
        plannedEpisodeFrom: p.plannedEpisodeFrom,
        plannedEpisodeTo: p.plannedEpisodeTo,
        characterStates: p.characterStates ?? [],
        plotOutline: p.plotOutline ?? [],
        fieldOrigins: p.fieldOrigins ?? {},
        updatedAt: p.updatedAt.toISOString(),
      })),
    pendingChanges: s.pendingChanges ?? {},
    approvalId: s.approvalId,
    approvedAt: s.approvedAt?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
  };
}
