/**
 * Slot update guard INV-CON-03/04 (design/11 §2.7 slot_updates, §3.3 R3–R4, §3.7 flips & dependencies,
 * §4.4 cross-channel conflicts). Pure: mutates the given (cloned) WorkingBrief.
 */
import type { ConceptFieldOrigin, ConceptSlotState } from "@ncs/shared";
import {
  getPath,
  isEmptyValue,
  normalizeText,
  sameValue,
  setPath,
  valueToText,
  type WorkingBrief,
} from "./brief.js";
import { DEF_BY_PATH, coerceValue, dependentsOf, isKnownPath, valueTypeOf } from "./question-set.js";
import { valueIsFlagged, type InstallSafetyLists } from "./checks.js";
import { addProposal, type ProposalSettlement } from "./change-proposals.js";

/** stored option of an agent/system prompt message (concept_messages.options) */
export interface StoredOption {
  idx: number;
  label: string;
  value: string;
  is_recommended?: boolean;
  rationale?: string;
  risk?: string;
  is_common_choice?: boolean;
  /** seed = fixed list / user's own values; agent = model candidate; control = reserved button */
  source: "seed" | "agent" | "control";
  field_path?: string;
}

export interface GuardMessage {
  id: string;
  body: string;
  channelId: string;
  authorKind: "user" | "agent" | "system";
  /** 설계 추가: posted by the auto-approve mode on the user's behalf — never the user's own words */
  auto?: boolean;
}

export interface SlotClaim {
  field_path: string;
  new_value: unknown;
  origin_claim: "user_stated" | "agent_proposed_accepted" | "agent_proposed_modified" | "agent_delegated";
  evidence_message_id: string | null;
  evidence_quote: string;
  key_phrase: string;
  /** built by deterministic code from a user's own button pick (not model output) */
  userAction?: boolean;
  /** 설계 추가: built by deterministic code from an auto-approve pick (the partner's recommendation, delegated) */
  autoAccepted?: boolean;
}

export interface SlotDiff {
  field_path: string;
  before: unknown;
  after: unknown;
  origin: ConceptFieldOrigin;
  slot_state: ConceptSlotState;
}

export interface GuardContext {
  /** user messages handled by this commit (the only valid evidence for user_stated) */
  messages: GuardMessage[];
  /** options of the prompt the user answered (deictic answers, CT-22) */
  promptOptions: StoredOption[];
  lists: InstallSafetyLists;
  /** copy request in this turn: values containing the title are dropped (6.3) */
  copyTitle: string | null;
  runId: string | null;
  newId: () => string;
  nextCharKey: () => string;
  notices: string[];
  diffs: Map<string, SlotDiff[]>;
  /** paths whose value changed in this commit (dependency re-confirm, X-9) */
  changed: Set<string>;
  flipLimit: number;
  /** proposals settled in this commit (superseded by a newer proposal, …) — audit trail */
  settled: ProposalSettlement[];
}

const PROTECTED: readonly ConceptFieldOrigin[] = ["user_stated", "user_edited"];

function quoteVerified(claim: SlotClaim, msg: GuardMessage | undefined, value: unknown): boolean {
  if (!msg || msg.authorKind !== "user" || msg.auto) return false;
  const quote = normalizeText(claim.evidence_quote);
  const key = normalizeText(claim.key_phrase);
  if (!quote || !key) return false;
  if (!normalizeText(msg.body).includes(quote)) return false;
  if (!quote.includes(key)) return false;
  if (valueTypeOf(claim.field_path) !== "text") return true; // structured slots: the quote itself is the evidence
  const v = normalizeText(valueToText(value));
  return v.includes(key) || key.includes(v);
}

/** the user's own message names this option (label or value) — required before a seed match counts as user_stated */
function messageNamesOption(o: StoredOption, msg: GuardMessage): boolean {
  if (msg.authorKind !== "user" || msg.auto) return false;
  const body = normalizeText(msg.body);
  if (!body) return false;
  const label = normalizeText(o.label);
  const value = normalizeText(o.value);
  return (label.length > 0 && body.includes(label)) || (value.length > 0 && body.includes(value));
}

/**
 * deictic / option answers (2.7): exact option → accepted, partial → modified.
 * A seed option only yields `user_stated` when the user's message itself names it (INV-CON-03: an
 * LLM claim that merely equals a seed value is not user evidence); agent candidates stay agent_proposed_*.
 */
function matchOption(value: unknown, options: StoredOption[], path: string, msg: GuardMessage): { origin: ConceptFieldOrigin } | null {
  const v = normalizeText(valueToText(value));
  if (!v) return null;
  const cands = options.filter((o) => o.source !== "control" && (!o.field_path || o.field_path === path));
  const exact = cands.find((o) => normalizeText(o.value) === v || normalizeText(o.label) === v);
  if (exact) {
    if (exact.source === "agent") return { origin: "agent_proposed_accepted" };
    return messageNamesOption(exact, msg) ? { origin: "user_stated" } : null;
  }
  const partial = cands.find((o) => {
    const ov = normalizeText(o.value);
    return ov.length >= 2 && (v.includes(ov) || ov.includes(v));
  });
  if (partial) {
    if (partial.source === "agent") return { origin: "agent_proposed_modified" };
    return messageNamesOption(partial, msg) ? { origin: "user_stated" } : null;
  }
  return null;
}

