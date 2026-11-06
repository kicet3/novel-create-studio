import { DEFAULTS, EPISODE_HARD_MIN_CHARS, EPISODE_HARD_MIN_MESSAGE, type NovelStatus } from "@ncs/shared";
import {
  ConflictError,
  DomainValidationError,
  InvalidTransitionError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type {
  Arc,
  GoalGuard,
  GoalSavedContext,
  NovelCreatedContext,
  NovelCreationParticipant,
  NovelApprovalPort,
  NovelHook,
  NovelService,
  SavedGoal,
  NovelStatusChangedContext,
  SeriesBible,
} from "../index.js";
import {
  assertArcTransition,
  assertBibleTransition,
  assertMvpAgeRating,
  assertNovelTransition,
  diffFields,
  rangesOverlap,
  resolveAutonomy,
} from "../domain/transitions.js";
import { novelRepo as repo } from "../adapters/db/novel-repository.js";
import { createStructureMethods } from "./structure-service.js";

/** title of a novel created without one (title_source=provisional) */
const PROVISIONAL_TITLE = "제목 미정";

export interface NovelServiceDeps {
  platform: Platform;
  audit: AuditService;
}

export function createNovelService({ platform, audit }: NovelServiceDeps): NovelService {
  const { uow, ids } = platform;
  const participants: NovelCreationParticipant[] = [];
  const statusHooks: Array<NovelHook<NovelStatusChangedContext>> = [];
  const goalHooks: Array<NovelHook<GoalSavedContext>> = [];
  const goalGuards: GoalGuard[] = [];
  let ownerCache: string | null = null;
  let approvals: NovelApprovalPort | null = null;

  const target = (scope: NovelScope) => ({ type: "novel" as const, id: scope.novelId });

  const mustNovel = async (tx: Tx | undefined, scope: NovelScope, forUpdate = false) => {
    const n = await repo.getNovel(tx?.db ?? uow.db, scope.novelId, { forUpdate: forUpdate && !!tx });
    if (!n) throw new NotFoundError("작품", scope.novelId);
    return n;
  };
  const mustArc = async (tx: Tx | undefined, scope: NovelScope, arcId: string, forUpdate = false) => {
    const a = await repo.getArc(tx?.db ?? uow.db, scope, arcId, forUpdate && !!tx);
    if (!a) throw new NotFoundError("아크", arcId);
    return a;
  };
  const mustBible = async (tx: Tx | undefined, scope: NovelScope, id: string, forUpdate = false) => {
    const b = await repo.getBible(tx?.db ?? uow.db, scope, id, forUpdate && !!tx);
    if (!b) throw new NotFoundError("기획서", id);
    return b;
  };

  const changeStatus = async (tx: Tx, scope: NovelScope, to: NovelStatus, actor: ActorRef, reason?: string, extra?: Record<string, unknown>) => {
    const before = await mustNovel(tx, scope, true);
    const rule = assertNovelTransition(before.status, to);
    const novel = await repo.updateNovel(tx.db, scope.novelId, { status: to, ...extra });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "novel.status_changed",
      target: target(scope),
      before: { status: before.status },
      after: { status: to },
      reason: reason ?? null,
      details: { rule: rule.id },
    });
    for (const h of statusHooks) await h({ tx, scope, from: before.status, to, ruleId: rule.id, novel, actor });
    return novel;
  };

  const assertArcRangeFree = async (tx: Tx, scope: NovelScope, range: { from: number; to: number }, exceptArcId?: string) => {
    const clash = (await repo.listArcs(tx.db, scope)).find(
      (a) => a.id !== exceptArcId && a.status !== "cancelled" && rangesOverlap(range, { from: a.plannedEpisodeFrom, to: a.plannedEpisodeTo }),
    );
    if (clash) {
      throw new ConflictError("arc_range_overlap", `계획 화 범위가 아크 '${clash.title}'(${clash.plannedEpisodeFrom}~${clash.plannedEpisodeTo}화)와 겹칩니다.`, {
        arcId: clash.id,
      });
    }
  };

  const structure = createStructureMethods({ platform, audit, approvals: () => approvals });

  const service: NovelService = {
    ...structure,
    // ── users ──
    async ensureOwnerUser(displayName = "작가") {
      const existing = await repo.firstOwner(uow.db);
      if (existing) {
        ownerCache = existing.id;
        return existing;
      }
      const user = await repo.insertUser(uow.db, { id: ids.next("usr"), displayName, role: "owner" });
      ownerCache = user.id;
      return user;
    },
    getOwnerUser: () => repo.firstOwner(uow.db),

    // ── hooks ──
    registerCreationParticipant(p) {
      if (participants.some((x) => x.module === p.module)) throw new Error(`creation participant already registered: ${p.module}`);
      participants.push(p);
      participants.sort((a, b) => a.order - b.order);
    },
    onStatusChanged: (h) => void statusHooks.push(h),
    onGoalSaved: (h) => void goalHooks.push(h),
    registerGoalGuard(g) {
      if (goalGuards.some((x) => x.module === g.module)) throw new Error(`goal guard already registered: ${g.module}`);
      goalGuards.push(g);
    },

    // ── novel ──
    async createNovel(input, actor) {
      const ownerUserId = ownerCache ?? (await service.ensureOwnerUser()).id;
      const ageRating = input.ageRating ?? "age_15";
      assertMvpAgeRating(ageRating);
      const prepared: NovelCreatedContext["prepared"] = {};
      for (const p of participants) if (p.prepare) prepared[p.module] = await p.prepare();
      return uow.run(async (tx) => {
        const scope = { novelId: ids.next("nov") };
        const schemaVersionId = ids.next("osv");
        let preset = (await repo.presets(tx.db))[0];
        if (!preset) {
          const d = DEFAULTS["length.default_profile"];
          preset = await repo.insertLengthProfile(tx.db, {
            id: ids.next("lpf"),
            novelId: null,
            name: "기본",
            minChars: d.min_chars,
            maxChars: d.max_chars,
            countBasis: d.count_basis,
          });
        }
        // novels.active_schema_version_id is DEFERRABLE INITIALLY DEFERRED: the ontology participant inserts it below.
        const givenTitle = input.title?.trim() && input.title.trim() !== PROVISIONAL_TITLE ? input.title.trim() : "";
        const novel = await repo.insertNovel(tx.db, {
          id: scope.novelId,
          title: givenTitle || PROVISIONAL_TITLE,
          titleSource: givenTitle ? "user" : "provisional",
          ageRating,
          status: "concept",
          timezone: input.timezone ?? "Asia/Seoul",
          defaultNarrationMode: DEFAULTS["novel.default_narration_mode"],
          lengthProfileId: preset.id,
          activeSchemaVersionId: schemaVersionId,
        });
        const quiet = DEFAULTS["question.quiet_hours"];
        await repo.insertNotificationPolicy(tx.db, {
          id: ids.next("ntp"),
          novelId: scope.novelId,
          quietHoursStart: quiet.start,
          quietHoursEnd: quiet.end,
          urgentExceptionEnabled: DEFAULTS["question.urgent_exception_enabled"],
          dailyCapNonBlocking: DEFAULTS["question.daily_cap_non_blocking"],
          digestWindowMinutes: DEFAULTS["question.digest_window_minutes"],
          digestMaxItems: DEFAULTS["question.digest_max_items"],
          deadlineHoursBlocking: DEFAULTS["question.deadline_hours.blocking"],
          deadlineHoursNonBlocking: DEFAULTS["question.deadline_hours.non_blocking"],
          reminderOffsetsMinutes: [...DEFAULTS["question.reminders.blocking"]],
          dailySummaryTime: DEFAULTS["question.daily_summary_time"],
        });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.created",
          target: target(scope),
          after: { title: novel.title, ageRating, status: "concept", entryMode: input.entryMode ?? "conversation" },
        });
        const ctx: NovelCreatedContext = {
          tx,
          scope,
          novel,
          actor,
          ownerUserId,
          entryMode: input.entryMode ?? "conversation",
          schemaVersionId,
          prepared,
          outputs: {},
        };
        for (const p of participants) await p.onNovelCreated(ctx);
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return novel;
      });
    },
    async exists(novelId) {
      return (await repo.getNovel(uow.db, novelId)) !== null;
    },
    getNovel: (scope, tx) => mustNovel(tx, scope),
    listNovels: (opts = {}) => repo.listNovels(uow.db, opts.includeArchived ?? false),
    updateSettings(scope, patch, actor, outer) {
      return uow.join(outer, async (tx) => {
        const before = await mustNovel(tx, scope, true);
        // a title the user changed (or explicitly confirmed) is final: concept working titles no longer replace it.
        // Re-sending the unchanged title (e.g. a settings form) does not confirm an auto title.
        const { confirmTitle, ...rest } = patch;
        const titleChanged = rest.title !== undefined && rest.title.trim() !== before.title;
        const effective = titleChanged || confirmTitle ? { ...rest, titleSource: "user" as const } : rest;
        const diff = diffFields(before as unknown as Record<string, unknown>, effective as Record<string, unknown>);
        if (!diff) return before;
        const novel = await repo.updateNovel(tx.db, scope.novelId, diff.after);
        await audit.record(tx, { novelId: scope.novelId, actor, action: "novel.settings_changed", target: target(scope), ...diff });
        return novel;
      });
    },
    async changeAutonomy(scope, input, actor) {
      const next = resolveAutonomy(input);
      return uow.run(async (tx) => {
        const before = await mustNovel(tx, scope, true);
        if (before.autonomyLevel === next.autonomyLevel && before.publishPolicy === next.publishPolicy) return before;
        const novel = await repo.updateNovel(tx.db, scope.novelId, next);
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.autonomy_changed",
          target: target(scope),
          before: { autonomyLevel: before.autonomyLevel, publishPolicy: before.publishPolicy },
          after: next,
          reason: input.reason ?? null,
          details: { acknowledgedFullAutoWarning: input.acknowledgedFullAutoWarning },
        });
        return novel;
      });
    },
    pause(scope, reason, actor, opts = {}) {
      return uow.join(opts.tx, async (tx) => {
        const before = await mustNovel(tx, scope, true);
        if (before.pausedAt && before.pauseReason === reason) return before;
        const novel = await repo.updateNovel(tx.db, scope.novelId, { pausedAt: platform.clock.date(), pauseReason: reason });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.paused",
          target: target(scope),
          before: { pauseReason: before.pauseReason },
          after: { pauseReason: reason },
          reason: opts.note ?? null,
        });
        return novel;
      });
    },
    resume(scope, actor, opts = {}) {
      return uow.join(opts.tx, async (tx) => {
        const before = await mustNovel(tx, scope, true);
        if (!before.pausedAt) return before;
        const novel = await repo.updateNovel(tx.db, scope.novelId, { pausedAt: null, pauseReason: null });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.resumed",
          target: target(scope),
          before: { pauseReason: before.pauseReason },
          reason: opts.note ?? null,
        });
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return novel;
      });
    },
    async transitionStatus(tx, scope, to, actor, reason) {
      if (to === "onboarding" || to === "planning") {
        throw new InvalidTransitionError("novel", "?", to, "이 전이는 컨셉 승인(N2) 또는 목표 저장(N3)으로만 일어납니다.");
      }
      return changeStatus(tx, scope, to, actor, reason);
    },
    async applyConceptApproval(tx, scope, input, actor) {
      assertMvpAgeRating(input.ageRating);
      const before = await mustNovel(tx, scope, true);
      const briefTitle = input.title?.trim();
      const candidate = input.titleCandidates?.map((t) => t.trim()).find(Boolean);
      const titleFields = briefTitle
        ? { title: briefTitle, titleSource: "user" as const }
        : candidate && before.titleSource === "provisional"
          ? { title: candidate, titleSource: "auto" as const }
          : {};
      const fields = {
        ...titleFields,
        genre: input.genre,
        ageRating: input.ageRating,
        targetAudience: input.targetAudience ?? null,
        ...(input.defaultNarrationMode ? { defaultNarrationMode: input.defaultNarrationMode } : {}),
        category: input.category,
        approvedConceptBriefId: input.conceptBriefId,
      };
      if (input.purpose === "initial") {
        if (before.status !== "concept") throw new InvalidTransitionError("novel", before.status, "onboarding");
      } else {
        if (before.status === "concept") throw new DomainValidationError("revision_before_initial", "첫 컨셉 승인 전에는 개정할 수 없습니다.");
        if (await repo.getApprovedBible(tx.db, scope)) {
          throw new DomainValidationError(
            "bible_already_approved",
            "기획서 승인 후 컨셉 개정은 기획서 개정 승인(CB7)에서 반영합니다.",
          );
        }
      }
      const diff = diffFields(before as unknown as Record<string, unknown>, fields);
      let novel = diff ? await repo.updateNovel(tx.db, scope.novelId, fields) : before;
      if (diff) {
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.settings_changed",
          target: target(scope),
          ...diff,
          approvalId: input.approvalId ?? null,
          details: { source: "concept_brief", conceptBriefId: input.conceptBriefId, purpose: input.purpose },
        });
      }
      if (input.purpose === "initial") novel = await changeStatus(tx, scope, "onboarding", actor, "컨셉 승인");
      return novel;
    },
    async applyWorkingTitle(tx, scope, input, actor) {
      const before = await mustNovel(tx, scope, true);
      const title = input.title.trim().slice(0, 200);
      if (!title || (before.titleSource === "user" && input.source !== "user")) return { novel: before, applied: false };
      const fields = { title, titleSource: input.source };
      const diff = diffFields(before as unknown as Record<string, unknown>, fields);
      if (!diff) return { novel: before, applied: false };
      const novel = await repo.updateNovel(tx.db, scope.novelId, diff.after);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "novel.settings_changed",
        target: target(scope),
        ...diff,
        reason: input.reason ?? null,
        details: { source: "concept_working_title" },
      });
      return { novel, applied: true };
    },
    nextDisplayNo: (tx, scope, kind) => repo.nextCounter(tx.db, scope, kind),

    // ── goal ──
    getGoal: (scope, tx) => repo.getGoal(tx?.db ?? uow.db, scope),
    saveGoal(scope, input, actor) {
      return uow.run(async (tx): Promise<SavedGoal> => {
        let novel = await mustNovel(tx, scope, true);
        if (novel.status === "concept") {
          throw new DomainValidationError("concept_not_approved", "컨셉을 승인한 뒤에 목표를 정할 수 있습니다."); // INV-NOV-05
        }
        if (novel.status === "archived") throw new DomainValidationError("novel_archived", "보관된 작품은 바꿀 수 없습니다.");
        const previous = await repo.getGoal(tx.db, scope, true);
        if (!previous && novel.status === "onboarding") for (const g of goalGuards) await g.check({ tx, scope, novel, actor });
        if (previous && input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) {
          throw new ConflictError("stale_revision", "다른 곳에서 목표가 먼저 바뀌었습니다. 새로 고친 뒤 다시 저장하세요.", {
            currentRevision: previous.revision,
          });
        }
        // 03 Goal.ending_direction / 05 §10: after the first save an ending change waits for an approval
        const endingChange =
          previous && approvals && input.endingDirection.trim() !== previous.endingDirection.trim() ? input.endingDirection.trim() : null;
        const values = {
          totalEpisodesMin: input.totalEpisodesMin,
          totalEpisodesMax: input.totalEpisodesMax,
          cadenceEpisodesPerWeek: input.cadenceEpisodesPerWeek,
          reserveTargetEpisodes: input.reserveTargetEpisodes,
          endingDirection: endingChange !== null ? previous!.endingDirection : input.endingDirection,
          notes: input.notes,
        };
        let goal;
        let before: Record<string, unknown> | null = null;
        let after: Record<string, unknown> = { ...values, revision: 1 };
        let changed = true;
        if (!previous) {
          goal = await repo.insertGoal(tx.db, { id: ids.next("gol"), novelId: scope.novelId, revision: 1, ...values });
        } else {
          const diff = diffFields(previous as unknown as Record<string, unknown>, values);
          if (!diff) {
            goal = previous;
            changed = false;
          } else {
            goal = await repo.updateGoal(tx.db, scope, previous.id, { ...values, revision: previous.revision + 1 });
            before = { ...diff.before, revision: previous.revision };
            after = { ...diff.after, revision: goal.revision };
          }
        }
        let pendingEndingChange: SavedGoal["pendingEndingChange"];
        if (endingChange !== null) {
          const req = await approvals!.requestApproval(tx, scope, {
            approvalType: "ending_change",
            target: { type: "goal", id: goal.id },
            question: {
              title: "결말 방향을 바꿀까요?",
              body: `결말 방향 변경은 승인이 필요합니다.\n\n지금: ${previous!.endingDirection}\n바꿀 내용: ${endingChange}\n\n승인하면 이후 기획·집필에 새 결말 방향이 반영됩니다.`,
              links: [{ type: "goal", id: goal.id }],
            },
            requestedBy: actor,
            payload: { from: previous!.endingDirection, to: endingChange, goalRevision: goal.revision },
          });
          pendingEndingChange = { approvalId: req.approvalId, questionId: req.questionId, endingDirection: endingChange };
        }
        if (!changed) return pendingEndingChange ? { ...goal, pendingEndingChange } : goal;
        await audit.record(tx, { novelId: scope.novelId, actor, action: "goal.updated", target: { type: "goal", id: goal.id }, before, after });
        const enteredPlanning = novel.status === "onboarding";
        if (enteredPlanning) novel = await changeStatus(tx, scope, "planning", actor, "목표 저장");
        for (const h of goalHooks) await h({ tx, scope, goal, previous, novel, enteredPlanning, actor });
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return pendingEndingChange ? { ...goal, pendingEndingChange } : goal;
      });
    },

    connectApprovals(port) {
      approvals = port;
      port.registerApprovalHandler("ending_change", async ({ tx, scope, approval, decision, actor, answerId }) => {
        if (decision !== "approved") return; // rejected: the goal keeps its ending direction
        const to = (approval.payload as { to?: unknown } | null)?.to;
        if (typeof to !== "string" || !to.trim()) return;
        const previous = await repo.getGoal(tx.db, scope, true);
        if (!previous || previous.id !== approval.subjectId || previous.endingDirection === to) return;
        const goal = await repo.updateGoal(tx.db, scope, previous.id, { endingDirection: to, revision: previous.revision + 1 });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "goal.updated",
          target: { type: "goal", id: goal.id },
          before: { endingDirection: previous.endingDirection, revision: previous.revision },
          after: { endingDirection: goal.endingDirection, revision: goal.revision },
          approvalId: approval.id,
          answerId,
        });
        // 설계 추가: an approved / pending story structure must be re-approved against the new ending direction
        const st = await repo.getStructure(tx.db, scope);
        if (st && (st.status !== "draft" || st.approvedRevision)) {
          await structure.reopenStructure(tx, scope, { goalEndingChanged: true }, actor, "연재 목표의 결말 방향 변경");
        }
        const novel = await mustNovel(tx, scope);
        for (const h of goalHooks) await h({ tx, scope, goal, previous, novel, enteredPlanning: false, actor });
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
      });
    },

    // ── series bible ──
    async createBibleVersion(tx, scope, input, actor) {
      const versionNo = await repo.nextBibleVersionNo(tx.db, scope);
      const bible = await repo.insertBible(tx.db, {
        id: ids.next("bib"),
        novelId: scope.novelId,
        versionNo,
        status: "draft",
        logline: input.logline,
        synopsis: input.synopsis,
        content: input.content ?? {},
        contentMd: input.contentMd,
        authorActorType: actor.type,
        authorActorId: actor.id,
        conceptBriefId: input.conceptBriefId,
      });
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "series_bible.version_created",
        target: { type: "series_bible", id: bible.id },
        after: { versionNo, status: "draft", conceptBriefId: input.conceptBriefId },
      });
      return bible;
    },
    async transitionBible(tx, scope, bibleId, to, actor, opts = {}) {
      const before = await mustBible(tx, scope, bibleId, true);
      assertBibleTransition(before.status, to);
      const patch: Partial<SeriesBible> = { status: to };
      if (to === "awaiting_approval" && opts.approvalId) patch.approvalId = opts.approvalId;
      if (to === "approved") {
        patch.approvedAt = platform.clock.date();
        if (opts.approvalId) patch.approvalId = opts.approvalId;
        const prev = await repo.getApprovedBible(tx.db, scope);
        if (prev && prev.id !== bibleId) {
          await repo.updateBible(tx.db, scope, prev.id, { status: "superseded" });
          await audit.record(tx, {
            novelId: scope.novelId,
            actor,
            action: "series_bible.status_changed",
            target: { type: "series_bible", id: prev.id },
            before: { status: "approved" },
            after: { status: "superseded" },
            details: { supersededBy: bibleId },
          });
        }
      }
      const bible = await repo.updateBible(tx.db, scope, bibleId, patch);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "series_bible.status_changed",
        target: { type: "series_bible", id: bibleId },
        before: { status: before.status },
        after: { status: to },
        approvalId: opts.approvalId ?? null,
        reason: opts.reason ?? null,
      });
      return bible;
    },
    getBible: (scope, id, tx) => mustBible(tx, scope, id),
    getApprovedBible: (scope, tx) => repo.getApprovedBible(tx?.db ?? uow.db, scope),
    listBibles: (scope, tx) => repo.listBibles(tx?.db ?? uow.db, scope),

    // ── arcs ──
    async createArc(outer, scope, input, actor) {
      if (input.plannedEpisodeTo < input.plannedEpisodeFrom) {
        throw new DomainValidationError("arc_range_invalid", "끝 화는 시작 화 이상이어야 합니다.");
      }
      return uow.join(outer, async (tx) => {
        await mustNovel(tx, scope);
        await assertArcRangeFree(tx, scope, { from: input.plannedEpisodeFrom, to: input.plannedEpisodeTo });
        if ((await repo.listArcs(tx.db, scope)).some((a) => a.ord === input.ord)) {
          throw new ConflictError("arc_ord_taken", `${input.ord}번째 아크가 이미 있습니다.`);
        }
        const arc = await repo.insertArc(tx.db, { id: ids.next("arc"), novelId: scope.novelId, status: "planned", ...input });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "arc.created",
          target: { type: "arc", id: arc.id },
          after: { ...input, status: "planned" },
        });
        return arc;
      });
    },
    updateArc(scope, arcId, patch, actor, outer) {
      return uow.join(outer, async (tx) => {
        const before = await mustArc(tx, scope, arcId, true);
        if (before.status === "completed" || before.status === "cancelled") {
          throw new DomainValidationError("arc_closed", "끝난 아크는 고칠 수 없습니다.");
        }
        const range = { from: patch.plannedEpisodeFrom ?? before.plannedEpisodeFrom, to: patch.plannedEpisodeTo ?? before.plannedEpisodeTo };
        if (range.to < range.from) throw new DomainValidationError("arc_range_invalid", "끝 화는 시작 화 이상이어야 합니다.");
        await assertArcRangeFree(tx, scope, range, arcId);
        const diff = diffFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
        if (!diff) return before;
        const arc = await repo.updateArc(tx.db, scope, arcId, diff.after);
        await audit.record(tx, { novelId: scope.novelId, actor, action: "arc.updated", target: { type: "arc", id: arcId }, ...diff });
        return arc;
      });
    },
    async transitionArc(tx, scope, arcId, to, actor, opts = {}) {
      const before = await mustArc(tx, scope, arcId, true);
      const rule = assertArcTransition(before.status, to);
      const patch: Partial<Arc> = { status: to };
      if (opts.planApprovalId) patch.planApprovalId = opts.planApprovalId;
      if (opts.arcApprovalId) patch.arcApprovalId = opts.arcApprovalId;
      const arc = await repo.updateArc(tx.db, scope, arcId, patch);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "arc.status_changed",
        target: { type: "arc", id: arcId },
        before: { status: before.status },
        after: { status: to },
        approvalId: opts.arcApprovalId ?? opts.planApprovalId ?? null,
        reason: opts.reason ?? null,
        details: { rule: rule.id },
      });
      return arc;
    },
    setArcPaused(scope, arcId, paused, actor, outer) {
      return uow.join(outer, async (tx) => {
        const before = await mustArc(tx, scope, arcId, true);
        if (!!before.pausedAt === paused) return before;
        const arc = await repo.updateArc(tx.db, scope, arcId, { pausedAt: paused ? platform.clock.date() : null });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: paused ? "arc.paused" : "arc.resumed",
          target: { type: "arc", id: arcId },
        });
        if (!paused) tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return arc;
      });
    },
    getArc: (scope, arcId, tx) => mustArc(tx, scope, arcId),
    listArcs: (scope, tx) => repo.listArcs(tx?.db ?? uow.db, scope),
    async findArcForEpisode(scope, episodeNo, tx) {
      const list = await repo.listArcs(tx?.db ?? uow.db, scope);
      return list.find((a) => a.status !== "cancelled" && a.plannedEpisodeFrom <= episodeNo && episodeNo <= a.plannedEpisodeTo) ?? null;
    },

    // ── length profile ──
    async getLengthProfile(scope, tx) {
      const novel = await mustNovel(tx, scope);
      const p = await repo.getLengthProfile(tx?.db ?? uow.db, novel.lengthProfileId);
      if (!p) throw new NotFoundError("분량 프로필", novel.lengthProfileId);
      return p;
    },
    listLengthPresets: () => repo.presets(uow.db),
    updateLengthProfile(scope, patch, actor) {
      return uow.run(async (tx) => {
        const novel = await mustNovel(tx, scope, true);
        const current = await repo.getLengthProfile(tx.db, novel.lengthProfileId);
        if (!current) throw new NotFoundError("분량 프로필", novel.lengthProfileId);
        const next = { minChars: patch.minChars ?? current.minChars, maxChars: patch.maxChars ?? current.maxChars, countBasis: patch.countBasis ?? current.countBasis };
        if (next.minChars < EPISODE_HARD_MIN_CHARS) throw new DomainValidationError("length_min_too_low", EPISODE_HARD_MIN_MESSAGE); // 0008 floor
        if (next.maxChars < next.minChars) throw new DomainValidationError("length_range_invalid", "최대 글자 수는 최소 글자 수 이상이어야 합니다.");
        const diff = diffFields(current as unknown as Record<string, unknown>, next);
        if (!diff) return current;
        let profile;
        if (current.novelId === null) {
          profile = await repo.insertLengthProfile(tx.db, { id: ids.next("lpf"), novelId: scope.novelId, name: current.name, ...next });
          await repo.updateNovel(tx.db, scope.novelId, { lengthProfileId: profile.id });
        } else {
          profile = await repo.updateLengthProfile(tx.db, scope, current.id, next);
        }
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.settings_changed",
          target: target(scope),
          before: { lengthProfile: diff.before },
          after: { lengthProfile: diff.after },
        });
        return profile;
      });
    },

    // ── notification policy ──
    async getNotificationPolicy(scope, tx) {
      const p = await repo.getNotificationPolicy(tx?.db ?? uow.db, scope);
      if (!p) throw new NotFoundError("알림 정책", scope.novelId);
      return p;
    },
    updateNotificationPolicy(scope, patch, actor) {
      return uow.run(async (tx) => {
        const before = await service.getNotificationPolicy(scope, tx);
        const diff = diffFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
        if (!diff) return before;
        const policy = await repo.updateNotificationPolicy(tx.db, scope, diff.after);
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "novel.settings_changed",
          target: target(scope),
          before: { notificationPolicy: diff.before },
          after: { notificationPolicy: diff.after },
        });
        return policy;
      });
    },
  };
  return service;
}
