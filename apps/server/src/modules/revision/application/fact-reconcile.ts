/**
 * 설계 추가(수정 반영): the ontology follows an edited episode text.
 *
 * Runs inside the extract_facts commit of every episode version (linking FactReconciler). Facts extracted from earlier
 * versions of the same episode are matched against the new text (domain/reconcile.ts):
 *   - still supported → kept; their evidence mentions are re-pointed to the new version (no duplicate fact — the
 *     extraction already reused the existing fact as "동일");
 *   - replaced by a new fact of the same subject / predicate (or the same single-valued slot) → superseded (link on both
 *     facts, history appended);
 *   - no longer supported → candidate rejected, canon retracted.
 * Canon (approved) changes need a human decision: the author's confirmation in the revision chat preview (the affected
 * facts were listed on the proposal card before [적용]) counts as that decision; any other approved / published change
 * becomes ONE canon_change (retcon when published canon is involved) approval for the episode, and the replacing
 * candidates are held until it is decided. Retired canon used by other episodes → impact list + continuity check there.
 */
import { actors, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ApprovalDecisionContext, HitlService } from "../../hitl/index.js";
import type { ManuscriptService } from "../../manuscript/index.js";
import type { EpisodeFact, OntologyService } from "../../ontology/index.js";
import type { OrchestrationService } from "../../orchestration/index.js";
import { evidenceSentence, planReconcile, previewFactEffects, type FactEffect } from "../domain/reconcile.js";
import { normalizeText } from "../domain/patch.js";

export const RECONCILE_PAYLOAD_KIND = "episode_fact_reconcile";

export interface ReconcileChange {
  oldFactId: string;
  newFactId: string | null;
  oldText: string;
  newText: string | null;
  oldCanonStatus: string;
}

interface ReconcilePayload {
  kind: typeof RECONCILE_PAYLOAD_KIND;
  episodeId: string;
  versionId: string;
  changes: ReconcileChange[];
  impacts: ImpactNote[];
}

export type ImpactNote = { subject: string; factId: string; items: Array<{ episodeId: string; episodeNo: number; title: string | null; via: string }> };

export interface FactReconcileDeps {
  ontology: OntologyService;
  manuscript: ManuscriptService;
  hitl: HitlService;
  orchestration: OrchestrationService;
  impactOf: (scope: NovelScope, episodeId: string, factId: string, tx?: Tx) => Promise<ImpactNote | null>;
}

const valueTextOf = (f: { value?: unknown; objectEntityId?: string | null }): string | null => {
  if (f.objectEntityId) return null;
  const v = f.value as { text?: unknown } | string | number | null | undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && typeof v.text === "string") return v.text;
  return null;
};

