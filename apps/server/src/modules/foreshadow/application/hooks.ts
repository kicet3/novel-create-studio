/**
 * foreshadow registrations into other modules (CONVENTIONS §6):
 *  - manuscript CheckGateContributor (07 §5.3 GC-2 "missing 비트 0") + onEpisodeTransition (E9/E13/E14/rewrite)
 *  - agents ContextSectionProvider `assigned_beats` (04 §9.5, FR-FOR-02/04)
 *  - hitl answer applier `setup_due` (FR-FOR-04, 05 §3.4) + approval handler `setup_abandon` (INV-SU-02)
 *  - manuscript version annotator `beats`
 */
import { DEFAULTS } from "@ncs/shared";
import { actors, AppError, NotFoundError, type ActorRef, type NovelScope } from "../../../platform/index.js";
import type { ContextSectionProvider } from "../../agents/index.js";
import type { AnswerApplier, ApprovalHandler } from "../../hitl/index.js";
import type { CheckGateContributor, EpisodeTransitionContext, VersionAnnotator } from "../../manuscript/index.js";
import { foreshadowRepo as repo } from "../adapters/db/foreshadow-repository.js";
import { setupDueOptionValueSchema, type SetupDueOptionValue } from "../domain/check.js";
import { effectiveDue } from "../domain/report.js";
import { formatSetupNo, TERMINAL_NARRATIVE } from "../domain/transitions.js";
import type { ForeshadowInternals } from "./foreshadow-service.js";
import type { ForeshadowPorts } from "./ports.js";

export function foreshadowGateContributor(svc: ForeshadowInternals): CheckGateContributor {
  return {
    name: "foreshadow",
    async evaluate(scope, episode, versionId, tx) {
      const beats = (await svc.beatsForEpisode(scope, episode.episodeNo, tx)).filter((b) => b.status !== "confirmed");
      const blockers: Array<{ refType: string; refId: string; message: string; sceneId?: string | null }> = [];
      let pending = false;
      for (const b of beats) {
        const checkedThisVersion = b.manuscriptVersionId === versionId;
        if (b.status === "planned" || !checkedThisVersion) pending = true;
        else if (b.status === "missing") {
          blockers.push({ refType: "setup_beat", refId: b.id, message: `떡밥 ${formatSetupNo(b.setup.displayNo)}의 ${b.kind} 비트가 없습니다.`, sceneId: null });
        }
      }
      return { source: "foreshadow", pass: !pending && blockers.length === 0, pending, fixScope: blockers.length ? "scene" : undefined, blockers };
    },
  };
}

const REWRITE_TARGETS = new Set(["drafting", "outlining"]);

export function foreshadowTransitionHook(deps: ForeshadowPorts, svc: ForeshadowInternals) {
  return async (ctx: EpisodeTransitionContext): Promise<void> => {
    const { tx, scope, episode, from, to } = ctx;
    const system = actors.system("orchestrator");
    if (to === "approved" && from !== "published") {
      // E9: approved version's detected beats → confirmed; S2–S4; overdue reviews (FR-FOR-04)
      await svc.confirmEpisodeBeats(tx, scope, episode, ctx.actor.type === "user" ? ctx.actor : system);
      await svc.scheduleOverdueReviews(tx, scope, episode.episodeNo, system).catch((err) => {
        // only application-level refusals (e.g. INV-GOL-01) are skipped; DB errors abort the transaction anyway
        if (!(err instanceof AppError)) throw err;
        deps.platform.log.warn({ err, episodeId: episode.id }, "foreshadow: overdue review scheduling skipped");
        return [];
      });
    } else if (to === "published") {
      await svc.setEpisodeBeatsPublished(tx, scope, episode.id, true, ctx.actor); // E13 / SC4
    } else if (from === "published" && to === "approved") {
      await svc.setEpisodeBeatsPublished(tx, scope, episode.id, false, ctx.actor); // E14 / SC5
    } else if (REWRITE_TARGETS.has(to) && from !== "planned") {
      await svc.resetDetectedBeats(tx, scope, episode.id, system); // B4 (E4/E5/E12)
    }
  };
}

export function assignedBeatsSection(deps: ForeshadowPorts, svc: ForeshadowInternals): ContextSectionProvider {
  return {
    section: "assigned_beats",
    module: "foreshadow",
    async build(scope, spec) {
      let episodeNo = Math.floor(spec.anchor.storyPoint / 1000);
      if (spec.episodeId) {
        const ep = await deps.manuscript.getEpisode(scope, spec.episodeId).catch(() => null);
        if (ep) episodeNo = ep.episodeNo;
      }
      if (episodeNo < 1) return null;
      const beats = await svc.beatsForEpisode(scope, episodeNo);
      const warn = DEFAULTS["setup.due_warning_episodes"];
      const dueSoon = (await svc.listSetups(scope, { narrativeStatuses: ["planted", "reinforced"] })).filter((s) => {
        const due = s.effectiveDueEpisodeNo;
        return due != null && due >= episodeNo && due - episodeNo <= warn && !beats.some((b) => b.setupId === s.id && b.kind === "payoff");
      });
      if (!beats.length && !dueSoon.length) return null;
      const lines = [`## 이번 화(${episodeNo}화)에 배정된 떡밥 비트`];
      for (const b of beats) {
        lines.push(`- [${b.id}] ${formatSetupNo(b.setup.displayNo)} "${b.setup.title}" — ${b.kind}: ${b.setup.description}${b.plannedNote ? ` (메모: ${b.plannedNote})` : ""}`);
      }
      if (dueSoon.length) {
        lines.push("", "## 회수 기한이 가까운 떡밥 (회수 제안)");
        for (const s of dueSoon) lines.push(`- ${formatSetupNo(s.displayNo)} "${s.title}" — 기한 ${s.effectiveDueEpisodeNo}화: ${s.description}`);
      }
      const text = lines.join("\n");
      return { text, tokenEstimate: Math.ceil(text.length / 2), refs: { setupIds: [...new Set([...beats.map((b) => b.setupId), ...dueSoon.map((s) => s.id)])] } };
    },
  };
}

