/**
 * 설계 추가(화 삭제): "생성한 화를 삭제하거나 수정할 때 기존의 온톨로지에 추가된 데이터도 정리가 되어야 한다".
 * Edits are reconciled by revision/fact-reconcile; this is the DELETE path (E17): the generated manuscript of an
 * episode and every record derived from it are removed in ONE transaction and the episode goes back to `planned`
 * with its plan (title, summary, hook, scene count, target length, 묶음) kept, so the scheduler writes it again.
 *
 * Order inside the transaction (FKs are DEFERRABLE INITIALLY IMMEDIATE, so dependents go first):
 *   1. published → E14 (unpublish, facts demoted) — requires the "외부 미공개" confirmation
 *   2. work in flight: tasks of the episode cancelled, pending approvals of the episode / its versions cancelled
 *   3. participants (continuity issues, foreshadow beats, revision chat) purge their records
 *   4. ontology purge: facts rejected / retracted (episode_deleted), evidence pruned, mentions / frames / names gone,
 *      orphaned candidate entities retired
 *   5. scenes (+ participants), recaps, rejections of the episode deleted
 *   6. E17 → planned (version pointers NULL, counters reset) — then the manuscript versions are deleted
 *   7. hold (default): the episode stays paused so nothing is written until the author resumes it; only an explicit
 *      holdRewrite:false lets the scheduler rewrite it right away. Audit `episode.manuscript_deleted`.
 */
