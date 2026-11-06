/**
 * Continuity rule catalog (06 §9), dedupe key (03 §3.6), severity adjustment, LLM review schema and
 * reconciliation plan. Pure — no I/O (the hash is an inline FNV-1a, no node:crypto).
 */
import { z } from "zod";
import { ENUMS, type ContinuityIssueKind, type ContinuityIssueStatus, type IssueFixScope, type IssueSeverity } from "@ncs/shared";
import { OPEN_STATUSES } from "./transitions.js";

export interface RuleDef {
  id: string;
  kind: ContinuityIssueKind;
  severity: IssueSeverity;
  /** needs a continuity_editor LLM verdict (violation / not / uncertain) */
  llm: boolean;
  title: string;
}

export const RULES: Readonly<Record<string, RuleDef>> = {
  "CR-01": { id: "CR-01", kind: "death_state", severity: "high", llm: true, title: "사망 인물의 등장·발화·행동" },
  "CR-02": { id: "CR-02", kind: "location_travel", severity: "high", llm: true, title: "장소·이동 시간 모순" },
  "CR-03": { id: "CR-03", kind: "appearance", severity: "medium", llm: true, title: "외형 모순" },
  "CR-04": { id: "CR-04", kind: "age", severity: "medium", llm: false, title: "나이 모순" },
  "CR-05": { id: "CR-05", kind: "relationship", severity: "medium", llm: true, title: "관계 모순" },
  "CR-06": { id: "CR-06", kind: "ability_rule", severity: "high", llm: true, title: "능력·세계 규칙 위반" },
  "CR-07a": { id: "CR-07a", kind: "character_knowledge", severity: "high", llm: true, title: "독자 공개 전 비밀 진술" },
  "CR-07b": { id: "CR-07b", kind: "character_knowledge", severity: "high", llm: true, title: "시점 인물이 모르는 비밀을 앎" },
  "CR-08a": { id: "CR-08a", kind: "identity_leak", severity: "high", llm: true, title: "독자 공개 전 정체 누설" },
  "CR-08b": { id: "CR-08b", kind: "identity_leak", severity: "high", llm: false, title: "정체를 모르는 인물이 본명으로 부름" },
  "CR-09": { id: "CR-09", kind: "schema_violation", severity: "high", llm: false, title: "개수 제약 위반" },
  "CR-10": { id: "CR-10", kind: "schema_violation", severity: "high", llm: false, title: "정의역·치역 위반" },
  "CR-11": { id: "CR-11", kind: "schema_violation", severity: "high", llm: false, title: "시간 제약 위반" },
  "CR-12": { id: "CR-12", kind: "published_canon_conflict", severity: "high", llm: false, title: "공개 사실과 충돌" },
  "CR-13": { id: "CR-13", kind: "answer_constraint", severity: "high", llm: true, title: "답변 제약 위반" },
  "CR-16": { id: "CR-16", kind: "glossary_spelling", severity: "low", llm: false, title: "표기 규칙 위반" },
};

/** LLM-reported issue kinds accepted from the open review (others are produced deterministically) */
export const LLM_REVIEW_KINDS = ["appearance", "age", "relationship", "ability_rule", "location_travel", "death_state", "character_knowledge", "plan_deviation"] as const;

// ── dedupe key (03 §3.6: (episode_id, kind, evidence hash); 06 §9: hash = rule id + sorted evidence ids + entities) ──
function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function evidenceHash(ruleId: string, evidenceIds: readonly string[], entityIds: readonly string[]): string {
  const basis = `${ruleId}|${[...new Set(evidenceIds)].sort().join(",")}|${[...new Set(entityIds)].sort().join(",")}`;
  return fnv1a(basis, 0x811c9dc5).toString(16).padStart(8, "0") + fnv1a(basis, 0x01000193).toString(16).padStart(8, "0");
}

export function dedupeKeyOf(episodeId: string, kind: ContinuityIssueKind, ruleId: string, evidenceIds: readonly string[], entityIds: readonly string[]): string {
  return `${episodeId}:${kind}:${evidenceHash(ruleId, evidenceIds, entityIds)}`;
}

