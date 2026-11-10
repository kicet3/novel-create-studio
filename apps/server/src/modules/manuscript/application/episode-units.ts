/**
 * 설계 추가 0023: 에피소드 묶음 (story episodes) — a plot's consecutive 화 grouped under one title, each 화 titled
 * "<묶음 제목> (n)" (episodes.title stays the display title every reader uses; it is kept in sync here).
 *
 *  - applyGroups: the grouping of a plot (plan_arc in "unit" title mode, or an approved [제목 정리]). Old units of the
 *    plot are retired, every 화 of the plot points at its new unit + part number; titles are rewritten only for the
 *    화 the caller allows (plan: planned 화; 제목 정리: not published, plus published ones the author picked).
 *  - [제목 정리] for existing novels: `plan_arc` with `retitle: true` (planner) proposes the grouping from the 화
 *    outlines / summaries → `episode_titles` approval (before → after in the question). Inbox approval = default
 *    apply (published 화 keep their title); the plot page applies with the author's choice of published 화
 *    (`confirmPublishedRename` required — readers see the new title). Applying switches the novel to "unit" mode.
 */
import { formatUnitEpisodeTitle, type EpisodeTitleMode, type EpisodeUnitDto, type RetitleApplyRequest, type RetitleApplyResult, type RetitleProposalView } from "@ncs/shared";
import { retitleApplyRequestSchema } from "@ncs/shared";
import { AppError, ConflictError, DomainValidationError, NotFoundError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ApprovalDecisionContext } from "../../hitl/index.js";
import type { Arc } from "../../novel/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { unitRepo, type EpisodeUnitRow } from "../adapters/db/unit-repository.js";
import { assignStoryEpisodes, planRetitle, type StoryEpisodeDraft, type StoryEpisodeGroup } from "../domain/episode-units.js";
import type { Episode } from "../index.js";
import { soft, type Ports } from "./support.js";

const ACTIVE = ["pending", "ready", "running", "blocked"] as const;

/** cycle key of the [제목 정리] plan_arc task (engine dedupe is per kind + target + cycle key) */
export const RETITLE_CYCLE_KEY = "retitle";
export const isRetitleTask = (t: { input: unknown }): boolean => {
  const i = t.input as { retitle?: boolean; cycle_key?: string } | null;
  return !!i?.retitle || i?.cycle_key === RETITLE_CYCLE_KEY;
};

export interface UnitInfo {
  unitId: string | null;
  unitTitle: string | null;
  unitPartNo: number | null;
  unitPartCount: number | null;
}

/** the stored proposal of an `episode_titles` approval */
export interface RetitlePayload {
  retitle: { groups: StoryEpisodeGroup[]; from: number; to: number; rationale: string };
}

/** a story-episode view of one 화 for the writing prompts ("이 화는 「X」 에피소드의 n/N화") */
export interface UnitContext {
  title: string;
  partNo: number;
  partCount: number;
  from: number;
  to: number;
  /** the other 화 of the 묶음 with their plans (pacing) */
  siblings: Array<{ episodeNo: number; partNo: number; title: string | null; planSummary: string; status: string }>;
}

export interface EpisodeUnitsApi {
  titleMode(scope: NovelScope, tx?: Tx): Promise<EpisodeTitleMode>;
  listUnits(scope: NovelScope, filter?: { arcId?: string }, tx?: Tx): Promise<EpisodeUnitDto[]>;
  withUnitInfo<E extends Episode>(scope: NovelScope, eps: E[], tx?: Tx): Promise<Array<E & UnitInfo>>;
  unitContext(scope: NovelScope, ep: Episode, tx?: Tx): Promise<UnitContext | null>;
  applyGroups(
    tx: Tx,
    scope: NovelScope,
    arc: Pick<Arc, "id">,
    groups: readonly StoryEpisodeDraft[],
    opts: { rename: (ep: Episode) => boolean; actor: ActorRef; reason: string; approvalId?: string | null },
  ): Promise<{ renamed: Array<{ episodeNo: number; before: string | null; after: string }>; keptPublished: number[] }>;
  requestRetitleApproval(tx: Tx, scope: NovelScope, arcId: string, proposal: RetitlePayload["retitle"], actor: ActorRef, taskId: string | null): Promise<{ approvalId: string | null }>;
  /** approval handler of `episode_titles` */
  decideRetitle(ctx: ApprovalDecisionContext): Promise<void>;
  proposeRetitle(scope: NovelScope, arcId: string, actor: ActorRef, note?: string): Promise<{ taskId: string }>;
  getRetitle(scope: NovelScope, arcId: string): Promise<RetitleProposalView>;
  applyRetitle(scope: NovelScope, arcId: string, input: RetitleApplyRequest, actor: ActorRef): Promise<RetitleApplyResult>;
}

