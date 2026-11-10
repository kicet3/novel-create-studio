/**
 * 설계 추가: 전체 구성(1~4부 + 결말) → 플롯(arcs) → 화.
 *  - plan_structure (planner): 4 parts + structured ending as JSON → novel.saveStructureProposal → story_structure approval (ST1)
 *  - story_structure approval handler (user only, any autonomy level): ST2 + plots created per part (arcs with part_id),
 *    change flags on plots after a re-approval, first appearances → cast, schedule_episodes
 *  - `story_plan` context section: ending, current part goal + per-character stage, current plot, this episode's plan
 *  - structure view / generate / decide / replan use cases (HTTP)
 */
import {
  EPISODE_HARD_MIN_CHARS,
  labelKo,
  storyEndingSchema,
  type StructureView,
} from "@ncs/shared";
import { actors, AppError, ConflictError, DomainValidationError, NotFoundError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ContextSectionProvider } from "../../agents/index.js";
import type { ApprovalDecisionContext } from "../../hitl/index.js";
import { normalizeStructure, structureCompleteness, structureTotal, toStoryStructureDto, distribute, type Arc, type StoryStructureWithParts, type StructureProposalInput } from "../../novel/index.js";
import { TaskFailure } from "../../orchestration/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { planStructureInputSchema, structureProposalSchema, type PlanStructureInput, type StructureProposal } from "../domain/schemas.js";
import { countBasisLabel } from "../domain/text.js";
import type { ManuscriptService, PlanningRosterEntry } from "../index.js";
import { promptOf, type PipelineHandler } from "./agent-task.js";
import type { ManuscriptInternals } from "./manuscript-service.js";
import { isRetitleTask } from "./episode-units.js";
import { castPortOf, soft } from "./support.js";

