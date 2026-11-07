/**
 * ManuscriptService: episodes E1–E16, versions + attribution, scenes, rejection, publish (03 §3.2, §4.1; 07).
 * Writing-pipeline task handlers live in ./pipeline-*.ts and call the internal helpers exported here.
 */
import type { EpisodeStatus, ReworkFrom } from "@ncs/shared";
import {
  actors,
  ConflictError,
  DomainValidationError,
  InvalidTransitionError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Tx,
} from "../../../platform/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { computeSpans, coversExactly, initialSpans, lineAttribution } from "../domain/attribution.js";
import { diffText } from "../domain/diff.js";
import { decideGate } from "../domain/gate.js";
import { retainSceneIds, storyPoint } from "../domain/scenes.js";
import { acceptedMaxChars, belowFloorByCounts, checkLength, countBasisLabel, countChars, lengthAdjustmentOf, normalizeText, type LengthCheck } from "../domain/text.js";
import { EPISODE_HARD_MIN_CHARS } from "@ncs/shared";
import { findEpisodeRule, HUMAN_EDITABLE_STATUSES } from "../domain/transitions.js";
import type {
  AttributionSpan,
  CheckGateVerdict,
  Episode,
  EpisodeRejection,
  EpisodeRuleId,
  GateOutcome,
  LengthOutOfRange,
  ManuscriptService,
  ManuscriptVersion,
  SaveVersionInput,
  Scene,
  SceneDraft,
} from "../index.js";
import { CHECK_PHASE_KINDS, isNotImplemented, settings, sha256, soft, WRITING_KINDS, type Ports } from "./support.js";

export interface InternalSaveVersion extends SaveVersionInput {
  stage?: EpisodeStatus;
  /** copy spans verbatim (E9 final copy) */
  inheritSpansFrom?: ManuscriptVersion | null;
}

export interface TransitionOpts {
  ruleId?: EpisodeRuleId;
  reason?: string;
  approvalId?: string | null;
  patch?: Partial<Episode>;
  details?: Record<string, unknown>;
}

export interface ManuscriptInternals {
  ports: Ports;
  mustEpisode(tx: Tx | undefined, scope: NovelScope, id: string, forUpdate?: boolean): Promise<Episode>;
  transition(tx: Tx, scope: NovelScope, episodeId: string, to: EpisodeStatus, actor: ActorRef, opts?: TransitionOpts): Promise<Episode>;
  saveVersion(tx: Tx, scope: NovelScope, episodeId: string, input: InternalSaveVersion): Promise<ManuscriptVersion>;
  approveInTx(tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef, approvalId: string | null): Promise<Episode>;
  /** gate evaluation in its own transaction (after the check tasks committed) */
  runGate(scope: NovelScope, episodeId: string): Promise<GateOutcome>;
  /** active task ids for an episode (outside any transaction) */
  activeEpisodeTasks(scope: NovelScope, episodeId: string): Promise<Array<{ id: string; kind: string; status: string }>>;
  lengthProfile(scope: NovelScope, tx?: Tx): Promise<{ minChars: number; maxChars: number; countBasis: "with_spaces" | "without_spaces" }>;
  spansOf(v: ManuscriptVersion | null): AttributionSpan[] | null;
  /** post-gate step: E6 then polish task, or straight to E8 when the checked version is already polished */
  afterGatePass(tx: Tx, scope: NovelScope, ep: Episode, actor: ActorRef): Promise<"polish_episode" | "awaiting_approval">;
  /** E8 + approval request (or full_auto E9(c)) */
  enterAwaitingApproval(tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef, summary: { lengthWarning: string | null; length?: LengthCheck | null }): Promise<Episode>;
  /** approval request for an episode already waiting without one (설계 추가 0014: level changed away from arc_approval) */
  requestEpisodeApproval(tx: Tx, scope: NovelScope, ep: Episode, actor: ActorRef, opts: { lengthWarning: string | null; belowFloor: boolean }): Promise<Episode>;
}