export function pushDiff(ctx: GuardContext, messageId: string | null, d: SlotDiff): void {
  const key = messageId ?? "_";
  ctx.diffs.set(key, [...(ctx.diffs.get(key) ?? []), d]);
}

/** set a value + provenance, counting flips and applying field dependencies (3.7) */
export function writeSlot(
  b: WorkingBrief,
  ctx: GuardContext,
  path: string,
  value: unknown,
  origin: ConceptFieldOrigin,
  state: ConceptSlotState,
  evidenceIds: string[],
  opts: { countFlip?: boolean; messageId?: string | null } = {},
): void {
  const before = getPath(b.content, path);
  const prev = b.field_provenance[path];
  const changed = !sameValue(before, value);
  let finalState = state;
  if (state === "confirmed" && valueIsFlagged(value, ctx.lists)) {
    finalState = "proposed";
    ctx.notices.push(`'${DEF_BY_PATH.get(path)?.label ?? path}' 내용은 연령 등급·유사성 점검에 걸려 확인이 필요합니다. 내용을 바꾸거나 다시 확정해 주세요.`);
  }
  if (changed) setPath(b.content, path, value);
  b.field_provenance[path] = {
    origin,
    slot_state: finalState,
    evidence_message_ids: [...new Set([...(changed ? [] : prev?.evidence_message_ids ?? []), ...evidenceIds])],
    history_count: (prev?.history_count ?? 0) + (changed ? 1 : 0),
    ...(prev?.template_question_ref ? { template_question_ref: prev.template_question_ref } : {}),
  };
  if (!changed && prev?.slot_state === finalState && prev.origin === origin) return;
  pushDiff(ctx, opts.messageId ?? evidenceIds[0] ?? null, { field_path: path, before: before ?? null, after: value ?? null, origin, slot_state: finalState });
  if (!changed) return;
  ctx.changed.add(path);
  if (opts.countFlip !== false && !isEmptyValue(before) && prev?.slot_state === "confirmed") {
    const flips = ((b.meta as { flips?: Record<string, number> }).flips ??= {});
    flips[path] = (flips[path] ?? 0) + 1;
    if (flips[path]! >= ctx.flipLimit && !(b.meta.flip_cards ?? []).some((f) => f.field_path === path)) {
      b.meta.flip_cards = [...(b.meta.flip_cards ?? []), { field_path: path, values: [before, value] }];
    }
  }
  if (!isEmptyValue(before)) applyDependencies(b, ctx, path);
}

/** 3.7 필드 의존 재확인: confirmed children → proposed (value/origin kept), logline → empty */
export function applyDependencies(b: WorkingBrief, ctx: GuardContext, parent: string): void {
  for (const child of dependentsOf(parent)) {
    if (child === "logline") {
      const before = getPath(b.content, "logline");
      if (!isEmptyValue(before) || (b.content.logline_options ?? []).length) {
        setPath(b.content, "logline", undefined);
        b.content.logline_options = [];
        const prev = b.field_provenance.logline;
        b.field_provenance.logline = { origin: prev?.origin ?? "user_stated", slot_state: "empty", evidence_message_ids: [], history_count: prev?.history_count ?? 0 };
        pushDiff(ctx, null, { field_path: "logline", before: before ?? null, after: null, origin: prev?.origin ?? "user_stated", slot_state: "empty" });
      }
      continue;
    }
    const p = b.field_provenance[child];
    if (p?.slot_state === "confirmed" && !isEmptyValue(getPath(b.content, child))) {
      p.slot_state = "proposed";
      (b.meta as { reconfirm?: string[] }).reconfirm = [...new Set([...((b.meta as { reconfirm?: string[] }).reconfirm ?? []), child])];
      pushDiff(ctx, null, { field_path: child, before: getPath(b.content, child) ?? null, after: getPath(b.content, child) ?? null, origin: p.origin, slot_state: "proposed" });
    }
  }
}

export type GuardResult = { applied: true; diff: SlotDiff } | { applied: false; reason: "unknown_path" | "no_value" | "no_evidence" | "change_proposal" | "copy_request" | "age_19" | "conflict" };

/**
 * Apply one claimed slot update (LLM or deterministic). Implements INV-CON-03:
 * `user_stated`/`user_edited` fields only change through a verified quote from a NEW user message;
 * anything else becomes a pending change proposal.
 */
