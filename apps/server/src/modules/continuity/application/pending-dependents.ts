/**
 * 설계 추가(미확정 사실 선행 집필): episodes written ahead on an earlier episode's provisional facts.
 *
 * Episode N (not approved yet) changes after N+1.. were outlined / drafted with N's candidate facts in their context
 * (`pending_canon` section → context snapshot factVersionIds):
 *   - N's text changed and its facts followed (extract_facts commit → FactReconciler, after revision's reconcile):
 *     a used fact version that is no longer live or now says something else counts as changed;
 *   - N was rejected (E10): every used fact of N may change with the rework.
 * Each affected later episode M (not approved / published, with a text) gets its continuity check re-run on its current
 * version (check_continuity, existing task); when M already waits for approval a medium `pending_canon_changed` issue
 * tells the author "앞 화(N화)의 미확정 설정이 바뀌었습니다". Runs after the caller's commit in its own transaction.
 */
import { createHash } from "node:crypto";
import type { TaskKind } from "@ncs/shared";
import { actors, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { Episode } from "../../manuscript/index.js";
import type { FactVersionUsage } from "../../ontology/index.js";
import type { ContinuityService, IssueEvidenceInput } from "../index.js";
import { orPlaceholder, type ContinuityPorts } from "./ports.js";

/** runs whose context may carry `pending_canon` */
export const PENDING_CONTEXT_KINDS: readonly TaskKind[] = ["outline_episode", "draft_episode", "revise_episode", "polish_episode", "adjust_length"];
export const PENDING_RECHECK_PREFIX = "prior";
const DONE: readonly string[] = ["approved", "published"];
const MAX_DEPENDENTS = 20;

const hashKey = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export type PendingChangeMode = "changed" | "rejected";

export function createPendingDependents(deps: ContinuityPorts, svc: Pick<ContinuityService, "openIssue">) {
  const log = deps.platform.log;

  /**
   * fact versions the writing runs behind M's current text read (context snapshots), oldest run first.
   * A later draft_episode rewrote the whole text: runs before it (and outlines before the outline it followed) are left
   * out, so a fact an old draft used and the redraft already follows in its new form does not flag M again.
   */
  async function usedVersions(scope: NovelScope, m: Episode): Promise<string[]> {
    const o = deps.orchestration;
    if (!o.listTasks || !o.listRuns || !deps.agents.getContextSnapshot) return [];
    const all = await orPlaceholder(() => o.listTasks(scope, { episodeId: m.id, kinds: [...PENDING_CONTEXT_KINDS], includeCancelled: true, limit: 200 }), []);
    const tasks = [...all].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id));
    const lastDraft = tasks.map((t) => t.kind === "draft_episode" && t.status === "done").lastIndexOf(true);
    const outlineBefore = tasks.map((t, i) => t.kind === "outline_episode" && t.status === "done" && (lastDraft < 0 || i < lastDraft)).lastIndexOf(true);
    const from = lastDraft >= 0 ? lastDraft : Math.max(0, outlineBefore);
    const picked = tasks.filter((t, i) => i >= from || i === outlineBefore);
    const out: string[] = [];
    for (const t of picked) {
      const runs = [...(await orPlaceholder(() => o.listRuns(scope, t.id), []))].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
      for (const r of runs) {
        if (!r.contextSnapshotId) continue;
        const snap = await deps.agents.getContextSnapshot(scope, r.contextSnapshotId).catch(() => null);
        for (const id of [...(snap?.factVersionIds ?? []), ...(snap?.candidateFactVersionIds ?? [])]) {
          const at = out.indexOf(id);
          if (at >= 0) out.splice(at, 1);
          out.push(id); // newest use last
        }
      }
    }
    return out;
  }

  /** per fact, only the version the newest run read counts (a rewrite on the changed fact clears the older use) */
  function latestPerFact(versions: string[], usage: FactVersionUsage[]): FactVersionUsage[] {
    const order = new Map(versions.map((v, i) => [v, i]));
    const best = new Map<string, FactVersionUsage>();
    for (const u of usage) {
      const prev = best.get(u.factId);
      if (!prev || (order.get(u.factVersionId) ?? -1) > (order.get(prev.factVersionId) ?? -1)) best.set(u.factId, u);
    }
    return [...best.values()];
  }

  /** same change already flagged on M's current text (a check_continuity with this cycle key exists) */
  async function alreadyFlagged(tx: Tx, scope: NovelScope, m: Episode, cycleKey: string): Promise<boolean> {
    const o = deps.orchestration;
    if (!o.listTasks) return false;
    const done = await orPlaceholder(() => o.listTasks(scope, { episodeId: m.id, kinds: ["check_continuity"], includeCancelled: true, limit: 200 }, tx), []);
    return done.some((t) => ((t.input ?? {}) as { cycle_key?: unknown }).cycle_key === cycleKey);
  }

  async function flag(scope: NovelScope, episodeId: string, mode: PendingChangeMode, actor: ActorRef): Promise<string[]> {
    const m0 = deps.manuscript;
    if (!m0.listEpisodes || !deps.ontology.factVersionUsage || !deps.orchestration.createTask) return [];
    const n = await m0.getEpisode(scope, episodeId).catch(() => null);
    if (!n) return [];
    if (mode === "changed" && DONE.includes(n.status)) return []; // approved facts change through canon_change / retcon
    const later = (await m0.listEpisodes(scope, { fromNo: n.episodeNo + 1 }))
      .filter((e) => e.episodeNo > n.episodeNo && !!e.currentVersionId && !DONE.includes(e.status) && e.status !== "planned")
      .slice(0, MAX_DEPENDENTS);
    if (!later.length) return [];
    const plans: Array<{ m: Episode; hit: FactVersionUsage[] }> = [];
    for (const m of later) {
      const versions = await usedVersions(scope, m);
      if (!versions.length) continue;
      const usage = latestPerFact(versions, await deps.ontology.factVersionUsage(scope, versions)).filter((u) => u.episodeId === n.id);
      const hit = mode === "rejected" ? usage : usage.filter((u) => u.changed);
      if (hit.length) plans.push({ m, hit });
    }
    if (!plans.length) return [];
    const canCheck = !deps.orchestration.getTaskKind || !!deps.orchestration.getTaskKind("check_continuity");
    await deps.platform.uow.run(async (tx) => {
      for (const { m, hit } of plans) {
        const cur = await m0.getEpisode(scope, m.id, tx).catch(() => null);
        if (!cur?.currentVersionId || DONE.includes(cur.status)) continue;
        const factIds = [...new Set(hit.map((u) => u.factId))];
        // keyed by what changed (used version → fact's version now), not by N's version: a later N version that leaves
        // these facts as they are does not re-flag M
        const what =
          mode === "rejected"
            ? `${n.currentVersionId ?? ""}`
            : hit
                .map((u) => `${u.factVersionId}>${u.currentVersionId ?? ""}:${u.canonStatus}`)
                .sort()
                .join(",");
        const stamp = `${PENDING_RECHECK_PREFIX}:${n.id}:${mode}:${hashKey(what)}`;
        const cycleKey = `${cur.currentVersionId}:${stamp}`;
        if (await alreadyFlagged(tx, scope, cur, cycleKey)) continue;
        if (canCheck) {
          await deps.orchestration.createTask(tx, scope, {
            kind: "check_continuity",
            targetType: "episode",
            targetId: cur.id,
            episodeId: cur.id,
            arcId: cur.arcId,
            input: { episode_id: cur.id, manuscript_version_id: cur.currentVersionId, fact_ids: factIds },
            cycleKey,
            createdBy: actor,
            priority: 600,
          });
        }
        if (cur.status === "awaiting_approval") await noteIssue(tx, scope, cur, n, hit, mode, actor, stamp);
      }
    });
    log.info({ episodeId, mode, dependents: plans.map((p) => p.m.episodeNo) }, "pending facts of an earlier episode changed: later episodes re-checked");
    return plans.map((p) => p.m.id);
  }

  async function noteIssue(tx: Tx, scope: NovelScope, m: Episode, n: Episode, hit: FactVersionUsage[], mode: PendingChangeMode, actor: ActorRef, stamp: string) {
    const evidence: IssueEvidenceInput[] = [...new Map(hit.map((u) => [u.factId, u])).values()].slice(0, 10).map((u) => ({ factId: u.factId, factVersionId: u.factVersionId }));
    const message =
      mode === "rejected"
        ? `앞 화(${n.episodeNo}화)가 반려되어 이 화가 따른 미확정 설정이 바뀔 수 있습니다. ${n.episodeNo}화를 다시 쓴 뒤 이어짐을 확인해 주세요.`
        : `앞 화(${n.episodeNo}화)의 미확정 설정이 바뀌었습니다. 이 화는 바뀌기 전 설정 ${evidence.length}개를 따라 쓰였습니다. 연속성 검사를 다시 돌립니다.`;
    await svc.openIssue(
      tx,
      scope,
      {
        kind: "pending_canon_changed",
        severity: "medium",
        detector: "continuity_editor",
        episodeId: m.id,
        manuscriptVersionId: m.currentVersionId!,
        message,
        suggestion: `${n.episodeNo}화 승인 전 바뀐 설정과 이 화 본문이 어긋나지 않는지 확인하고, 어긋나면 고치거나 반려해 주세요.`,
        fixScope: "scene",
        evidence,
        ruleId: "PENDING:prior_changed",
        dedupeKey: `pending:${m.id}:${m.currentVersionId}:${stamp}`,
      },
      actor,
    );
  }

  return {
    flag,
    /** FactReconciler (linking extract_facts commit): runs after the commit, after revision's reconcile changed the facts */
    reconciler: {
      order: 100,
      async reconcileEpisode(tx: Tx, scope: NovelScope, input: { episodeId: string }) {
        tx.afterCommit(async () => {
          try {
            await flag(scope, input.episodeId, "changed", actors.system("orchestrator"));
          } catch (err) {
            log.warn({ err, episodeId: input.episodeId }, "pending dependents check failed");
          }
        });
      },
    },
    /** E10 (awaiting_approval → revising): N rejected */
    onRejected(tx: Tx, scope: NovelScope, episodeId: string) {
      tx.afterCommit(async () => {
        try {
          await flag(scope, episodeId, "rejected", actors.system("orchestrator"));
        } catch (err) {
          log.warn({ err, episodeId }, "pending dependents check (rejection) failed");
        }
      });
    },
  };
}