export function createManuscriptService(ports: Ports): { service: ManuscriptService; internals: ManuscriptInternals } {
  const { deps, reg } = ports;
  const { platform, audit, novel, ontology, orchestration, hitl } = deps;
  const { uow, ids, clock, log } = platform;
  const orchestrator = actors.system("orchestrator");
  const epRef = (id: string) => ({ type: "episode" as const, id });
  const cfg = settings();

  const mustEpisode = async (tx: Tx | undefined, scope: NovelScope, id: string, forUpdate = false) => {
    const e = await repo.getEpisode(tx?.db ?? uow.db, scope, id, forUpdate && !!tx);
    if (!e) throw new NotFoundError("회차", id);
    return e;
  };
  const mustVersion = async (tx: Tx | undefined, scope: NovelScope, id: string) => {
    const v = await repo.getVersion(tx?.db ?? uow.db, scope, id);
    if (!v) throw new NotFoundError("원고 버전", id);
    return v;
  };
  const spansOf = (v: ManuscriptVersion | null): AttributionSpan[] | null => (v ? ((v.attributionSpans as AttributionSpan[]) ?? []) : null);

  const lengthProfile = async (scope: NovelScope, tx?: Tx) => {
    const p = await novel.getLengthProfile(scope, tx);
    return { minChars: p.minChars, maxChars: p.maxChars, countBasis: p.countBasis };
  };
  /** 설계 추가 0017: a stored version outside the accepted range of the profile (null = in range) */
  const outOfRange = (v: { charCountWithSpaces: number; charCountWithoutSpaces: number }, profile: Awaited<ReturnType<typeof lengthProfile>>): LengthOutOfRange | null => {
    const count = profile.countBasis === "without_spaces" ? v.charCountWithoutSpaces : v.charCountWithSpaces;
    const a = lengthAdjustmentOf(count, profile, cfg.lengthTolerance);
    return a ? { deviation: a === "expand" ? "short" : "long", count, minChars: profile.minChars, maxChars: profile.maxChars, acceptedMaxChars: acceptedMaxChars(profile.maxChars, cfg.lengthTolerance) } : null;
  };

  // ── transitions ─────────────────────────────────────────────────────
  const transition = async (tx: Tx, scope: NovelScope, episodeId: string, to: EpisodeStatus, actor: ActorRef, opts: TransitionOpts = {}) => {
    const before = await mustEpisode(tx, scope, episodeId, true);
    const rule = findEpisodeRule(before.status, to, opts.ruleId);
    const updated = await repo.casStatus(tx.db, scope, episodeId, before.status, { ...(opts.patch ?? {}), status: to });
    if (!updated) throw new ConflictError("episode_changed", "화 상태가 동시에 바뀌었습니다. 다시 시도하세요.");
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: rule.action,
      target: epRef(episodeId),
      before: { status: before.status },
      after: { status: to },
      reason: opts.reason ?? null,
      approvalId: opts.approvalId ?? null,
      details: { rule: rule.id, episodeNo: before.episodeNo, ...(opts.details ?? {}) },
    });
    for (const hook of reg.transitionHooks) {
      await hook({ tx, scope, episode: updated, from: before.status, to, ruleId: rule.id, actor, approvalId: opts.approvalId ?? null });
    }
    tx.afterCommit(() => platform.workSignal.notify("task", scope.novelId));
    return updated;
  };

  // ── versions ────────────────────────────────────────────────────────
  const saveVersion = async (tx: Tx, scope: NovelScope, episodeId: string, input: InternalSaveVersion) => {
    const ep = await mustEpisode(tx, scope, episodeId, true);
    if (input.kind === "outline" && input.outlineData == null) throw new DomainValidationError("outline_data_required", "아웃라인에는 구성 데이터가 필요합니다.");
    const content = normalizeText(input.content);
    const id = ids.next("mnv");
    const versionNo = await repo.nextVersionNo(tx.db, scope, episodeId);
    const parentId = input.parentVersionId !== undefined ? input.parentVersionId : input.kind === "outline" ? ep.outlineVersionId : ep.currentVersionId;
    const parent = parentId ? await mustVersion(tx, scope, parentId) : null;
    const author = { actorType: input.author.type, actorId: input.author.id };
    let spans: AttributionSpan[];
    let humanSpansChanged = false;
    if (input.inheritSpansFrom) {
      spans = spansOf(input.inheritSpansFrom) ?? initialSpans(content.length, author, id);
    } else if (parent && parent.kind !== "outline" && input.kind !== "outline") {
      const r = computeSpans(spansOf(parent), diffText(parent.content, content), content.length, author, id);
      spans = r.spans;
      humanSpansChanged = r.humanSpansChanged;
    } else {
      spans = initialSpans(content.length, author, id);
    }
    if (!coversExactly(spans, content.length)) spans = initialSpans(content.length, author, id); // INV-MV-02 safety net
    const agent = input.author.type === "agent" ? input.author : null;
    const version = await repo.insertVersion(tx.db, {
      id,
      novelId: scope.novelId,
      episodeId,
      versionNo,
      kind: input.kind,
      parentVersionId: parent?.id ?? null,
      stage: input.stage ?? ep.status,
      content,
      outlineData: input.outlineData ?? null,
      charCountWithSpaces: countChars(content, "with_spaces"),
      charCountWithoutSpaces: countChars(content, "without_spaces"),
      contentHash: sha256(content),
      authorActorType: input.author.type,
      authorActorId: input.author.id,
      agentRole: agent ? agent.id : null,
      modelId: agent ? (input.modelId ?? "unknown") : (input.modelId ?? null),
      runId: agent ? agent.runId : null,
      isHumanEdit: input.isHumanEdit ?? input.author.type === "user",
      isFallbackModel: input.isFallbackModel ?? false,
      attributionSpans: spans,
      writerAnnotations: input.writerAnnotations ?? null,
    });
    const pointer = input.kind === "outline" ? { outlineVersionId: id } : input.kind === "final" ? {} : { currentVersionId: id };
    if (Object.keys(pointer).length) await repo.updateEpisode(tx.db, scope, episodeId, pointer);
    const length = input.kind === "outline" ? null : checkLength(content, await lengthProfile(scope, tx));
    await audit.record(tx, {
      novelId: scope.novelId,
      actor: input.author,
      action: "manuscript.version_created",
      target: { type: "manuscript_version", id },
      after: { episodeId, versionNo, kind: input.kind, stage: version.stage, charCountWithSpaces: version.charCountWithSpaces, charCountWithoutSpaces: version.charCountWithoutSpaces },
      details: { parentVersionId: parent?.id ?? null, lengthDeviation: length?.deviation ?? null, belowFloor: length?.belowFloor ?? null, humanSpansChanged },
    });
    if (humanSpansChanged) {
      // INV-MV-03: an agent version changed user-written text → high issue, never confirmed without approval
      await ports.openIssue(
        tx,
        scope,
        {
          kind: "human_edit_conflict",
          severity: "high",
          episodeId,
          manuscriptVersionId: id,
          sceneId: null,
          charStart: null,
          charEnd: null,
          message: "에이전트 버전이 사람이 쓴 구간을 바꿨습니다. 확인 후 승인해야 확정됩니다.",
          fixScope: "scene",
        },
        input.author,
      );
    }
    return version;
  };

  // ── scenes (07 §6) ──────────────────────────────────────────────────
  const replaceScenes = async (tx: Tx, scope: NovelScope, versionId: string, drafts: SceneDraft[], actor: ActorRef): Promise<Scene[]> => {
    const version = await mustVersion(tx, scope, versionId);
    const ep = await mustEpisode(tx, scope, version.episodeId, true);
    if (ep.status === "published") throw new DomainValidationError("published_no_resegment", "공개된 화는 씬을 다시 나눌 수 없습니다."); // INV-EP-04
    if (!drafts.length) throw new DomainValidationError("scenes_required", "씬이 하나 이상 있어야 합니다.");
    if (drafts.length > cfg.maxScenes) throw new DomainValidationError("too_many_scenes", `씬은 ${cfg.maxScenes}개를 넘을 수 없습니다.`);
    const sorted = [...drafts].sort((a, b) => a.charStart - b.charStart);
    let pos = 0;
    for (const d of sorted) {
      if (d.charStart !== pos || d.charEnd < d.charStart) throw new DomainValidationError("scene_ranges_invalid", "씬 구간이 본문 전체를 빈틈없이 덮어야 합니다."); // INV-SC-02
      pos = d.charEnd;
    }
    if (pos !== version.content.length) throw new DomainValidationError("scene_ranges_invalid", "씬 구간이 본문 전체를 빈틈없이 덮어야 합니다.");
    const old = await repo.lockActiveScenes(tx.db, scope, ep.id);
    const oldVersionIds = [...new Set(old.map((s) => s.manuscriptVersionId))];
    const oldContent = oldVersionIds.length === 1 ? (await mustVersion(tx, scope, oldVersionIds[0]!)).content : null;
    const ops = oldContent !== null ? diffText(oldContent, version.content) : [];
    const { assigned, retired, overlaps } = oldContent !== null
      ? retainSceneIds({ old: old.map((s) => ({ id: s.id, start: s.charStart, end: s.charEnd })), fresh: sorted.map((d) => ({ start: d.charStart, end: d.charEnd })), ops, minOverlap: cfg.sceneOverlapMin, oldText: oldContent, newText: version.content })
      : { assigned: sorted.map(() => null), retired: old.map((s) => s.id), overlaps: sorted.map(() => 0) };
    // free the active-ord unique index first, then re-activate retained rows with their new ord
    await repo.retireScenes(tx.db, scope, old.map((s) => s.id));
    const byId = new Map(old.map((s) => [s.id, s]));
    const timelineId = ep.primaryTimelineId;
    const out: Scene[] = [];
    const created: string[] = [];
    for (const [i, d] of sorted.entries()) {
      const ord = i + 1;
      const keep = assigned[i] ? byId.get(assigned[i]!) : undefined;
      const common = {
        ord,
        status: "active" as const,
        manuscriptVersionId: versionId,
        charStart: d.charStart,
        charEnd: d.charEnd,
        storyPoint: storyPoint(ep.episodeNo, ord),
        summary: d.summary || keep?.summary || "",
        timelineId: d.timelineId ?? keep?.timelineId ?? timelineId,
        povEntityId: d.povEntityId !== undefined ? d.povEntityId : (keep?.povEntityId ?? null),
        locationEntityId: d.locationEntityId !== undefined ? d.locationEntityId : (keep?.locationEntityId ?? null),
        narrationMode: d.narrationMode !== undefined ? d.narrationMode : (keep?.narrationMode ?? null),
      };
      if (keep) {
        out.push(await repo.updateScene(tx.db, scope, keep.id, { ...common, boundaryRevision: keep.boundaryRevision + 1 }));
      } else {
        const id = ids.next("scn");
        created.push(id);
        out.push(...(await repo.insertScenes(tx.db, [{ id, novelId: scope.novelId, episodeId: ep.id, ...common }])));
      }
    }
    const retainedIds = assigned.filter((x): x is string => !!x);
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "scene.resegmented",
      target: epRef(ep.id),
      before: { scenes: old.map((s) => ({ id: s.id, ord: s.ord, charStart: s.charStart, charEnd: s.charEnd })) },
      after: { scenes: out.map((s) => ({ id: s.id, ord: s.ord, charStart: s.charStart, charEnd: s.charEnd })) },
      details: { manuscriptVersionId: versionId, retained: retainedIds, retired, created, overlaps, count: out.length },
    });
    return out;
  };

  // ── approval / publish (E9, E13, E14) ───────────────────────────────
  const approveInTx = async (tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef, approvalId: string | null) => {
    const ep = await mustEpisode(tx, scope, episodeId, true);
    if (ep.status !== "awaiting_approval") throw new InvalidTransitionError("episode", ep.status, "approved");
    if (!ep.currentVersionId) throw new DomainValidationError("no_version", "승인할 원고 버전이 없습니다.");
    const source = await mustVersion(tx, scope, ep.currentVersionId);
    if (actor.type !== "user" && belowFloorByCounts(source, (await lengthProfile(scope, tx)).countBasis)) {
      throw new DomainValidationError("length_below_floor", "분량 미달(3,000자 미만) 원고는 자동 승인할 수 없습니다."); // 설계 추가 L11
    }
    const final = await saveVersion(tx, scope, episodeId, {
      kind: "final",
      content: source.content,
      parentVersionId: source.id,
      author: orchestrator,
      stage: "approved",
      inheritSpansFrom: source,
      isHumanEdit: false,
    });
    const now = clock.date();
    const updated = await transition(tx, scope, episodeId, "approved", actor, {
      ruleId: "E9",
      approvalId,
      patch: {
        approvedVersionId: final.id,
        approvedAt: now,
        approvedByActorType: actor.type,
        approvedByActorId: actor.id,
        blockReasons: ep.blockReasons.filter((r) => r !== "approval"),
      },
      details: { approvedVersionId: final.id, sourceVersionId: source.id },
    });
    const promoted = await soft(() => ontology.promoteEpisodeFacts(tx, scope, episodeId, "approved", actor), null);
    if (promoted) {
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "fact.status_changed",
        target: epRef(episodeId),
        after: { canonStatus: "approved" },
        approvalId,
        details: { count: promoted.promoted, held: promoted.held, bulk: true },
      });
    }
    // N4 (assumption, novel transitions): first approved episode moves the novel to serializing
    const n = await novel.getNovel(scope, tx);
    if (n.status === "planning") await novel.transitionStatus(tx, scope, "serializing", orchestrator, "첫 화 승인");
    // AR7: arc completed when every episode of the arc is approved/published
    const arcEps = await repo.listEpisodes(tx.db, scope, { arcId: ep.arcId });
    const arc = await novel.getArc(scope, ep.arcId, tx);
    if (arc.status === "active" && arcEps.every((e) => e.id === episodeId || e.status === "approved" || e.status === "published")) {
      await novel.transitionArc(tx, scope, arc.id, "completed", orchestrator, { reason: "마지막 화 승인" });
    }
    return updated;
  };

  const publishInTx = async (tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef) => {
    const ep = await mustEpisode(tx, scope, episodeId, true);
    if (ep.status !== "approved" || !ep.approvedVersionId) throw new InvalidTransitionError("episode", ep.status, "published");
    if (actor.type !== "user" && belowFloorByCounts(await mustVersion(tx, scope, ep.approvedVersionId), (await lengthProfile(scope, tx)).countBasis)) {
      throw new DomainValidationError("length_below_floor", "분량 미달(3,000자 미만) 원고는 자동 공개할 수 없습니다."); // 설계 추가 L12
    }
    const updated = await transition(tx, scope, episodeId, "published", actor, {
      ruleId: "E13",
      patch: { publishedVersionId: ep.approvedVersionId, publishedAt: clock.date(), publishedByActorType: actor.type, publishedByActorId: actor.id }, // INV-EP-03
      details: { publishedVersionId: ep.approvedVersionId },
    });
    const promoted = await soft(() => ontology.promoteEpisodeFacts(tx, scope, episodeId, "published_locked", actor), null);
    if (promoted) {
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "fact.status_changed",
        target: epRef(episodeId),
        after: { canonStatus: "published_locked" },
        details: { count: promoted.promoted, held: promoted.held, bulk: true },
      });
    }
    const n = await novel.getNovel(scope, tx);
    if (n.status === "planning") await novel.transitionStatus(tx, scope, "serializing", actor, "첫 화 공개");
    return updated;
  };

  // ── rejection (E10 / E11) ───────────────────────────────────────────
  const rejectInTx = async (
    tx: Tx,
    scope: NovelScope,
    episodeId: string,
    input: { decisionNote: string; reworkFrom: ReworkFrom; approvalId: string | null },
    actor: ActorRef,
  ): Promise<EpisodeRejection> => {
    if (!input.decisionNote?.trim()) throw new DomainValidationError("decision_note_required", "반려 사유를 입력하세요.");
    if (actor.type !== "user") throw new DomainValidationError("user_required", "반려는 사람만 할 수 있습니다.");
    const ep = await mustEpisode(tx, scope, episodeId, true);
    const ruleId: EpisodeRuleId = ep.status === "approved" ? "E11" : "E10";
    if (ep.status !== "awaiting_approval" && ep.status !== "approved") throw new InvalidTransitionError("episode", ep.status, "revising");
    const fromVersionId = ep.currentVersionId;
    if (!fromVersionId) throw new DomainValidationError("no_version", "반려할 원고 버전이 없습니다.");
    // E11 / full_auto may have no approval to link (episode_rejections.approval_id nullable since 0002)
    const rejectionNo = await repo.nextRejectionNo(tx.db, scope, episodeId);
    const rejection = await repo.insertRejection(tx.db, {
      id: ids.next("erj"),
      novelId: scope.novelId,
      episodeId,
      rejectionNo,
      approvalId: input.approvalId,
      fromVersionId,
      reason: input.decisionNote.trim(),
      reworkFrom: input.reworkFrom,
      rejectedByUserId: actor.id,
    });
    await transition(tx, scope, episodeId, "revising", actor, {
      ruleId,
      approvalId: input.approvalId,
      reason: input.decisionNote.trim(),
      patch: {
        rejectionCount: ep.rejectionCount + 1,
        lastReworkFrom: input.reworkFrom,
        autoRewriteCount: 0, // 07 §5.4 reset on human intervention
        blockReasons: ep.blockReasons.filter((r) => r !== "approval"),
        ...(ruleId === "E11" ? { approvedVersionId: null, approvedAt: null, approvedByActorType: null, approvedByActorId: null } : {}),
      },
      details: { rejectionId: rejection.id, rejectionNo, reworkFrom: input.reworkFrom, fromVersionId },
    });
    if (ruleId === "E11") await soft(() => ontology.demoteEpisodeFacts(tx, scope, episodeId, actor), null);
    await ports.createTask(tx, scope, {
      kind: "plan_rework",
      targetType: "episode",
      targetId: episodeId,
      episodeId,
      arcId: ep.arcId,
      input: { episode_id: episodeId, rejection_id: rejection.id, rework_from: input.reworkFrom, manuscript_version_id: fromVersionId, cycle_key: rejection.id },
      createdBy: actor,
      cycleKey: rejection.id,
      priority: 800,
    });
    return rejection;
  };

  // ── E8 entry ────────────────────────────────────────────────────────
  const enterAwaitingApproval = async (tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef, summary: { lengthWarning: string | null; length?: LengthCheck | null }) => {
    const n = await novel.getNovel(scope, tx);
    const pre = await mustEpisode(tx, scope, episodeId);
    const preVersion = pre.currentVersionId ? await mustVersion(tx, scope, pre.currentVersionId) : null;
    const profile = await lengthProfile(scope, tx);
    // 설계 추가 L10: under the 3,000-char floor → never auto-approved / auto-published; the user decides this episode alone
    const belowFloor = summary.length?.belowFloor ?? (preVersion ? belowFloorByCounts(preVersion, profile.countBasis) : false);
    const ep = await transition(tx, scope, episodeId, "awaiting_approval", actor, { ruleId: "E8", details: { lengthWarning: summary.lengthWarning, belowFloor } });
    // 설계 추가 0014: full_auto no longer approves here (E9(c) without an approval row); every level but arc_approval
    // requests the episode approval and the autopilot decides it (approval row + auto_decided + provenance "자동 승인")
    if (n.autonomyLevel === "arc_approval" && !belowFloor) return ep; // arc approval (plot batch) requested by the scheduler
    return requestEpisodeApproval(tx, scope, ep, actor, { lengthWarning: summary.lengthWarning, belowFloor });
  };

  /** per-episode approval request of an episode already in awaiting_approval (E8 above, or a level change away from arc_approval) */
  const requestEpisodeApproval = async (tx: Tx, scope: NovelScope, waiting: Episode, actor: ActorRef, opts: { lengthWarning: string | null; belowFloor: boolean }) => {
    let ep = waiting;
    const episodeId = ep.id;
    const belowFloor = opts.belowFloor;
    const summary = { lengthWarning: opts.lengthWarning };
    const profile = await lengthProfile(scope, tx);
    const version = ep.currentVersionId ? await mustVersion(tx, scope, ep.currentVersionId) : null;
    const counts = version ? `공백 포함 ${version.charCountWithSpaces}자 / 공백 제외 ${version.charCountWithoutSpaces}자` : "";
    const floorCount = version ? (profile.countBasis === "without_spaces" ? version.charCountWithoutSpaces : version.charCountWithSpaces) : 0;
    const range = version && !belowFloor ? outOfRange(version, profile) : null;
    const nv = await novel.getNovel(scope, tx);
    const sequential = nv.autonomyLevel === "episode_approval" && nv.sequentialEpisodes;
    const webBase = platform.config.server.public_base_url?.replace(/\/$/, "") ?? `http://${platform.config.server.host}:${platform.config.server.port}`;
    const body = [
      belowFloor ? `⚠ 분량 미달: ${countBasisLabel(profile.countBasis)} ${floorCount.toLocaleString("ko-KR")}자 (최소 ${EPISODE_HARD_MIN_CHARS.toLocaleString("ko-KR")}자). 자동 승인·공개하지 않습니다.` : null,
      `${ep.episodeNo}화${ep.title ? ` 「${ep.title}」` : ""} 원고가 검사와 다듬기를 마쳤습니다.`,
      ep.hookNote ? `회차 말 훅: ${ep.hookNote}` : null,
      counts ? `분량: ${counts}${summary.lengthWarning ? ` (${summary.lengthWarning})` : ""}` : null,
      `반려 횟수: ${ep.rejectionCount}`,
      `${ep.episodeNo}화를 읽고 승인해 주세요.${sequential ? ` 승인하면 ${ep.episodeNo + 1}화를 씁니다.` : ""}`,
      `읽기: ${webBase}/novels/${scope.novelId}/read/${ep.episodeNo}?mode=draft`,
      `수정 대화: ${webBase}/novels/${scope.novelId}/episodes/${ep.episodeNo}?mode=chat`,
      "승인하면 이 화의 후보 사실이 캐논이 됩니다. 반려하면 다시 작업할 단계와 사유를 적어 주세요.",
    ]
      .filter(Boolean)
      .join("\n");
    const req = await ports.requestApproval(tx, scope, {
      approvalType: "episode",
      target: epRef(episodeId),
      question: { title: `${ep.episodeNo}화 승인 요청${belowFloor ? " (분량 미달)" : ""}`, body, links: [epRef(episodeId), ...(version ? [{ type: "manuscript_version" as const, id: version.id }] : [])] },
      requestedBy: actor,
      // 설계 추가 0017: outside the accepted range → the autopilot leaves it to the author
      payload: { episodeNo: ep.episodeNo, ...(belowFloor ? { lengthBelowFloor: true } : {}), ...(range ? { lengthOutOfRange: range } : {}) },
    });
    ep = await repo.updateEpisode(tx.db, scope, episodeId, { blockReasons: [...new Set([...ep.blockReasons, "approval" as const])] });
    await audit.record(tx, { novelId: scope.novelId, actor, action: "episode.blocked", target: epRef(episodeId), after: { blockReasons: ep.blockReasons }, approvalId: req.approvalId });
    return ep;
  };

  const afterGatePass = async (tx: Tx, scope: NovelScope, ep: Episode, actor: ActorRef) => {
    await transition(tx, scope, ep.id, "polishing", actor, { ruleId: "E6" });
    const current = ep.currentVersionId ? await mustVersion(tx, scope, ep.currentVersionId) : null;
    // 설계 추가 0017: a writer version saved while polishing is the length-adjusted polished text (adjust_length)
    if (current && (current.agentRole === "line_editor" || (current.agentRole === "writer" && current.stage === "polishing"))) {
      // the checked version is the polished candidate (E7 recheck passed) → E8 right away
      const length = checkLength(current.content, await lengthProfile(scope, tx));
      await enterAwaitingApproval(tx, scope, ep.id, actor, { lengthWarning: lengthWarningOf(length), length });
      return "awaiting_approval" as const;
    }
    await ports.createTask(tx, scope, {
      kind: "polish_episode",
      targetType: "episode",
      targetId: ep.id,
      episodeId: ep.id,
      arcId: ep.arcId,
      input: { episode_id: ep.id, manuscript_version_id: ep.currentVersionId ?? undefined, cycle_key: ep.currentVersionId ?? ep.id },
      createdBy: actor,
      cycleKey: ep.currentVersionId ?? ep.id,
      priority: 500,
    });
    return "polish_episode" as const;
  };

  // ── gate (07 §5.3) ──────────────────────────────────────────────────
  const listCheckTasks = async (scope: NovelScope, ep: Episode, versionId: string) => {
    const kinds = CHECK_PHASE_KINDS.filter((k) => ports.isRegistered(k));
    if (!kinds.length) return { pending: [] as string[], failed: [] as string[] };
    const version = await mustVersion(undefined, scope, versionId);
    const tasks = await orchestration.listTasks(scope, { episodeId: ep.id, kinds: [...kinds], includeCancelled: false, limit: 500 });
    const forVersion = tasks.filter((t) => {
      const inp = (t.input ?? {}) as { manuscript_version_id?: string; version_id?: string };
      const vid = inp.manuscript_version_id ?? inp.version_id;
      return vid ? vid === versionId : t.createdAt >= version.createdAt;
    });
    const pending: string[] = [];
    const failed: string[] = [];
    for (const kind of kinds) {
      const ts = forVersion.filter((t) => t.kind === kind);
      if (!ts.length) {
        // a kind nobody created for this version: required only for my own kinds and the extraction chain
        if (kind === "split_scenes" || kind === "check_text_safety") pending.push(`${kind}:missing`);
        else if ((kind === "extract_facts" && ports.isRegistered("extract_facts")) || (kind === "link_mentions" && forVersion.some((t) => t.kind === "extract_facts"))) {
          pending.push(`${kind}:missing`);
        }
        continue;
      }
      if (ts.some((t) => t.status === "done")) continue;
      if (ts.every((t) => t.status === "failed")) failed.push(kind);
      else pending.push(kind);
    }
    return { pending, failed };
  };

  const evaluateContributors = async (scope: NovelScope, ep: Episode, versionId: string, tx?: Tx) => {
    const verdicts: CheckGateVerdict[] = [];
    for (const c of reg.contributors) {
      try {
        verdicts.push(await c.evaluate(scope, ep, versionId, tx));
      } catch (err) {
        if (isNotImplemented(err)) continue;
        throw err;
      }
    }
    return verdicts;
  };

  const runGate = async (scope: NovelScope, episodeId: string): Promise<GateOutcome> => {
    const pre = await mustEpisode(undefined, scope, episodeId);
    if (pre.status !== "checking" || !pre.currentVersionId) return { kind: "not_checking" };
    const tasks = await listCheckTasks(scope, pre, pre.currentVersionId);
    return uow.run(async (tx) => {
      let ep = await mustEpisode(tx, scope, episodeId, true);
      if (ep.status !== "checking" || ep.currentVersionId !== pre.currentVersionId) return { kind: "not_checking" } as const;
      const extractionFailed = tasks.failed.some((k) => ["split_scenes", "extract_facts", "link_mentions"].includes(k));
      if (tasks.failed.length) {
        if (extractionFailed && !ep.blockReasons.includes("extraction_failure")) await setBlock(tx, scope, ep, "extraction_failure", true, orchestrator);
        return { kind: "wait", reason: `failed: ${tasks.failed.join(",")}` } as const;
      }
      // a retried split/extract/link task succeeded: the "사실 추출 실패" block is stale
      if (ep.blockReasons.includes("extraction_failure")) ep = await setBlock(tx, scope, ep, "extraction_failure", false, orchestrator);
      const verdicts = await evaluateContributors(scope, ep, ep.currentVersionId!, tx);
      const d = decideGate({ tasksPending: tasks.pending, verdicts, autoRewriteCount: ep.autoRewriteCount, maxAutoRewrites: cfg.maxAutoRewrites });
      if (d.kind === "wait") return d;
      if (d.kind === "pass") {
        const next = await afterGatePass(tx, scope, ep, orchestrator);
        return { kind: "passed", next } as const;
      }
      if (d.kind === "rewrite_limit") {
        if (ep.blockReasons.includes("rewrite_limit")) return { kind: "rewrite_limit", questionId: null } as const;
        await setBlock(tx, scope, ep, "rewrite_limit", true, orchestrator);
        const issueLinks = d.blockers.filter((b) => b.refType === "continuity_issue").map((b) => ({ type: "continuity_issue" as const, id: b.refId }));
        const hasSafety = d.blockers.some((b) => /safety/.test(b.message) || b.refType === "safety");
        const questionId = await ports.createQuestion(
          tx,
          scope,
          {
            topic: "rewrite_limit",
            questionType: "single_choice",
            title: `${ep.episodeNo}화 자동 재작성 상한에 도달했습니다`,
            body: `검사에서 남은 문제를 자동으로 고치지 못했습니다(자동 재작성 ${ep.autoRewriteCount}회).\n${d.blockers.map((b) => `- ${b.message}`).join("\n")}`,
            options: [
              { label: "직접 고치기", value: "human_edit" },
              ...(hasSafety ? [] : [{ label: "이슈 허용", value: "waive_issue" }]),
              { label: "아웃라인부터 다시 쓰기", value: "replan_from_outline", isRecommended: true },
              { label: "보류", value: "hold" },
            ],
            links: issueLinks.length ? issueLinks : [epRef(ep.id)],
            proposedBlockingBasis: "rewrite_limit",
          },
          { createdBy: orchestrator },
        );
        return { kind: "rewrite_limit", questionId } as const;
      }
      const to = d.kind === "outline" ? "outlining" : "drafting";
      await transition(tx, scope, ep.id, to, orchestrator, {
        ruleId: d.kind === "outline" ? "E5" : "E4",
        patch: { autoRewriteCount: ep.autoRewriteCount + 1 },
        details: { blockers: d.blockers.slice(0, 50) },
      });
      const kind = d.kind === "outline" ? "outline_episode" : "revise_episode";
      const taskId = await ports.createTask(tx, scope, {
        kind,
        targetType: "episode",
        targetId: ep.id,
        episodeId: ep.id,
        arcId: ep.arcId,
        input: {
          episode_id: ep.id,
          manuscript_version_id: ep.currentVersionId ?? undefined,
          rework_cause: "check",
          target_scene_ids: d.kind === "draft" ? d.sceneIds : [],
          issue_refs: d.blockers.slice(0, 50).map((b) => ({ refType: b.refType, refId: b.refId, message: b.message })),
          cycle_key: ep.currentVersionId ?? ep.id,
        },
        createdBy: orchestrator,
        cycleKey: ep.currentVersionId ?? ep.id,
        priority: 800,
      });
      return { kind: "rewrite", to, taskId } as const;
    });
  };

  const setBlock = async (tx: Tx, scope: NovelScope, ep: Episode, reason: Episode["blockReasons"][number], on: boolean, actor: ActorRef) => {
    const has = ep.blockReasons.includes(reason);
    if (has === on) return ep;
    const next = on ? [...ep.blockReasons, reason] : ep.blockReasons.filter((r) => r !== reason);
    const updated = await repo.updateEpisode(tx.db, scope, ep.id, { blockReasons: next });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: on ? "episode.blocked" : "episode.unblocked",
      target: epRef(ep.id),
      before: { blockReasons: ep.blockReasons },
      after: { blockReasons: next },
      details: { reason },
    });
    return updated;
  };

  const activeEpisodeTasks = async (scope: NovelScope, episodeId: string) => {
    const ts = await orchestration.listTasks(scope, { episodeId, statuses: ["pending", "ready", "running", "blocked"], limit: 500 });
    return ts.map((t) => ({ id: t.id, kind: t.kind, status: t.status }));
  };

  // ── service ─────────────────────────────────────────────────────────
  const service: ManuscriptService = {
    async createPlannedEpisodes(tx, scope, arcId, list, actor) {
      const arc = await novel.getArc(scope, arcId, tx);
      const timelineId = await ports.defaultTimelineId(scope, tx);
      const out: Episode[] = [];
      for (const e of list) {
        if (e.episodeNo < arc.plannedEpisodeFrom || e.episodeNo > arc.plannedEpisodeTo) {
          throw new DomainValidationError("episode_outside_arc", `${e.episodeNo}화는 아크 범위(${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화) 밖입니다.`);
        }
        const existing = await repo.getEpisodeByNo(tx.db, scope, e.episodeNo);
        if (existing) {
          if (existing.arcId !== arcId) throw new ConflictError("episode_no_taken", `${e.episodeNo}화는 이미 다른 아크에 있습니다.`); // INV-EP-01
          if (existing.status === "planned") {
            // replan keeps the episode number and replaces only the plan fields (no outline exists yet)
            out.push(
              await repo.updateEpisode(tx.db, scope, existing.id, {
                title: e.title ?? existing.title,
                hookNote: e.hookNote ?? existing.hookNote,
                ...(e.planSummary !== undefined ? { planSummary: e.planSummary } : {}),
                ...(e.plannedSceneCount !== undefined ? { plannedSceneCount: e.plannedSceneCount } : {}),
                ...(e.targetChars !== undefined ? { targetChars: e.targetChars === null ? null : Math.max(EPISODE_HARD_MIN_CHARS, e.targetChars) } : {}),
              }),
            );
          } else out.push(existing);
          continue;
        }
        const [row] = await repo.insertEpisodes(tx.db, [
          {
            id: ids.next("epi"),
            novelId: scope.novelId,
            arcId,
            episodeNo: e.episodeNo,
            title: e.title ?? null,
            hookNote: e.hookNote ?? null,
            primaryTimelineId: timelineId,
            status: "planned",
            planSummary: e.planSummary ?? "",
            plannedSceneCount: e.plannedSceneCount ?? null,
            targetChars: e.targetChars == null ? null : Math.max(EPISODE_HARD_MIN_CHARS, e.targetChars),
          },
        ]);
        await audit.record(tx, { novelId: scope.novelId, actor, action: "episode.created", target: epRef(row!.id), after: { episodeNo: e.episodeNo, arcId, status: "planned" } });
        out.push(row!);
      }
      return out;
    },
    getEpisode: (scope, id, tx) => mustEpisode(tx, scope, id),
    async getEpisodeByNo(scope, no, tx) {
      const e = await repo.getEpisodeByNo(tx?.db ?? uow.db, scope, no);
      if (!e) throw new NotFoundError(`${no}화`, String(no));
      return e;
    },
    listEpisodes: (scope, filter, tx) => repo.listEpisodes(tx?.db ?? uow.db, scope, filter),
    async transitionEpisode(tx, scope, episodeId, to, actor, opts = {}) {
      const ep = await mustEpisode(tx, scope, episodeId, true);
      if (ep.status === "awaiting_approval" && to === "approved") return approveInTx(tx, scope, episodeId, actor, opts.approvalId ?? null);
      if (ep.status === "approved" && to === "published") return publishInTx(tx, scope, episodeId, actor);
      if (to === "revising") throw new DomainValidationError("use_reject", "반려는 rejectEpisode로 처리합니다.");
      return transition(tx, scope, episodeId, to, actor, opts);
    },
    async setBlockReason(tx, scope, episodeId, reason, on, actor) {
      return setBlock(tx, scope, await mustEpisode(tx, scope, episodeId, true), reason, on, actor);
    },
    async setEpisodePaused(scope, episodeId, paused, actor) {
      const tasks = (await activeEpisodeTasks(scope, episodeId)).filter((t) => t.status !== "blocked" || paused);
      return uow.run(async (tx) => {
        const ep = await mustEpisode(tx, scope, episodeId, true);
        if (!!ep.pausedAt === paused) return ep;
        const updated = await repo.updateEpisode(tx.db, scope, episodeId, { pausedAt: paused ? clock.date() : null });
        for (const t of tasks) {
          await soft(() => (paused ? orchestration.pause(tx, scope, { scope: "task", id: t.id }, "user", actor) : orchestration.resume(tx, scope, { scope: "task", id: t.id }, actor)), undefined);
        }
        await audit.record(tx, { novelId: scope.novelId, actor, action: paused ? "episode.paused" : "episode.resumed", target: epRef(episodeId), details: { taskIds: tasks.map((t) => t.id) } });
        if (!paused) tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return updated;
      });
    },

    saveVersion: (tx, scope, episodeId, input) => saveVersion(tx, scope, episodeId, input),
    async saveHumanEdit(scope, episodeNo, input, actor) {
      const pre = await service.getEpisodeByNo(scope, episodeNo);
      return uow.run((tx) => service.applyHumanEditTx(tx, scope, pre.id, input, actor));
    },
    async applyHumanEditTx(tx, scope, episodeId, input, actor) {
      if (actor.type !== "user") throw new DomainValidationError("user_required", "사람 편집은 사용자만 저장할 수 있습니다.");
      const ep = await mustEpisode(tx, scope, episodeId, true);
      if (ep.status === "published") throw new DomainValidationError("retcon_required", "공개된 화는 직접 고칠 수 없습니다. 리트콘 승인으로 진행하세요."); // INV-EP-04
      if (!HUMAN_EDITABLE_STATUSES.includes(ep.status)) throw new InvalidTransitionError("episode", ep.status, "checking", "지금 상태에서는 원고를 직접 고칠 수 없습니다.");
      const base = ep.currentVersionId ?? ep.outlineVersionId;
      if (input.baseVersionId !== base) {
        throw new ConflictError("stale_base_version", "다른 버전이 먼저 저장되었습니다. 최신 버전을 기준으로 다시 편집하세요.", { currentVersionId: base });
      }
      if (!normalizeText(input.content).trim()) throw new DomainValidationError("content_required", "본문이 비어 있습니다.");
      const tasks = (await orchestration.listTasks(scope, { episodeId: ep.id, statuses: ["pending", "ready", "running", "blocked"], limit: 500 }, tx)).map((t) => ({ id: t.id, kind: t.kind }));
      const pendingApprovals =
        ep.status === "awaiting_approval"
          ? (await soft(() => hitl.listApprovals(scope, { statuses: ["pending"], types: ["episode"] }, tx), [])).filter((a) => a.subjectId === ep.id)
          : [];
      // stop in-flight work on this episode (runs stop at their next checkpoint: superseded)
      for (const t of tasks) if (WRITING_KINDS.includes(t.kind as never) || CHECK_PHASE_KINDS.includes(t.kind as never)) await orchestration.cancelTask(tx, scope, t.id, actor);
      for (const a of pendingApprovals) await soft(() => hitl.supersedeApproval(tx, scope, a.id, null, actor), undefined); // A5
      const baseVersion = await mustVersion(tx, scope, input.baseVersionId);
      const version = await saveVersion(tx, scope, ep.id, {
        kind: "revision",
        content: input.content,
        parentVersionId: baseVersion.kind === "outline" ? null : baseVersion.id,
        author: actor,
        isHumanEdit: true,
        ...(input.writerAnnotations !== undefined ? { writerAnnotations: input.writerAnnotations } : {}),
      });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "manuscript.human_edited",
        target: { type: "manuscript_version", id: version.id },
        details: { episodeId: ep.id, baseVersionId: input.baseVersionId, statusAtEdit: ep.status, ...(input.auditDetails ?? {}) },
      });
      const patch = {
        autoRewriteCount: 0,
        blockReasons: ep.blockReasons.filter((r) => r !== "approval" && r !== "rewrite_limit"),
        ...(ep.status === "approved" ? { approvedVersionId: null, approvedAt: null, approvedByActorType: null, approvedByActorId: null } : {}),
      };
      if (ep.status !== "checking") {
        await transition(tx, scope, ep.id, "checking", actor, { ruleId: "E16", patch, details: { versionId: version.id } });
        if (ep.status === "approved") await soft(() => ontology.demoteEpisodeFacts(tx, scope, ep.id, actor), null);
      } else {
        await repo.updateEpisode(tx.db, scope, ep.id, patch);
      }
      await ports.createTask(tx, scope, {
        kind: "split_scenes",
        targetType: "episode",
        targetId: ep.id,
        episodeId: ep.id,
        arcId: ep.arcId,
        input: { episode_id: ep.id, manuscript_version_id: version.id, cycle_key: version.id },
        createdBy: actor,
        cycleKey: version.id,
        priority: 700,
      });
      return version;
    },
    getVersion: (scope, id, tx) => mustVersion(tx, scope, id),
    listVersions: (scope, episodeId, tx) => repo.listVersions(tx?.db ?? uow.db, scope, episodeId),
    replaceScenes,
    listScenes: (scope, episodeId, opts) => repo.listScenes(uow.db, scope, episodeId, opts),
    countChars,

    rejectEpisode: (tx, scope, episodeId, input, actor) => rejectInTx(tx, scope, episodeId, input, actor),
    listRejections: (scope, episodeId) => repo.listRejections(uow.db, scope, episodeId),
    async requestRevision(scope, episodeNo, input, actor) {
      const ep = await service.getEpisodeByNo(scope, episodeNo);
      if (ep.status !== "approved") throw new InvalidTransitionError("episode", ep.status, "revising", "공개 전 승인된 화만 수정 요청할 수 있습니다.");
      // the approval that approved this episode (E9 audit row carries it; arc approvals count too)
      const approvedEvents = await audit.list(scope, { targetIds: [ep.id], actionPrefix: "episode.approved", limit: 1 });
      let approvalId = approvedEvents.items[0]?.approvalId ?? null;
      if (!approvalId) {
        const approvals = await soft(() => hitl.listApprovals(scope, { statuses: ["approved"], types: ["episode"] }), []);
        approvalId = approvals.filter((a) => a.subjectId === ep.id).sort((a, b) => +b.createdAt - +a.createdAt)[0]?.id ?? null;
      }
      return uow.run((tx) => rejectInTx(tx, scope, ep.id, { ...input, approvalId }, actor));
    },
    publishEpisode: (scope, episodeId, actor) => uow.run((tx) => publishInTx(tx, scope, episodeId, actor)),
    setScheduledPublish(scope, episodeId, at, actor) {
      return uow.run(async (tx) => {
        const ep = await mustEpisode(tx, scope, episodeId, true);
        if (at && ep.status !== "approved") throw new InvalidTransitionError("episode", ep.status, "scheduled");
        if ((ep.scheduledPublishAt?.getTime() ?? null) === (at?.getTime() ?? null)) return ep;
        const updated = await repo.updateEpisode(tx.db, scope, episodeId, { scheduledPublishAt: at });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "episode.publish_scheduled",
          target: epRef(episodeId),
          before: { scheduledPublishAt: ep.scheduledPublishAt?.toISOString() ?? null },
          after: { scheduledPublishAt: at?.toISOString() ?? null },
          details: { episodeNo: ep.episodeNo },
        });
        return updated;
      });
    },
    async unpublishEpisode(scope, episodeId, input, actor) {
      if (input.confirmedNotPublishedExternally !== true) {
        throw new DomainValidationError("external_confirmation_required", "외부 플랫폼에 공개되지 않았음을 확인해야 공개를 취소할 수 있습니다."); // FR-MAN-03
      }
      if (!input.reason?.trim()) throw new DomainValidationError("reason_required", "공개 취소 사유를 입력하세요.");
      return uow.run(async (tx) => {
        const ep = await mustEpisode(tx, scope, episodeId, true);
        const updated = await transition(tx, scope, episodeId, "approved", actor, {
          ruleId: "E14",
          reason: input.reason.trim(),
          patch: { publishedVersionId: null, publishedAt: null, publishedByActorType: null, publishedByActorId: null },
          details: { previousPublishedVersionId: ep.publishedVersionId, confirmedNotPublishedExternally: true },
        });
        const demoted = await soft(() => ontology.demoteEpisodeFacts(tx, scope, episodeId, actor), null);
        if (demoted) {
          await audit.record(tx, { novelId: scope.novelId, actor, action: "fact.status_changed", target: epRef(episodeId), after: { canonStatus: "approved" }, details: { count: demoted.demoted, bulk: true } });
        }
        return updated;
      });
    },

    registerCheckGateContributor: (c) => void reg.contributors.push(c),
    async evaluateCheckGate(scope, episodeId, tx) {
      const ep = await mustEpisode(tx, scope, episodeId);
      const versionId = ep.currentVersionId;
      if (!versionId) return { pass: false, pending: true, fixScope: null, verdicts: [] };
      const tasks = tx ? { pending: [], failed: [] } : await listCheckTasks(scope, ep, versionId); // listTasks has no tx (PGlite single connection)
      const verdicts = await evaluateContributors(scope, ep, versionId, tx);
      const d = decideGate({ tasksPending: [...tasks.pending, ...tasks.failed], verdicts, autoRewriteCount: 0, maxAutoRewrites: Number.MAX_SAFE_INTEGER });
      const fixScope = d.kind === "outline" ? "outline" : d.kind === "draft" ? (verdicts.find((v) => !v.pass && v.fixScope)?.fixScope ?? "scene") : null;
      return { pass: d.kind === "pass", pending: d.kind === "wait", fixScope, verdicts };
    },
    onEpisodeTransition: (hook) => void reg.transitionHooks.push(hook),
    onArcPlanDecision: (hook) => void reg.arcPlanHooks.push(hook),

    async reserveSummary(scope) {
      const counts = await repo.countByStatus(uow.db, scope);
      const goal = await novel.getGoal(scope);
      return {
        includingAwaiting: (counts.awaiting_approval ?? 0) + (counts.approved ?? 0),
        approvedOnly: counts.approved ?? 0,
        target: goal?.reserveTargetEpisodes ?? cfg.reserveTarget,
      };
    },

    advanceCheckGate(tx, scope, episodeId) {
      // evaluated right after the caller's commit: task statuses are final then and listTasks needs no tx
      tx.afterCommit(async () => {
        try {
          await runGate(scope, episodeId);
        } catch (err) {
          log.warn({ err, episodeId }, "check gate evaluation failed (sweep will retry)");
        }
      });
      return Promise.resolve({ kind: "wait", reason: "deferred_after_commit" });
    },
    requestArcPlanApproval: () => {
      throw new Error("wired in module.ts");
    },
    getStructureView: () => {
      throw new Error("wired in module.ts");
    },
    requestStructure: () => {
      throw new Error("wired in module.ts");
    },
    decideStructure: () => {
      throw new Error("wired in module.ts");
    },
    replanArc: () => {
      throw new Error("wired in module.ts");
    },
    registerPlanningCastPort: (port) => {
      reg.castPort = port;
    },
    async withLengthFlags(scope, list) {
      const profile = await lengthProfile(scope);
      const out = [];
      for (const e of list) {
        const v = e.currentVersionId ? await repo.getVersion(uow.db, scope, e.currentVersionId) : null;
        out.push({ ...e, lengthBelowFloor: v ? belowFloorByCounts(v, profile.countBasis) : false, lengthOutOfRange: v ? outOfRange(v, profile) : null });
      }
      return out;
    },
    schedule: () => {
      throw new Error("wired in module.ts");
    },
    getEpisodeEnd: () => {
      throw new Error("wired in module.ts");
    },
    listPendingPriorFacts: () => {
      throw new Error("wired in module.ts");
    },
    registerIssueSink: (sink) => void reg.issueSinks.push(sink),
    registerPlannedBeatSource: (src) => void reg.beatSources.push(src),
    registerVersionAnnotator: (kind, a) => void reg.annotators[kind].push(a),
    async getVersionDetail(scope, versionId, include) {
      const v = await mustVersion(undefined, scope, versionId);
      const out: Record<string, unknown> = { ...v };
      if (!include.includes("spans")) delete out.attributionSpans;
      if (include.includes("lines")) out.lines = lineAttribution(v.content, spansOf(v) ?? []);
      if (include.includes("scenes")) {
        const all = await repo.listScenes(uow.db, scope, v.episodeId, { includeRetired: true });
        out.scenes = all.filter((s) => s.manuscriptVersionId === v.id || s.status === "active");
      }
      for (const k of ["issues", "beats"] as const) {
        if (!include.includes(k)) continue;
        const list = reg.annotators[k];
        out[k] = list.length ? (await Promise.all(list.map((a) => soft(() => a(scope, v), [])))).flat() : null;
      }
      return out;
    },
  };

  return {
    service,
    internals: {
      ports,
      mustEpisode,
      transition,
      saveVersion,
      approveInTx,
      runGate,
      activeEpisodeTasks,
      lengthProfile,
      spansOf,
      afterGatePass,
      enterAwaitingApproval,
      requestEpisodeApproval,
    },
  };
}

export function lengthWarningText(d: "short" | "long" | "floor"): string {
  return d === "floor" ? "분량 미달(최소 3,000자)" : d === "short" ? "분량 기준보다 짧습니다" : "분량 기준보다 깁니다";
}

/** warning text of a length check: the hard floor first, then the profile deviation */
export function lengthWarningOf(l: LengthCheck): string | null {
  return l.belowFloor ? lengthWarningText("floor") : l.deviation ? lengthWarningText(l.deviation) : null;
}