export function createFactReconcile(deps: FactReconcileDeps) {
  const { ontology, manuscript, hitl, orchestration } = deps;

  /** evidence of episode facts: sentences in earlier texts of the episode + mention surfaces + grounded elsewhere */
  async function evidenceOf(scope: NovelScope, episodeId: string, facts: EpisodeFact[], exceptVersionId: string | null, tx?: Tx) {
    const versionIds = new Set((await manuscript.listVersions(scope, episodeId, tx)).map((v) => v.id));
    const mentionIds = [...new Set(facts.flatMap((f) => f.mentionIds))];
    const ms = mentionIds.length ? await ontology.listMentions(scope, { ids: mentionIds, limit: mentionIds.length }, tx) : [];
    const byId = new Map(ms.map((m) => [m.id, m]));
    const texts = new Map<string, string | null>();
    const textOf = async (vid: string) => {
      if (!texts.has(vid)) texts.set(vid, await manuscript.getVersion(scope, vid, tx).then((v) => normalizeText(v.content)).catch(() => null));
      return texts.get(vid) ?? null;
    };
    const out = new Map<string, { sentences: string[]; surfaces: string[]; groundedElsewhere: boolean }>();
    for (const f of facts) {
      const sentences: string[] = [];
      const surfaces: string[] = [];
      let elsewhere = false;
      for (const mid of f.mentionIds) {
        const m = byId.get(mid);
        if (!m) continue;
        if (!m.manuscriptVersionId || !versionIds.has(m.manuscriptVersionId)) {
          elsewhere = true; // another episode / the bible / an answer grounds it too
          continue;
        }
        if (m.manuscriptVersionId === exceptVersionId) continue;
        if (m.linkedEntityId === f.subjectEntityId) surfaces.push(m.surface);
        const text = m.charStart != null && m.charEnd != null ? await textOf(m.manuscriptVersionId) : null;
        const s = text ? evidenceSentence(text, m.charStart!, m.charEnd!) : "";
        if (s) sentences.push(s);
      }
      out.set(f.factId, { sentences: [...new Set(sentences)], surfaces: [...new Set(surfaces)], groundedElsewhere: elsewhere });
    }
    return { out, versionIds };
  }

  // ── dry run for the revision chat proposal card ───────────────────────
  async function preview(scope: NovelScope, episodeId: string, current: string, patched: string, patches: Array<{ start: number; end: number; replacement: string }>): Promise<FactEffect[]> {
    const facts = await ontology.listEpisodeFacts(scope, episodeId);
    if (!facts.length) return [];
    const { out } = await evidenceOf(scope, episodeId, facts, null);
    return previewFactEffects(
      facts.map((f) => ({ factId: f.factId, canonStatus: f.canonStatus, text: f.text, valueText: valueTextOf(f), surfaces: out.get(f.factId)?.surfaces ?? [], sentences: out.get(f.factId)?.sentences ?? [] })),
      current,
      patched,
      patches,
    ).slice(0, 30);
  }

  // ── extract_facts commit hook ─────────────────────────────────────────
  async function reconcileEpisode(tx: Tx, scope: NovelScope, input: { episodeId: string; manuscriptVersionId: string; writtenFactIds: string[]; createdFactIds: string[] }, actor: ActorRef) {
    const all = await ontology.listEpisodeFacts(scope, input.episodeId, tx);
    const prev = await pendingOf(scope, input.episodeId, tx);
    if (!all.length && !prev.length) return;
    const written = new Set(input.writtenFactIds);
    const createdSet = new Set(input.createdFactIds);
    const older = all.filter((f) => !written.has(f.factId));
    const { out: ev, versionIds } = await evidenceOf(scope, input.episodeId, all, input.manuscriptVersionId, tx);
    const olderVersions = [...versionIds].filter((v) => v !== input.manuscriptVersionId);
    // re-point: facts the new text re-extracted keep only the new version's evidence of this episode
    const reused = all.filter((f) => written.has(f.factId) && !createdSet.has(f.factId)).map((f) => f.factId);
    if (reused.length) await ontology.pruneFactMentions(tx, scope, reused, olderVersions);
    const version = await manuscript.getVersion(scope, input.manuscriptVersionId, tx);
    const created = all.filter((f) => createdSet.has(f.factId));
    const byId = new Map(all.map((f) => [f.factId, f]));
    const raw = older.length
      ? planReconcile(
          older.map((f) => ({ factId: f.factId, canonStatus: f.canonStatus, subjectEntityId: f.subjectEntityId, predicate: f.predicate, sentences: ev.get(f.factId)?.sentences ?? [], groundedElsewhere: ev.get(f.factId)?.groundedElsewhere ?? false, heldSuccessor: f.reconcilePending })),
          created.map((f) => ({ factId: f.factId, subjectEntityId: f.subjectEntityId, predicate: f.predicate, conflictWith: f.conflictWith })),
          version.content,
        )
      : { kept: [], retire: [] };
    // the author already rejected the change of this canon fact (kept the old setting): no new question unless a
    // different replacement appears; the same replacement again is rejected in line with that decision
    const kept = new Set(raw.kept);
    const sameAsRejected: string[] = [];
    const retire = raw.retire.filter((r) => {
      const mark = byId.get(r.factId)?.reconcileKeptBy;
      if (!mark || r.canonStatus === "candidate") return true;
      // the rejected change was a retraction: the text still lacks the evidence → same question, not asked again
      if (!r.successor) {
        if (mark.rejectedNewText != null) return true;
        kept.add(r.factId);
        return false;
      }
      const succText = byId.get(r.successor)?.text ?? null;
      if (succText == null || mark.rejectedNewText == null || normalizeText(succText).trim() !== normalizeText(mark.rejectedNewText).trim()) return true;
      sameAsRejected.push(r.successor);
      kept.add(r.factId);
      return false;
    });
    // the author's confirmation recorded with a revision chat patch of THIS version (shown on the proposal card first)
    const rc = ((version.writerAnnotations ?? null) as { revision_chat?: { confirmedFactIds?: unknown; confirmedEffects?: unknown; acceptedBy?: unknown; proposalIds?: unknown } } | null)?.revision_chat;
    const shownEffect = new Map<string, string>(
      version.isHumanEdit && Array.isArray(rc?.confirmedEffects) ? (rc!.confirmedEffects as Array<{ factId: string; effect: string }>).map((e) => [e.factId, e.effect]) : [],
    );
    const confirmer = version.isHumanEdit && typeof rc?.acceptedBy === "string" ? actors.user(rc.acceptedBy) : null;
    const base = { episodeId: input.episodeId, fromVersionIds: olderVersions, toVersionId: input.manuscriptVersionId };
    // a confirmation counts only for the outcome the author saw: "change" needs a replacing fact, "retract" none
    const matchesShown = (r: { factId: string; successor: string | null }) => {
      const e = shownEffect.get(r.factId);
      return e === "change" ? !!r.successor : e === "retract" ? !r.successor : false;
    };

    const agentNow = retire.filter((r) => r.canonStatus === "candidate");
    const humanNow = retire.filter((r) => r.canonStatus === "approved" && confirmer && matchesShown(r));
    const pending = retire.filter((r) => !agentNow.includes(r) && !humanNow.includes(r));
    if (agentNow.length) {
      await ontology.retireFacts(
        tx,
        scope,
        agentNow.map((r) => ({ factId: r.factId, supersededByFactId: r.successor })),
        actor,
        { changeReason: "reinterpretation", reason: "본문 수정: 새 본문에 근거가 없는 후보", details: { ...base, decidedBy: "agent" } },
      );
    }
    if (sameAsRejected.length) {
      const live = (await ontology.getFactsByIds(scope, sameAsRejected, tx)).filter((f) => f.canonStatus === "candidate").map((f) => f.factId);
      if (live.length) await ontology.withdrawFacts(tx, scope, live, actor, "본문 수정: 작가가 이미 반려한 설정 변경과 같은 후보(기존 설정 유지)");
    }
    if (humanNow.length && confirmer) {
      const impacts = await followImpacts(tx, scope, input.episodeId, humanNow.map((r) => r.factId), actor);
      await ontology.retireFacts(
        tx,
        scope,
        humanNow.map((r) => ({ factId: r.factId, supersededByFactId: r.successor })),
        confirmer,
        { changeReason: "user_edit", reason: "본문 수정: 작가가 수정 대화에서 확인한 설정 변경", details: { ...base, decidedBy: "human_confirmed", proposalIds: rc?.proposalIds ?? null, impacts } },
      );
    }
    // the pending request of the episode follows the current text: changes the text supports again (re-extracted or
    // kept) or the author just confirmed are dropped, changes of this version replace older ones of the same fact
    const resolved = new Set([...written, ...kept, ...humanNow.map((r) => r.factId)]);
    const fresh: ReconcileChange[] = pending.map((r) => ({ oldFactId: r.factId, newFactId: r.successor, oldText: byId.get(r.factId)?.text ?? r.factId, newText: r.successor ? (byId.get(r.successor)?.text ?? null) : null, oldCanonStatus: r.canonStatus }));
    await syncDecision(tx, scope, input.episodeId, input.manuscriptVersionId, prev, fresh, resolved, written, actor);
  }

  async function pendingOf(scope: NovelScope, episodeId: string, tx: Tx) {
    const list = await hitl.listApprovals(scope, { statuses: ["pending"], types: ["canon_change", "retcon"] }, tx).catch(() => []);
    return list.filter((a) => a.subjectId === episodeId && (a.payload as { kind?: string } | null)?.kind === RECONCILE_PAYLOAD_KIND);
  }

  /**
   * one approval per episode. Changes of the earlier pending request are merged by old fact (the newer replacement wins);
   * resolved ones are dropped. The request is re-issued (superseding the old one) whenever the set changed, cancelled
   * when nothing is left; replacing candidates are held while they wait, released (and rejected) when dropped.
   */
  async function syncDecision(tx: Tx, scope: NovelScope, episodeId: string, versionId: string, prev: Awaited<ReturnType<typeof pendingOf>>, fresh: ReconcileChange[], resolved: Set<string>, written: Set<string>, actor: ActorRef) {
    const carried = prev.flatMap((a) => ((a.payload as unknown as ReconcilePayload).changes ?? []) as ReconcileChange[]);
    const merged = new Map<string, ReconcileChange>();
    for (const c of carried) if (!resolved.has(c.oldFactId)) merged.set(c.oldFactId, c);
    for (const c of fresh) {
      // the waiting replacement was re-extracted from this text too (e.g. the polished text of the same edit): it stays
      const was = merged.get(c.oldFactId);
      merged.set(c.oldFactId, !c.newFactId && was?.newFactId && written.has(was.newFactId) ? was : c);
    }
    // the old facts must still be live canon
    const oldLive = new Set(
      (await ontology.getFactsByIds(scope, [...merged.keys()], tx)).filter((f) => f.canonStatus === "approved" || f.canonStatus === "published_locked").map((f) => f.factId),
    );
    for (const id of [...merged.keys()]) if (!oldLive.has(id)) merged.delete(id);
    const changes = [...merged.values()];
    const key = (c: ReconcileChange) => `${c.oldFactId}\u0000${c.newFactId ?? ""}`;
    const same = carried.length === changes.length && carried.every((c) => changes.some((x) => key(x) === key(c)));
    // successors no longer waiting: release the hold, reject the candidate (the change it carried is gone or replaced)
    const keepSucc = new Set(changes.map((c) => c.newFactId).filter((x): x is string => !!x));
    const dropped = [...new Set(carried.map((c) => c.newFactId).filter((x): x is string => !!x && !keepSucc.has(x)))];
    if (dropped.length) {
      await ontology.setFactReconcileHold(tx, scope, dropped, false, actor);
      const cands = (await ontology.getFactsByIds(scope, dropped, tx)).filter((f) => f.canonStatus === "candidate").map((f) => f.factId);
      if (cands.length) await ontology.withdrawFacts(tx, scope, cands, actor, "본문 수정: 대기 중인 설정 변경이 새 본문으로 정리됨");
    }
    if (same && prev.length === 1) return; // already waiting for the author with exactly these changes
    if (!changes.length) {
      for (const a of prev) await hitl.cancelApproval(tx, scope, a.id, "본문이 다시 바뀌어 확인할 설정 변경이 없습니다.", actor).catch(() => undefined);
      return;
    }
    const ep = await manuscript.getEpisode(scope, episodeId, tx);
    const impacts: ImpactNote[] = [];
    for (const c of changes.slice(0, 10)) {
      const note = await deps.impactOf(scope, episodeId, c.oldFactId, tx).catch(() => null);
      if (note && note.items.length) impacts.push(note);
    }
    const retcon = changes.some((c) => c.oldCanonStatus === "published_locked");
    const lines = changes.map((c) => (c.newText ? `- ${c.oldText} → ${c.newText}` : `- ${c.oldText} → 새 본문에 근거 없음(철회)`));
    const impactLines = impacts.flatMap((n) => [`영향(${n.subject}): ${n.items.map((i) => `${i.episodeNo}화`).join(", ")}`]);
    const req = await hitl.requestApproval(tx, scope, {
      approvalType: retcon ? "retcon" : "canon_change",
      target: { type: "episode", id: episodeId },
      question: {
        title: `${ep.episodeNo}화 본문 수정: 승인된 설정 변경 확인${retcon ? " (리트콘)" : ""}`,
        body: [
          `${ep.episodeNo}화 본문이 바뀌어 승인된 설정 ${changes.length}개가 새 본문과 맞지 않습니다.`,
          ...lines,
          ...impactLines,
          "승인하면 예전 설정은 철회되거나 새 설정으로 대체됩니다(이력은 남습니다). 반려하면 예전 설정을 그대로 두고 새 후보는 기각합니다. 다른 화 본문은 자동으로 고치지 않습니다.",
        ].join("\n"),
        links: [{ type: "episode", id: episodeId }, ...changes.slice(0, 10).map((c) => ({ type: "fact" as const, id: c.oldFactId }))],
      },
      requestedBy: actor,
      supersedes: prev[0]?.id ?? null,
      payload: { kind: RECONCILE_PAYLOAD_KIND, episodeId, versionId, changes, impacts } satisfies ReconcilePayload as unknown as Record<string, unknown>,
    });
    for (const a of prev.slice(1)) await hitl.supersedeApproval(tx, scope, a.id, req.approvalId, actor).catch(() => undefined);
    if (keepSucc.size) await ontology.setFactReconcileHold(tx, scope, [...keepSucc], true, actor);
  }

  /** canon_change / retcon approval of a reconcile request */
  async function onApproval(ctx: ApprovalDecisionContext) {
    const { tx, scope, approval, actor } = ctx;
    const pl = approval.payload as unknown as ReconcilePayload;
    const changes = pl.changes ?? [];
    const ids = [...new Set(changes.flatMap((c) => [c.oldFactId, c.newFactId ?? ""]).filter(Boolean))];
    const now = new Map((await ontology.getFactsByIds(scope, ids, tx)).map((f) => [f.factId, f]));
    const successors = changes.map((c) => c.newFactId).filter((x): x is string => !!x && ["candidate", "approved", "published_locked"].includes(now.get(x)?.canonStatus ?? ""));
    if (ctx.decision === "rejected") {
      // the author keeps the approved setting: the replacing candidates are rejected (history kept)
      await ontology.setFactReconcileHold(tx, scope, successors, false, actor);
      const cands = successors.filter((id) => now.get(id)?.canonStatus === "candidate");
      if (cands.length) await ontology.withdrawFacts(tx, scope, cands, actor, `본문 수정 설정 변경 반려(${approval.id}): 기존 설정 유지`);
      // remember the decision on the kept canon: later versions of the episode do not ask the same again
      const keptCanon = changes.filter((c) => ["approved", "published_locked"].includes(now.get(c.oldFactId)?.canonStatus ?? ""));
      if (keptCanon.length) await ontology.markFactsKeptByDecision(tx, scope, keptCanon.map((c) => ({ factId: c.oldFactId, rejectedNewText: c.newText })), approval.id, actor);
      return;
    }
    const live = changes.filter((c) => ["approved", "published_locked", "candidate"].includes(now.get(c.oldFactId)?.canonStatus ?? ""));
    const retcon = approval.approvalType === "retcon";
    const impacts = await followImpacts(tx, scope, pl.episodeId, live.map((c) => c.oldFactId), actor);
    await ontology.retireFacts(
      tx,
      scope,
      live.map((c) => ({ factId: c.oldFactId, supersededByFactId: c.newFactId && successors.includes(c.newFactId) ? c.newFactId : null })),
      actor,
      { changeReason: retcon ? "retcon" : "canon_change", approvalId: approval.id, reason: "본문 수정: 승인된 설정 변경", details: { episodeId: pl.episodeId, toVersionId: pl.versionId, decidedBy: "approval", approvalId: approval.id, impacts } },
    );
    await ontology.setFactReconcileHold(tx, scope, successors, false, actor);
    // the episode was approved again meanwhile: its replacing candidates become canon now (they were held)
    const ep = await manuscript.getEpisode(scope, pl.episodeId, tx).catch(() => null);
    const cands = successors.filter((id) => now.get(id)?.canonStatus === "candidate");
    if (ep && (ep.status === "approved" || ep.status === "published") && cands.length) await ontology.approveCandidateFacts(tx, scope, cands, actor);
  }

  /** retired canon used by other episodes: re-run the continuity check of their current text (listed, never edited) */
  async function followImpacts(tx: Tx, scope: NovelScope, episodeId: string, factIds: string[], actor: ActorRef): Promise<ImpactNote[]> {
    const seen = new Set<string>();
    const notes: ImpactNote[] = [];
    for (const fid of factIds.slice(0, 10)) {
      const note = await deps.impactOf(scope, episodeId, fid, tx).catch(() => null);
      if (!note?.items.length) continue;
      notes.push(note);
      for (const it of note.items) seen.add(it.episodeId);
    }
    if (!seen.size || !orchestration.getTaskKind("check_continuity")) return notes;
    for (const eid of [...seen].slice(0, 10)) {
      const e = await manuscript.getEpisode(scope, eid, tx).catch(() => null);
      if (!e?.currentVersionId) continue;
      await orchestration.createTask(tx, scope, {
        kind: "check_continuity",
        targetType: "episode",
        targetId: e.id,
        episodeId: e.id,
        arcId: e.arcId,
        input: { episode_id: e.id, manuscript_version_id: e.currentVersionId, cycle_key: `${e.currentVersionId}:facts:${factIds[0]}`, fact_ids: factIds },
        cycleKey: `${e.currentVersionId}:facts:${factIds[0]}`,
        createdBy: actor,
        priority: 600,
      });
    }
    return notes;
  }

  return { reconcileEpisode, preview, onApproval };
}

export type FactReconcile = ReturnType<typeof createFactReconcile>;