export function applyClaim(b: WorkingBrief, ctx: GuardContext, claim: SlotClaim): GuardResult {
  const path = claim.field_path;
  if (!isKnownPath(path)) return { applied: false, reason: "unknown_path" };
  if (path === "age_rating" && typeof claim.new_value === "string" && /19|성인|age_19/.test(claim.new_value)) {
    ctx.notices.push("현재는 15세 이용가까지만 지원합니다. 15세 이용가를 추천합니다.");
    return { applied: false, reason: "age_19" };
  }
  const value = coerceValue(path, claim.new_value, ctx.nextCharKey);
  if (value === undefined || value === "age_19") {
    if (value === "age_19") ctx.notices.push("현재는 15세 이용가까지만 지원합니다. 15세 이용가를 추천합니다.");
    return { applied: false, reason: value === "age_19" ? "age_19" : "no_value" };
  }
  if (ctx.copyTitle && normalizeText(valueToText(value)).includes(normalizeText(ctx.copyTitle))) {
    return { applied: false, reason: "copy_request" };
  }
  const msg = ctx.messages.find((m) => m.id === claim.evidence_message_id);
  if (claim.origin_claim === "agent_delegated") return { applied: false, reason: "no_evidence" }; // decided by code only (3.5)
  if (!msg) {
    return proposeChange(b, ctx, path, value, "근거 메시지가 없는 변경 제안입니다.") ? { applied: false, reason: "change_proposal" } : { applied: false, reason: "no_evidence" };
  }
  let origin: ConceptFieldOrigin;
  let state: ConceptSlotState = "confirmed";
  /** the new value is grounded in the user's own words/pick (only then may it replace a user value) */
  let grounded = !!claim.userAction;
  if (claim.autoAccepted) {
    // 자동 승인: the partner's recommendation, accepted on the user's behalf (distinct provenance, not user evidence)
    origin = "agent_auto_accepted";
    grounded = false;
  } else if (msg.auto) {
    // a model claim citing an auto-approve message: an interpretation that still needs confirmation
    origin = "agent_proposed_modified";
    state = "proposed";
  } else if (claim.origin_claim === "user_stated" && quoteVerified(claim, msg, value)) {
    origin = "user_stated";
    grounded = true;
  } else {
    const m = matchOption(value, ctx.promptOptions, path, msg);
    if (m) {
      origin = m.origin;
      if (m.origin === "user_stated") grounded = true;
    }
    else {
      origin = "agent_proposed_modified"; // interpretation not grounded in the quote → needs confirmation (R4)
      state = "proposed";
    }
  }
  if (ctx.copyTitle) state = "proposed"; // 6.3: copy-request turn never confirms
  const prev = b.field_provenance[path];
  const current = getPath(b.content, path);
  if (prev && PROTECTED.includes(prev.origin) && !isEmptyValue(current) && !sameValue(current, value) && !(origin === "user_stated" && grounded) && !claim.userAction) {
    proposeChange(b, ctx, path, value, "사용자가 정한 값과 다른 해석입니다.");
    return { applied: false, reason: "change_proposal" };
  }
  writeSlot(b, ctx, path, value, origin, state, [msg.id], { messageId: msg.id });
  return { applied: true, diff: { field_path: path, before: current ?? null, after: value, origin, slot_state: state } };
}

/** INV-CON-03 (b): agent-only changes of protected/non-empty fields wait for user acceptance */
export function proposeChange(b: WorkingBrief, ctx: GuardContext, path: string, value: unknown, reason: string): boolean {
  if (isEmptyValue(getPath(b.content, path))) return false;
  if (sameValue(getPath(b.content, path), value)) return false;
  addProposal(b, { id: ctx.newId(), path, value, reason, runId: ctx.runId }, ctx.settled);
  return true;
}

/**
 * 4.4: same slot, different values from different channels in one batch → no overwrite, ask which one.
 * Returns the claims that are safe to apply (conflicting ones are recorded in meta.conflicts).
 */
export function splitConflicts(b: WorkingBrief, ctx: GuardContext, claims: SlotClaim[]): SlotClaim[] {
  const byPath = new Map<string, SlotClaim[]>();
  for (const c of claims) byPath.set(c.field_path, [...(byPath.get(c.field_path) ?? []), c]);
  const keep: SlotClaim[] = [];
  for (const [path, list] of byPath) {
    const channels = new Set(list.map((c) => ctx.messages.find((m) => m.id === c.evidence_message_id)?.channelId).filter(Boolean));
    const distinct = list.filter((c, i) => list.findIndex((x) => sameValue(x.new_value, c.new_value)) === i);
    if (channels.size > 1 && distinct.length > 1) {
      b.meta.conflicts = [
        ...(b.meta.conflicts ?? []).filter((x) => x.field_path !== path),
        {
          field_path: path,
          values: distinct.map((c) => ({ value: c.new_value, channel_id: ctx.messages.find((m) => m.id === c.evidence_message_id)!.channelId, message_id: c.evidence_message_id! })),
        },
      ];
      const p = b.field_provenance[path];
      if (p) p.slot_state = "proposed";
      continue;
    }
    keep.push(...list); // same channel: later value wins (연속 정정)
  }
  return keep;
}
