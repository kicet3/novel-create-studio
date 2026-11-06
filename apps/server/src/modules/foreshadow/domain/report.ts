/**
 * SetupReport R1–R5 (06 §8.1) and setup metrics (06 §8.2, `computeSetupMetrics`). Pure — the
 * application layer loads rows and calls these functions (no storage: computed on read).
 */
import type { CanonStatus, SetupBeatKind, SetupBeatStatus, SetupImportance, SetupNarrativeStatus } from "@ncs/shared";
import { formatSetupNo } from "./transitions.js";

export interface ReportBeat {
  id: string;
  kind: SetupBeatKind;
  status: SetupBeatStatus;
  plannedEpisodeNo: number | null;
  episodeId: string | null;
  sceneId: string | null;
  charStart: number | null;
  charEnd: number | null;
  confirmedAt: Date | null;
}

export interface ReportSetup {
  id: string;
  displayNo: number;
  title: string;
  importance: SetupImportance;
  narrativeStatus: SetupNarrativeStatus;
  canonStatus: CanonStatus;
  dueKind: "episode" | "arc";
  dueEpisodeNo: number | null;
  dueArcId: string | null;
  createdAt: Date;
  /** decision time of the setup_abandon approval (or best-known abandonment time) */
  abandonedAt: Date | null;
  beats: ReportBeat[];
  dueChanges: Array<{
    fromDueKind: "episode" | "arc" | null;
    fromDueEpisodeNo: number | null;
    fromDueArcId: string | null;
    toDueKind: "episode" | "arc";
    toDueEpisodeNo: number | null;
    toDueArcId: string | null;
    createdAt: Date;
  }>;
}

export interface ReportInput {
  setups: ReportSetup[];
  /** approved/published episodes: episode_no → approved_at */
  approvedAt: ReadonlyMap<number, Date>;
  arcEnds: ReadonlyMap<string, number>;
  asOfEpisodeNo: number | null;
  overdueWindowEpisodes: number;
  /** latest setup_due question per setup */
  dueQuestions: ReadonlyMap<string, { questionId: string; status: string }>;
  contradictions: Array<{ setupId: string | null; issueId: string; issueDisplayNo: number | null; severity: "high" | "medium" | "low"; message: string }>;
}

export function effectiveDue(s: { dueKind: "episode" | "arc"; dueEpisodeNo: number | null; dueArcId: string | null }, arcEnds: ReadonlyMap<string, number>): number | null {
  if (s.dueKind === "episode") return s.dueEpisodeNo;
  return s.dueArcId ? (arcEnds.get(s.dueArcId) ?? null) : null;
}

const IN_SCOPE: readonly CanonStatus[] = ["approved", "published_locked"];

function evidence(s: ReportSetup) {
  return s.beats
    .filter((b) => b.status === "confirmed" || b.status === "detected")
    .map((b) => ({ beatId: b.id, kind: b.kind, episodeId: b.episodeId, sceneId: b.sceneId, charStart: b.charStart, charEnd: b.charEnd }));
}

function base(s: ReportSetup, arcEnds: ReadonlyMap<string, number>) {
  return {
    setupId: s.id,
    displayNo: s.displayNo,
    displayLabel: formatSetupNo(s.displayNo),
    title: s.title,
    importance: s.importance,
    narrativeStatus: s.narrativeStatus,
    dueEpisodeNo: effectiveDue(s, arcEnds),
    evidence: evidence(s),
  };
}

const confirmedCount = (s: ReportSetup, kind: SetupBeatKind) => s.beats.filter((b) => b.kind === kind && b.status === "confirmed").length;

export interface Metric {
  value: number | null;
  numerator: number;
  denominator: number;
}
const metric = (n: number, d: number): Metric => ({ value: d === 0 ? null : n / d, numerator: n, denominator: d });