/** finds a setup_due option value anywhere in the answer payload (selected option values) */
export function findSetupDueValue(payload: unknown): (SetupDueOptionValue & { setup_id?: string }) | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): (SetupDueOptionValue & { setup_id?: string }) | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const parsed = setupDueOptionValueSchema.safeParse(v);
    if (parsed.success) return { ...parsed.data, setup_id: typeof (v as { setup_id?: unknown }).setup_id === "string" ? (v as { setup_id: string }).setup_id : undefined };
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      const r = walk(child);
      if (r) return r;
    }
    return null;
  };
  return walk(payload);
}

export function setupDueApplier(deps: ForeshadowPorts, svc: ForeshadowInternals): AnswerApplier {
  return async ({ tx, scope, question, answer, actor, selectedOptions }) => {
    const value = findSetupDueValue((selectedOptions ?? []).map((o) => o.value)) ?? findSetupDueValue(answer.payload);
    if (!value) return { status: "not_applied", reason: "선택한 처리 방법을 해석할 수 없습니다.", items: [] };
    const setupId = value.setup_id;
    if (!setupId) return { status: "not_applied", reason: "질문에 연결된 떡밥을 찾을 수 없습니다.", items: [] };
    const s = await repo.getSetup(tx.db, scope, setupId);
    if (!s) throw new NotFoundError("떡밥", setupId);
    if (TERMINAL_NARRATIVE.includes(s.narrativeStatus)) return { status: "not_applied", reason: "이미 끝난 떡밥입니다.", items: [] };
    const ref = { type: "setup" as const, id: s.id };
    if (value.kind === "extend") {
      await svc.changeDue(tx, scope, s.id, { dueKind: "episode", dueEpisodeNo: value.to_due_episode_no, reason: "기한 초과 질문 답변: 기한 연장", questionId: question.id }, actor);
      return { status: "applied", items: [{ changeKind: "setup_changed", ref, summary: `${formatSetupNo(s.displayNo)} 기한을 ${value.to_due_episode_no}화로 연장했습니다.` }] };
    }
    if (value.kind === "assign") {
      const due = effectiveDue(s, await svc.arcEnds(scope, tx));
      if (due == null || value.episode_no > due) {
        await svc.changeDue(tx, scope, s.id, { dueKind: "episode", dueEpisodeNo: value.episode_no, reason: "기한 초과 질문 답변: 회수 화 지정", questionId: question.id }, actor);
      }
      const beats = await svc.planBeats(tx, scope, s.id, [{ kind: "payoff", plannedEpisodeNo: value.episode_no, note: "기한 초과 질문 답변으로 배정" }], actor);
      return {
        status: "applied",
        items: [{ changeKind: "setup_changed", ref: { type: "setup_beat", id: beats[0]!.id }, summary: `${formatSetupNo(s.displayNo)}을(를) ${value.episode_no}화에서 회수하도록 배정했습니다.` }],
      };
    }
    // abandon → approval (INV-SU-02)
    const { approvalId } = await deps.hitl.requestApproval(tx, scope, {
      approvalType: "setup_abandon",
      target: ref,
      question: {
        title: `떡밥 ${formatSetupNo(s.displayNo)} "${s.title}" 폐기 승인`,
        body: `기한이 지난 떡밥을 폐기할지 결정해 주세요. 폐기하면 더 이상 회수하지 않습니다.\n\n${s.description}`,
        links: [ref],
      },
      requestedBy: actor,
    });
    return { status: "applied", items: [{ changeKind: "setup_changed", ref: { type: "approval", id: approvalId }, summary: `${formatSetupNo(s.displayNo)} 폐기 승인을 요청했습니다.` }] };
  };
}

export function setupAbandonHandler(svc: ForeshadowInternals): ApprovalHandler {
  return async ({ tx, scope, approval, decision, decisionNote, actor }) => {
    if (decision !== "approved" || approval.subjectType !== "setup") return;
    const s = await repo.getSetup(tx.db, scope, approval.subjectId);
    if (!s || TERMINAL_NARRATIVE.includes(s.narrativeStatus)) return;
    const reason = decisionNote?.trim() || "사용자가 떡밥 폐기를 승인했습니다.";
    if (s.canonStatus === "candidate") {
      // planned + candidate cannot be abandoned (03 §4.7 combination) → excluded from the plan (SC3)
      await svc.transitionCanon(tx, scope, s.id, "rejected", actor as ActorRef, { approvalId: approval.id, reason });
      return;
    }
    // the approval being decided is the guard itself (its status may still be updated by hitl after the handler)
    await svc.transitionNarrativeVerified(tx, scope, s.id, "abandoned", actor, reason, { approvalId: approval.id });
  };
}

export function beatsAnnotator(deps: ForeshadowPorts): VersionAnnotator {
  return async (scope: NovelScope, version) => {
    const beats = await repo.listBeats(deps.platform.uow.db, scope, { episodeId: version.episodeId });
    return beats.filter((b) => b.manuscriptVersionId === version.id);
  };
}
