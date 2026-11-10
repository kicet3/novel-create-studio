/**
 * 설계 추가 0024: [문체 다듬기] — a rhythm-only polish of an episode that already finished the pipeline
 * (awaiting_approval / approved, never published). The task (polish_episode, rhythm_only + rhythm_mode=manual) saves a
 * candidate version next to the current one (episodes.rhythm_candidate_version_id); the author compares it in the diff
 * view and keeps it (E16 human-edit rules: re-check, an approved episode loses its approval) or discards it.
 */
import { ConflictError, DomainValidationError, InvalidTransitionError, type ActorRef, type NovelScope } from "../../../platform/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { userRanges } from "../domain/attribution.js";
import { measureRhythm, rhythmBlocks } from "../domain/rhythm.js";
import type { Episode, ManuscriptService } from "../index.js";
import { soft, WRITING_KINDS, type Ports } from "./support.js";

export const RHYTHM_POLISH_STATUSES = ["awaiting_approval", "approved"] as const;

export function createRhythmPolish(ports: Ports, getService: () => ManuscriptService) {
  const { platform, novel, orchestration, audit } = ports.deps;
  const { uow, clock } = platform;

  /** 202: queues the rhythm-only pass (an active one on the same version is returned as is) */
  const requestRhythmPolish = async (scope: NovelScope, episodeNo: number, actor: ActorRef): Promise<{ taskId: string }> => {
    const pre = await getService().getEpisodeByNo(scope, episodeNo);
    return uow.run(async (tx) => {
      const ep = (await repo.getEpisode(tx.db, scope, pre.id, true))!;
      if (ep.status === "published") throw new DomainValidationError("retcon_required", "공개된 화는 문체 다듬기를 할 수 없습니다. 리트콘 승인으로 진행하세요.");
      if (!(RHYTHM_POLISH_STATUSES as readonly string[]).includes(ep.status)) {
        throw new InvalidTransitionError("episode", ep.status, "rhythm_polish", "검사와 다듬기를 마친 화(승인 대기·승인)만 문체 다듬기를 할 수 있습니다.");
      }
      if (!ep.currentVersionId) throw new DomainValidationError("no_manuscript", "다듬을 원고가 없습니다.");
      const active = await orchestration.listTasks(scope, { episodeId: ep.id, statuses: ["pending", "ready", "running", "blocked"], limit: 100 }, tx);
      const same = active.find((t) => t.kind === "polish_episode" && (t.input as { rhythm_mode?: string })?.rhythm_mode === "manual" && (t.input as { manuscript_version_id?: string })?.manuscript_version_id === ep.currentVersionId);
      if (same) return { taskId: same.id };
      if (active.some((t) => WRITING_KINDS.includes(t.kind as never))) throw new ConflictError("episode_busy", "이 화에서 원고 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.");
      const current = await getService().getVersion(scope, ep.currentVersionId, tx);
      const n = await novel.getNovel(scope, tx);
      const metric = measureRhythm(current.content, n.proseRhythm);
      const blocks = rhythmBlocks(current.content, metric.flaggedParagraphs, userRanges((current.attributionSpans as never) ?? []));
      if (!blocks.length) {
        throw new DomainValidationError(
          "rhythm_ok",
          metric.flaggedParagraphs.length ? "리듬 기준을 넘는 문단이 모두 사람이 쓴 구간이라 고치지 않습니다." : "문장 리듬 기준을 넘는 문단이 없습니다.",
        );
      }
      const cycleKey = `${ep.currentVersionId}:rhythm_manual:${clock.date().getTime()}`;
      const taskId = await ports.createTask(tx, scope, {
        kind: "polish_episode",
        targetType: "episode",
        targetId: ep.id,
        episodeId: ep.id,
        arcId: ep.arcId,
        input: { episode_id: ep.id, manuscript_version_id: ep.currentVersionId, rhythm_only: true, rhythm_mode: "manual", cycle_key: cycleKey },
        createdBy: actor,
        cycleKey,
        priority: 800,
      });
      if (!taskId) throw new ConflictError("task_not_created", "문체 다듬기 작업을 만들지 못했습니다.");
      return { taskId };
    });
  };

  /** keep → E16 (same rules as a human edit of the current version); discard → candidate cleared */
  const decideRhythmCandidate = async (scope: NovelScope, episodeNo: number, input: { versionId: string; decision: "keep" | "discard" }, actor: ActorRef): Promise<Episode> => {
    if (actor.type !== "user") throw new DomainValidationError("user_required", "문체 다듬기 후보는 작가만 적용하거나 버릴 수 있습니다.");
    const pre = await getService().getEpisodeByNo(scope, episodeNo);
    return uow.run(async (tx) => {
      const ep = (await repo.getEpisode(tx.db, scope, pre.id, true))!;
      if (ep.rhythmCandidateVersionId !== input.versionId) {
        throw new ConflictError("rhythm_candidate_stale", "이 후보는 더 이상 유효하지 않습니다. 화면을 새로 고쳐 주세요.", { rhythmCandidateVersionId: ep.rhythmCandidateVersionId });
      }
      const candidate = await getService().getVersion(scope, input.versionId, tx);
      const record = (decision: string, details: Record<string, unknown> = {}) =>
        audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "manuscript.rhythm_candidate_decided",
          target: { type: "manuscript_version", id: candidate.id },
          after: { decision },
          details: { episodeId: ep.id, episodeNo: ep.episodeNo, baseVersionId: candidate.parentVersionId, ...details },
        });
      if (input.decision === "discard" || candidate.parentVersionId !== ep.currentVersionId) {
        // a candidate of an older working copy can only be discarded (keep would undo the newer text)
        if (input.decision === "keep") {
          throw new ConflictError("stale_base_version", "후보를 만든 뒤 원고가 바뀌었습니다. 후보를 버리고 문체 다듬기를 다시 요청하세요.", { currentVersionId: ep.currentVersionId });
        }
        const updated = await repo.updateEpisode(tx.db, scope, ep.id, { rhythmCandidateVersionId: null });
        await record("discard");
        return updated;
      }
      // keep: the candidate text becomes the working copy under the human-edit rules (E16) — the author chose it
      const version = await getService().applyHumanEditTx(
        tx,
        scope,
        ep.id,
        { content: candidate.content, baseVersionId: ep.currentVersionId!, auditDetails: { rhythmCandidateVersionId: candidate.id } },
        actor,
      );
      await record("keep", { versionId: version.id });
      tx.afterCommit(() => platform.workSignal.notify("task", scope.novelId));
      return (await soft(() => repo.getEpisode(tx.db, scope, ep.id), null)) ?? ep;
    });
  };

  return { requestRhythmPolish, decideRhythmCandidate };
}
