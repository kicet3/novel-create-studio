/**
 * foreshadow use cases (03 §3.7, §4.7; 06 §8; 07 §1.3, §5.2). Every state change: domain table →
 * row update → audit in the SAME transaction.
 */
import { DEFAULTS, type ActivityAction, type CanonStatus, type SetupNarrativeStatus } from "@ncs/shared";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Ref,
  type Tx,
} from "../../../platform/index.js";
import { foreshadowRepo as repo } from "../adapters/db/foreshadow-repository.js";
import { buildSetupReport, effectiveDue, type ReportSetup } from "../domain/report.js";
import {
  assertBeatTransition,
  assertCanonTransition,
  assertNarrativeTransition,
  isCanonLocked,
  narrativeTargetForBeat,
  parseSetupNo,
  TERMINAL_NARRATIVE,
} from "../domain/transitions.js";
import type {
  BeatPlan,
  ForeshadowService,
  Setup,
  SetupBeat,
  SetupFilter,
  SetupInput,
  SetupIssueSink,
  SetupListItem,
  SetupReport,
} from "../index.js";
import { orPlaceholder, type ForeshadowPorts } from "./ports.js";

/** setup content edits (title / due / importance) */
const SETUP_UPDATED: ActivityAction = "setup.updated";

const ref = (id: string): Ref => ({ type: "setup", id });
const beatRef = (id: string): Ref => ({ type: "setup_beat", id });

export interface ForeshadowInternals extends ForeshadowService {
  /** E9 (03 §4.1): detected beats of the approved version → confirmed + narrative S2–S4; overdue review tasks */
  confirmEpisodeBeats(tx: Tx, scope: NovelScope, episode: { id: string; episodeNo: number; approvedVersionId: string | null; currentVersionId: string | null }, actor: ActorRef): Promise<{ confirmed: string[]; transitioned: string[] }>;
  /** E13 / E14 canon locking of beats and setups planted in the episode */
  setEpisodeBeatsPublished(tx: Tx, scope: NovelScope, episodeId: string, published: boolean, actor: ActorRef): Promise<number>;
  /** B4: rewrite → detected beats of the episode back to planned (evidence cleared) */
  resetDetectedBeats(tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef): Promise<number>;
  /** pin the current fact version on fact links of a setup (plant detection / E9; 03 §3.7) */
  pinLinkedFacts(tx: Tx, scope: NovelScope, setupId: string, versions: Array<{ factId: string; factVersionId: string }>): Promise<number>;
  /** create review_setup_due tasks for overdue setups (FR-FOR-04) */
  scheduleOverdueReviews(tx: Tx, scope: NovelScope, asOfEpisodeNo: number, actor: ActorRef): Promise<string[]>;
  readonly issueSinks: readonly SetupIssueSink[];
  /** S5 from inside the setup_abandon approval handler (the approval being decided is the guard) */
  transitionNarrativeVerified: ForeshadowService["transitionNarrative"];
  currentEpisodeNo(scope: NovelScope): Promise<number | null>;
  arcEnds(scope: NovelScope, tx?: Tx): Promise<Map<string, number>>;
}