const PLAN_STRUCTURE_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 승인된 기획서와 확정 캐스트를 바탕으로 작품 전체 구성(1~4부와 결말)을 JSON으로 설계합니다.
- 결말을 먼저 정하고, 각 부가 결말로 가는 단계가 되게 합니다.
- 부는 정확히 4개(ord 1~4)입니다. 부 title에는 "1부", "제1부 —" 같은 순서 표기를 넣지 않고 제목만 씁니다. 화 범위(episode_from~episode_to)는 1화부터 총 화수까지 겹치거나 비지 않게 이어집니다.
- 각 부의 plots는 큰 사건 단위이며 episode_count 합계가 그 부의 화 범위와 같습니다. 플롯 하나에 2화 이상을 권장합니다.
- 인물은 roster의 id(character_id)로만 가리킵니다. 주인공과 서브 주인공마다 부 끝 상태(character_states)와 결말 최종 상태(character_final_states)를 적습니다.
- 결말에는 세계·갈등의 최종 상태, 갈등이 끝나는 방식, 주인공의 변화(시작 → 끝), 회수할 떡밥을 적습니다.
- first_appearances에는 인물마다 첫 등장 화를 적습니다. 연령 등급을 넘는 내용은 넣지 않습니다.
- "기존 구성"이 있으면 사용자 확정(user) 항목은 그대로 두고 나머지만 고칩니다. 반려 사유가 있으면 반영합니다.`;

const ACTIVE = ["pending", "ready", "running", "blocked"] as const;

/** "1부 — 다시 뜬 달", "제2부: 계약자", "Part 3. …" → the title without the ordinal (the UI and inbox add "N부") */
export function stripPartOrdinal(title: string): string {
  const t = title.trim();
  const stripped = t.replace(/^(?:제\s*)?[0-9一二三四]+\s*부\s*(?:[—–\-:：.·|]\s*)?|^part\s*[0-9]+\s*(?:[—–\-:：.·|]\s*)?/iu, "").trim();
  return stripped || t;
}

/**
 * block ref of tasks gated on an unapproved story structure (plan_arc, outline_episode, draft_episode): one stable ref per
 * novel so the tasks are released by the next approval even when the request they waited on was cancelled (ST5) or none
 * existed yet (draft).
 */
export const structureGateRef = (scope: NovelScope) => ({ refType: "novel" as const, refId: scope.novelId });
const mainOf = (roster: PlanningRosterEntry[]) => roster.filter((r) => (r.role === "protagonist" || r.role === "sub_protagonist") && !r.introducedArcId);

export interface StructureApi {
  handlers: Array<PipelineHandler<any, any>>;
  approvalHandlers: { story_structure: (ctx: ApprovalDecisionContext) => Promise<void> };
  section: ContextSectionProvider;
  service: Pick<ManuscriptService, "getStructureView" | "requestStructure" | "decideStructure" | "replanArc">;
  /** ST1 when the structure is a draft; returns the pending approval id */
  requestStructureApproval(tx: Tx, scope: NovelScope, actor: ActorRef, taskId?: string | null): Promise<string | null>;
  /** reasons the structure cannot be generated now (empty = ok) */
  gate(scope: NovelScope, tx?: Tx): Promise<{ reasons: Array<{ code: string; message: string; details?: Record<string, unknown> }>; cast: Awaited<ReturnType<ReturnType<typeof castPortOf>["completeness"]>> }>;
  createPlanStructureTask(tx: Tx, scope: NovelScope, input: { scope: "all" | "ending" | "parts"; instructions?: string | null; rejection_note?: string | null }, actor: ActorRef): Promise<string | null>;
}

/** 설계 추가 0023: "[이번 에피소드] 이 화는 「X」 에피소드의 n/N화 …" (story_plan section + writing prompts) */
export function storyEpisodeLine(episodeNo: number, u: import("../index.js").EpisodeUnitContext): string {
  const role = u.partCount <= 1 ? "한 화로 끝나는 에피소드입니다" : u.partNo === 1 ? "에피소드의 시작 화입니다(사건 도입)" : u.partNo === u.partCount ? "에피소드의 마지막 화입니다(이 에피소드의 사건을 마무리하고 다음 이야기로 넘깁니다)" : "에피소드의 중간 화입니다(사건 전개, 다음 화로 이어지는 훅)";
  const others = u.siblings.map((x) => `(${x.partNo}) ${x.episodeNo}화: ${x.planSummary || "-"}`).join(" / ");
  return `[이번 에피소드] 이 화(${episodeNo}화)는 「${u.title}」 에피소드의 ${u.partNo}/${u.partCount}화 — ${role}.${u.partCount > 1 ? ` 묶음 ${u.from}~${u.to}화. 같은 묶음의 다른 화: ${others}` : ""}`;
}

export function createStructure(m: ManuscriptInternals, getService: () => ManuscriptService): StructureApi {
  const { ports } = m;
  const { novel, orchestration, hitl, platform } = ports.deps;
  const cast = () => castPortOf(ports.reg);
  const db = () => platform.uow.db;

  // ── gate ──
  const gate: StructureApi["gate"] = async (scope, tx) => {
    const reasons: Array<{ code: string; message: string; details?: Record<string, unknown> }> = [];
    const n = await novel.getNovel(scope, tx);
    const goal = await novel.getGoal(scope, tx);
    const bible = await novel.getApprovedBible(scope, tx);
    const c = await cast().completeness(scope, { scope: "initial" }, tx);
    // the order of the real flow: concept → cast → goal → series bible
    if (!n.approvedConceptBriefId) reasons.push({ code: "concept_not_approved", message: "컨셉을 먼저 확정하세요. 컨셉을 확정해야 캐릭터를 편집할 수 있습니다." });
    if (!c.complete) reasons.push({ code: "cast_incomplete", message: c.message, details: { items: c.items } });
    if (!goal) reasons.push({ code: "goal_required", message: "연재 목표를 먼저 저장하세요." });
    if (!bible) reasons.push({ code: "bible_not_approved", message: "기획서를 승인한 뒤에 전체 구성을 만들 수 있습니다." });
    if (goal && structureTotal(goal) < 4) reasons.push({ code: "structure_too_short", message: "전체 구성은 4부로 나눕니다. 목표 총 화수를 4화 이상으로 정하세요." });
    return { reasons, cast: c };
  };

  const createPlanStructureTask: StructureApi["createPlanStructureTask"] = async (tx, scope, input, actor) => {
    return ports.createTask(tx, scope, {
      kind: "plan_structure",
      targetType: "novel",
      targetId: scope.novelId,
      input: { scope: input.scope, instructions: input.instructions ?? null, rejection_note: input.rejection_note ?? null },
      createdBy: actor,
      cycleKey: `structure:${scope.novelId}`,
      priority: 400,
    });
  };

  // ── ST1 ──
  const requestStructureApproval: StructureApi["requestStructureApproval"] = async (tx, scope, actor, taskId) => {
    const s = await novel.getStructure(scope, tx);
    if (!s) return null;
    if (s.status !== "draft") return s.approvalId;
    const ending = storyEndingSchema.parse(s.ending ?? {});
    const parts = [...s.parts].sort((a, b) => a.ord - b.ord);
    const pending = s.pendingChanges ?? {};
    const changes = [
      pending.ending ? "결말이 바뀌었습니다." : "",
      pending.goalEndingChanged ? "연재 목표의 결말 방향이 바뀌었습니다." : "",
      ...(pending.partIds ?? []).map((id) => {
        const p = parts.find((x) => x.id === id);
        return p ? `${p.ord}부가 바뀌었습니다.` : "";
      }),
    ].filter(Boolean);
    const body = [
      s.approvedRevision ? `승인된 구성이 바뀌어 다시 승인이 필요합니다.${changes.length ? `\n${changes.map((c) => `- ${c}`).join("\n")}` : ""}` : "작품 전체 구성(1~4부와 결말)을 확인하세요.",
      "",
      ...parts.map((p) => `${p.ord}부 「${p.title || "제목 없음"}」 ${p.plannedEpisodeFrom}~${p.plannedEpisodeTo}화 — ${p.goalText || "목표 없음"} (플롯 ${(p.plotOutline ?? []).length}개)`),
      "",
      `결말: ${ending.conflictResolution || "(비어 있음)"}`,
      `주인공의 변화: ${ending.protagonistChange.from || "?"} → ${ending.protagonistChange.to || "?"}`,
      "",
      "승인하면 1부부터 플롯 계획을 시작합니다. 반려하면 사유를 적어 주세요.",
    ].join("\n");
    const req = await ports.requestApproval(tx, scope, {
      approvalType: "story_structure",
      target: { type: "novel", id: scope.novelId },
      question: { title: s.approvedRevision ? "바뀐 전체 구성 재승인 요청" : "전체 구성 승인 요청", body, links: [{ type: "novel", id: scope.novelId }] },
      requestedBy: actor,
      taskId: taskId ?? null,
      payload: { structureId: s.id, revision: s.revision, pendingChanges: pending },
    });
    await novel.transitionStructure(tx, scope, "awaiting_approval", actor, req.approvalId ? { approvalId: req.approvalId } : {});
    return req.approvalId;
  };

  // ── plan_structure ──
  const planStructure: PipelineHandler<PlanStructureInput, { proposal: StructureProposalInput; modelId: string; bibleId: string | null }> = {
    kind: "plan_structure",
    role: "planner",
    promptTemplateVersion: "planner.plan_structure@0.1.0",
    inputSchema: planStructureInputSchema,
    allowedWrites: ["novel.saveStructureProposal", "hitl.requestApproval"],
    // 설계 추가(world): approved world ontology + flagged candidates
    context: async () => ({ anchor: { storyPoint: 0, timelineId: "" }, sections: ["cast", "story_plan", "world"] }),
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const c = await cast().completeness(scope, { scope: "initial" });
      if (!c.complete) throw new TaskFailure("internal", c.message, false);
      const n = await novel.getNovel(scope);
      const goal = await novel.getGoal(scope);
      if (!goal) throw new TaskFailure("internal", "연재 목표를 먼저 저장하세요.", false);
      const total = structureTotal(goal);
      if (total < 4) throw new TaskFailure("internal", "전체 구성은 4부로 나눕니다. 목표 총 화수를 4화 이상으로 정하세요.", false);
      const bible = await novel.getApprovedBible(scope);
      const roster = (await cast().roster(scope)).filter((r) => !r.introducedArcId || r.status === "confirmed");
      const existing = await novel.getStructure(scope);
      const bibleContent = (bible?.content ?? {}) as { world?: string; world_rules?: Array<{ statement: string }>; ending_direction?: string };
      const data = JSON.stringify({
        novel: { title: n.title, genre: n.genre, ageRating: n.ageRating },
        goal: { totalEpisodes: total, totalEpisodesMin: goal.totalEpisodesMin, totalEpisodesMax: goal.totalEpisodesMax, endingDirection: goal.endingDirection },
        bible: bible ? { logline: bible.logline, synopsis: bible.synopsis, world: bibleContent.world ?? "", worldRules: (bibleContent.world_rules ?? []).map((r) => r.statement) } : null,
        roster: roster.map((r) => ({ id: r.id, name: r.name, role: r.role, role_label: labelKo("character_role", r.role) })),
        existing: existing ? toStoryStructureDto(existing) : null,
        scope: input.scope,
        instructions: input.instructions ?? null,
        rejection_note: input.rejection_note ?? null,
      });
      const out = await llm.call({
        run,
        purpose: "plan_structure",
        ...promptOf(context, PLAN_STRUCTURE_INSTRUCTION, data),
        output: { kind: "object", schemaName: "StoryStructureProposal", schema: structureProposalSchema },
        maxOutputTokens: 12_000,
        // 설계 추가 0011: facts / genre conventions (novel setting 인터넷 검색); sources stay on the provider call
        webSearch: true,
      });
      const v = out.value as StructureProposal;
      const raw: StructureProposalInput = {
        ending: {
          worldState: v.ending.world_state.trim(),
          conflictResolution: v.ending.conflict_resolution.trim(),
          characterFinalStates: v.ending.character_final_states.map((x) => ({ characterId: x.character_id, finalState: x.final_state.trim() })),
          protagonistChange: { from: v.ending.protagonist_change.from.trim(), to: v.ending.protagonist_change.to.trim() },
          foreshadowPayoffs: v.ending.foreshadow_payoffs.filter((f) => f.setup.trim()).map((f) => ({ setup: f.setup.trim(), payoff: f.payoff.trim(), setupId: null })),
        },
        parts: v.parts.map((p) => ({
          ord: p.ord,
          title: stripPartOrdinal(p.title),
          goalText: p.goal,
          turningPoints: p.turning_points,
          plannedEpisodeFrom: p.episode_from,
          plannedEpisodeTo: p.episode_to,
          characterStates: p.character_states.map((x) => ({ characterId: x.character_id, state: x.state.trim() })),
          plotOutline: p.plots.map((x) => ({ title: x.title, coreEvent: x.core_event, episodeCount: x.episode_count })),
        })),
        firstAppearances: v.first_appearances.map((f) => ({ characterId: f.character_id, episodeNo: f.episode_no })),
      };
      const proposal = normalizeStructure(raw, { total, characterIds: roster.map((r) => r.id) });
      return { proposal: { ...proposal, scope: input.scope }, modelId: out.modelId, bibleId: bible?.id ?? null };
    },
    async commit(tx, run, _input, p) {
      const scope = { novelId: run.novelId };
      const agent = actors.agent("planner", run.runId);
      await novel.saveStructureProposal(tx, scope, { ...p.proposal, sourceBibleId: p.bibleId, modelId: p.modelId }, agent);
      await requestStructureApproval(tx, scope, agent, run.taskId);
      return { kind: "done", outputRefs: [{ refType: "novel", refId: scope.novelId }] };
    },
  };

  // ── plots (arcs) from the approved structure ──
  const syncPlots = async (tx: Tx, scope: NovelScope, s: StoryStructureWithParts, actor: ActorRef) => {
    const pending = s.pendingChanges ?? {};
    let arcs = await novel.listArcs(scope, tx);
    const eps = await repo.listEpisodes(tx.db, scope);
    const epsOf = (arcId: string) => eps.filter((e) => e.arcId === arcId);
    const epCount = (arcId: string) => epsOf(arcId).length;
    const flags = new Map<string, Set<"ending_changed" | "part_changed">>();
    const flag = (a: Arc, f: "ending_changed" | "part_changed") => {
      const set = flags.get(a.id) ?? new Set(a.planFlags ?? []);
      set.add(f);
      flags.set(a.id, set);
    };
    const created: string[] = [];
    const parts = [...s.parts].sort((a, b) => a.ord - b.ord);
    // pass 1 — plots of changed parts follow the new ranges: an empty planned plot is dropped (AR8); a plot that has not
    // started yet (planned / awaiting its plan approval, only planned episodes) is clipped to the part, its planned
    // episodes outside move to the plot that covers them below. Running plots cannot leave their part (part_range_locked).
    const orphans: Array<{ id: string; episodeNo: number; fromArcId: string }> = [];
    for (const part of parts) {
      if (!pending.partIds?.includes(part.id)) continue;
      for (const a of arcs.filter((x) => x.partId === part.id && x.status !== "cancelled")) {
        if (a.status === "planned" && epCount(a.id) === 0) {
          await novel.transitionArc(tx, scope, a.id, "cancelled", actor, { reason: `${part.ord}부 구성 변경` }); // AR8
          continue;
        }
        const from = Math.max(a.plannedEpisodeFrom, part.plannedEpisodeFrom);
        const to = Math.min(a.plannedEpisodeTo, part.plannedEpisodeTo);
        const notStarted = (a.status === "planned" || a.status === "plan_awaiting_approval") && epsOf(a.id).every((e) => e.status === "planned");
        if ((from !== a.plannedEpisodeFrom || to !== a.plannedEpisodeTo) && notStarted) {
          for (const e of epsOf(a.id)) if (e.episodeNo < from || e.episodeNo > to) orphans.push({ id: e.id, episodeNo: e.episodeNo, fromArcId: a.id });
          if (a.status === "plan_awaiting_approval" && a.planApprovalId) await soft(() => hitl.cancelApproval(tx, scope, a.planApprovalId!, "전체 구성 변경", actor), undefined);
          if (from > to) {
            await novel.transitionArc(tx, scope, a.id, "cancelled", actor, { reason: `${part.ord}부 범위 밖으로 밀려남` }); // AR8
            continue;
          }
          if (a.status === "plan_awaiting_approval") await novel.transitionArc(tx, scope, a.id, "planned", actor, { reason: "전체 구성 변경" }); // AR3
          await novel.updateArc(scope, a.id, { plannedEpisodeFrom: from, plannedEpisodeTo: to }, actor, tx);
        }
        flag(a, "part_changed");
      }
    }
    arcs = await novel.listArcs(scope, tx);
    // pass 2 — every episode window of a part that no live plot covers gets plots from the part's outline
    for (const part of parts) {
      const live = arcs.filter((a) => a.status !== "cancelled");
      const inPart = live.filter((a) => a.partId === part.id);
      const windows: Array<[number, number]> = [];
      for (let start = part.plannedEpisodeFrom; start <= part.plannedEpisodeTo; ) {
        const hit = live.find((a) => a.plannedEpisodeFrom <= start && start <= a.plannedEpisodeTo);
        if (hit) {
          start = hit.plannedEpisodeTo + 1;
          continue;
        }
        const nextTaken = live.filter((a) => a.plannedEpisodeFrom > start).reduce((x, a) => Math.min(x, a.plannedEpisodeFrom - 1), part.plannedEpisodeTo);
        const end = Math.min(part.plannedEpisodeTo, nextTaken);
        windows.push([start, end]);
        start = end + 1;
      }
      // outline entries already turned into plots are skipped (an extension uses the remaining ones)
      let outline = (part.plotOutline ?? []).slice(inPart.length);
      let ord = arcs.reduce((x, a) => Math.max(x, a.ord), 0) + 1;
      for (const [wi, [ws, we]] of windows.entries()) {
        const take = wi === windows.length - 1 ? outline : outline.slice(0, 1);
        outline = outline.slice(take.length);
        const list = take.length
          ? take
          : [{ title: inPart.length || wi ? `${part.ord}부 추가 사건` : part.title || `${part.ord}부 핵심 사건`, coreEvent: part.goalText, episodeCount: we - ws + 1 }];
        const counts = distribute(we - ws + 1, list.map((o) => o.episodeCount));
        let from = ws;
        for (const [i, o] of list.slice(0, counts.length).entries()) {
          const to = i === counts.length - 1 ? we : from + counts[i]! - 1;
          const arc = await novel.createArc(
            tx,
            scope,
            { ord: ord++, title: o.title, goalText: o.coreEvent, conflictText: "", endCondition: "", plannedEpisodeFrom: from, plannedEpisodeTo: to, partId: part.id, coreEvent: o.coreEvent },
            actor,
          );
          created.push(arc.id);
          arcs.push(arc);
          from = to + 1;
        }
      }
    }
    // planned episodes pushed out of their plot join the plot that now covers their number (it is planned again)
    const adopted = new Set<string>();
    for (const o of orphans) {
      const target = arcs.find((a) => a.status !== "cancelled" && a.plannedEpisodeFrom <= o.episodeNo && o.episodeNo <= a.plannedEpisodeTo);
      if (!target || target.id === o.fromArcId) continue;
      await repo.updateEpisode(tx.db, scope, o.id, { arcId: target.id });
      await ports.deps.audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "arc.updated",
        target: { type: "arc", id: target.id },
        before: { episodeId: o.id, episodeNo: o.episodeNo, arcId: o.fromArcId },
        after: { episodeId: o.id, episodeNo: o.episodeNo, arcId: target.id },
        reason: "전체 구성 변경으로 화가 이 플롯으로 옮겨졌습니다",
      });
      adopted.add(target.id);
    }
    if (pending.ending || pending.goalEndingChanged) {
      for (const a of arcs) {
        if (!["planned", "plan_awaiting_approval", "active", "awaiting_approval"].includes(a.status) || epCount(a.id) === 0) continue;
        flag(a, "ending_changed");
      }
    }
    const replanned: string[] = [];
    for (const [arcId, set] of flags) {
      const arc = arcs.find((a) => a.id === arcId)!;
      await novel.setArcPlanFlags(tx, scope, arcId, [...set], actor);
      if (arc.status !== "planned" && arc.status !== "plan_awaiting_approval") continue; // active plots: the user decides (replan / keep)
      if (arc.status === "plan_awaiting_approval") {
        if (arc.planApprovalId) await soft(() => hitl.cancelApproval(tx, scope, arc.planApprovalId!, "전체 구성 변경", actor), undefined);
        await novel.transitionArc(tx, scope, arcId, "planned", actor, { reason: "전체 구성 변경" }); // AR3
      }
      const why = [...set].map((f) => labelKo("arc_plan_flag", f)).join(", ");
      await ports.createTask(tx, scope, {
        kind: "plan_arc",
        targetType: "arc",
        targetId: arcId,
        arcId,
        input: { arc_id: arcId, rejection_note: `전체 구성 변경: ${why}. 바뀐 결말·부 목표에 맞게 다시 계획합니다.`, replan: true },
        createdBy: actor,
        priority: 400,
      });
      await novel.setArcPlanFlags(tx, scope, arcId, [], actor);
      replanned.push(arcId);
    }
    for (const arcId of adopted) {
      const arc = arcs.find((a) => a.id === arcId)!;
      if (replanned.includes(arcId) || arc.status !== "planned") continue;
      await ports.createTask(tx, scope, { kind: "plan_arc", targetType: "arc", targetId: arcId, arcId, input: { arc_id: arcId, replan: true, rejection_note: "전체 구성 변경으로 옮겨 온 화를 포함해 이 플롯의 화 계획을 세웁니다." }, createdBy: actor, priority: 400 });
      replanned.push(arcId);
    }
    return { created, flagged: [...flags.keys()], replanned, moved: orphans.length };
  };

  const story_structure = async (ctx: ApprovalDecisionContext) => {
    const { tx, scope, approval, actor } = ctx;
    // 설계 추가 0014: the autopilot may approve it (opt-in "구성·결말도 자동 승인") unless the ending changed after an approval
    if (actor.type !== "user" && !ctx.auto) throw new DomainValidationError("structure_user_only", "전체 구성은 작가가 직접 승인해야 합니다.");
    const s = await novel.getStructure(scope, tx);
    if (!s || s.status !== "awaiting_approval" || (s.approvalId && s.approvalId !== approval.id)) return; // stale approval
    if (ctx.auto && (s.pendingChanges?.ending || s.pendingChanges?.goalEndingChanged)) {
      throw new DomainValidationError("structure_ending_human", "결말이 바뀐 전체 구성은 작가가 직접 다시 승인해야 합니다.");
    }
    // the request names the revision the author was shown; a newer revision is never decided by an older request
    const shown = (approval.payload as { revision?: unknown } | null)?.revision;
    if (typeof shown === "number" && shown !== s.revision) {
      throw new ConflictError("revision_conflict", "승인 요청 뒤에 구성이 바뀌었습니다. 구성 화면에서 바뀐 내용을 확인한 뒤 다시 승인하세요.", { currentRevision: s.revision, requestedRevision: shown });
    }
    if (ctx.decision === "approved") {
      const goal = await novel.getGoal(scope, tx);
      const roster = await cast().roster(scope, tx);
      const reasons = structureCompleteness(s, { mainCharacters: mainOf(roster), totalMin: goal?.totalEpisodesMin ?? 1, totalMax: goal?.totalEpisodesMax ?? null });
      if (reasons.length) throw new DomainValidationError("structure_incomplete", `전체 구성을 승인할 수 없습니다. ${reasons[0]}${reasons.length > 1 ? ` 외 ${reasons.length - 1}건` : ""}`, { reasons });
      const c = await cast().completeness(scope, { scope: "initial" }, tx);
      if (!c.complete) throw new DomainValidationError("cast_incomplete", c.message, { items: c.items });
      const first = !s.approvedRevision;
      await novel.transitionStructure(tx, scope, "approved", actor, { approvalId: approval.id }); // ST2
      const r = await syncPlots(tx, scope, s, actor);
      if (first && (s.firstAppearances ?? []).length) await cast().applyFirstAppearances(tx, scope, s.firstAppearances, actor);
      await soft(() => orchestration.unblockByRef(tx, scope, { refType: "approval", refId: approval.id }, { reason: "approval_decided", keyPrefix: `apr:${approval.id}` }), []);
      // tasks gated on the unapproved structure (plan_arc / outline / draft, STRUCTURE_GATE_REF) run again
      await soft(() => orchestration.unblockByRef(tx, scope, structureGateRef(scope), { reason: "approval_decided", keyPrefix: `structure:${approval.id}` }), []);
      if (goal) await ports.createTask(tx, scope, { kind: "schedule_episodes", targetType: "goal", targetId: goal.id, input: { goal_id: goal.id, reason: "structure_approved" }, createdBy: actor, priority: 400 });
      platform.log.info({ novelId: scope.novelId, ...r }, "story structure approved");
    } else {
      await novel.transitionStructure(tx, scope, "draft", actor, { ruleId: "ST3", reason: ctx.decisionNote ?? undefined, approvalId: approval.id });
      await createPlanStructureTask(tx, scope, { scope: "all", rejection_note: ctx.decisionNote ?? "반려" }, actor);
    }
    tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
  };

  // ── story_plan context section ──
  const section: ContextSectionProvider = {
    section: "story_plan",
    module: "manuscript",
    async build(scope, spec) {
      const s = await novel.getStructure(scope);
      if (!s) return null;
      const roster = await cast().roster(scope);
      const nameOf = (id: string) => roster.find((r) => r.id === id)?.name ?? null;
      const ending = storyEndingSchema.parse(s.ending ?? {});
      const ep = spec.episodeId ? await repo.getEpisode(db(), scope, spec.episodeId) : null;
      const arcId = ep?.arcId ?? spec.arcId ?? null;
      const arc = arcId ? await soft(() => novel.getArc(scope, arcId), null) : null;
      const parts = [...s.parts].sort((a, b) => a.ord - b.ord);
      const part =
        (arc?.partId ? parts.find((p) => p.id === arc.partId) : undefined) ??
        (ep ? parts.find((p) => p.plannedEpisodeFrom <= ep.episodeNo && ep.episodeNo <= p.plannedEpisodeTo) : undefined) ??
        (arc ? parts.find((p) => p.plannedEpisodeFrom <= arc.plannedEpisodeFrom && arc.plannedEpisodeFrom <= p.plannedEpisodeTo) : undefined);
      const lines: string[] = [];
      lines.push(`[결말] 세계·갈등: ${ending.worldState || "-"} / 갈등의 끝: ${ending.conflictResolution || "-"} / 주인공의 변화: ${ending.protagonistChange.from || "?"} → ${ending.protagonistChange.to || "?"}`);
      const finals = ending.characterFinalStates.filter((c) => nameOf(c.characterId));
      if (finals.length) lines.push(`  인물 최종 상태: ${finals.map((c) => `- ${nameOf(c.characterId)}: ${c.finalState}`).join(" ")}`);
      if (ending.foreshadowPayoffs.length) lines.push(`  회수할 떡밥: ${ending.foreshadowPayoffs.map((f) => `- ${f.setup} → ${f.payoff}`).join(" ")}`);
      if (part) {
        lines.push(`[현재 부] ${part.ord}부 「${part.title}」 (${part.plannedEpisodeFrom}~${part.plannedEpisodeTo}화) 목표: ${part.goalText || "-"} / 전환점: ${(part.turningPoints ?? []).join(", ") || "-"}`);
        const states = (part.characterStates ?? []).filter((c) => nameOf(c.characterId));
        if (states.length) lines.push(`  부 끝 인물 상태(이번 부에서 도달할 단계): ${states.map((c) => `- ${nameOf(c.characterId)}: ${c.state}`).join(" ")}`);
      }
      if (arc) {
        const setup = (arc.setupPlan ?? {}) as { plant?: string[]; payoff?: string[] };
        const involved = (arc.involvedCharacterIds ?? []).map(nameOf).filter(Boolean);
        lines.push(
          `[현재 플롯] 「${arc.title}」 (${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화) 핵심 사건: ${arc.coreEvent || arc.goalText || "-"} / 만들어 낼 변화: ${arc.changeText || "-"} / 등장 인물: ${involved.join(", ") || "-"} / 심을 떡밥: ${(setup.plant ?? []).join(", ") || "-"} / 회수할 떡밥: ${(setup.payoff ?? []).join(", ") || "-"}`,
        );
      }
      if (ep) {
        const profile = await m.lengthProfile(scope);
        const target = Math.max(ep.targetChars ?? 0, profile.minChars);
        lines.push(`[이번 화 계획] ${ep.episodeNo}화: ${ep.planSummary || ep.hookNote || "-"} / 씬 ${ep.plannedSceneCount ?? "?"}개 / 목표 ${target}자 이상(${countBasisLabel(profile.countBasis)}, 최소 ${Math.max(EPISODE_HARD_MIN_CHARS, profile.minChars)}자)`);
        // 설계 추가 0023: the 화's place inside its story episode (에피소드 묶음)
        const u = await soft(() => getService().getEpisodeUnitContext(scope, ep), null);
        if (u) lines.push(storyEpisodeLine(ep.episodeNo, u));
      }
      const text = lines.join("\n");
      return { text, tokenEstimate: Math.ceil(text.length / 2), refs: {} };
    },
  };

  // ── use cases ──
  const getStructureView: StructureApi["service"]["getStructureView"] = async (scope) => {
    const s = await novel.getStructure(scope);
    const g = await gate(scope);
    const goal = await novel.getGoal(scope);
    const tasks = (await orchestration.listTasks(scope, { kinds: ["plan_structure"], includeCancelled: false, limit: 20 })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const active = tasks.find((t) => (ACTIVE as readonly string[]).includes(t.status));
    const last = tasks[0];
    const arcs = (await novel.listArcs(scope)).filter((a) => a.status !== "cancelled");
    const eps = await getService().withUnitInfo(scope, await getService().withLengthFlags(scope, await repo.listEpisodes(db(), scope)));
    const units = await getService().listEpisodeUnits(scope);
    const titleMode = ((await novel.getNovel(scope)) as { episodeTitleMode?: "unit" | "per_episode" }).episodeTitleMode ?? "unit";
    const roster = await cast().roster(scope);
    const gapsOf = async (a: Arc) => {
      if (a.status !== "planned" && a.status !== "plan_awaiting_approval") return null;
      if (!roster.some((r) => r.introducedArcId === a.id)) return null;
      const c = await cast().completeness(scope, { scope: "arc", arcId: a.id });
      return c.complete ? null : c;
    };
    const replans = new Map<string, string>();
    const retitles = new Map<string, string>();
    for (const ap of await soft(() => hitl.listApprovals(scope, { statuses: ["pending"], types: ["arc_plan", "episode_titles"] }), [])) {
      if (ap.approvalType === "episode_titles") retitles.set(ap.subjectId, ap.id);
      else if ((ap.payload as { replan?: unknown } | null)?.replan) replans.set(ap.subjectId, ap.id);
    }
    const castGaps = new Map<string, Awaited<ReturnType<typeof gapsOf>>>();
    for (const a of arcs) castGaps.set(a.id, await gapsOf(a));
    const view: StructureView = {
      structure: s ? toStoryStructureDto(s) : null,
      gate: { canGenerate: g.reasons.length === 0, reasons: g.reasons.map((r) => r.message), codes: g.reasons.map((r) => r.code), cast: g.cast },
      task: active ? { id: active.id, status: active.status } : null,
      lastError: !active && last?.status === "failed" ? (last.latestRun?.errorMessage ? `전체 구성을 만들지 못했습니다: ${last.latestRun.errorMessage}`.slice(0, 300) : "전체 구성을 만들지 못했습니다. 다시 시도하세요.") : null,
      plots: arcs.map((a) => {
        const n = eps.filter((e) => e.arcId === a.id).length;
        return {
          ...a,
          setupPlan: { plant: (a.setupPlan as { plant?: string[] })?.plant ?? [], payoff: (a.setupPlan as { payoff?: string[] })?.payoff ?? [] },
          pausedAt: a.pausedAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
          episodeCount: n,
          planningStage: n ? ("episodes_planned" as const) : ("outline" as const),
          castGaps: castGaps.get(a.id) ?? null,
          replanApprovalId: replans.get(a.id) ?? null,
          retitleApprovalId: retitles.get(a.id) ?? null,
        };
      }),
      episodes: eps.map((e) => ({
        id: e.id,
        arcId: e.arcId,
        episodeNo: e.episodeNo,
        title: e.title,
        status: e.status,
        planSummary: e.planSummary,
        plannedSceneCount: e.plannedSceneCount,
        targetChars: e.targetChars,
        lengthBelowFloor: e.lengthBelowFloor,
        unitId: e.unitId,
        unitTitle: e.unitTitle,
        unitPartNo: e.unitPartNo,
        unitPartCount: e.unitPartCount,
      })),
      units,
      episodeTitleMode: titleMode,
      goal: goal ? { totalEpisodesMin: goal.totalEpisodesMin, totalEpisodesMax: goal.totalEpisodesMax, endingDirection: goal.endingDirection } : null,
    };
    return view;
  };

  const requestStructure: StructureApi["service"]["requestStructure"] = async (scope, input, actor) => {
    const g = await gate(scope);
    const first = g.reasons[0];
    if (first) throw new DomainValidationError(first.code, first.message, first.details ?? (g.reasons.length > 1 ? { reasons: g.reasons.map((r) => r.message) } : undefined));
    const active = (await orchestration.listTasks(scope, { kinds: ["plan_structure"], statuses: [...ACTIVE], limit: 5 }))[0];
    if (active) return { taskId: active.id };
    const taskId = await platform.uow.run((tx) => createPlanStructureTask(tx, scope, { scope: input.scope, instructions: input.instructions ?? null }, actor));
    if (!taskId) throw new AppError(500, "task_not_created", "전체 구성 작업을 만들지 못했습니다.");
    return { taskId };
  };

  const decideStructure: StructureApi["service"]["decideStructure"] = async (scope, input, actor) => {
    if (actor.type !== "user") throw new DomainValidationError("structure_user_only", "전체 구성은 작가가 직접 승인해야 합니다.");
    const pre = await novel.getStructure(scope);
    if (!pre) throw new NotFoundError("전체 구성", scope.novelId);
    if (pre.revision !== input.expectedRevision) throw new ConflictError("revision_conflict", "다른 곳에서 구성이 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.", { currentRevision: pre.revision });
    if (pre.status === "approved") throw new ConflictError("structure_not_pending", "이미 승인된 구성이며 바뀐 내용이 없습니다.");
    const channels = ports.deps.messaging ? await ports.deps.messaging.preferredChannels(scope) : [];
    const web = channels.find((c) => c.kind === "web");
    if (!web) throw new AppError(500, "web_channel_missing", "웹 인박스 채널이 없습니다.");
    await platform.uow.run(async (tx) => {
      // re-checked inside the transaction: a plan_structure commit between the read above and here must not be decided
      const cur = await novel.getStructure(scope, tx);
      if (!cur || cur.revision !== input.expectedRevision) {
        throw new ConflictError("revision_conflict", "다른 곳에서 구성이 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.", { currentRevision: cur?.revision ?? null });
      }
      const approvalId = await requestStructureApproval(tx, scope, actor);
      if (!approvalId) throw new AppError(500, "approval_missing", "전체 구성 승인 요청을 만들지 못했습니다.");
      const approval = await hitl.getApproval(scope, approvalId, tx);
      const shown = (approval.payload as { revision?: unknown } | null)?.revision;
      if (typeof shown === "number" && shown !== input.expectedRevision) {
        throw new ConflictError("revision_conflict", "다른 곳에서 구성이 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.", { currentRevision: cur.revision });
      }
      await hitl.acceptAnswer(
        scope,
        {
          questionId: approval.questionId,
          channelId: web.id,
          responderUserId: actor.id,
          approval: { decision: input.decision, ...(input.note ? { decisionNote: input.note } : {}) },
          sourceKey: `web:structure:${approvalId}:${platform.ids.next("ans")}`,
        },
        tx,
      );
    });
    return getStructureView(scope);
  };

  const replanArc: StructureApi["service"]["replanArc"] = async (scope, arcId, note, actor) => {
    const s = await novel.getStructure(scope);
    if (s && s.status !== "approved") throw new DomainValidationError("structure_not_approved", "전체 구성을 승인한 뒤에 플롯을 다시 계획할 수 있습니다.");
    const arc = await novel.getArc(scope, arcId);
    const eps = await repo.listEpisodes(db(), scope, { arcId });
    if (arc.status === "completed" || arc.status === "cancelled" || (arc.status !== "planned" && arc.status !== "plan_awaiting_approval" && !eps.some((e) => e.status === "planned"))) {
      throw new ConflictError("arc_not_replannable", "끝났거나 남은 계획 화가 없는 플롯은 다시 계획할 수 없습니다.");
    }
    const active = (await orchestration.listTasks(scope, { kinds: ["plan_arc"], targetId: arcId, statuses: [...ACTIVE], limit: 10 })).find((t) => !isRetitleTask(t));
    if (active) return { taskId: active.id };
    const taskId = await platform.uow.run(async (tx) => {
      const fresh = await novel.getArc(scope, arcId, tx);
      if (fresh.status === "plan_awaiting_approval") {
        if (fresh.planApprovalId) await soft(() => hitl.cancelApproval(tx, scope, fresh.planApprovalId!, "플롯 재계획", actor), undefined);
        await novel.transitionArc(tx, scope, arcId, "planned", actor, { reason: "플롯 재계획" }); // AR3
      }
      const id = await ports.createTask(tx, scope, {
        kind: "plan_arc",
        targetType: "arc",
        targetId: arcId,
        arcId,
        input: { arc_id: arcId, rejection_note: note?.trim() || "플롯을 다시 계획합니다.", replan: true },
        createdBy: actor,
        priority: 400,
      });
      await novel.setArcPlanFlags(tx, scope, arcId, [], actor);
      tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
      return id;
    });
    if (!taskId) throw new AppError(500, "task_not_created", "플롯 재계획 작업을 만들지 못했습니다.");
    return { taskId };
  };

  return {
    handlers: [planStructure],
    approvalHandlers: { story_structure },
    section,
    service: { getStructureView, requestStructure, decideStructure, replanArc },
    requestStructureApproval,
    gate,
    createPlanStructureTask,
  };
}

