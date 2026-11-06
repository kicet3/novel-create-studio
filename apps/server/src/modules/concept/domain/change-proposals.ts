/**
 * Change-proposal lifecycle (INV-CON-03 (b) + 설계 추가: 대화로 해결된 제안 정리). Pure: mutates the given
 * (cloned) WorkingBrief.
 *
 * A proposal is `pending` until it is settled by one of:
 * - the user's decision — [제안 수락]/[지금 값 유지] button, a quote-verified `proposal_decisions` entry
 *   from the model, or a plain yes/no text answer to the proposal question → accepted / rejected
 * - the field reaching the proposed value some other way (the user said it in their own words, a form
 *   edit) → accepted (resolution applied_in_chat / form_edit) or superseded (already_applied)
 * - the field moving to a different value after the proposal was made → superseded (field_changed)
 * - a newer proposal for the same field → superseded (replaced)
 * Settling never writes a value by itself except an explicit user acceptance.
 */
import type { ConceptFieldOrigin } from "@ncs/shared";
import { getPath, isEmptyValue, normalizeText, sameValue, type ChangeProposal, type ProposalResolution, type WorkingBrief } from "./brief.js";

export interface ProposalSettlement {
  id: string;
  field_path: string;
  value: unknown;
  status: Exclude<ChangeProposal["status"], "pending">;
  resolution: ProposalResolution;
  message_id: string | null;
}

/** user-backed origins: a value with one of these was chosen by the user, not the agent alone */
const USER_BACKED: readonly ConceptFieldOrigin[] = ["user_stated", "user_edited", "agent_proposed_accepted"];

export function settleProposal(
  cp: ChangeProposal,
  status: ProposalSettlement["status"],
  resolution: ProposalResolution,
  messageId: string | null,
  out: ProposalSettlement[],
): void {
  if (cp.status !== "pending") return;
  cp.status = status;
  cp.resolution = resolution;
  cp.resolved_message_id = messageId;
  out.push({ id: cp.id, field_path: cp.field_path, value: cp.new_value, status, resolution, message_id: messageId });
}

/**
 * Add a pending proposal for `path`. Same value already pending → no-op; a pending one with a different
 * value is superseded (`replaced`) so at most one proposal per field is pending.
 */
export function addProposal(
  b: WorkingBrief,
  p: { id: string; path: string; value: unknown; reason: string; runId: string | null },
  out: ProposalSettlement[],
): void {
  const pending = b.change_proposals.filter((x) => x.status === "pending" && x.field_path === p.path);
  if (pending.some((x) => sameValue(x.new_value, p.value))) return;
  for (const old of pending) settleProposal(old, "superseded", "replaced", null, out);
  b.change_proposals.push({
    id: p.id,
    field_path: p.path,
    new_value: p.value,
    reason: p.reason,
    status: "pending",
    run_id: p.runId,
    base_value: getPath(b.content, p.path) ?? null,
  });
}

/**
 * After a commit wrote the brief: settle the proposals that existed before it and are now moot.
 * `existing` = ids pending before this commit (proposals created in it are left alone);
 * `changed` = paths whose value changed in this commit (fallback for proposals without `base_value`).
 */
export function reconcileProposals(
  b: WorkingBrief,
  o: { existing: ReadonlySet<string>; changed: ReadonlySet<string>; messageId: string | null; acceptedResolution: ProposalResolution },
  out: ProposalSettlement[],
): void {
  // proposals stored before addProposal kept one-per-field could pile up: the newest one stands
  const newestByPath = new Map<string, ChangeProposal>();
  for (const cp of b.change_proposals) if (cp.status === "pending") newestByPath.set(cp.field_path, cp);
  for (const cp of b.change_proposals) {
    if (cp.status === "pending" && o.existing.has(cp.id) && newestByPath.get(cp.field_path) !== cp) settleProposal(cp, "superseded", "replaced", null, out);
  }
  for (const cp of b.change_proposals) {
    if (cp.status !== "pending" || !o.existing.has(cp.id)) continue;
    const cur = getPath(b.content, cp.field_path);
    if (!isEmptyValue(cur) && sameValue(cur, cp.new_value)) {
      const origin = b.field_provenance[cp.field_path]?.origin;
      if (origin && USER_BACKED.includes(origin)) settleProposal(cp, "accepted", o.acceptedResolution, o.messageId, out);
      else settleProposal(cp, "superseded", "already_applied", o.messageId, out);
      continue;
    }
    const moved = cp.base_value !== undefined ? !sameValue(cur ?? null, cp.base_value) : o.changed.has(cp.field_path);
    if (moved || isEmptyValue(cur)) settleProposal(cp, "superseded", "field_changed", o.messageId, out);
  }
}

/** the pending proposal a prompt asked about (its [제안 수락] control option), if any */
export function promptProposalId(options: ReadonlyArray<{ value: string }> | null | undefined): string | null {
  const o = (options ?? []).find((x) => x.value.startsWith("@accept_proposal:"));
  return o ? o.value.slice("@accept_proposal:".length) : null;
}

// matched against normalizeText() output (lowercase, no spaces/punctuation)
const NEGATED_CHANGE_RE = /(안바꿔|안바꿀|바꾸지마|바꾸지말|바꾸지않)/;
const ACCEPT_RE = /(제안대로|제안그대로|그걸로바꿔|그렇게바꿔|바꿔주세요|바꿔줘|바꿔요|바꿀게|바꿉시다|바꾸죠|바꾸자|수락)/;
const REJECT_RE = /(싫어|싫습니다|거절|유지|그대로둘|그대로두|그대로갈|그대로놔|놔둬|놔두)/;
// matched against the first word only, so "예를 들면", "응원해요", "아니면", "동의하기 어렵네요" are not answers
const YES_WORD_RE = /^(네|넵|넹|예|응|웅|그래|그래요|좋아|좋아요|좋습니다|좋네요|오케이|ok|okay|yes|동의|동의해요|동의합니다)$/;
const NO_WORD_RE = /^(아니|아니요|아니오|아뇨|노|no)$/;

/** plain yes/no answer to a proposal question (deterministic fallback when the model gave no decision) */
export function yesNoAnswer(text: string): "accepted" | "rejected" | null {
  const t = normalizeText(text);
  if (!t || t.length > 40) return null;
  if (NEGATED_CHANGE_RE.test(t)) return "rejected";
  if (ACCEPT_RE.test(t)) return "accepted";
  // a question back ("네? 무슨 제안이요?") is not a decision
  if (/[?？]/.test(text)) return null;
  const first = (text.trim().split(/[\s,.!~…·]+/)[0] ?? "").toLowerCase();
  if (NO_WORD_RE.test(first) || REJECT_RE.test(t)) return "rejected";
  if (YES_WORD_RE.test(first)) return "accepted";
  return null;
}

/** INV-CON-03: a model's decision counts only with the user's own words quoted from a handled message */
export function decisionVerified(quote: string, body: string): boolean {
  const q = normalizeText(quote);
  return q.length > 0 && normalizeText(body).includes(q);
}
