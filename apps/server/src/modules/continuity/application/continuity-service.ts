/**
 * continuity use cases (03 §3.6, §4.6; 07 §5.1, §5.3–5.6). State changes: domain table → row → audit,
 * all in the caller's transaction.
 */
import type { ContinuityIssueKind, IssueSeverity, RefType } from "@ncs/shared";
import { actors, DomainValidationError, NotFoundError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { SetupIssueDraft, SetupIssueSink } from "../../foreshadow/index.js";
import type { SafetyIssueDraft } from "../../manuscript/index.js";
import { continuityRepo as repo } from "../adapters/db/continuity-repository.js";
import { dedupeKeyOf, planReconcile, type ExistingIssue } from "../domain/rules.js";
import { assertIssueTransition, OPEN_STATUSES, SAFETY_KINDS, SETUP_KINDS } from "../domain/transitions.js";
import type { ContinuityIssue, ContinuityService, IssueEvidenceInput, OpenIssueInput, TransitionIssueOptions } from "../index.js";
import type { ContinuityPorts } from "./ports.js";

const issueRef = (id: string) => ({ type: "continuity_issue" as const, id });

/** issue draft produced by a check (dedupe key already computed) */
export type IssueDraft = OpenIssueInput & { dedupeKey: string };

export interface ReconcileInput {
  episodeId: string;
  manuscriptVersionId: string;
  drafts: IssueDraft[];
  /** kinds this check owns — only these existing issues are reconciled */
  kinds: readonly ContinuityIssueKind[];
  /** active scene ids of the new version (an issue whose scene vanished is superseded, C8) */
  sceneIds?: ReadonlySet<string> | null;
  isHumanEdit?: boolean;
}

export interface ContinuityInternals extends ContinuityService {
  reconcile(tx: Tx, scope: NovelScope, input: ReconcileInput, actor: ActorRef): Promise<{ opened: string[]; relinked: string[]; resolved: string[] }>;
  /** resolve open issues detected on versions other than `currentVersionId` (gate passed on the current one) */
  closeStaleIssues(tx: Tx, scope: NovelScope, episodeId: string, currentVersionId: string, isHumanEdit: boolean, actor: ActorRef): Promise<number>;
  setupIssueSink: SetupIssueSink;
  safetyIssueSink: (tx: Tx, scope: NovelScope, issue: SafetyIssueDraft, actor: ActorRef) => Promise<{ issueId: string }>;
}

function evidenceRows(scope: NovelScope, issueId: string, ev: IssueEvidenceInput[]) {
  const rows: Array<{ novelId: string; issueId: string; refType: RefType; refId: string; factVersionId: string | null; schemaRuleKey: string | null; note: string | null }> = [];
  for (const e of ev) {
    const base = { novelId: scope.novelId, issueId, factVersionId: null as string | null, schemaRuleKey: e.schemaRuleKey ?? null, note: e.quote ?? null };
    if (e.factId || e.factVersionId) rows.push({ ...base, refType: "fact", refId: e.factId ?? e.factVersionId!, factVersionId: e.factVersionId ?? null });
    if (e.answerId) rows.push({ ...base, refType: "answer", refId: e.answerId });
    if (e.nameId) rows.push({ ...base, refType: "entity_name", refId: e.nameId });
    if (e.mentionId) rows.push({ ...base, refType: "mention", refId: e.mentionId });
    if (e.setupId) rows.push({ ...base, refType: "setup", refId: e.setupId });
    if (e.setupBeatId) rows.push({ ...base, refType: "setup_beat", refId: e.setupBeatId });
    if (e.glossaryTermId) rows.push({ ...base, refType: "glossary_term", refId: e.glossaryTermId });
    if (e.arcId) rows.push({ ...base, refType: "arc", refId: e.arcId });
    if (e.manuscriptVersionId) rows.push({ ...base, refType: "manuscript_version", refId: e.manuscriptVersionId });
  }
  return rows;
}

function evidenceIds(ev: IssueEvidenceInput[]): string[] {
  return ev.flatMap((e) => [e.factId ?? e.factVersionId, e.answerId, e.nameId, e.mentionId, e.setupId, e.setupBeatId, e.glossaryTermId, e.arcId, e.manuscriptVersionId].filter((x): x is string => !!x));
}

export function createContinuityService(deps: ContinuityPorts): ContinuityInternals {
  const { platform, audit } = deps;

  async function lock(tx: Tx, scope: NovelScope, id: string): Promise<ContinuityIssue> {
    const i = await repo.getIssue(tx.db, scope, id, true);
    if (!i) throw new NotFoundError("연속성 이슈", id);
    return i;
  }

  async function insertIssue(tx: Tx, scope: NovelScope, input: OpenIssueInput, dedupeKey: string, actor: ActorRef, previousIssueId: string | null): Promise<ContinuityIssue> {
    const rows = evidenceRows(scope, "x", input.evidence);
    // INV-CI-01: evidence + location (episode at least). Safety / human-edit drafts from manuscript carry location only.
    if (!rows.length && !SAFETY_KINDS.includes(input.kind) && input.kind !== "human_edit_conflict") {
      throw new DomainValidationError("issue_evidence_required", "연속성 이슈에는 근거가 1개 이상 있어야 합니다.");
    }
    if (!input.episodeId || !input.manuscriptVersionId) throw new DomainValidationError("issue_location_required", "이슈에는 원고 위치(화·버전)가 있어야 합니다.");
    if (!input.message.trim()) throw new DomainValidationError("issue_message_required", "이슈 내용을 입력하세요.");
    const displayNo = await deps.novel.nextDisplayNo(tx, scope, "continuity_issue");
    const issue = await repo.insertIssue(tx.db, {
      id: platform.ids.next("cis"),
      novelId: scope.novelId,
      displayNo,
      episodeId: input.episodeId,
      manuscriptVersionId: input.manuscriptVersionId,
      sceneId: input.sceneId ?? null,
      charStart: input.charStart ?? null,
      charEnd: input.charEnd ?? null,
      kind: input.kind,
      severity: input.severity,
      detector: input.detector,
      detectedByRunId: input.detectedByRunId ?? (actor.type === "agent" ? actor.runId : null),
      message: input.message.trim(),
      proposedFix: input.suggestion ?? null,
      fixScope: input.fixScope ?? null,
      dedupeKey,
      previousIssueId: previousIssueId ?? input.previousIssueId ?? null,
    });
    await repo.insertEvidence(tx.db, evidenceRows(scope, issue.id, input.evidence));
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "continuity_issue.opened",
      target: issueRef(issue.id),
      after: { displayNo, kind: issue.kind, severity: issue.severity, episodeId: issue.episodeId, manuscriptVersionId: issue.manuscriptVersionId, sceneId: issue.sceneId },
      details: { rule: "C1", detector: issue.detector, evidence: rows.length, previousIssueId: issue.previousIssueId },
    });
    return issue;
  }

  async function relink(tx: Tx, scope: NovelScope, existing: ContinuityIssue, draft: OpenIssueInput, reopen: boolean, actor: ActorRef): Promise<ContinuityIssue> {
    if (reopen) {
      // C4: reproduced after a rewrite
      assertIssueTransition({ from: existing.status, to: "open", kind: existing.kind, severity: existing.severity, actor });
    }
    const after = await repo.updateIssue(tx.db, scope, existing.id, {
      status: reopen ? "open" : existing.status,
      manuscriptVersionId: draft.manuscriptVersionId,
      sceneId: draft.sceneId ?? null,
      charStart: draft.charStart ?? null,
      charEnd: draft.charEnd ?? null,
      message: draft.message.trim() || existing.message,
      proposedFix: draft.suggestion ?? existing.proposedFix,
      fixScope: draft.fixScope ?? existing.fixScope,
      detectedByRunId: draft.detectedByRunId ?? (actor.type === "agent" ? actor.runId : existing.detectedByRunId),
    });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "continuity_issue.status_changed",
      target: issueRef(existing.id),
      before: { status: existing.status, manuscriptVersionId: existing.manuscriptVersionId },
      after: { status: after.status, manuscriptVersionId: after.manuscriptVersionId },
      details: { rule: reopen ? "C4" : "C1", relinked: true },
    });
    return after;
  }

  async function transition(tx: Tx, scope: NovelScope, issueId: string, to: ContinuityIssue["status"], actor: ActorRef, opts: TransitionIssueOptions = {}): Promise<ContinuityIssue> {
    const i = await lock(tx, scope, issueId);
    let retconApprovalId: string | null = null;
    let canonChangeApprovalId: string | null = null;
    let humanEditAfterIssue = false;
    if (opts.approvalId && (to === "waived" || to === "resolved")) {
      const apr = await deps.hitl.getApproval(scope, opts.approvalId, tx);
      if (apr.status === "approved" && apr.approvalType === "retcon") retconApprovalId = apr.id;
      if (apr.status === "approved" && apr.approvalType === "canon_change") canonChangeApprovalId = apr.id;
    }
    if (to === "resolved" && actor.type === "user" && opts.resolutionKind === "human_edited") {
      const ep = await deps.manuscript.getEpisode(scope, i.episodeId, tx);
      if (ep.currentVersionId && ep.currentVersionId !== i.manuscriptVersionId) {
        const [cur, old] = await Promise.all([deps.manuscript.getVersion(scope, ep.currentVersionId, tx), deps.manuscript.getVersion(scope, i.manuscriptVersionId, tx)]);
        humanEditAfterIssue = cur.isHumanEdit && cur.versionNo > old.versionNo;
      }
    }
    const rule = assertIssueTransition({
      from: i.status,
      to,
      kind: i.kind,
      severity: i.severity,
      actor,
      resolutionKind: opts.resolutionKind ?? null,
      autoFixDiff: opts.autoFixDiff,
      retconApprovalId,
      canonChangeApprovalId,
      humanEditAfterIssue,
    });
    const closing = !OPEN_STATUSES.includes(to);
    const after = await repo.updateIssue(tx.db, scope, i.id, {
      status: to,
      resolutionKind: to === "resolved" ? opts.resolutionKind! : i.resolutionKind,
      autoFixDiff: opts.autoFixDiff !== undefined ? opts.autoFixDiff : i.autoFixDiff,
      resolvedByActorType: closing ? actor.type : null,
      resolvedByActorId: closing ? actor.id : null,
      resolvedAt: closing ? platform.clock.date() : null,
      questionId: opts.questionId ?? i.questionId,
      approvalId: opts.approvalId ?? i.approvalId,
    });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: rule.action,
      target: issueRef(i.id),
      before: { status: i.status },
      after: { status: to, resolutionKind: after.resolutionKind },
      reason: opts.note ?? null,
      approvalId: opts.approvalId ?? null,
      questionId: opts.questionId ?? null,
      details: { rule: rule.id, kind: i.kind, severity: i.severity },
    });
    return after;
  }

  async function resolveNotReproduced(tx: Tx, scope: NovelScope, issue: ContinuityIssue, sceneIds: ReadonlySet<string> | null | undefined, isHumanEdit: boolean, actor: ActorRef) {
    const system = actors.system("orchestrator");
    if (issue.sceneId && sceneIds && !sceneIds.has(issue.sceneId)) {
      return transition(tx, scope, issue.id, "superseded", system, { note: "새 버전에서 위치가 사라졌습니다." }); // C8
    }
    if (issue.status === "fixing") return transition(tx, scope, issue.id, "resolved", actor, { resolutionKind: isHumanEdit ? "human_edited" : "rewritten" }); // C3
    if (isHumanEdit) return transition(tx, scope, issue.id, "resolved", actor, { resolutionKind: "human_edited" }); // C5
    await transition(tx, scope, issue.id, "fixing", system); // C2
    return transition(tx, scope, issue.id, "resolved", actor, { resolutionKind: "rewritten" }); // C3
  }

  const svc: ContinuityInternals = {
    async openIssue(tx, scope, input, actor) {
      const ids = evidenceIds(input.evidence);
      const key = input.dedupeKey ?? dedupeKeyOf(input.episodeId, input.kind, input.ruleId ?? input.kind, ids, input.entityIds ?? []);
      const existing = (await repo.listIssues(tx.db, scope, { episodeId: input.episodeId })).filter((i) => i.dedupeKey === key);
      const active = existing.find((i) => OPEN_STATUSES.includes(i.status));
      if (active) return relink(tx, scope, active, input, active.status === "fixing", actor);
      const decided = existing.find((i) => i.status === "waived" || i.status === "false_positive");
      if (decided) return decided;
      return insertIssue(tx, scope, input, key, actor, existing[0]?.id ?? null);
    },

    transitionIssue: transition,

    async supersedeForNewVersion(tx, scope, episodeId, newVersionId, actor) {
      const stale = (await repo.listIssues(tx.db, scope, { episodeId, statuses: ["open", "fixing"] })).filter((i) => i.manuscriptVersionId !== newVersionId);
      for (const i of stale) await transition(tx, scope, i.id, "superseded", actor, { note: "아웃라인부터 다시 쓴 새 버전" });
      return stale.length;
    },

    async markFixing(tx, scope, episodeId, actor, opts = {}) {
      const open = (await repo.listIssues(tx.db, scope, { episodeId, statuses: ["open"], severities: ["high"] })).filter((i) => !opts.issueIds || opts.issueIds.includes(i.id));
      for (const i of open) await transition(tx, scope, i.id, "fixing", actor);
      return open.length;
    },

    async listIssues(scope, filter = {}, tx) {
      return repo.listIssues(tx?.db ?? platform.uow.db, scope, filter);
    },

    async getIssue(scope, issueId) {
      const i = await repo.getIssue(platform.uow.db, scope, issueId);
      if (!i) throw new NotFoundError("연속성 이슈", issueId);
      return { ...i, evidence: await repo.listEvidence(platform.uow.db, scope, [i.id]) };
    },

    async countOpenBySeverity(scope, opts = {}) {
      return repo.countOpenBySeverity(platform.uow.db, scope, opts.episodeId);
    },

    async reconcile(tx, scope, input, actor) {
      const existingRows = (await repo.listIssues(tx.db, scope, { episodeId: input.episodeId, kinds: [...input.kinds] }));
      const byId = new Map(existingRows.map((i) => [i.id, i]));
      const existing: ExistingIssue[] = existingRows.map((i) => ({ id: i.id, dedupeKey: i.dedupeKey, status: i.status, manuscriptVersionId: i.manuscriptVersionId, createdAt: i.createdAt }));
      const steps = planReconcile(input.drafts, existing, input.manuscriptVersionId);
      const out = { opened: [] as string[], relinked: [] as string[], resolved: [] as string[] };
      for (const s of steps) {
        if (s.op === "create") out.opened.push((await insertIssue(tx, scope, s.draft, s.draft.dedupeKey, actor, s.previousIssueId)).id);
        else if (s.op === "relink") out.relinked.push((await relink(tx, scope, byId.get(s.issueId)!, s.draft, s.reopen, actor)).id);
        else if (s.op === "resolve") {
          await resolveNotReproduced(tx, scope, byId.get(s.issueId)!, input.sceneIds, input.isHumanEdit ?? false, actor);
          out.resolved.push(s.issueId);
        }
      }
      return out;
    },

    async closeStaleIssues(tx, scope, episodeId, currentVersionId, isHumanEdit, actor) {
      const stale = (await repo.listIssues(tx.db, scope, { episodeId, statuses: ["open", "fixing"] })).filter((i) => i.manuscriptVersionId !== currentVersionId);
      for (const i of stale) await resolveNotReproduced(tx, scope, i, null, isHumanEdit, actor);
      return stale.length;
    },

    setupIssueSink: {
      async reconcileSetupIssues(tx, scope, input, actor) {
        const drafts: IssueDraft[] = input.drafts.map((d: SetupIssueDraft) => {
          const evidence: IssueEvidenceInput[] = [{ setupId: d.setupId }, { setupBeatId: d.beatId }, ...(d.factVersionIds ?? []).map((f) => ({ factId: f.factId, factVersionId: f.factVersionId }))];
          const ruleId = d.kind === "setup_missing" ? "CR-14" : "CR-15";
          return {
            kind: d.kind,
            severity: d.severity,
            detector: "foreshadow_manager",
            episodeId: d.episodeId,
            manuscriptVersionId: d.manuscriptVersionId,
            sceneId: d.sceneId ?? null,
            charStart: d.charStart ?? null,
            charEnd: d.charEnd ?? null,
            message: d.message,
            suggestion: d.suggestion ?? null,
            fixScope: d.fixScope ?? "scene",
            evidence,
            detectedByRunId: input.runId,
            ruleId,
            // the beat identifies the issue across versions (not the fact versions, which may move)
            dedupeKey: dedupeKeyOf(d.episodeId, d.kind, ruleId, [d.setupId, d.beatId], []),
          };
        });
        return svc.reconcile(tx, scope, { episodeId: input.episodeId, manuscriptVersionId: input.manuscriptVersionId, drafts, kinds: SETUP_KINDS }, actor);
      },
      async listOpenSetupIssues(scope) {
        const issues = await repo.listIssues(platform.uow.db, scope, { statuses: ["open", "fixing"], kinds: [...SETUP_KINDS] });
        const ev = await repo.listEvidence(platform.uow.db, scope, issues.map((i) => i.id));
        return issues.map((i) => ({
          setupId: ev.find((e) => e.issueId === i.id && e.refType === "setup")?.refId ?? null,
          issueId: i.id,
          issueDisplayNo: i.displayNo,
          severity: i.severity as IssueSeverity,
          message: i.message,
          kind: i.kind,
        }));
      },
    },

    async safetyIssueSink(tx, scope, issue, actor) {
      const ruleId = issue.kind === "human_edit_conflict" ? "CR-18" : `SF:${issue.kind}`;
      const i = await svc.openIssue(
        tx,
        scope,
        {
          kind: issue.kind,
          severity: issue.severity,
          detector: issue.kind === "human_edit_conflict" ? "continuity_editor" : "continuity_editor",
          episodeId: issue.episodeId,
          manuscriptVersionId: issue.manuscriptVersionId,
          sceneId: issue.sceneId,
          charStart: issue.charStart,
          charEnd: issue.charEnd,
          message: issue.message,
          fixScope: issue.fixScope,
          evidence: [],
          ruleId,
          dedupeKey: dedupeKeyOf(issue.episodeId, issue.kind, ruleId, [issue.sceneId ?? "episode"], []),
        },
        actor,
      );
      return { issueId: i.id };
    },
  };
  return svc;
}