const groupsOfPayload = (payload: unknown): RetitlePayload["retitle"] | null => {
  const r = (payload as Partial<RetitlePayload> | null)?.retitle;
  if (!r || !Array.isArray(r.groups)) return null;
  return r;
};

export function createEpisodeUnits(ports: Ports): EpisodeUnitsApi {
  const { platform, audit, novel, orchestration, hitl } = ports.deps;
  const db = (tx?: Tx) => tx?.db ?? platform.uow.db;
  /** direct apply from the plot page: the author's options for the handler that runs inside acceptAnswer */
  const directOptions = new Map<string, { include: Set<number>; result?: RetitleApplyResult }>();

  const titleMode: EpisodeUnitsApi["titleMode"] = async (scope, tx) => {
    const n = (await novel.getNovel(scope, tx)) as { episodeTitleMode?: EpisodeTitleMode | null };
    return n.episodeTitleMode === "per_episode" ? "per_episode" : "unit";
  };

  const toDto = (u: EpisodeUnitRow, eps: Episode[]): EpisodeUnitDto => {
    const nos = eps.filter((e) => e.unitId === u.id).map((e) => e.episodeNo).sort((a, b) => a - b);
    return {
      id: u.id,
      arcId: u.arcId,
      title: u.title,
      ord: u.ord,
      episodeFrom: nos[0] ?? 0,
      episodeTo: nos[nos.length - 1] ?? 0,
      partCount: u.plannedEpisodeCount,
      episodeNos: nos,
    };
  };

  const listUnits: EpisodeUnitsApi["listUnits"] = async (scope, filter = {}, tx) => {
    const units = await unitRepo.list(db(tx), scope, { arcId: filter.arcId });
    if (!units.length) return [];
    const eps = await repo.listEpisodes(db(tx), scope, filter.arcId ? { arcId: filter.arcId } : {});
    return units.map((u) => toDto(u, eps)).sort((a, b) => (a.episodeFrom || Infinity) - (b.episodeFrom || Infinity) || a.ord - b.ord);
  };

  const withUnitInfo: EpisodeUnitsApi["withUnitInfo"] = async (scope, eps, tx) => {
    const ids = [...new Set(eps.map((e) => e.unitId).filter((x): x is string => !!x))];
    const units = new Map((await unitRepo.list(db(tx), scope, { ids })).map((u) => [u.id, u]));
    return eps.map((e) => {
      const u = e.unitId ? units.get(e.unitId) : undefined;
      return {
        ...e,
        unitId: u ? u.id : null,
        unitTitle: u ? u.title : null,
        unitPartNo: u ? e.unitPartNo : null,
        unitPartCount: u ? u.plannedEpisodeCount : null,
      };
    });
  };

  const unitContext: EpisodeUnitsApi["unitContext"] = async (scope, ep, tx) => {
    if (!ep.unitId || !ep.unitPartNo) return null;
    const [u] = await unitRepo.list(db(tx), scope, { ids: [ep.unitId] });
    if (!u) return null;
    const members = (await repo.listEpisodes(db(tx), scope, { arcId: ep.arcId })).filter((e) => e.unitId === u.id).sort((a, b) => a.episodeNo - b.episodeNo);
    return {
      title: u.title,
      partNo: ep.unitPartNo,
      partCount: u.plannedEpisodeCount,
      from: members[0]?.episodeNo ?? ep.episodeNo,
      to: members[members.length - 1]?.episodeNo ?? ep.episodeNo,
      siblings: members.filter((e) => e.id !== ep.id).map((e) => ({ episodeNo: e.episodeNo, partNo: e.unitPartNo ?? 0, title: e.title, planSummary: e.planSummary, status: e.status })),
    };
  };

  const applyGroups: EpisodeUnitsApi["applyGroups"] = async (tx, scope, arc, raw, opts) => {
    const groups: StoryEpisodeGroup[] = [...raw].sort((a, b) => a.from - b.from).map((g, i) => ({ title: g.title, from: g.from, to: g.to, ord: i + 1 }));
    const eps = await repo.listEpisodes(tx.db, scope, { arcId: arc.id });
    // 화 that keep their title stay in the 묶음 only when the title fits their place; otherwise they keep their current
    // 묶음 and the new one restarts at (1) after them (no "(2)" without a "(1)")
    const { segments, slots } = assignStoryEpisodes(
      groups,
      eps.map((e) => ({ episodeNo: e.episodeNo, title: e.title, renameable: opts.rename(e) })),
    );
    const pinnedUnitIds = [...new Set(eps.filter((e) => slots.get(e.episodeNo)?.kind === "pinned" && e.unitId).map((e) => e.unitId!))];
    await unitRepo.retireArc(tx.db, scope, arc.id, pinnedUnitIds);
    const rows = await unitRepo.insert(
      tx.db,
      segments.map((g) => ({ id: platform.ids.next("epu"), novelId: scope.novelId, arcId: arc.id, title: g.title, ord: g.ord, plannedEpisodeCount: g.episodeNos.length, status: "active" as const })),
    );
    const unitByOrd = new Map(rows.map((r) => [r.ord, r]));
    const renamed: Array<{ episodeNo: number; before: string | null; after: string }> = [];
    const keptPublished: number[] = [];
    const pinnedCount = new Map<string, number>();
    for (const ep of eps) {
      const slot = slots.get(ep.episodeNo);
      if (slot?.kind === "pinned") {
        if (ep.status === "published") keptPublished.push(ep.episodeNo);
        if (ep.unitId) pinnedCount.set(ep.unitId, (pinnedCount.get(ep.unitId) ?? 0) + 1);
        continue; // keeps title, 묶음 and part number
      }
      const unit = slot ? unitByOrd.get(segments[slot.segment]!.ord) : undefined;
      const rename = slot?.kind === "member" && slot.rename;
      await repo.updateEpisode(tx.db, scope, ep.id, {
        unitId: unit?.id ?? null,
        unitPartNo: unit && slot ? slot.partNo : null,
        ...(rename && slot ? { title: slot.title } : {}),
      });
      if (rename && slot) renamed.push({ episodeNo: ep.episodeNo, before: ep.title, after: slot.title });
    }
    // a kept 묶음 that lost 화 to the new grouping counts only the 화 still in it
    for (const [id, n] of pinnedCount) await unitRepo.setCount(tx.db, scope, id, n);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: opts.actor,
      action: "episode.retitled",
      target: { type: "arc", id: arc.id },
      after: { units: segments.map((g) => ({ title: g.title, from: g.from, to: g.to })) },
      details: { reason: opts.reason, renamed, keptPublished, ...(opts.approvalId ? { approvalId: opts.approvalId } : {}) },
    });
    return { renamed, keptPublished };
  };

  const pendingRetitle = async (scope: NovelScope, arcId: string, tx?: Tx) =>
    (await soft(() => hitl.listApprovals(scope, { statuses: ["pending"], types: ["episode_titles"] }, tx), [])).find((a) => a.subjectId === arcId) ?? null;

  const requestRetitleApproval: EpisodeUnitsApi["requestRetitleApproval"] = async (tx, scope, arcId, proposal, actor, taskId) => {
    const arc = await novel.getArc(scope, arcId, tx);
    const eps = await repo.listEpisodes(tx.db, scope, { arcId });
    const items = planRetitle(proposal.groups, eps);
    const line = (i: (typeof items)[number]) =>
      i.excluded
        ? `- ${i.episodeNo}화: ${i.before ?? "(제목 없음)"} (공개됨 — 제목 유지, 묶음에서 빠짐)`
        : `- ${i.episodeNo}화: ${i.before ?? "(제목 없음)"} → ${i.after}${i.unchanged ? " (그대로)" : ""}`;
    const published = items.filter((i) => i.excluded);
    const req = await ports.requestApproval(tx, scope, {
      approvalType: "episode_titles",
      target: { type: "arc", id: arcId },
      question: {
        title: `「${arc.title}」 제목 정리 제안`,
        body: [
          `「${arc.title}」(${proposal.from}~${proposal.to}화)의 화를 에피소드 묶음으로 나눠 「묶음 제목 (1)」「묶음 제목 (2)」처럼 제목을 맞춥니다.`,
          `승인하면 공개 전 화의 제목이 바뀌고, 앞으로 이 작품은 에피소드 묶음 제목 방식으로 계획합니다. 반려하면 아무것도 바뀌지 않습니다.`,
          published.length ? `공개된 화(${published.map((i) => `${i.episodeNo}화`).join(", ")})는 제목을 유지하고 새 묶음에서 빠집니다(묶음은 그다음 화부터 (1)로 시작). 바꾸려면 구성 화면의 [제목 정리]에서 직접 골라 적용하세요.` : "",
          "",
          ...proposal.groups.map((g) => `■ ${g.title} (${g.from === g.to ? `${g.from}화` : `${g.from}~${g.to}화, ${g.to - g.from + 1}화`})`),
          "",
          ...items.slice(0, 40).map(line),
          proposal.rationale ? `\n제안 이유: ${proposal.rationale}` : "",
        ]
          .filter((x, i, a) => x !== "" || a[i - 1] !== "")
          .join("\n"),
        links: [{ type: "arc", id: arcId }],
      },
      requestedBy: actor,
      taskId,
      payload: { retitle: proposal },
    });
    return { approvalId: req.approvalId };
  };

  const applyProposal = async (tx: Tx, scope: NovelScope, arcId: string, proposal: RetitlePayload["retitle"], include: Set<number>, actor: ActorRef, approvalId: string | null): Promise<RetitleApplyResult> => {
    const r = await applyGroups(tx, scope, { id: arcId }, proposal.groups, {
      rename: (ep) => ep.status !== "published" || include.has(ep.episodeNo),
      actor,
      reason: "제목 정리",
      approvalId,
    });
    if ((await titleMode(scope, tx)) !== "unit") await novel.updateSettings(scope, { episodeTitleMode: "unit" }, actor, tx);
    tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
    return { applied: true, renamed: r.renamed, keptPublished: r.keptPublished, episodeTitleMode: "unit" };
  };

  const decideRetitle: EpisodeUnitsApi["decideRetitle"] = async (ctx) => {
    const { tx, scope, approval, actor } = ctx;
    const direct = directOptions.get(approval.id);
    if (ctx.decision !== "approved") {
      if (direct) direct.result = { applied: false, renamed: [], keptPublished: [], episodeTitleMode: await titleMode(scope, tx) };
      return;
    }
    const proposal = groupsOfPayload(approval.payload);
    if (!proposal) return;
    const result = await applyProposal(tx, scope, approval.subjectId, proposal, direct?.include ?? new Set(), actor, approval.id);
    if (direct) direct.result = result;
  };

  const proposeRetitle: EpisodeUnitsApi["proposeRetitle"] = async (scope, arcId, actor, note) => {
    const arc = await novel.getArc(scope, arcId);
    if (arc.status === "cancelled") throw new ConflictError("arc_cancelled", "취소된 플롯은 제목을 정리할 수 없습니다.");
    const eps = await repo.listEpisodes(db(), scope, { arcId });
    if (!eps.length) throw new DomainValidationError("arc_without_episodes", "화 계획이 있는 플롯만 제목을 정리할 수 있습니다.");
    const active = (await orchestration.listTasks(scope, { kinds: ["plan_arc"], targetId: arcId, statuses: [...ACTIVE], limit: 10 })).find(isRetitleTask);
    if (active) return { taskId: active.id };
    const taskId = await platform.uow.run(async (tx) => {
      // own cycle key: never deduped against (or swallowing) a plan / re-plan task of the same plot
      const id = await ports.createTask(tx, scope, {
        kind: "plan_arc",
        targetType: "arc",
        targetId: arcId,
        arcId,
        input: { arc_id: arcId, retitle: true, ...(note?.trim() ? { rejection_note: note.trim() } : {}) },
        cycleKey: RETITLE_CYCLE_KEY,
        createdBy: actor,
        priority: 450,
      });
      tx.afterCommit(() => platform.workSignal.notify("task", scope.novelId));
      return id;
    });
    if (!taskId) throw new AppError(500, "task_not_created", "제목 정리 작업을 만들지 못했습니다.");
    return { taskId };
  };

  const getRetitle: EpisodeUnitsApi["getRetitle"] = async (scope, arcId) => {
    await novel.getArc(scope, arcId);
    const tasks = (await orchestration.listTasks(scope, { kinds: ["plan_arc"], targetId: arcId, includeCancelled: false, limit: 30 }))
      .filter(isRetitleTask)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const active = tasks.find((t) => (ACTIVE as readonly string[]).includes(t.status));
    const last = tasks[0];
    const pending = await pendingRetitle(scope, arcId);
    const proposal = pending ? groupsOfPayload(pending.payload) : null;
    const eps = await repo.listEpisodes(db(), scope, { arcId });
    return {
      arcId,
      task: active ? { id: active.id, status: active.status } : null,
      lastError: !active && last?.status === "failed" ? `제목 정리 제안을 만들지 못했습니다${last.latestRun?.errorMessage ? `: ${last.latestRun.errorMessage}` : "."}`.slice(0, 300) : null,
      proposal:
        pending && proposal
          ? {
              approvalId: pending.id,
              createdAt: pending.createdAt.toISOString(),
              units: proposal.groups.map((g) => ({ title: g.title, from: g.from, to: g.to })),
              items: planRetitle(proposal.groups, eps),
            }
          : null,
    };
  };

  const applyRetitle: EpisodeUnitsApi["applyRetitle"] = async (scope, arcId, raw, actor) => {
    const input = retitleApplyRequestSchema.parse(raw);
    if (actor.type !== "user") throw new DomainValidationError("user_required", "제목 정리는 작가가 직접 적용합니다.");
    const approval = await hitl.getApproval(scope, input.approvalId);
    if (approval.approvalType !== "episode_titles" || approval.subjectId !== arcId) throw new NotFoundError("제목 정리 제안", input.approvalId);
    if (approval.status !== "pending") throw new ConflictError("retitle_not_pending", "이미 처리된 제안입니다. 새로 불러온 뒤 다시 시도하세요.");
    const proposal = groupsOfPayload(approval.payload);
    if (!proposal) throw new NotFoundError("제목 정리 제안", input.approvalId);
    const include = new Set(input.reject ? [] : input.includePublishedEpisodeNos);
    if (include.size) {
      const eps = await repo.listEpisodes(db(), scope, { arcId });
      const published = new Set(eps.filter((e) => e.status === "published").map((e) => e.episodeNo));
      const bad = [...include].filter((no) => !published.has(no));
      if (bad.length) throw new DomainValidationError("not_published_episode", `공개된 화가 아닙니다: ${bad.map((n) => `${n}화`).join(", ")}`);
      if (!input.confirmPublishedRename) {
        throw new DomainValidationError("published_rename_confirmation_required", "공개된 화의 제목을 바꾸면 독자에게 보이는 제목이 바뀝니다. 확인한 뒤 다시 적용하세요.", { episodeNos: [...include] });
      }
    }
    const channels = ports.deps.messaging ? await ports.deps.messaging.preferredChannels(scope) : [];
    const web = channels.find((c) => c.kind === "web");
    if (!web) throw new AppError(500, "web_channel_missing", "웹 인박스 채널이 없습니다.");
    directOptions.set(approval.id, { include });
    try {
      await platform.uow.run(async (tx) => {
        const cur = await hitl.getApproval(scope, approval.id, tx);
        if (cur.status !== "pending") throw new ConflictError("retitle_not_pending", "이미 처리된 제안입니다. 새로 불러온 뒤 다시 시도하세요.");
        await hitl.acceptAnswer(
          scope,
          {
            questionId: cur.questionId,
            channelId: web.id,
            responderUserId: actor.id,
            approval: input.reject ? { decision: "rejected", decisionNote: input.note || "제목 정리 제안을 반려합니다." } : { decision: "approved", ...(input.note ? { decisionNote: input.note } : {}) },
            sourceKey: `web:episode_titles:${approval.id}:${platform.ids.next("ans")}`,
          },
          tx,
        );
      });
      const result = directOptions.get(approval.id)?.result;
      return result ?? { applied: false, renamed: [], keptPublished: [], episodeTitleMode: await titleMode(scope) };
    } finally {
      directOptions.delete(approval.id);
    }
  };

  return { titleMode, listUnits, withUnitInfo, unitContext, applyGroups, requestRetitleApproval, decideRetitle, proposeRetitle, getRetitle, applyRetitle };
}

/** the 화 range a 제목 정리 covers: the existing 화 of the plot */
export function retitleRange(eps: readonly Pick<Episode, "episodeNo">[]): { from: number; to: number } | null {
  if (!eps.length) return null;
  const nos = eps.map((e) => e.episodeNo);
  return { from: Math.min(...nos), to: Math.max(...nos) };
}

export { formatUnitEpisodeTitle };
