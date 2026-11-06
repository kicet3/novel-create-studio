/**
 * 전체 구성(1~4부 + 결말) storage and transitions (설계 추가, owned by novel like goals / bibles / arcs).
 * Generation, approval and plot creation live in manuscript's planning pipeline (plan_structure, story_structure).
 */
import { STRUCTURE_PART_COUNT, storyEndingSchema, type ArcPlanFlag, type StoryEnding, type StructurePendingChanges } from "@ncs/shared";
import type { StoryPartsRow } from "@ncs/db/schema";
import { ConflictError, DomainValidationError, InvalidTransitionError, NotFoundError, type ActorRef, type NovelScope, type Platform, type Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { NovelApprovalPort, NovelService, StoryPartPatch, StoryStructureWithParts } from "../index.js";
import { novelRepo as repo } from "../adapters/db/novel-repository.js";
import { applyPartRangeEdit, assertStructureTransition, distribute, isEmptyValue, mergeAgentFields, mergePending, type FieldOrigins, type PartDraft, type PlotOutline } from "../domain/structure.js";

/** plot outline scaled to a new part size (each plot ≥ 1 episode) */
const fitPlots = (plots: readonly PlotOutline[], size: number): PlotOutline[] => {
  const counts = distribute(size, plots.map((p) => p.episodeCount));
  return plots.slice(0, counts.length).map((p, i) => ({ ...p, episodeCount: counts[i]! }));
};

type StructureMethods = Pick<
  NovelService,
  "getStructure" | "saveStructureProposal" | "updateStructureEnding" | "updateStoryPart" | "transitionStructure" | "reopenStructure" | "setStructureFirstAppearances" | "setArcPlanFlags"
>;

const PART_FIELDS = ["title", "goalText", "turningPoints", "plannedEpisodeFrom", "plannedEpisodeTo", "characterStates", "plotOutline"] as const;
const ENDING_FIELDS = ["worldState", "conflictResolution", "characterFinalStates", "protagonistChange", "foreshadowPayoffs"] as const;

const partValues = (p: StoryPartsRow): Record<string, unknown> => ({
  title: p.title,
  goalText: p.goalText,
  turningPoints: p.turningPoints ?? [],
  plannedEpisodeFrom: p.plannedEpisodeFrom,
  plannedEpisodeTo: p.plannedEpisodeTo,
  characterStates: p.characterStates ?? [],
  plotOutline: p.plotOutline ?? [],
});

export function createStructureMethods(deps: { platform: Platform; audit: AuditService; approvals: () => NovelApprovalPort | null }): StructureMethods {
  const { platform, audit } = deps;
  const { uow, ids, clock } = platform;
  const novelTarget = (scope: NovelScope) => ({ type: "novel" as const, id: scope.novelId });

  const load = async (db: Tx["db"] | typeof uow.db, scope: NovelScope, forUpdate = false): Promise<StoryStructureWithParts | null> => {
    const s = await repo.getStructure(db, scope, forUpdate);
    if (!s) return null;
    return { ...s, parts: await repo.listParts(db, scope) };
  };
  const mustLoad = async (tx: Tx, scope: NovelScope) => {
    const s = await load(tx.db, scope, true);
    if (!s) throw new NotFoundError("전체 구성", scope.novelId);
    return s;
  };

  const cancelPending = async (tx: Tx, scope: NovelScope, approvalId: string | null, reason: string, actor: ActorRef) => {
    const port = deps.approvals();
    if (!approvalId || !port?.cancelApproval) return;
    try {
      await port.cancelApproval(tx, scope, approvalId, reason, actor);
    } catch (err) {
      // only an approval that is no longer pending (already decided / superseded) is left as it is; anything else
      // (missing approval, database error) fails the edit so no stale request stays in the inbox
      if (!(err instanceof InvalidTransitionError) && !(err instanceof ConflictError)) throw err;
    }
  };

  const transition = async (tx: Tx, scope: NovelScope, to: StoryStructureWithParts["status"], actor: ActorRef, opts: { approvalId?: string; reason?: string; ruleId?: string; pending?: StructurePendingChanges } = {}) => {
    const before = await mustLoad(tx, scope);
    const rule = assertStructureTransition(before.status, to, opts.ruleId);
    const patch: Record<string, unknown> = { status: to };
    if (to === "awaiting_approval") patch.approvalId = opts.approvalId ?? null;
    if (to === "approved") {
      patch.approvedAt = clock.date();
      patch.approvedRevision = before.revision;
      patch.pendingChanges = {};
      if (opts.approvalId) patch.approvalId = opts.approvalId;
    }
    if (to === "draft" && opts.pending) patch.pendingChanges = mergePending(before.pendingChanges ?? {}, opts.pending);
    if (before.status === "awaiting_approval" && to === "draft" && rule.id === "ST5") {
      await cancelPending(tx, scope, before.approvalId, opts.reason ?? "전체 구성이 바뀌었습니다", actor);
    }
    const s = await repo.updateStructure(tx.db, scope, before.id, patch);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "structure.status_changed",
      target: novelTarget(scope),
      before: { status: before.status, revision: before.revision },
      after: { status: to, revision: s.revision },
      reason: opts.reason ?? null,
      approvalId: opts.approvalId ?? null,
      details: { rule: rule.id, structureId: before.id, pendingChanges: s.pendingChanges },
    });
    return s;
  };

  /** user edits / regeneration of a non-draft structure: approved → ST4, awaiting → ST5 (cancels the pending approval) */
  const reopenFor = async (tx: Tx, scope: NovelScope, s: StoryStructureWithParts, pending: StructurePendingChanges, actor: ActorRef, reason: string) => {
    if (s.status === "approved") await transition(tx, scope, "draft", actor, { ruleId: "ST4", pending, reason });
    else if (s.status === "awaiting_approval") await transition(tx, scope, "draft", actor, { ruleId: "ST5", pending: s.approvedRevision ? pending : {}, reason });
    else if (s.approvedRevision) await repo.updateStructure(tx.db, scope, s.id, { pendingChanges: mergePending(s.pendingChanges ?? {}, pending) });
  };

  const methods: StructureMethods = {
    getStructure: (scope, tx) => load(tx?.db ?? uow.db, scope),

    async saveStructureProposal(tx, scope, input, actor) {
      const applyEnding = input.scope !== "parts";
      const applyParts = input.scope !== "ending";
      const current = await load(tx.db, scope, true);
      if (!current) {
        if (input.parts.length !== STRUCTURE_PART_COUNT) throw new DomainValidationError("structure_parts_invalid", `전체 구성은 ${STRUCTURE_PART_COUNT}부여야 합니다.`);
        const ending = storyEndingSchema.parse(input.ending ?? {});
        const endingOrigins: FieldOrigins = {};
        for (const k of ENDING_FIELDS) if (!isEmptyValue(ending[k])) endingOrigins[k] = "agent";
        const id = ids.next("sst");
        await repo.insertStructure(tx.db, {
          id,
          novelId: scope.novelId,
          status: "draft",
          revision: 1,
          ending,
          endingFieldOrigins: endingOrigins,
          firstAppearances: input.firstAppearances,
          pendingChanges: {},
          sourceBibleId: input.sourceBibleId ?? null,
          modelId: input.modelId ?? null,
        });
        await repo.insertParts(
          tx.db,
          input.parts.map((p) => {
            const origins: FieldOrigins = {};
            for (const k of PART_FIELDS) if (!isEmptyValue((p as unknown as Record<string, unknown>)[k])) origins[k] = "agent";
            return { id: ids.next("spt"), novelId: scope.novelId, structureId: id, ...p, fieldOrigins: origins };
          }),
        );
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "structure.created",
          target: novelTarget(scope),
          after: { structureId: id, revision: 1, parts: input.parts.map((p) => ({ ord: p.ord, from: p.plannedEpisodeFrom, to: p.plannedEpisodeTo, plots: p.plotOutline.length })) },
        });
        return (await load(tx.db, scope))!;
      }
      const changedParts: string[] = [];
      let endingChanged = false;
      const skipped: Record<string, string[]> = {};
      if (applyEnding) {
        const cur = storyEndingSchema.parse(current.ending ?? {});
        const m = mergeAgentFields(cur as unknown as Record<string, unknown>, current.endingFieldOrigins ?? {}, input.ending as Record<string, unknown>);
        if (m.skipped.length) skipped.ending = m.skipped;
        if (m.changed.length) {
          endingChanged = true;
          await repo.updateStructure(tx.db, scope, current.id, { ending: m.values as unknown as StoryEnding, endingFieldOrigins: m.origins });
        }
      }
      let rangesKept: string | null = null;
      if (applyParts) {
        // the ranges move together: they are kept as they are when any part has a user range (a partial agent change
        // could overlap it) or when the proposal would push a running plot (active / awaiting / completed) out of its part
        const userRange = (p: StoryPartsRow) => p.fieldOrigins?.plannedEpisodeFrom === "user" || p.fieldOrigins?.plannedEpisodeTo === "user";
        const running = (await repo.listArcs(tx.db, scope)).filter((a) => a.partId && ["active", "awaiting_approval", "completed"].includes(a.status));
        const lockHit = running.find((a) => {
          const part = current.parts.find((p) => p.id === a.partId);
          const prop = part ? input.parts.find((x) => x.ord === part.ord) : undefined;
          return !!prop && (a.plannedEpisodeFrom < prop.plannedEpisodeFrom || a.plannedEpisodeTo > prop.plannedEpisodeTo);
        });
        rangesKept = current.parts.some(userRange) ? "user_range" : lockHit ? "part_range_locked" : null;
        for (const p of current.parts) {
          const proposal = input.parts.find((x) => x.ord === p.ord);
          if (!proposal) continue;
          const origins = p.fieldOrigins ?? {};
          const prop: Partial<PartDraft> = { ...proposal };
          if (rangesKept) {
            delete prop.plannedEpisodeFrom;
            delete prop.plannedEpisodeTo;
            if (origins.plotOutline === "user") delete prop.plotOutline;
            else if (prop.plotOutline?.length) prop.plotOutline = fitPlots(prop.plotOutline, p.plannedEpisodeTo - p.plannedEpisodeFrom + 1); // the user's range wins
          }
          delete (prop as { ord?: number }).ord;
          const m = mergeAgentFields(partValues(p), origins, prop as Record<string, unknown>);
          if (m.skipped.length) skipped[`part${p.ord}`] = m.skipped;
          if (!m.changed.length) continue;
          await repo.updatePart(tx.db, scope, p.id, { ...(m.values as Partial<StoryPartsRow>), fieldOrigins: m.origins });
          changedParts.push(p.id);
        }
      }
      const patch: Record<string, unknown> = { revision: current.revision + 1, modelId: input.modelId ?? current.modelId, sourceBibleId: input.sourceBibleId ?? current.sourceBibleId };
      if (input.firstAppearances.length) {
        const known = new Map((current.firstAppearances ?? []).map((f) => [f.characterId, f.episodeNo]));
        for (const f of input.firstAppearances) if (!known.has(f.characterId)) known.set(f.characterId, f.episodeNo);
        patch.firstAppearances = [...known.entries()].map(([characterId, episodeNo]) => ({ characterId, episodeNo }));
      }
      const firstsChanged = patch.firstAppearances !== undefined && JSON.stringify(patch.firstAppearances) !== JSON.stringify(current.firstAppearances ?? []);
      if (!endingChanged && !changedParts.length && !firstsChanged) {
        // nothing the agent may change differs: an approved / awaiting structure stays as it is (no reopen, no revision)
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "structure.updated",
          target: novelTarget(scope),
          before: { revision: current.revision, status: current.status },
          after: { revision: current.revision, status: current.status },
          details: { source: "agent", scope: input.scope ?? "all", unchanged: true, skippedUserFields: skipped, rangesKept },
        });
        return (await load(tx.db, scope))!;
      }
      const pending: StructurePendingChanges = { regenerated: true, ...(endingChanged ? { ending: true } : {}), ...(changedParts.length ? { partIds: changedParts } : {}) };
      await reopenFor(tx, scope, current, pending, actor, "AI로 다시 만든 구성"); // before the revision bump (approved ⇒ approved_revision = revision)
      await repo.updateStructure(tx.db, scope, current.id, patch);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "structure.updated",
        target: novelTarget(scope),
        before: { revision: current.revision, status: current.status },
        after: { revision: current.revision + 1 },
        details: { source: "agent", scope: input.scope ?? "all", endingChanged, changedParts, skippedUserFields: skipped, rangesKept },
      });
      return (await load(tx.db, scope))!;
    },

    updateStructureEnding(scope, patch, expectedRevision, actor) {
      return uow.run(async (tx) => {
        const s = await mustLoad(tx, scope);
        if (s.revision !== expectedRevision) {
          throw new ConflictError("revision_conflict", "다른 곳에서 구성이 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.", { currentRevision: s.revision });
        }
        const cur = storyEndingSchema.parse(s.ending ?? {});
        const next = storyEndingSchema.parse({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
        const changed = ENDING_FIELDS.filter((k) => patch[k] !== undefined && JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
        if (!changed.length) return s;
        const origins: FieldOrigins = { ...(s.endingFieldOrigins ?? {}) };
        for (const k of changed) {
          if (isEmptyValue(next[k])) delete origins[k];
          else origins[k] = "user";
        }
        await reopenFor(tx, scope, s, { ending: true }, actor, "결말 편집");
        await repo.updateStructure(tx.db, scope, s.id, { ending: next, endingFieldOrigins: origins, revision: s.revision + 1 });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "structure.updated",
          target: novelTarget(scope),
          before: { revision: s.revision, ending: Object.fromEntries(changed.map((k) => [k, cur[k]])) },
          after: { revision: s.revision + 1, ending: Object.fromEntries(changed.map((k) => [k, next[k]])) },
          details: { source: "user", fields: changed },
        });
        return (await load(tx.db, scope))!;
      });
    },

    updateStoryPart(scope, partId, patch: StoryPartPatch, expectedRevision, actor) {
      return uow.run(async (tx) => {
        const s = await mustLoad(tx, scope);
        if (s.revision !== expectedRevision) {
          throw new ConflictError("revision_conflict", "다른 곳에서 구성이 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.", { currentRevision: s.revision });
        }
        const part = s.parts.find((p) => p.id === partId);
        if (!part) throw new NotFoundError("부", partId);
        const rangeEdit = patch.plannedEpisodeFrom !== undefined || patch.plannedEpisodeTo !== undefined;
        const ranges = rangeEdit
          ? applyPartRangeEdit(
              s.parts.map((p) => ({ id: p.id, ord: p.ord, plannedEpisodeFrom: p.plannedEpisodeFrom, plannedEpisodeTo: p.plannedEpisodeTo })),
              partId,
              { from: patch.plannedEpisodeFrom, to: patch.plannedEpisodeTo },
            )
          : null;
        if (ranges) {
          // a running plot (active / awaiting / completed) must stay inside its part
          const arcs = (await repo.listArcs(tx.db, scope)).filter((a) => a.partId && ["active", "awaiting_approval", "completed"].includes(a.status));
          for (const a of arcs) {
            const r = ranges.find((x) => x.id === a.partId);
            if (r && (a.plannedEpisodeFrom < r.plannedEpisodeFrom || a.plannedEpisodeTo > r.plannedEpisodeTo)) {
              throw new DomainValidationError("part_range_locked", "이미 진행 중인 화가 있는 범위는 줄일 수 없습니다.", { arcId: a.id });
            }
          }
        }
        const changedIds: string[] = [];
        const beforeVals: Record<string, Record<string, unknown>> = {};
        const afterVals: Record<string, Record<string, unknown>> = {};
        for (const p of s.parts) {
          const cur = partValues(p);
          const next: Record<string, unknown> = {};
          if (p.id === partId) for (const k of PART_FIELDS) if (patch[k] !== undefined) next[k] = patch[k];
          const r = ranges?.find((x) => x.id === p.id);
          if (r) {
            next.plannedEpisodeFrom = r.plannedEpisodeFrom;
            next.plannedEpisodeTo = r.plannedEpisodeTo;
            // a new range re-spreads the plot episode counts unless the user sends the outline too
            const size = r.plannedEpisodeTo - r.plannedEpisodeFrom + 1;
            if (next.plotOutline === undefined && (p.plotOutline ?? []).length && size !== p.plannedEpisodeTo - p.plannedEpisodeFrom + 1) next.plotOutline = fitPlots(p.plotOutline, size);
          }
          const diffKeys = Object.keys(next).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
          if (!diffKeys.length) continue;
          const origins: FieldOrigins = { ...(p.fieldOrigins ?? {}) };
          const autoPlots = p.id !== partId || patch.plotOutline === undefined;
          for (const k of diffKeys) {
            if (k === "plotOutline" && autoPlots) continue; // re-spread counts keep the outline's origin
            if (isEmptyValue(next[k])) delete origins[k];
            else origins[k] = "user";
          }
          await repo.updatePart(tx.db, scope, p.id, { ...(Object.fromEntries(diffKeys.map((k) => [k, next[k]])) as Partial<StoryPartsRow>), fieldOrigins: origins });
          changedIds.push(p.id);
          beforeVals[`part${p.ord}`] = Object.fromEntries(diffKeys.map((k) => [k, cur[k]]));
          afterVals[`part${p.ord}`] = Object.fromEntries(diffKeys.map((k) => [k, next[k]]));
        }
        if (!changedIds.length) return s;
        await reopenFor(tx, scope, s, { partIds: changedIds }, actor, `${part.ord}부 편집`);
        await repo.updateStructure(tx.db, scope, s.id, { revision: s.revision + 1 });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "structure.updated",
          target: novelTarget(scope),
          before: { revision: s.revision, ...beforeVals },
          after: { revision: s.revision + 1, ...afterVals },
          details: { source: "user", partIds: changedIds },
        });
        return (await load(tx.db, scope))!;
      });
    },

    transitionStructure: (tx, scope, to, actor, opts = {}) => transition(tx, scope, to, actor, opts),

    async reopenStructure(tx, scope, change, actor, reason) {
      const s = await load(tx.db, scope, true);
      if (!s) return;
      await reopenFor(tx, scope, s, change, actor, reason);
      await repo.updateStructure(tx.db, scope, s.id, { revision: s.revision + 1 });
    },

    async setStructureFirstAppearances(tx, scope, items) {
      const s = await load(tx.db, scope, true);
      if (!s) return;
      await repo.updateStructure(tx.db, scope, s.id, { firstAppearances: items });
    },

    async setArcPlanFlags(tx, scope, arcId, flags: ArcPlanFlag[], actor) {
      const before = await repo.getArc(tx.db, scope, arcId, true);
      if (!before) throw new NotFoundError("플롯", arcId);
      const next = [...new Set(flags)].sort();
      if (JSON.stringify([...(before.planFlags ?? [])].sort()) === JSON.stringify(next)) return before;
      const arc = await repo.updateArc(tx.db, scope, arcId, { planFlags: next });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: next.length ? "arc.plan_flagged" : "arc.plan_flags_cleared",
        target: { type: "arc", id: arcId },
        before: { planFlags: before.planFlags },
        after: { planFlags: next },
      });
      return arc;
    },
  };
  return methods;
}
