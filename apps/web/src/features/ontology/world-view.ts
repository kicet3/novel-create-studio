/** Pure view helpers of the 세계관 온톨로지 후보 panel (unit-tested). */
import type { WorldItemDto, WorldOntologyView } from "@ncs/shared";

export const isGenerating = (s: WorldOntologyView["generation"]["state"]) => s === "queued" || s === "running";

/** one status sentence for the generation card */
export function generationLine(v: Pick<WorldOntologyView, "generation" | "counts" | "groups" | "briefApproved">): string {
  const g = v.generation;
  switch (g.state) {
    case "waiting_brief":
      return "컨셉 브리프가 승인되면 세계관 온톨로지를 자동으로 만듭니다.";
    case "none":
      return "아직 세계관 온톨로지를 만들지 않았습니다. [세계관 생성]을 누르세요.";
    case "queued":
      return "세계관 온톨로지 생성을 기다리는 중입니다…";
    case "running":
      return "세계관 온톨로지를 만드는 중입니다. 세력·장소·체계·역사·규칙을 정리하고 있습니다…";
    case "failed":
      return "세계관 온톨로지를 만들지 못했습니다. [다시 생성]으로 다시 시도하세요.";
    case "done": {
      const total = v.groups.reduce((n, gr) => n + gr.items.length, 0);
      if (!total) return "세계관 온톨로지를 만들었지만 후보가 없습니다. [다시 생성]으로 다시 시도하세요.";
      return v.counts.pending > 0 ? `후보 ${v.counts.pending}개가 검토를 기다립니다.` : "모든 후보를 검토했습니다.";
    }
  }
}

export function statusTone(s: WorldItemDto["status"]): "warn" | "ok" | "neutral" {
  return s === "pending" ? "warn" : s === "approved" ? "ok" : "neutral";
}

/** label of the item's statement: 능력 체계 = 대가, 규칙·제약 = 규칙 */
export function statementLabel(item: Pick<WorldItemDto, "entityType" | "kind">): string {
  return item.entityType === "ability" ? "대가" : "규칙";
}
