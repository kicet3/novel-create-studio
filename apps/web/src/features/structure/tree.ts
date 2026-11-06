/** 구성 화면의 순수 계산: 부 → 플롯 → 화 묶기, 상태 요약, 재승인 사유 문구. */
import type { StoryPartDto, StoryStructureDto, StructureEpisodeDto, StructurePlotDto, StructureView } from "@ncs/shared";

export interface PlotNode {
  plot: StructurePlotDto;
  episodes: StructureEpisodeDto[];
  /** 결말·부 변경 확인 필요 */
  flagged: boolean;
  belowFloorCount: number;
}

export interface PartNode {
  part: StoryPartDto;
  plots: PlotNode[];
  /** 부 범위 안에서 계획된 화 수 */
  plannedEpisodes: number;
  flaggedPlots: number;
}

export interface StructureTree {
  parts: PartNode[];
  /** 부에 연결되지 않은 플롯(구성 이전 작품의 아크) */
  unassigned: PlotNode[];
  cancelled: PlotNode[];
}

const byOrd = <T extends { ord: number }>(a: T, b: T) => a.ord - b.ord;

export function buildTree(view: Pick<StructureView, "structure" | "plots" | "episodes">): StructureTree {
  const epsByArc = new Map<string, StructureEpisodeDto[]>();
  for (const e of [...view.episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
    const list = epsByArc.get(e.arcId) ?? [];
    list.push(e);
    epsByArc.set(e.arcId, list);
  }
  const node = (plot: StructurePlotDto): PlotNode => {
    const episodes = epsByArc.get(plot.id) ?? [];
    return { plot, episodes, flagged: plot.planFlags.length > 0, belowFloorCount: episodes.filter((e) => e.lengthBelowFloor).length };
  };
  const plots = [...view.plots].sort(byOrd);
  const live = plots.filter((p) => p.status !== "cancelled");
  const parts = [...(view.structure?.parts ?? [])].sort(byOrd);
  const partIds = new Set(parts.map((p) => p.id));
  return {
    parts: parts.map((part) => {
      const nodes = live.filter((p) => p.partId === part.id).map(node);
      return {
        part,
        plots: nodes,
        plannedEpisodes: nodes.reduce((n, p) => n + p.episodes.length, 0),
        flaggedPlots: nodes.filter((p) => p.flagged).length,
      };
    }),
    unassigned: live.filter((p) => !p.partId || !partIds.has(p.partId)).map(node),
    cancelled: plots.filter((p) => p.status === "cancelled").map(node),
  };
}

export type StructureDisplayStatus = "none" | "draft" | "awaiting_approval" | "approved" | "reapproval";

/** 승인한 적이 있는데 다시 초안·승인 대기가 되면 "재승인 필요" */
export function displayStatus(s: StoryStructureDto | null): StructureDisplayStatus {
  if (!s) return "none";
  if (s.status === "approved") return "approved";
  if (s.approvedRevision != null) return "reapproval";
  return s.status;
}

export const DISPLAY_STATUS_LABEL: Record<StructureDisplayStatus, string> = {
  none: "구성 없음",
  draft: "초안",
  awaiting_approval: "승인 대기",
  approved: "승인됨",
  reapproval: "재승인 필요",
};

/** 승인 이후 바뀐 내용(재승인 사유) */
export function pendingChangeLines(s: StoryStructureDto | null): string[] {
  if (!s) return [];
  const p = s.pendingChanges;
  const out: string[] = [];
  if (p.ending) out.push("결말이 바뀌었습니다.");
  for (const id of p.partIds ?? []) {
    const part = s.parts.find((x) => x.id === id);
    out.push(part ? `${part.ord}부가 바뀌었습니다.` : "부가 바뀌었습니다.");
  }
  if (p.goalEndingChanged) out.push("연재 목표의 결말 방향이 바뀌었습니다.");
  if (p.regenerated) out.push("AI가 구성을 다시 만들었습니다.");
  return out;
}

/** 홈 단계 카드 상태 */
export type StructureStep = "cast_incomplete" | "blocked" | "create" | "generating" | "draft" | "awaiting_approval" | "approved" | "reapproval";

export function structureStep(v: StructureView): StructureStep {
  if (v.task) return "generating";
  const d = displayStatus(v.structure);
  if (d === "none") {
    // before the concept is approved the cast cannot be edited: the step is "준비 전", not "캐릭터 보완"
    if (!v.gate.cast.complete && !v.gate.codes.includes("concept_not_approved")) return "cast_incomplete";
    return v.gate.canGenerate ? "create" : "blocked";
  }
  return d;
}

export const STRUCTURE_STEP_LABEL: Record<StructureStep, string> = {
  cast_incomplete: "캐릭터 보완 필요",
  blocked: "준비 전",
  create: "만들기",
  generating: "만드는 중",
  draft: "초안",
  awaiting_approval: "승인 대기",
  approved: "승인됨",
  reapproval: "재승인 필요",
};

export function rangeLabel(from: number, to: number): string {
  return from === to ? `${from}화` : `${from}~${to}화`;
}

/** 부 편집기에서 플롯 개요의 화 수 합계가 부 범위와 맞는지 */
export function outlineSumMismatch(from: number, to: number, outline: Array<{ episodeCount: number }>): string | null {
  if (outline.length === 0) return null;
  const want = to - from + 1;
  const sum = outline.reduce((n, o) => n + (Number.isFinite(o.episodeCount) ? o.episodeCount : 0), 0);
  return sum === want ? null : `플롯 화 수 합계(${sum}화)가 부 범위(${want}화)와 다릅니다. 저장하면 서버가 범위에 맞게 다시 나눕니다.`;
}

/** 캐릭터 id → 이름(모르는 id는 "알 수 없는 인물") */
export function nameOf(names: ReadonlyMap<string, string>, id: string): string {
  return names.get(id) ?? "알 수 없는 인물";
}

/** 부 제목 앞의 "1부 —" 같은 순서 표기를 뺀 제목(화면은 따로 "N부"를 붙입니다) */
export function partTitle(title: string): string {
  const t = title.trim();
  const stripped = t.replace(/^(?:제\s*)?[0-9一二三四]+\s*부\s*(?:[—–\-:：.·|]\s*)?/u, "").trim();
  return stripped || t;
}