export function createForeshadowService(deps: ForeshadowPorts): ForeshadowInternals {
  const { platform, audit, novel } = deps;
  const issueSinks: SetupIssueSink[] = [];

  async function arcEnds(scope: NovelScope, tx?: Tx): Promise<Map<string, number>> {
    const arcs = await novel.listArcs(scope, tx);
    return new Map(arcs.map((a) => [a.id, a.plannedEpisodeTo]));
  }

  async function currentEpisodeNo(scope: NovelScope): Promise<number | null> {
    const eps = await orPlaceholder(() => deps.manuscript.listEpisodes(scope, { statuses: ["approved", "published"] }), []);
    return eps.length ? Math.max(...eps.map((e) => e.episodeNo)) : null;
  }

  async function lockSetup(tx: Tx, scope: NovelScope, setupId: string): Promise<Setup> {
    const s = await repo.getSetup(tx.db, scope, setupId, true);
    if (!s) throw new NotFoundError("떡밥", setupId);
    return s;
  }

  function validateDue(due: { dueKind: "episode" | "arc"; dueEpisodeNo?: number | null; dueArcId?: string | null }) {
    if (due.dueKind === "episode" && (due.dueEpisodeNo == null || due.dueEpisodeNo < 1)) {
      throw new DomainValidationError("setup_due_episode_required", "화 기한 떡밥은 기한 화 번호가 있어야 합니다.");
    }
    if (due.dueKind === "arc" && !due.dueArcId) {
      throw new DomainValidationError("setup_due_arc_required", "아크 기한 떡밥은 기한 아크가 있어야 합니다.");
    }
  }

  function linkRefs(links: Ref[] | undefined): Array<{ refType: "entity" | "fact"; refId: string }> {
    return (links ?? []).map((l) => {
      if (l.type !== "entity" && l.type !== "fact") {
        throw new DomainValidationError("setup_link_type", "떡밥에는 엔티티·사실만 연결할 수 있습니다.", { type: l.type });
      }
      const prefix = l.type === "entity" ? "ent_" : "fct_";
      if (!l.id.startsWith(prefix)) throw new DomainValidationError("setup_link_id", "떡밥 연결은 ID로만 합니다(FR-ONT-12).", { id: l.id });
      return { refType: l.type, refId: l.id };
    });
  }

  async function toListItems(scope: NovelScope, rows: Setup[], tx?: Tx): Promise<SetupListItem[]> {
    if (!rows.length) return [];
    const db = tx?.db ?? platform.uow.db;
    const [beats, ends, cur] = await Promise.all([
      repo.listBeats(db, scope, { setupIds: rows.map((r) => r.id) }),
      arcEnds(scope, tx),
      tx ? Promise.resolve(null) : currentEpisodeNo(scope),
    ]);
    return rows.map((s) => {
      const due = effectiveDue(s, ends);
      return {
        ...s,
        beats: beats.filter((b) => b.setupId === s.id),
        effectiveDueEpisodeNo: due,
        remainingEpisodes: due != null && cur != null ? due - cur : null,
      };
    });
  }

  async function transitionNarrativeImpl(
    tx: Tx,
    scope: NovelScope,
    setupId: string,
    to: SetupNarrativeStatus,
    actor: ActorRef,
    reason?: string,
    opts: { approvalId?: string | null; beatId?: string | null } = {},
    approvalVerified = false,
  ): Promise<Setup> {
    const s = await lockSetup(tx, scope, setupId);
    const beat = opts.beatId ? await repo.getBeat(tx.db, scope, opts.beatId) : null;
    if (opts.beatId && (!beat || beat.setupId !== s.id)) throw new NotFoundError("떡밥 비트", opts.beatId);
    if (to === "abandoned" && opts.approvalId && !approvalVerified) {
      const apr = await deps.hitl.getApproval(scope, opts.approvalId, tx);
      if (apr.approvalType !== "setup_abandon" || apr.status !== "approved" || apr.subjectId !== s.id) {
        throw new DomainValidationError("setup_abandon_approval_invalid", "승인된 이 떡밥의 폐기 승인이 아닙니다.", { approvalId: opts.approvalId });
      }
    }
    const rule = assertNarrativeTransition({
      from: s.narrativeStatus,
      to,
      canon: s.canonStatus,
      beat: beat ? { id: beat.id, kind: beat.kind, status: beat.status } : null,
      abandonApprovalId: opts.approvalId ?? null,
      reason: reason ?? null,
    });
    const patch: Partial<Setup> = { narrativeStatus: to };
    if (to === "paid_off") patch.paidOffBeatId = beat!.id;
    if (to === "abandoned") {
      patch.abandonedReason = reason!;
      patch.abandonApprovalId = opts.approvalId!;
    }
    const after = await repo.updateSetup(tx.db, scope, s.id, patch);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: rule.id === "S5" ? "setup.abandoned" : "setup.narrative_status_changed",
      target: ref(s.id),
      before: { narrativeStatus: s.narrativeStatus },
      after: { narrativeStatus: to },
      reason: reason ?? null,
      approvalId: opts.approvalId ?? null,
      details: { rule: rule.id, beatId: beat?.id ?? null },
    });
    return after;
  }

  async function transitionCanonImpl(tx: Tx, scope: NovelScope, setupId: string, to: CanonStatus, actor: ActorRef, opts: { approvalId?: string | null; reason?: string } = {}) {
    const s = await lockSetup(tx, scope, setupId);
    const rule = assertCanonTransition(s.narrativeStatus, s.canonStatus, to, opts);
    const after = await repo.updateSetup(tx.db, scope, s.id, { canonStatus: to });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "setup.canon_status_changed",
      target: ref(s.id),
      before: { canonStatus: s.canonStatus },
      after: { canonStatus: to },
      reason: opts.reason ?? null,
      approvalId: opts.approvalId ?? null,
      details: { rule: rule.id },
    });
    return after;
  }

  const svc: ForeshadowInternals = {
    issueSinks,
    currentEpisodeNo,
    arcEnds,

    registerIssueSink(sink) {
      issueSinks.push(sink);
    },

    async createSetup(tx, scope, input, actor) {
      validateDue(input);
      const links = linkRefs(input.links);
      if (!input.title.trim() || !input.description.trim()) {
        throw new DomainValidationError("setup_text_required", "떡밥 제목과 설명을 입력하세요.");
      }
      const displayNo = await novel.nextDisplayNo(tx, scope, "setup");
      const s = await repo.insertSetup(tx.db, {
        id: platform.ids.next("stp"),
        novelId: scope.novelId,
        displayNo,
        title: input.title.trim(),
        description: input.description.trim(),
        importance: input.importance,
        plannedArcId: input.plannedArcId ?? null,
        dueKind: input.dueKind,
        dueEpisodeNo: input.dueKind === "episode" ? input.dueEpisodeNo! : null,
        dueArcId: input.dueKind === "arc" ? input.dueArcId! : null,
        createdByActorType: actor.type,
        createdByActorId: actor.id,
      });
      await repo.insertLinks(tx.db, scope, s.id, links);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "setup.created",
        target: ref(s.id),
        after: { displayNo, title: s.title, importance: s.importance, dueKind: s.dueKind, dueEpisodeNo: s.dueEpisodeNo, dueArcId: s.dueArcId },
        details: { rule: "S1", links: links.length },
      });
      return s;
    },

    async updateSetup(tx, scope, setupId, patch, actor, opts = {}) {
      const s = await lockSetup(tx, scope, setupId);
      if (TERMINAL_NARRATIVE.includes(s.narrativeStatus)) throw new ConflictError("setup_terminal", "끝난 떡밥은 고칠 수 없습니다.");
      const touchesLocked = patch.title !== undefined || patch.importance !== undefined || patch.dueKind !== undefined || patch.dueEpisodeNo !== undefined || patch.dueArcId !== undefined;
      if (isCanonLocked(s.canonStatus) && touchesLocked && !opts.approvalId) {
        throw new DomainValidationError("setup_canon_change_required", "승인된 떡밥의 제목·기한·중요도를 바꾸려면 승인이 필요합니다.");
      }
      const fields: Partial<Setup> = {};
      if (patch.title !== undefined) fields.title = patch.title.trim();
      if (patch.description !== undefined) fields.description = patch.description.trim();
      if (patch.importance !== undefined) fields.importance = patch.importance;
      let after = s;
      if (Object.keys(fields).length) {
        after = await repo.updateSetup(tx.db, scope, s.id, fields);
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: SETUP_UPDATED,
          target: ref(s.id),
          before: Object.fromEntries(Object.keys(fields).map((k) => [k, (s as Record<string, unknown>)[k]])),
          after: fields,
          approvalId: opts.approvalId ?? null,
          details: undefined,
        });
      }
      if (patch.dueKind !== undefined || patch.dueEpisodeNo !== undefined || patch.dueArcId !== undefined) {
        after = await svc.changeDue(
          tx,
          scope,
          s.id,
          {
            dueKind: patch.dueKind ?? s.dueKind,
            dueEpisodeNo: patch.dueEpisodeNo !== undefined ? patch.dueEpisodeNo : s.dueEpisodeNo,
            dueArcId: patch.dueArcId !== undefined ? patch.dueArcId : s.dueArcId,
            reason: "떡밥 계획 수정",
            approvalId: opts.approvalId ?? null,
          },
          actor,
        );
      }
      if (patch.links?.length) await repo.insertLinks(tx.db, scope, s.id, linkRefs(patch.links));
      return after;
    },

    async planBeats(tx, scope, setupId, beats: BeatPlan[], actor) {
      const s = await lockSetup(tx, scope, setupId);
      if (TERMINAL_NARRATIVE.includes(s.narrativeStatus) || s.canonStatus === "rejected" || s.canonStatus === "retracted") {
        throw new ConflictError("setup_terminal", "끝났거나 제외된 떡밥에는 비트를 더할 수 없습니다.");
      }
      if (!beats.length) return [];
      for (const b of beats) {
        if (!Number.isInteger(b.plannedEpisodeNo) || b.plannedEpisodeNo < 1) {
          throw new DomainValidationError("setup_beat_episode", "비트 배정 화 번호가 올바르지 않습니다.");
        }
      }
      const rows = await repo.insertBeats(
        tx.db,
        beats.map((b) => ({
          id: platform.ids.next("sbt"),
          novelId: scope.novelId,
          setupId: s.id,
          kind: b.kind,
          plannedEpisodeNo: b.plannedEpisodeNo,
          plannedNote: b.note ?? null,
        })),
      );
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "setup.beat_planned",
        target: ref(s.id),
        after: rows.map((r) => ({ id: r.id, kind: r.kind, plannedEpisodeNo: r.plannedEpisodeNo })),
        details: { ids: rows.map((r) => r.id), count: rows.length },
      });
      return rows;
    },

    transitionNarrative: (tx, scope, setupId, to, actor, reason, opts) => transitionNarrativeImpl(tx, scope, setupId, to, actor, reason, opts),
    transitionNarrativeVerified: (tx, scope, setupId, to, actor, reason, opts) => transitionNarrativeImpl(tx, scope, setupId, to, actor, reason, opts, true),
    transitionCanon: transitionCanonImpl,

    async changeDue(tx, scope, setupId, due, actor) {
      const s = await lockSetup(tx, scope, setupId);
      if (TERMINAL_NARRATIVE.includes(s.narrativeStatus)) throw new ConflictError("setup_terminal", "끝난 떡밥의 기한은 바꿀 수 없습니다.");
      validateDue(due);
      if (!due.reason?.trim()) throw new DomainValidationError("setup_due_reason_required", "기한 변경 사유를 입력하세요.");
      // INV-SU-03: approved setups change due only through a question (extension) or approval; the user may decide directly
      if (isCanonLocked(s.canonStatus) && actor.type !== "user" && !due.questionId && !due.approvalId) {
        throw new DomainValidationError("setup_due_question_required", "승인된 떡밥의 기한 변경은 질문 답변이나 승인으로만 할 수 있습니다.");
      }
      const toEpisode = due.dueKind === "episode" ? due.dueEpisodeNo! : null;
      const toArc = due.dueKind === "arc" ? due.dueArcId! : null;
      if (s.dueKind === due.dueKind && s.dueEpisodeNo === toEpisode && s.dueArcId === toArc) return s;
      const change = await repo.insertDueChange(tx.db, {
        id: platform.ids.next("sdc"),
        novelId: scope.novelId,
        setupId: s.id,
        fromDueKind: s.dueKind,
        fromDueEpisodeNo: s.dueEpisodeNo,
        fromDueArcId: s.dueArcId,
        toDueKind: due.dueKind,
        toDueEpisodeNo: toEpisode,
        toDueArcId: toArc,
        reason: due.reason.trim(),
        questionId: due.questionId ?? null,
        approvalId: due.approvalId ?? null,
        changedByActorType: actor.type,
        changedByActorId: actor.id,
      });
      const after = await repo.updateSetup(tx.db, scope, s.id, { dueKind: due.dueKind, dueEpisodeNo: toEpisode, dueArcId: toArc });
      // 07 §5.2 B6: planned/missing payoff beats beyond the new due are released
      const ends = await arcEnds(scope, tx);
      const newDue = effectiveDue(after, ends);
      const cancelled: string[] = [];
      if (newDue != null) {
        for (const b of await repo.listBeats(tx.db, scope, { setupIds: [s.id] })) {
          if (b.kind === "payoff" && (b.status === "planned" || b.status === "missing") && b.plannedEpisodeNo != null && b.plannedEpisodeNo > newDue) {
            assertBeatTransition(b.status, "cancelled");
            await repo.updateBeat(tx.db, scope, b.id, { status: "cancelled" });
            cancelled.push(b.id);
          }
        }
      }
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "setup.due_changed",
        target: ref(s.id),
        before: { dueKind: s.dueKind, dueEpisodeNo: s.dueEpisodeNo, dueArcId: s.dueArcId },
        after: { dueKind: after.dueKind, dueEpisodeNo: after.dueEpisodeNo, dueArcId: after.dueArcId },
        reason: due.reason,
        questionId: due.questionId ?? null,
        approvalId: due.approvalId ?? null,
        details: { dueChangeId: change.id, cancelledBeatIds: cancelled },
      });
      return after;
    },

    async recordBeatResult(tx, scope, beatId, result, actor) {
      let b = await repo.getBeat(tx.db, scope, beatId, true);
      if (!b) throw new NotFoundError("떡밥 비트", beatId);
      // a detection on an older version is reset first (B4) so the new result is a table transition
      if (b.status === "detected" && b.manuscriptVersionId !== result.manuscriptVersionId) {
        assertBeatTransition("detected", "planned");
        b = await repo.updateBeat(tx.db, scope, b.id, { status: "planned", sceneId: null, charStart: null, charEnd: null, manuscriptVersionId: null, detectedByRunId: null, canonStatus: "candidate" });
      }
      if (b.status === "detected" && result.status === "detected") {
        // idempotent re-run on the same version: refresh the span only
        return repo.updateBeat(tx.db, scope, b.id, { sceneId: result.sceneId ?? b.sceneId, charStart: result.charStart ?? b.charStart, charEnd: result.charEnd ?? b.charEnd });
      }
      const rule = assertBeatTransition(b.status, result.status);
      const episodeId = result.episodeId ?? b.episodeId;
      if (result.status === "detected" && (!episodeId || !result.sceneId || result.charStart == null || result.charEnd == null)) {
        throw new DomainValidationError("setup_beat_evidence_required", "검출된 비트에는 근거 씬과 위치가 있어야 합니다(FR-FOR-08).");
      }
      const after = await repo.updateBeat(tx.db, scope, b.id, {
        status: result.status,
        episodeId: episodeId ?? null,
        manuscriptVersionId: result.manuscriptVersionId,
        sceneId: result.status === "detected" ? result.sceneId! : null,
        charStart: result.status === "detected" ? result.charStart! : null,
        charEnd: result.status === "detected" ? result.charEnd! : null,
        detectedByRunId: result.runId ?? (actor.type === "agent" ? actor.runId : null),
        canonStatus: "candidate",
      });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: result.status === "detected" ? "setup.beat_detected" : "setup.beat_missing",
        target: beatRef(b.id),
        before: { status: b.status },
        after: { status: after.status, manuscriptVersionId: after.manuscriptVersionId, sceneId: after.sceneId },
        details: { rule: rule.id, setupId: b.setupId },
      });
      return after;
    },

    async beatsForEpisode(scope, episodeNo, tx) {
      const db = tx?.db ?? platform.uow.db;
      const beats = (await repo.listBeats(db, scope, { plannedEpisodeNo: episodeNo })).filter((b) => b.status !== "cancelled");
      const setupRows = await repo.listSetups(db, scope, { ids: [...new Set(beats.map((b) => b.setupId))] });
      const byId = new Map(setupRows.filter((s) => s.canonStatus !== "rejected" && s.canonStatus !== "retracted" && s.narrativeStatus !== "abandoned").map((s) => [s.id, s]));
      return beats.filter((b) => byId.has(b.setupId)).map((b) => ({ ...b, setup: byId.get(b.setupId)! }));
    },

    async missingBeats(scope, episodeId, versionId, tx) {
      const db = tx?.db ?? platform.uow.db;
      return (await repo.listBeats(db, scope, { episodeId })).filter((b) => b.status === "missing" && b.manuscriptVersionId === versionId);
    },

    async listSetups(scope, filter: SetupFilter = {}) {
      const rows = await repo.listSetups(platform.uow.db, scope, { plannedArcId: filter.plannedArcId });
      let items = await toListItems(scope, rows);
      if (filter.narrativeStatuses?.length) items = items.filter((s) => filter.narrativeStatuses!.includes(s.narrativeStatus));
      if (filter.canonStatuses?.length) items = items.filter((s) => filter.canonStatuses!.includes(s.canonStatus));
      if (filter.importance?.length) items = items.filter((s) => filter.importance!.includes(s.importance));
      const open = (s: SetupListItem) => !TERMINAL_NARRATIVE.includes(s.narrativeStatus) && s.canonStatus !== "rejected" && s.canonStatus !== "retracted";
      if (filter.overdueOnly) items = items.filter((s) => open(s) && s.remainingEpisodes != null && s.remainingEpisodes < 0);
      if (filter.dueWithinEpisodes != null) {
        const n = filter.dueWithinEpisodes;
        items = items.filter((s) => open(s) && s.remainingEpisodes != null && s.remainingEpisodes <= n);
      }
      return items;
    },

    async getSetup(scope, setupIdOrNo) {
      const db = platform.uow.db;
      let s: Setup | null = null;
      if (typeof setupIdOrNo === "string" && setupIdOrNo.startsWith("stp_")) s = await repo.getSetup(db, scope, setupIdOrNo);
      else {
        const no = parseSetupNo(setupIdOrNo);
        if (no != null) s = await repo.getSetupByNo(db, scope, no);
      }
      if (!s) throw new NotFoundError("떡밥", String(setupIdOrNo));
      const [item] = await toListItems(scope, [s]);
      const [dueChanges, links] = await Promise.all([repo.listDueChanges(db, scope, [s.id]), repo.listLinks(db, scope, [s.id])]);
      return { ...item!, dueChanges, links: links.map((l) => ({ type: l.refType, id: l.refId, pinnedFactVersionId: l.pinnedFactVersionId })) };
    },

    async report(scope, asOfEpisodeNo): Promise<SetupReport> {
      const db = platform.uow.db;
      const rows = await repo.listSetups(db, scope);
      const ids = rows.map((r) => r.id);
      const [beats, changes, ends, episodes] = await Promise.all([
        repo.listBeats(db, scope, { setupIds: ids }),
        repo.listDueChanges(db, scope, ids),
        arcEnds(scope),
        orPlaceholder(() => deps.manuscript.listEpisodes(scope, { statuses: ["approved", "published"] }), []),
      ]);
      const approvedAt = new Map<number, Date>();
      for (const e of episodes) if (e.approvedAt) approvedAt.set(e.episodeNo, e.approvedAt);
      const cur = asOfEpisodeNo ?? (episodes.length ? Math.max(...episodes.map((e) => e.episodeNo)) : null);
      const abandonedAt = new Map<string, Date>();
      for (const s of rows) {
        if (s.narrativeStatus === "abandoned" && s.abandonApprovalId) {
          const apr = await orPlaceholder(() => deps.hitl.getApproval(scope, s.abandonApprovalId!), null);
          abandonedAt.set(s.id, apr?.decidedAt ?? s.updatedAt);
        }
      }
      // latest setup_due question per setup: review_setup_due task output refs (question ids)
      const dueQuestions = new Map<string, { questionId: string; status: string }>();
      const tasks = await orPlaceholder(() => deps.orchestration.listTasks(scope, { kinds: ["review_setup_due"], includeCancelled: false }), []);
      const questions = await orPlaceholder(() => deps.hitl.listQuestions(scope, { topics: ["setup_due"] }), []);
      const qStatus = new Map(questions.map((q) => [q.id, q.status]));
      for (const t of [...tasks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
        const qRef = ((t.outputRefs as Array<{ refType: string; refId: string }> | null) ?? []).find((r) => r.refType === "question");
        if (qRef) dueQuestions.set(t.targetId, { questionId: qRef.refId, status: qStatus.get(qRef.refId) ?? "unknown" });
      }
      const contradictions = (await Promise.all(issueSinks.map((s) => s.listOpenSetupIssues(scope))))
        .flat()
        .filter((i) => i.kind === "setup_contradiction")
        .map((i) => ({ setupId: i.setupId, issueId: i.issueId, issueDisplayNo: i.issueDisplayNo, severity: i.severity, message: i.message }));
      const reportSetups: ReportSetup[] = rows.map((s) => ({
        id: s.id,
        displayNo: s.displayNo,
        title: s.title,
        importance: s.importance,
        narrativeStatus: s.narrativeStatus,
        canonStatus: s.canonStatus,
        dueKind: s.dueKind,
        dueEpisodeNo: s.dueEpisodeNo,
        dueArcId: s.dueArcId,
        createdAt: s.createdAt,
        abandonedAt: abandonedAt.get(s.id) ?? null,
        beats: beats.filter((b) => b.setupId === s.id),
        dueChanges: changes.filter((c) => c.setupId === s.id),
      }));
      return buildSetupReport({
        setups: reportSetups,
        approvedAt,
        arcEnds: ends,
        asOfEpisodeNo: cur,
        overdueWindowEpisodes: DEFAULTS["setup.overdue_handling_window_episodes"],
        dueQuestions,
        contradictions,
      });
    },

    async applyArcPlanDecision(tx, scope, arcId, decision, actor, approvalId) {
      const rows = (await repo.listSetups(tx.db, scope, { plannedArcId: arcId })).filter((s) => s.canonStatus === "candidate");
      const changed: string[] = [];
      for (const s of rows) {
        await transitionCanonImpl(tx, scope, s.id, decision === "approved" ? "approved" : "rejected", actor, { approvalId, reason: decision === "approved" ? "아크 계획 승인" : "아크 계획에서 제외" });
        changed.push(s.id);
      }
      return changed;
    },

    async confirmEpisodeBeats(tx, scope, episode, actor) {
      const versionId = episode.approvedVersionId ?? episode.currentVersionId;
      const beats = (await repo.listBeats(tx.db, scope, { episodeId: episode.id })).filter((b) => b.status === "detected" && (!versionId || b.manuscriptVersionId === versionId));
      const now = platform.clock.date();
      const confirmed: string[] = [];
      const transitioned: string[] = [];
      const order = { plant: 0, reinforce: 1, payoff: 2 } as const;
      beats.sort((a, b) => order[a.kind] - order[b.kind]);
      const arcsById = new Map((await novel.listArcs(scope, tx)).map((a) => [a.id, a]));
      for (const b of beats) {
        assertBeatTransition("detected", "confirmed");
        await repo.updateBeat(tx.db, scope, b.id, { status: "confirmed", canonStatus: "approved", confirmedAt: now });
        confirmed.push(b.id);
        let s = await lockSetup(tx, scope, b.setupId);
        // SC2 workaround: the arc plan was approved (arc active) but no arc_plan hook reached foreshadow
        if (s.canonStatus === "candidate") {
          const arc = s.plannedArcId ? arcsById.get(s.plannedArcId) : undefined;
          if (!arc || ["active", "awaiting_approval", "completed"].includes(arc.status)) {
            s = await transitionCanonImpl(tx, scope, s.id, "approved", actor, { reason: "확정된 화에 비트가 들어감(아크 계획 승인 반영)" });
          }
        }
        const target = narrativeTargetForBeat(b.kind, s.narrativeStatus);
        if (target && s.canonStatus !== "candidate" && s.canonStatus !== "rejected") {
          await transitionNarrativeImpl(tx, scope, s.id, target, actor, undefined, { beatId: b.id });
          transitioned.push(s.id);
        }
      }
      if (confirmed.length) {
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "setup.beat_confirmed",
          target: { type: "episode", id: episode.id },
          details: { ids: confirmed, count: confirmed.length, setupIds: [...new Set(beats.map((b) => b.setupId))] },
        });
      }
      return { confirmed, transitioned };
    },

    async setEpisodeBeatsPublished(tx, scope, episodeId, published, actor) {
      const beats = (await repo.listBeats(tx.db, scope, { episodeId })).filter((b) => b.status === "confirmed");
      let changed = 0;
      for (const b of beats) {
        const to: CanonStatus = published ? "published_locked" : "approved";
        if (b.canonStatus !== to) {
          await repo.updateBeat(tx.db, scope, b.id, { canonStatus: to });
          changed++;
        }
        if (b.kind === "plant") {
          const s = await lockSetup(tx, scope, b.setupId);
          if (published && s.canonStatus === "approved") await transitionCanonImpl(tx, scope, s.id, "published_locked", actor, { reason: "설치 화 공개 (E13)" });
          if (!published && s.canonStatus === "published_locked") await transitionCanonImpl(tx, scope, s.id, "approved", actor, { reason: "설치 화 공개 취소 (E14)" });
        }
      }
      return changed;
    },

    async resetDetectedBeats(tx, scope, episodeId, actor) {
      const beats = (await repo.listBeats(tx.db, scope, { episodeId })).filter((b) => b.status === "detected");
      for (const b of beats) {
        assertBeatTransition("detected", "planned");
        await repo.updateBeat(tx.db, scope, b.id, { status: "planned", sceneId: null, charStart: null, charEnd: null, manuscriptVersionId: null, detectedByRunId: null, canonStatus: "candidate" });
      }
      if (beats.length) {
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "setup.beat_planned",
          target: { type: "episode", id: episodeId },
          details: { ids: beats.map((b) => b.id), count: beats.length, rule: "B4", reason: "재작성으로 재검사 대상" },
        });
      }
      return beats.length;
    },

    async countEpisodeBeats(scope, input, tx) {
      const rows = await repo.listBeatsForDeletedText(tx?.db ?? platform.uow.db, scope, input.episodeId, input.versionIds);
      return rows.filter((b) => b.status === "detected" || b.status === "missing" || b.status === "confirmed").length;
    },
    async purgeEpisodeBeats(tx, scope, input, actor) {
      const all = await repo.listBeatsForDeletedText(tx.db, scope, input.episodeId, input.versionIds);
      const beats = all.filter((b) => b.status === "detected" || b.status === "missing" || b.status === "confirmed");
      const resetIds = new Set(beats.map((b) => b.id));
      // beats that keep their status (e.g. `cancelled` by B6 after a `missing` result) still point at the text through
      // manuscript_version_id / scene_id — the anchors go, or the caller's version / scene deletes hit the FK
      const anchored = all.filter((b) => !resetIds.has(b.id) && (b.manuscriptVersionId || b.sceneId));
      for (const b of anchored) {
        await repo.updateBeat(tx.db, scope, b.id, { sceneId: null, charStart: null, charEnd: null, manuscriptVersionId: null, detectedByRunId: null });
      }
      if (!beats.length) return 0;
      for (const b of beats) {
        // B4-like reset (also from missing / confirmed: the text the result was about no longer exists)
        await repo.updateBeat(tx.db, scope, b.id, { status: "planned", episodeId: null, sceneId: null, charStart: null, charEnd: null, manuscriptVersionId: null, detectedByRunId: null, confirmedAt: null, canonStatus: "candidate" });
      }
      // setups advanced by a confirmed beat of this text step back to what their remaining confirmed beats support
      for (const setupId of new Set(beats.filter((b) => b.status === "confirmed").map((b) => b.setupId))) {
        const s = await lockSetup(tx, scope, setupId);
        if (s.narrativeStatus === "abandoned") continue;
        const remaining = (await repo.listBeats(tx.db, scope, { setupIds: [s.id] })).filter((x) => x.status === "confirmed" && !resetIds.has(x.id));
        const paidOff = remaining.find((x) => x.kind === "payoff");
        const target: SetupNarrativeStatus = paidOff ? "paid_off" : remaining.some((x) => x.kind === "reinforce") ? "reinforced" : remaining.some((x) => x.kind === "plant") ? "planted" : "planned";
        const patch: Partial<Setup> = {};
        if (s.paidOffBeatId && resetIds.has(s.paidOffBeatId)) patch.paidOffBeatId = paidOff?.id ?? null;
        if (s.narrativeStatus !== target) patch.narrativeStatus = target;
        if (!Object.keys(patch).length) continue;
        await repo.updateSetup(tx.db, scope, s.id, patch);
        if (patch.narrativeStatus) {
          await audit.record(tx, {
            novelId: scope.novelId,
            actor,
            action: "setup.narrative_status_changed",
            target: ref(s.id),
            before: { narrativeStatus: s.narrativeStatus },
            after: { narrativeStatus: target },
            reason: "화 삭제(원고 폐기): 확정 비트가 사라져 되돌림",
            details: { rule: "B4", episodeId: input.episodeId },
          });
        }
      }
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "setup.beat_planned",
        target: { type: "episode", id: input.episodeId },
        details: { ids: beats.map((b) => b.id), count: beats.length, rule: "B4", reason: "화 삭제(원고 폐기)", anchorsCleared: anchored.map((b) => b.id) },
      });
      return beats.length;
    },

    async pinLinkedFacts(tx, scope, setupId, versions) {
      if (!versions.length) return 0;
      const links = (await repo.listLinks(tx.db, scope, [setupId])).filter((l) => l.refType === "fact");
      let n = 0;
      for (const l of links) {
        const v = versions.find((x) => x.factId === l.refId);
        if (v && l.pinnedFactVersionId !== v.factVersionId) {
          await repo.pinFactVersion(tx.db, scope, l.id, v.factVersionId);
          n++;
        }
      }
      return n;
    },

    async scheduleOverdueReviews(tx, scope, asOfEpisodeNo, actor) {
      const rows = (await repo.listSetups(tx.db, scope)).filter(
        (s) => (s.narrativeStatus === "planted" || s.narrativeStatus === "reinforced") && isCanonLocked(s.canonStatus),
      );
      const ends = await arcEnds(scope, tx);
      const created: string[] = [];
      for (const s of rows) {
        const due = effectiveDue(s, ends);
        if (due == null || due >= asOfEpisodeNo) continue;
        const r = await deps.orchestration.createTask(tx, scope, {
          kind: "review_setup_due",
          targetType: "setup",
          targetId: s.id,
          input: { setup_id: s.id, as_of_episode_no: asOfEpisodeNo },
          createdBy: actor,
          cycleKey: `${s.id}:due:${due}`,
          priority: 100,
        });
        if (r.created) created.push(r.taskId);
      }
      return created;
    },
  };
  return svc;
}