import type { DeleteManuscriptRequest, EpisodeDeletePreviewDto } from "@ncs/shared";
import { AppError, DomainValidationError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import type { Episode, EpisodeDeleteContext, EpisodeDeleteParticipant } from "../index.js";
import type { ManuscriptInternals } from "./manuscript-service.js";
import { soft } from "./support.js";

const ACTIVE_TASK_STATUSES = ["pending", "ready", "running", "blocked"] as const;

export function createEpisodeDelete(internals: ManuscriptInternals) {
  const { ports, mustEpisode, transition, unpublishInTx } = internals;
  const { deps, reg } = ports;
  const { platform, audit, ontology, orchestration, hitl } = deps;
  const { uow, clock } = platform;
  const epRef = (id: string) => ({ type: "episode" as const, id });

  async function contextOf(scope: NovelScope, ep: Episode, tx?: Tx): Promise<EpisodeDeleteContext> {
    const db = tx?.db ?? uow.db;
    const versions = await repo.listVersions(db, scope, ep.id);
    const scenes = await repo.listScenes(db, scope, ep.id, { includeRetired: true });
    return { episodeId: ep.id, episodeNo: ep.episodeNo, versionIds: versions.map((v) => v.id), sceneIds: scenes.map((s) => s.id) };
  }

  /** pending approvals about the episode: its own (episode / arc-level subject), its versions, or a fact-reconcile request of it */
  async function pendingApprovals(scope: NovelScope, ctx: EpisodeDeleteContext, tx?: Tx) {
    const all = await soft(() => hitl.listApprovals(scope, { statuses: ["pending"] }, tx), []);
    const subjects = new Set([ctx.episodeId, ...ctx.versionIds]);
    return all.filter((a) => subjects.has(a.subjectId) || (a.payload as { episodeId?: unknown } | null)?.episodeId === ctx.episodeId);
  }

  async function participantCount(name: EpisodeDeleteParticipant["name"], scope: NovelScope, ctx: EpisodeDeleteContext, tx?: Tx): Promise<number> {
    let n = 0;
    for (const p of reg.deleteParticipants.filter((x) => x.name === name)) n += await p.count(scope, ctx, tx);
    return n;
  }

  async function previewDelete(scope: NovelScope, episodeId: string): Promise<EpisodeDeletePreviewDto> {
    const ep = await mustEpisode(undefined, scope, episodeId);
    const ctx = await contextOf(scope, ep);
    const purge = await ontology.previewManuscriptPurge(scope, ctx);
    const tasks = await orchestration.listTasks(scope, { episodeId: ep.id, statuses: [...ACTIVE_TASK_STATUSES], limit: 500 });
    const approvals = await pendingApprovals(scope, ctx);
    return {
      episodeNo: ep.episodeNo,
      status: ep.status,
      published: ep.status === "published",
      versionCount: ctx.versionIds.length,
      facts: purge.facts,
      mentionCount: purge.mentionCount,
      entityRetireCount: purge.entityRetireCount,
      issueCount: await participantCount("issues", scope, ctx),
      setupBeatCount: await participantCount("beats", scope, ctx),
      recapCount: await repo.countRecaps(uow.db, scope, ep.id),
      revisionSessionCount: await participantCount("sessions", scope, ctx),
      activeTaskCount: tasks.length,
      pendingApprovalCount: approvals.length,
      // the approve/reject question of each pending approval is the only question we can attribute to the episode here
      pendingQuestionCount: approvals.length,
    };
  }

  async function cancelQuestions(tx: Tx, scope: NovelScope, ids: string[], reason: string, actor: ActorRef): Promise<number> {
    let n = 0;
    for (const id of [...new Set(ids)]) {
      try {
        await hitl.cancelQuestion(tx, scope, id, reason, actor);
        n++;
      } catch (err) {
        // already answered / cancelled questions are left as they are
        if (!(err instanceof AppError)) throw err;
      }
    }
    return n;
  }

  async function deleteManuscript(scope: NovelScope, episodeId: string, input: DeleteManuscriptRequest, actor: ActorRef): Promise<Episode> {
    if (actor.type !== "user") throw new DomainValidationError("user_required", "화 삭제는 사람만 할 수 있습니다.");
    const reason = input.reason?.trim();
    if (!reason) throw new DomainValidationError("reason_required", "삭제 사유를 입력하세요.");
    // task statuses are final outside the transaction (PGlite: listTasks has no tx)
    const tasks = await orchestration.listTasks(scope, { episodeId, statuses: [...ACTIVE_TASK_STATUSES], limit: 500 });
    return uow.run(async (tx) => {
      const before = await mustEpisode(tx, scope, episodeId, true);
      const ctx = await contextOf(scope, before, tx);
      if (before.status === "planned" && ctx.versionIds.length === 0) {
        throw new DomainValidationError("nothing_to_delete", "이 화에는 삭제할 원고가 없습니다.");
      }
      // 1. published → E14 first (same confirmation as unpublish, FR-MAN-03)
      if (before.status === "published") {
        if (input.confirmedNotPublishedExternally !== true) {
          throw new DomainValidationError("external_confirmation_required", "외부 플랫폼에 공개되지 않았음을 확인해야 공개된 화를 삭제할 수 있습니다.");
        }
        await unpublishInTx(tx, scope, episodeId, reason, actor);
      }
      // 2. work in flight
      for (const t of tasks) {
        try {
          await orchestration.cancelTask(tx, scope, t.id, actor);
        } catch (err) {
          if (!(err instanceof AppError)) throw err; // finished meanwhile
        }
      }
      const approvals = await pendingApprovals(scope, ctx, tx);
      for (const a of approvals) await soft(() => hitl.cancelApproval(tx, scope, a.id, `화 삭제: ${reason}`, actor), undefined);
      // 3. records of other modules (issues, beats, revision chat)
      const counts: Record<EpisodeDeleteParticipant["name"], number> = { issues: 0, beats: 0, sessions: 0 };
      const questionIds: string[] = [];
      for (const p of reg.deleteParticipants) {
        const r = await p.purge(tx, scope, ctx, actor, reason);
        counts[p.name] += r.count;
        if (r.questionIds) questionIds.push(...r.questionIds);
      }
      // 4. ontology
      const purge = await ontology.purgeManuscriptVersions(tx, scope, ctx, actor, { reason });
      questionIds.push(...purge.questionIds);
      const questions = await cancelQuestions(tx, scope, questionIds, `화 삭제: ${reason}`, actor);
      // 5. the episode's own derived rows
      const scenes = await repo.deleteScenes(tx.db, scope, ctx.sceneIds);
      const recaps = await repo.deleteRecaps(tx.db, scope, episodeId);
      await repo.deleteRejections(tx.db, scope, episodeId);
      // 6. E17 → planned (pointers first, versions after)
      const current = await mustEpisode(tx, scope, episodeId, true);
      // 글이 다시 써지면 안 되는 동안: unless the author explicitly asks for an immediate rewrite, the episode stays paused
      const hold = input.holdRewrite !== false;
      const patch: Partial<Episode> = {
        outlineVersionId: null,
        currentVersionId: null,
        approvedVersionId: null,
        publishedVersionId: null,
        rhythmCandidateVersionId: null,
        approvedAt: null,
        approvedByActorType: null,
        approvedByActorId: null,
        publishedAt: null,
        publishedByActorType: null,
        publishedByActorId: null,
        scheduledPublishAt: null,
        blockReasons: [],
        rejectionCount: 0,
        autoRewriteCount: 0,
        lastReworkFrom: null,
        ...(hold ? { pausedAt: current.pausedAt ?? clock.date() } : {}),
      };
      // one `episode.manuscript_deleted` audit row (the E17 transition records it; the version rows go right after)
      const details = {
        statusBefore: before.status,
        currentVersionIdBefore: before.currentVersionId,
        publishedVersionIdBefore: before.publishedVersionId,
        versionCount: ctx.versionIds.length,
        sceneCount: scenes,
        facts: { rejected: purge.factsRejected, retracted: purge.factsRetracted, otherPruned: purge.otherFactsPruned, otherRetired: purge.otherFactsRetired },
        mentions: purge.mentions,
        entitiesRetired: purge.entitiesRetired,
        namesDeleted: purge.namesDeleted,
        narrativeFrames: purge.frames,
        issues: counts.issues,
        beats: counts.beats,
        recaps,
        sessions: counts.sessions,
        tasks: tasks.map((t) => t.id),
        approvals: approvals.map((a) => a.id),
        questions,
        holdRewrite: hold,
      };
      let updated: Episode;
      if (current.status === "planned") {
        // a planned episode that still had versions (e.g. an interrupted outline): no state change, same cleanup
        updated = await repo.updateEpisode(tx.db, scope, episodeId, patch);
        await audit.record(tx, { novelId: scope.novelId, actor, action: "episode.manuscript_deleted", target: epRef(episodeId), before: { status: "planned" }, after: { status: "planned" }, reason, details: { rule: null, episodeNo: before.episodeNo, ...details } });
      } else {
        updated = await transition(tx, scope, episodeId, "planned", actor, { ruleId: "E17", reason, patch, details });
      }
      await repo.deleteVersions(tx.db, scope, episodeId);
      // 7. hold
      if (hold && !current.pausedAt) {
        await audit.record(tx, { novelId: scope.novelId, actor, action: "episode.paused", target: epRef(episodeId), reason, details: { taskIds: tasks.map((t) => t.id), onDelete: true } });
      }
      tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
      return updated;
    });
  }

  return { previewDelete, deleteManuscript };
}