/** 06 §9 severity adjustment: evidence only from earlier-episode candidate facts → low (not for safety / human edit / answer constraints). */
export function adjustSeverity(kind: ContinuityIssueKind, base: IssueSeverity, evidenceCanon: ReadonlyArray<string | null | undefined>): IssueSeverity {
  if (kind.startsWith("safety_") || kind === "human_edit_conflict" || kind === "answer_constraint") return base;
  const statuses = evidenceCanon.filter((s): s is string => !!s);
  if (statuses.length && statuses.every((s) => s === "candidate")) return "low";
  return base;
}

// ── LLM review (continuity_editor) ──
export const continuityReviewSchema = z.object({
  verdicts: z
    .array(
      z.object({
        candidate_id: z.string(),
        verdict: z.enum(["violation", "not_violation", "uncertain"]),
        message: z.string().max(2000).optional(),
        proposed_fix: z.string().max(2000).optional(),
        fix_scope: z.enum(ENUMS.issue_fix_scope).optional(),
        quote: z.string().max(2000).optional(),
      }),
    )
    .default([]),
  issues: z
    .array(
      z.object({
        kind: z.enum(LLM_REVIEW_KINDS),
        severity: z.enum(ENUMS.issue_severity).default("medium"),
        scene_ord: z.number().int().min(1).optional(),
        quote: z.string().max(2000).optional(),
        message: z.string().min(1).max(2000),
        proposed_fix: z.string().max(2000).optional(),
        fix_scope: z.enum(ENUMS.issue_fix_scope).default("span"),
        /** fact handles from [FACTS] (F1, F2 …) — at least one (INV-CI-01) */
        evidence: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type ContinuityReview = z.infer<typeof continuityReviewSchema>;

// ── reconciliation plan (C1 dedupe, C4 reproduce, C3/C5 not reproduced) ──
export interface ExistingIssue {
  id: string;
  dedupeKey: string;
  status: ContinuityIssueStatus;
  manuscriptVersionId: string;
  createdAt: Date;
}

export interface DraftKeyed {
  dedupeKey: string;
}

export type ReconcileStep<D> =
  | { op: "create"; draft: D; previousIssueId: string | null }
  | { op: "relink"; draft: D; issueId: string; reopen: boolean }
  | { op: "skip_waived"; draft: D; issueId: string }
  | { op: "resolve"; issueId: string; from: "open" | "fixing" };

/**
 * Plan how this check's drafts map onto the episode's existing issues (only issues of the kinds the
 * check owns). Open issues detected on the SAME version and not reproduced are left alone (a rerun
 * on identical text is not a fix).
 */
export function planReconcile<D extends DraftKeyed>(drafts: readonly D[], existing: readonly ExistingIssue[], versionId: string): ReconcileStep<D>[] {
  const steps: ReconcileStep<D>[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  const byKey = new Map<string, ExistingIssue[]>();
  for (const e of [...existing].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    byKey.set(e.dedupeKey, [...(byKey.get(e.dedupeKey) ?? []), e]);
  }
  for (const d of drafts) {
    if (seen.has(d.dedupeKey)) continue;
    seen.add(d.dedupeKey);
    const list = byKey.get(d.dedupeKey) ?? [];
    const active = list.find((e) => OPEN_STATUSES.includes(e.status));
    if (active) {
      matched.add(active.id);
      steps.push({ op: "relink", draft: d, issueId: active.id, reopen: active.status === "fixing" });
      continue;
    }
    const decided = list.find((e) => e.status === "waived" || e.status === "false_positive");
    if (decided) {
      steps.push({ op: "skip_waived", draft: d, issueId: decided.id });
      continue;
    }
    steps.push({ op: "create", draft: d, previousIssueId: list[0]?.id ?? null });
  }
  for (const e of existing) {
    if (matched.has(e.id) || !OPEN_STATUSES.includes(e.status)) continue;
    if (e.manuscriptVersionId === versionId) continue;
    steps.push({ op: "resolve", issueId: e.id, from: e.status as "open" | "fixing" });
  }
  return steps;
}

export const FIX_SCOPE_RANK: Record<IssueFixScope, number> = { span: 1, scene: 2, outline: 3 };
export function strongest(scopes: ReadonlyArray<IssueFixScope | null | undefined>): IssueFixScope | undefined {
  let best: IssueFixScope | undefined;
  for (const s of scopes) if (s && (!best || FIX_SCOPE_RANK[s] > FIX_SCOPE_RANK[best])) best = s;
  return best;
}