/** 06 §8.2 — payoff rate, abandon rate, overdue handled rate. */
export function computeSetupMetrics(input: Pick<ReportInput, "setups" | "approvedAt" | "arcEnds" | "asOfEpisodeNo" | "overdueWindowEpisodes">) {
  const cur = input.asOfEpisodeNo;
  const scoped = input.setups.filter((s) => IN_SCOPE.includes(s.canonStatus) || (s.narrativeStatus === "abandoned" && s.canonStatus === "retracted"));
  const dueReached = cur == null ? [] : scoped.filter((s) => s.narrativeStatus !== "planned" && (effectiveDue(s, input.arcEnds) ?? Infinity) <= cur);
  const paid = dueReached.filter((s) => s.narrativeStatus === "paid_off").length;
  const abandoned = dueReached.filter((s) => s.narrativeStatus === "abandoned").length;

  // overdue handling: one event per due value that actually became overdue
  let handled = 0;
  let total = 0;
  for (const s of scoped) {
    if (s.narrativeStatus === "planned") continue;
    const history = dueHistory(s, input.arcEnds);
    const payoffAt = s.beats.filter((b) => b.kind === "payoff" && b.status === "confirmed" && b.confirmedAt).map((b) => b.confirmedAt!.getTime());
    const firstPayoff = payoffAt.length ? Math.min(...payoffAt) : Infinity;
    for (const h of history) {
      if (h.due == null) continue;
      const overdueAt = input.approvedAt.get(h.due + 1)?.getTime();
      if (overdueAt == null) continue; // never became overdue (yet)
      if (overdueAt >= h.validTo) continue; // changed before becoming overdue
      if (firstPayoff < overdueAt) continue; // paid off in time
      const windowEnd = input.approvedAt.get(h.due + input.overdueWindowEpisodes)?.getTime() ?? Infinity;
      const isHandled =
        firstPayoff < windowEnd ||
        s.dueChanges.some((c) => c.createdAt.getTime() >= overdueAt && c.createdAt.getTime() < windowEnd) ||
        (s.narrativeStatus === "abandoned" && s.abandonedAt != null && s.abandonedAt.getTime() < windowEnd);
      if (isHandled) {
        handled++;
        total++;
      } else if (windowEnd !== Infinity) {
        total++;
      }
    }
  }
  return { payoffRate: metric(paid, dueReached.length), abandonRate: metric(abandoned, dueReached.length), overdueHandledRate: metric(handled, total) };
}

/** due values with their validity interval [validFrom, validTo) (ms) */
export function dueHistory(s: ReportSetup, arcEnds: ReadonlyMap<string, number>): Array<{ due: number | null; validFrom: number; validTo: number }> {
  const changes = [...s.dueChanges].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: Array<{ due: number | null; validFrom: number; validTo: number }> = [];
  const first = changes[0];
  const initial = first
    ? effectiveDue({ dueKind: first.fromDueKind ?? s.dueKind, dueEpisodeNo: first.fromDueEpisodeNo, dueArcId: first.fromDueArcId }, arcEnds)
    : effectiveDue(s, arcEnds);
  out.push({ due: initial, validFrom: s.createdAt.getTime(), validTo: first ? first.createdAt.getTime() : Infinity });
  changes.forEach((c, i) => {
    const next = changes[i + 1];
    out.push({
      due: effectiveDue({ dueKind: c.toDueKind, dueEpisodeNo: c.toDueEpisodeNo, dueArcId: c.toDueArcId }, arcEnds),
      validFrom: c.createdAt.getTime(),
      validTo: next ? next.createdAt.getTime() : Infinity,
    });
  });
  return out;
}

/** 06 §8.1 SetupReport */
export function buildSetupReport(input: ReportInput) {
  const cur = input.asOfEpisodeNo;
  const scoped = input.setups.filter((s) => IN_SCOPE.includes(s.canonStatus));
  const unresolved = scoped.filter((s) => s.narrativeStatus === "planted" || s.narrativeStatus === "reinforced");
  const r1 = unresolved.map((s) => {
    const due = effectiveDue(s, input.arcEnds);
    return { ...base(s, input.arcEnds), remainingEpisodes: due != null && cur != null ? due - cur : null, reinforceCount: confirmedCount(s, "reinforce") };
  });
  const r2 = unresolved
    .filter((s) => {
      const due = effectiveDue(s, input.arcEnds);
      return cur != null && due != null && due < cur;
    })
    .map((s) => {
      const q = input.dueQuestions.get(s.id);
      return { ...base(s, input.arcEnds), overdueEpisodes: cur! - effectiveDue(s, input.arcEnds)!, openQuestionId: q?.questionId ?? null, questionStatus: q?.status ?? null };
    });
  const r3 = scoped.filter((s) => s.narrativeStatus === "paid_off" && confirmedCount(s, "reinforce") === 0).map((s) => base(s, input.arcEnds));
  return {
    asOfEpisodeNo: cur,
    r1Unresolved: r1,
    r2Overdue: r2,
    r3PaidOffWithoutReinforce: r3,
    r4ContradictionCandidates: input.contradictions,
    r5Metrics: computeSetupMetrics(input),
  };
}
export type SetupReport = ReturnType<typeof buildSetupReport>;
