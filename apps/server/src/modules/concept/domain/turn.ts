/**
 * Pure commit planner for `concept_turn` / `import_concept` / form edits (design/11 §2.5 X-7/X-9, §2.7,
 * §3.2–3.8). Inputs are snapshots; the application layer persists the result in one transaction.
 */
import type { ConceptEntryMode, ConceptStage } from "@ncs/shared";
import {
  cloneBrief,
  getPath,
  isEmptyValue,
  normalizeText,
  sameValue,
  setPath,
  slotState,
  valueToText,
  type WorkingBrief,
} from "./brief.js";
import { runDeterministicChecks, type InstallSafetyLists } from "./checks.js";
import {
  CONTROL,
  control,
  controlKeyOf,
  convergingDone,
  divergingDone,
  escapeButtons,
  fallbackCandidates,
  loglineCandidates,
  missingRequired,
  satisfied,
  selectNext,
  summaryText,
  type NextStep,
} from "./next-question.js";
import type { ConceptTurnProposal, ImportProposal } from "./proposal.js";
import { COMMON_1, DEF_BY_PATH, isKnownPath, requiredLevel, requiredPaths, slotLabel } from "./question-set.js";
import { applyClaim, splitConflicts, writeSlot, type GuardContext, type SlotClaim, type SlotDiff, type StoredOption } from "./slot-guard.js";
import {
  addProposal,
  decisionVerified,
  promptProposalId,
  reconcileProposals,
  settleProposal,
  yesNoAnswer,
  type ProposalSettlement,
} from "./change-proposals.js";
import type { ChangeProposal, ProposalResolution } from "./brief.js";

export interface TurnMessage {
  id: string;
  seq: number;
  authorKind: "user" | "agent" | "system";
  kind: string;
  body: string;
  channelId: string;
  pickedIdx: number | null;
  options: StoredOption[] | null;
  askedFieldPaths: string[] | null;
  /** 설계 추가: posted by the auto-approve mode on the user's behalf (domain/auto-approve.ts) */
  autoApproved?: boolean;
}

export interface TurnLimits {
  flipLimit: number;
  softWarning: number;
  agentTurnCount: number;
  turnLimit: number;
  messenger: boolean;
  replyMaxChars: number;
}

export interface PlanTurnInput {
  brief: WorkingBrief;
  stage: ConceptStage;
  entryMode: ConceptEntryMode;
  /** user messages handled by this commit (ascending seq) */
  messages: TurnMessage[];
  /** latest agent/system prompt (with options/asked paths) before the first handled message */
  prompt: TurnMessage | null;
  proposal: ConceptTurnProposal | null;
  runId: string | null;
  lists: InstallSafetyLists;
  limits: TurnLimits;
  newId: () => string;
  /** resume / "대화로 마저 채우기" first turn: short summary + next question (3.9) */
  forceSummary?: boolean;
}

export interface PlannedReply {
  body: string;
  options: StoredOption[];
  askedFieldPaths: string[];
}

export interface PlanTurnOutput {
  brief: WorkingBrief;
  stage: ConceptStage;
  stageChange: { from: ConceptStage; to: ConceptStage; by: "user" | "system" } | null;
  /** slot diffs keyed by user message id ("_" = not tied to a message) */
  diffs: Map<string, SlotDiff[]>;
  reply: PlannedReply;
  notices: string[];
  /** user pressed [승인 요청] inside the chat */
  submitRequested: boolean;
  /** user pressed [나중에 이어 하기] / [20턴 더] / [폼으로 마저 입력] */
  pauseRequested: boolean;
  extendRequested: boolean;
  formModeRequested: boolean;
  /** change proposals that left `pending` in this commit (audit trail) */
  settled: ProposalSettlement[];
}

const DELEGATE_RE = /알아서|아무거나|추천대로|맡길게|맡겨|맡깁니다|네가 정해|니가 정해|정해\s*줘|추천해\s*줘/;
const NONE_RE = /^(없음|없어|없어요|아직 없음|모르겠어|몰라)\.?$/;

function newGuard(b: WorkingBrief, input: PlanTurnInput, notices: string[], diffs: Map<string, SlotDiff[]>, changed: Set<string>, copyTitle: string | null): GuardContext {
  return {
    messages: input.messages.map((m) => ({ id: m.id, body: m.body, channelId: m.channelId, authorKind: m.authorKind, auto: !!m.autoApproved })),
    promptOptions: input.prompt?.options ?? [],
    lists: input.lists,
    copyTitle,
    runId: input.runId,
    newId: input.newId,
    nextCharKey: () => {
      const n = (b.meta.next_character_no ?? 1);
      b.meta.next_character_no = n + 1;
      return `chr_${n}`;
    },
    notices,
    diffs,
    changed,
    flipLimit: input.limits.flipLimit,
    settled: [],
  };
}

/** the user's decision on a pending proposal: accept writes the proposed value (button-equivalent) */
function decideProposal(b: WorkingBrief, g: GuardContext, cp: ChangeProposal, decision: "accepted" | "rejected", resolution: ProposalResolution, messageId: string): void {
  if (cp.status !== "pending") return;
  settleProposal(cp, decision, resolution, messageId, g.settled);
  const origin = resolution === "auto_accepted" ? "agent_auto_accepted" : "agent_proposed_accepted";
  if (decision === "accepted") writeSlot(b, g, cp.field_path, cp.new_value, origin, "confirmed", [messageId], { messageId });
}

export function resolveOption(prompt: TurnMessage | null, m: TurnMessage, optionValue?: string | null): StoredOption | null {
  const opts = prompt?.options ?? [];
  if (m.pickedIdx !== null && m.pickedIdx !== undefined) {
    const hit = opts.find((o) => o.idx === m.pickedIdx);
    if (hit) return hit;
    const ctl = (Object.values(CONTROL) as Array<{ idx: number; value: string; label: string }>).find((c) => c.idx === m.pickedIdx);
    if (ctl) return { idx: ctl.idx, value: ctl.value, label: ctl.label, source: "control" };
  }
  if (optionValue) {
    const hit = opts.find((o) => o.value === optionValue) ?? (controlKeyOf(optionValue) ? control(controlKeyOf(optionValue)!) : null);
    if (hit) return hit;
    if (optionValue.startsWith("@")) return { idx: -1, value: optionValue, label: optionValue, source: "control" };
  }
  return null;
}

function recommendedValue(path: string, input: PlanTurnInput, b: WorkingBrief): unknown {
  const p = input.proposal;
  if (p && p.delegate_values[path] !== undefined) return p.delegate_values[path];
  const q = p?.questions.find((x) => x.slot_key === path);
  const rec = q?.options.find((o) => o.is_recommended) ?? q?.options[0];
  if (rec) return rec.value;
  const prev = input.prompt?.options?.find((o) => o.field_path === path && o.source === "agent" && o.is_recommended);
  if (prev) return prev.value;
  const def = DEF_BY_PATH.get(path);
  if (def) return fallbackCandidates(def, b)[0]?.value;
  return undefined;
}

function delegateFill(b: WorkingBrief, g: GuardContext, path: string, value: unknown, messageId: string | null): boolean {
  if (value === undefined) return false;
  const v = typeof value === "string" ? value : value;
  writeSlot(b, g, path, path === "category.trope_labels" || path === "category.subgenre_labels" ? [String(v)] : v, "agent_delegated", "proposed", messageId ? [messageId] : [], {
    countFlip: false,
    messageId,
  });
  return true;
}

function confirmPaths(b: WorkingBrief, g: GuardContext, paths: string[], messageId: string, auto = false): number {
  let n = 0;
  for (const path of paths) {
    const p = b.field_provenance[path];
    if (!p || p.slot_state === "confirmed" || isEmptyValue(getPath(b.content, path))) continue;
    p.slot_state = "confirmed";
    // 자동 승인 confirmed the agent's interpretation on the user's behalf: distinct provenance (not a user confirmation)
    if (auto && p.origin !== "user_stated" && p.origin !== "user_edited") p.origin = "agent_auto_accepted";
    p.evidence_message_ids = [...new Set([...p.evidence_message_ids, messageId])];
    (b.meta as { reconfirm?: string[] }).reconfirm = ((b.meta as { reconfirm?: string[] }).reconfirm ?? []).filter((x) => x !== path);
    g.diffs.set(messageId, [...(g.diffs.get(messageId) ?? []), { field_path: path, before: getPath(b.content, path) ?? null, after: getPath(b.content, path) ?? null, origin: p.origin, slot_state: "confirmed" }]);
    n++;
  }
  return n;
}

function deferPath(b: WorkingBrief, path: string, note: string) {
  const prev = b.field_provenance[path];
  b.field_provenance[path] = { origin: prev?.origin ?? "user_stated", slot_state: "deferred", evidence_message_ids: prev?.evidence_message_ids ?? [], history_count: prev?.history_count ?? 0 };
  const oq = (b.content.open_questions ??= []);
  if (!oq.some((q) => q.field_path === path)) oq.push({ field_path: path, note });
}

/** 3.2 / 3.7 deterministic stage rules (forward only; user-only moves are flagged by the caller) */
function nextStageBySystem(b: WorkingBrief, stage: ConceptStage, hadUserInput: boolean): ConceptStage {
  let s = stage;
  if (s === "opening" && hadUserInput) s = "diverging";
  if (s === "diverging" && divergingDone(b)) s = "converging";
  return s;
}

/**
 * Plan one concept turn commit.
 * `superseded=true` (X-7): only user-evidenced slot updates are applied; the reply is still composed but
 * the caller stores it with is_superseded and does not deliver it.
 */
export function planTurn(input: PlanTurnInput): PlanTurnOutput {
  const b = cloneBrief(input.brief);
  const notices: string[] = [];
  const diffs = new Map<string, SlotDiff[]>();
  const changed = new Set<string>();
  const proposal = input.proposal;
  const copyTitle = proposal?.copy_request_detected?.work_title?.trim() || null;
  const g = newGuard(b, input, notices, diffs, changed, copyTitle);
  const askedPath = input.prompt?.askedFieldPaths?.[0] ?? null;
  /** proposals pending before this commit (reconciled at the end) */
  const existingProposals = new Set(b.change_proposals.filter((p) => p.status === "pending").map((p) => p.id));
  /** the prompt was "'X'을(를) …로 바꾸자는 제안이 있습니다. 바꿀까요?" — a text reply is a yes/no, never the field value */
  const askedProposalId = promptProposalId(input.prompt?.options);
  let stage = input.stage;
  let stageBy: "user" | "system" = "system";
  let delegateSignal = false;
  let delegateAll = false;
  let wrapUp = false;
  let toConfirming = false;
  let summaryRequested = !!input.forceSummary;
  let submitRequested = false;
  let pauseRequested = false;
  let extendRequested = false;
  let formModeRequested = false;
  let candidatesFor: string | null = null;
  const codeClaims: SlotClaim[] = [];
  const textMessages: TurnMessage[] = [];

  for (const m of input.messages) {
    if (m.kind === "option_pick") {
      const o = resolveOption(input.prompt, m, null) ?? resolveOption(input.prompt, m, m.body);
      if (!o) continue;
      if (o.source === "control") {
        const v = o.value;
        const key = controlKeyOf(v);
        if (key === "recommend") delegateSignal = true;
        else if (key === "defer") {
          const def = askedPath ? DEF_BY_PATH.get(askedPath) : null;
          if (def && requiredLevel(def, b.content) !== "core") deferPath(b, def.path, "사용자가 나중에로 넘김");
          else if (def) notices.push(`'${def.label}'은(는) 필수 항목이라 나중에로 넘길 수 없습니다.`);
        } else if (key === "summary") summaryRequested = true;
        else if (key === "wrapUp") wrapUp = true;
        else if (key === "delegateAll") delegateAll = true;
        else if (key === "toConfirming") toConfirming = true;
        else if (key === "submit") submitRequested = true;
        else if (key === "later") pauseRequested = true;
        else if (key === "extendTurns") extendRequested = true;
        else if (key === "formMode") formModeRequested = true;
        else if (key === "none") {
          /* opening "아직 없음": nothing to store */
        } else if (key === "confirmDelegated") {
          const paths = Object.entries(b.field_provenance).filter(([, p]) => p.origin === "agent_delegated" && p.slot_state === "proposed").map(([k]) => k);
          confirmPaths(b, g, paths, m.id);
        } else if (key === "confirmImported") {
          const paths = Object.entries(b.field_provenance).filter(([, p]) => p.origin === "imported" && p.slot_state === "proposed").map(([k]) => k);
          confirmPaths(b, g, paths, m.id);
        } else if (v.startsWith("@confirm_field:")) {
          confirmPaths(b, g, [v.slice("@confirm_field:".length)], m.id, !!m.autoApproved);
        } else if (v.startsWith("@accept_proposal:") || v.startsWith("@reject_proposal:")) {
          const id = v.split(":")[1];
          const cp = b.change_proposals.find((p) => p.id === id && p.status === "pending");
          if (cp) decideProposal(b, g, cp, v.startsWith("@accept") ? "accepted" : "rejected", m.autoApproved ? "auto_accepted" : "button", m.id);
        }
        continue;
      }
      // regular option (seed / agent candidate / conflict / flip pick)
      const path = o.field_path ?? askedPath;
      if (!path) continue;
      b.meta.conflicts = (b.meta.conflicts ?? []).filter((c) => c.field_path !== path);
      b.meta.flip_cards = (b.meta.flip_cards ?? []).filter((c) => c.field_path !== path);
      codeClaims.push(
        m.autoApproved
          ? // 자동 승인: the partner's pick on the user's behalf — never user_stated, never overrides a user value
            { field_path: path, new_value: o.value, origin_claim: "agent_proposed_accepted", evidence_message_id: m.id, evidence_quote: "", key_phrase: "", autoAccepted: true }
          : {
              field_path: path,
              new_value: o.value,
              origin_claim: o.source === "agent" ? "agent_proposed_accepted" : "user_stated",
              evidence_message_id: m.id,
              evidence_quote: m.body,
              key_phrase: o.source === "agent" ? "" : m.body,
              userAction: true,
            },
      );
      continue;
    }
    if (m.kind === "text") {
      if (DELEGATE_RE.test(m.body) || proposal?.user_intent === "delegate") delegateSignal = true;
      else textMessages.push(m);
    }
  }

  // change proposals settled in the chat: quote-verified model decisions (INV-CON-03), else a plain yes/no
  // answer to the proposal question. Decided fields take no further model claim in this commit.
  const decidedPaths = new Set<string>();
  for (const d of proposal?.proposal_decisions ?? []) {
    const cp = b.change_proposals.find((p) => p.id === d.proposal_id && p.status === "pending");
    const msg = input.messages.find((m) => m.id === d.evidence_message_id && m.authorKind === "user" && !m.autoApproved);
    if (!cp || !msg || !decisionVerified(d.evidence_quote, msg.body)) continue;
    decideProposal(b, g, cp, d.decision, "decided_in_chat", msg.id);
    decidedPaths.add(cp.field_path);
  }
  const rawModelClaims = proposal?.slot_updates ?? [];
  const asked = askedProposalId ? b.change_proposals.find((p) => p.id === askedProposalId && p.status === "pending") : undefined;
  if (asked && !rawModelClaims.some((u) => u.field_path === asked.field_path)) {
    for (const m of [...textMessages].reverse()) {
      const answer = yesNoAnswer(m.body);
      if (!answer) continue;
      decideProposal(b, g, asked, answer, "decided_in_chat", m.id);
      decidedPaths.add(asked.field_path);
      break;
    }
  }

  // 2.7 slot updates: model claims, else deterministic fallback (answer to the asked slot)
  const modelClaims: SlotClaim[] = rawModelClaims.filter((u) => !decidedPaths.has(u.field_path)).map((u) => ({ ...u, evidence_message_id: u.evidence_message_id ?? null }));
  if (!rawModelClaims.length && askedPath && !askedProposalId) {
    for (const m of textMessages) {
      if (askedPath === "seed_notes" && NONE_RE.test(m.body.trim())) continue;
      codeClaims.push({ field_path: askedPath, new_value: m.body, origin_claim: "user_stated", evidence_message_id: m.id, evidence_quote: m.body, key_phrase: m.body });
    }
  }
  if (input.stage === "opening" && !askedPath) {
    for (const m of textMessages) if (!NONE_RE.test(m.body.trim())) codeClaims.push({ field_path: "seed_notes", new_value: m.body, origin_claim: "user_stated", evidence_message_id: m.id, evidence_quote: m.body, key_phrase: m.body });
  }
  for (const claim of splitConflicts(b, g, [...modelClaims, ...codeClaims])) applyClaim(b, g, claim);
  if (proposal) for (const cp of proposal.change_proposals) if (isKnownPath(cp.field_path) && !decidedPaths.has(cp.field_path)) proposeIfDiffers(b, g, cp.field_path, cp.new_value, cp.reason);

  // 3.5 delegation
  const delegate = b.meta.delegate ?? null;
  if (delegateSignal && askedPath) {
    const def = DEF_BY_PATH.get(askedPath);
    if (!def || !def.delegable) {
      notices.push(`'${slotLabel(askedPath)}'은(는) 위임으로 정할 수 없습니다. 후보 중에서 골라 주세요.`);
      candidatesFor = askedPath;
    } else {
      const count = delegate?.path === askedPath ? delegate.count + 1 : 1;
      if (count >= 2) {
        const value = recommendedValue(askedPath, input, b);
        if (delegateFill(b, g, askedPath, value, input.messages[input.messages.length - 1]?.id ?? null)) {
          notices.push(`'${def.label}'은(는) 추천안 "${valueToText(getPath(b.content, askedPath))}"(으)로 두었습니다. 확인 단계에서 바꿀 수 있습니다.`);
        }
        b.meta.delegate = null;
      } else {
        b.meta.delegate = { path: askedPath, count };
        candidatesFor = askedPath;
      }
    }
  } else if (input.messages.length) b.meta.delegate = null;

  if (delegateAll) {
    const lastId = input.messages[input.messages.length - 1]?.id ?? null;
    for (const path of requiredPaths(b.content)) {
      if (path === "logline" || satisfied(b, path)) continue;
      const def = DEF_BY_PATH.get(path);
      if (!def?.delegable) continue;
      if (slotState(b, path) === "proposed" && !isEmptyValue(getPath(b.content, path))) continue;
      delegateFill(b, g, path, recommendedValue(path, input, b), lastId);
    }
    for (const def of COMMON_1) {
      if (requiredLevel(def, b.content) === "core" || def.stage === "opening") continue;
      if (slotState(b, def.path) === "empty") deferPath(b, def.path, "전부 맡기기로 나중에 정함");
    }
    toConfirming = true;
  }
  if (wrapUp) {
    for (const def of COMMON_1) {
      if (requiredLevel(def, b.content) !== "core" && def.stage !== "opening" && slotState(b, def.path) === "empty") deferPath(b, def.path, "이대로 정리로 나중에 정함");
    }
    const missing = missingRequired(b).filter((p) => p !== "logline" && !satisfied(b, p));
    if (missing.length) notices.push(`남은 필수 항목 ${missing.length}개만 정하면 됩니다: ${missing.map(slotLabel).join(", ")}.`);
    else toConfirming = true;
  }

  // X-9 deterministic checks (+ model flags)
  const userTexts = input.messages.filter((m) => m.authorKind === "user" && !m.autoApproved).map((m) => ({ messageId: m.id, text: m.body }));
  b.checks = runDeterministicChecks(b, input.lists, userTexts);
  if (proposal) {
    for (const f of proposal.safety_flags) {
      if (f.kind === "real_person") b.checks.safety.real_person_hits.push({ name: f.note || "실존 인물", field_path: f.field_path, source: "llm" });
      else if (f.kind === "over_age_rating") b.checks.safety.age_rating_flags.push({ field_path: f.field_path, keyword: f.note || "등급 초과", message_id: f.message_id });
      else b.checks.safety.minor_flags.push({ character_key: f.field_path ?? "unknown", note: f.note || "미성년 인물과 성적 맥락" });
      if (f.field_path && b.field_provenance[f.field_path]?.slot_state === "confirmed") b.field_provenance[f.field_path]!.slot_state = "proposed";
    }
    if (copyTitle) {
      b.checks.similarity.copy_requests.push({
        work_title: copyTitle,
        quote: proposal.copy_request_detected!.quote,
        message_id: proposal.copy_request_detected!.message_id ?? input.messages[0]?.id ?? "",
        field_paths: [...changed],
      });
      notices.push(`'${copyTitle}'을(를) 그대로 따라 할 수는 없습니다. 분위기만 참고하고 고유 설정·고유명은 새로 만들어 주세요.`);
    }
  }
  if (b.checks.safety.age_rating_flags.length && b.content.age_rating === "age_15") {
    notices.push("이 내용은 15세 등급을 넘습니다. 대안을 고르거나 내용을 고쳐 주세요.");
  }

  // stages (CS2)
  const hadInput = input.messages.length > 0;
  const before = stage;
  stage = nextStageBySystem(b, stage, hadInput);
  if (toConfirming && stage !== "confirming") {
    stage = "confirming";
    stageBy = "user";
  }
  if (stage === "converging" && !divergingDone(b) && before === "converging") stage = "converging";

  // proposals the conversation made moot (the user said the proposed value, or moved the field elsewhere)
  reconcileProposals(b, { existing: existingProposals, changed, messageId: input.messages[input.messages.length - 1]?.id ?? null, acceptedResolution: "applied_in_chat" }, g.settled);

  // logline candidates (CQ-21)
  if (stage === "confirming" && isEmptyValue(b.content.logline) && !(b.content.logline_options ?? []).length) {
    b.content.logline_options = proposal?.logline_options.length ? proposal.logline_options.slice(0, 3) : loglineCandidates(b);
  }

  // asked-streak (같은 슬롯 연속 3턴 초과)
  const step = selectNext(b, stage, { candidatesFor, messenger: input.limits.messenger });
  const stepPath = "path" in step ? step.path : null;
  const streak = stepPath && b.meta.asked?.path === stepPath ? b.meta.asked.count + 1 : 1;
  b.meta.asked = stepPath ? { path: stepPath, count: streak } : null;

  const reply = composeReply(b, step, stage, input, notices, { summaryRequested, streak, candidatesFor });
  return {
    brief: b,
    stage,
    stageChange: stage !== input.stage ? { from: input.stage, to: stage, by: stageBy } : null,
    diffs,
    reply,
    notices,
    submitRequested,
    pauseRequested,
    extendRequested,
    formModeRequested,
    settled: g.settled,
  };
}

function proposeIfDiffers(b: WorkingBrief, g: GuardContext, path: string, value: unknown, reason: string) {
  const cur = getPath(b.content, path);
  if (isEmptyValue(cur)) return;
  if (normalizeText(valueToText(cur)) === normalizeText(valueToText(value))) return;
  // the user already turned this exact change down and the field has not moved since: don't nag
  const declined = b.change_proposals.some(
    (p) => p.status === "rejected" && p.field_path === path && sameValue(p.new_value, value) && (p.base_value === undefined || sameValue(p.base_value ?? null, cur)),
  );
  if (declined) return;
  addProposal(b, { id: g.newId(), path, value, reason: reason || "에이전트 수정 제안", runId: g.runId }, g.settled);
}

function composeReply(
  b: WorkingBrief,
  step: NextStep,
  stage: ConceptStage,
  input: PlanTurnInput,
  notices: string[],
  o: { summaryRequested: boolean; streak: number; candidatesFor: string | null },
): PlannedReply {
  const proposal = input.proposal;
  const lines: string[] = [...new Set(notices)];
  // 설계 변경: brief complete → closing summary + [승인 요청] guidance, no new question
  if (o.summaryRequested || step.kind === "ready") lines.push(summaryText(b, undefined, { omitStatus: step.kind === "ready" }));
  if (stage === "converging" && proposal?.weakness_notes.length) lines.push(...proposal.weakness_notes.slice(0, 2).map((w) => `[약점] ${w}`));
  let options = step.options;
  let askText = step.text;
  const stepPath = "path" in step ? step.path : null;
  const modelQ = proposal?.questions.find((q) => q.slot_key === stepPath);
  if (step.kind === "ask" && modelQ) {
    askText = modelQ.ask_text || askText;
    if (modelQ.options.length) {
      options = modelQ.options.slice(0, 3).map((x, i) => ({
        idx: i + 1,
        label: x.label,
        value: x.value,
        is_recommended: x.is_recommended,
        rationale: x.rationale,
        risk: x.risk,
        is_common_choice: x.is_common_choice,
        source: "agent" as const,
        field_path: step.path,
      }));
    }
  }
  if (step.kind === "ask" && step.path === "logline" && (b.content.logline_options ?? []).length) {
    options = b.content.logline_options!.slice(0, 3).map((l, i) => ({ idx: i + 1, label: l.length > 60 ? `${l.slice(0, 59)}…` : l, value: l, source: "agent" as const, field_path: "logline", is_recommended: i === 0 }));
  }
  // the model's phrasing is used only when it asks the slot the code selected (3.5); otherwise the code's text
  const replyText = proposal?.reply_text?.trim();
  if (replyText && modelQ && step.kind === "ask") lines.push(replyText);
  else lines.push(step.kind === "ask" ? `[질문] ${askText}` : askText);
  if (step.kind === "ask" && step.def.why_ko) lines.push(step.def.why_ko);
  if (options.some((x) => x.source !== "control")) {
    lines.push(
      options
        .filter((x) => x.source !== "control")
        .map((x) => `${x.idx}) ${x.label}${x.is_recommended ? " (추천)" : ""}${x.is_common_choice ? " · 흔한 선택" : ""}${x.rationale ? ` – ${x.rationale}` : ""}${x.risk ? ` 위험: ${x.risk}` : ""}`)
        .join("\n"),
    );
  }
  if (o.streak > 3 && step.kind === "ask") lines.push(step.required ? "추천안으로 채워 둘까요? [추천해 줘]를 두 번 누르면 추천안으로 둡니다." : "이 항목은 [나중에]로 넘겨도 됩니다.");
  // the turn cap is a hidden safety ceiling: warn only close to it, and only while required fields remain
  const used = input.limits.agentTurnCount + 1;
  const missing = missingRequired(b);
  if (missing.length && used >= input.limits.softWarning && used < input.limits.turnLimit) {
    lines.push(`대화 안전 상한까지 ${input.limits.turnLimit - used}턴 남았습니다. 남은 필수 항목 ${missing.length}개(${missing.map(slotLabel).join(", ")})는 [전부 맡기기]로 정리할 수도 있습니다.`);
  }
  let body = lines.filter(Boolean).join("\n");
  if (body.length > input.limits.replyMaxChars) body = `${body.slice(0, input.limits.replyMaxChars - 1)}…`;
  const all = [...options, ...escapeButtons(step).filter((c) => !options.some((x) => x.value === c.value))];
  return { body, options: all, askedFieldPaths: stepPath ? [stepPath] : [] };
}

// ── import_concept (2.3 import) ──────────────────────────────────────────
const IMPORT_LABELS: Array<[RegExp, string]> = [
  [/^(장르|genre)$/i, "category.genre_label"],
  [/^(하위\s*장르)$/, "category.subgenre_labels"],
  [/^(트로프|키워드|태그)$/, "category.trope_labels"],
  [/^(연령\s*등급|등급|연령)$/, "age_rating"],
  [/^(주인공|주인공\s*처지|출발\s*조건)$/, "protagonist.starting_condition"],
  [/^(욕망|목표|주인공\s*목표)$/, "protagonist.desire"],
  [/^(결핍)$/, "protagonist.lack"],
  [/^(대립|적대자|악역|장애물)$/, "opposition"],
  [/^(걸린\s*것|위험)$/, "stakes"],
  [/^(훅|핵심\s*훅|차별점)$/, "core_hook"],
  [/^(세계관|세계\s*규칙|규칙)$/, "world_rules[item_key=core]"],
  [/^(주요\s*인물|등장인물|인물)$/, "main_characters"],
  [/^(결말|결말\s*방향|엔딩)$/, "ending_direction"],
  [/^(톤|분위기|문체)$/, "tone"],
  [/^(화수|분량)$/, "serial_plan.total_episodes_min"],
  [/^(독자|타깃|타깃\s*독자)$/, "target.readers"],
  [/^(로그라인|한\s*줄\s*요약)$/, "logline"],
  [/^(제목|제목\s*후보)$/, "title_candidates"],
  [/^(시놉시스|줄거리|전제)$/, "premise"],
];

/** deterministic fallback extractor for `키: 값` lines (MVP-α, no fact candidates — FR-NOV-05 v1) */
export function extractImportLines(text: string): ImportProposal["slot_updates"] {
  const out: ImportProposal["slot_updates"] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*#]*\s*([^:：]{1,20})\s*[:：]\s*(.+)$/.exec(line);
    if (!m) continue;
    const label = m[1]!.trim();
    const hit = IMPORT_LABELS.find(([re]) => re.test(label)) ?? (COMMON_1.find((d) => d.label === label) ? [/x/, COMMON_1.find((d) => d.label === label)!.path] as [RegExp, string] : null);
    if (hit && !out.some((u) => u.field_path === hit[1])) out.push({ field_path: hit[1], new_value: m[2]!.trim() });
  }
  return out;
}

export interface PlanImportInput {
  brief: WorkingBrief;
  stage: ConceptStage;
  message: TurnMessage;
  proposal: ImportProposal | null;
  lists: InstallSafetyLists;
  limits: TurnLimits;
  newId: () => string;
}

const QUESTION_ORDER = new Map(COMMON_1.map((d, i) => [d.path, i]));
/** stable sort of slot updates by question-set order (unknown paths keep their place at the end) */
export function sortByQuestionOrder<T extends { field_path: string }>(updates: readonly T[]): T[] {
  const rank = (p: string) => (p === "logline" ? Number.MAX_SAFE_INTEGER : QUESTION_ORDER.get(p) ?? COMMON_1.length);
  return updates.map((u, i) => ({ u, i })).sort((a, b) => rank(a.u.field_path) - rank(b.u.field_path) || a.i - b.i).map((x) => x.u);
}

export function planImport(input: PlanImportInput): PlanTurnOutput {
  const b = cloneBrief(input.brief);
  const notices: string[] = [];
  const diffs = new Map<string, SlotDiff[]>();
  const changed = new Set<string>();
  const g = newGuard(b, { ...input, entryMode: "import", messages: [input.message], prompt: null, proposal: null, runId: null }, notices, diffs, changed, null);
  const existingProposals = new Set(b.change_proposals.filter((p) => p.status === "pending").map((p) => p.id));
  // parents before dependents (question-set order, logline last): a changed parent clears / reopens its dependents
  // (3.7), so a dependent extracted from the same text must be written after its parent or it is lost
  const updates = sortByQuestionOrder(input.proposal?.slot_updates.length ? input.proposal.slot_updates : extractImportLines(input.message.body));
  let filled = 0;
  for (const u of updates) {
    if (!isKnownPath(u.field_path)) continue;
    const cur = b.field_provenance[u.field_path];
    if (cur && (cur.origin === "user_stated" || cur.origin === "user_edited") && !isEmptyValue(getPath(b.content, u.field_path))) continue; // INV-CON-03
    const value = coerceForImport(b, g, u.field_path, u.new_value);
    if (value === undefined) continue;
    writeSlot(b, g, u.field_path, value, "imported", "proposed", [input.message.id], { countFlip: false, messageId: input.message.id });
    filled++;
  }
  if (isEmptyValue(b.content.seed_notes)) {
    setPath(b.content, "seed_notes", input.message.body.slice(0, 4000));
    b.field_provenance.seed_notes = { origin: "imported", slot_state: "proposed", evidence_message_ids: [input.message.id], history_count: 1 };
  }
  const docs = (b.content.source_documents ??= []);
  if (!docs.some((d) => d.concept_message_id === input.message.id)) {
    docs.push({ concept_message_id: input.message.id, chars: input.message.body.length, kind: input.proposal?.source_kind ?? "synopsis" });
  }
  reconcileProposals(b, { existing: existingProposals, changed, messageId: input.message.id, acceptedResolution: "applied_in_chat" }, g.settled);
  b.checks = runDeterministicChecks(b, input.lists, [{ messageId: input.message.id, text: input.message.body }]);
  const stage: ConceptStage = input.stage === "confirming" ? "confirming" : "converging";
  const step = selectNext(b, stage, {});
  const lines = [
    input.proposal?.reply_text?.trim() || `붙여 넣은 원문에서 ${filled}개 항목을 뽑았습니다. 브리프 패널에서 확인한 뒤 [추출값 전체 확인]을 눌러 주세요.`,
    step.kind === "ask" ? `[질문] ${step.text}` : step.text,
  ];
  const stepPath = "path" in step ? step.path : null;
  return {
    brief: b,
    stage,
    stageChange: stage !== input.stage ? { from: input.stage, to: stage, by: "system" } : null,
    diffs,
    reply: {
      body: lines.join("\n").slice(0, input.limits.replyMaxChars),
      options: [control("confirmImported"), ...step.options.filter((o) => o.value !== CONTROL.confirmImported.value), ...escapeButtons(step)],
      askedFieldPaths: stepPath ? [stepPath] : [],
    },
    notices,
    submitRequested: false,
    pauseRequested: false,
    extendRequested: false,
    formModeRequested: false,
    settled: g.settled,
  };
}

function coerceForImport(b: WorkingBrief, g: GuardContext, path: string, raw: unknown): unknown {
  // reuse the guard's coercion through a throw-away claim-free path
  const dummy = cloneBrief(b);
  const res = applyClaim(dummy, { ...g, notices: [], diffs: new Map(), changed: new Set(), messages: [{ id: "_import", body: valueToText(raw), channelId: "", authorKind: "user" }] }, {
    field_path: path,
    new_value: raw,
    origin_claim: "user_stated",
    evidence_message_id: "_import",
    evidence_quote: valueToText(raw),
    key_phrase: valueToText(raw),
    userAction: true,
  });
  return res.applied ? getPath(dummy.content, path) : undefined;
}

// ── form edit (direct_input / 패널 "고치기") ─────────────────────────────
export interface PlanEditInput {
  brief: WorkingBrief;
  stage: ConceptStage;
  entryMode: ConceptEntryMode;
  messageId: string;
  path: string;
  value: unknown;
  lists: InstallSafetyLists;
  flipLimit: number;
  newId: () => string;
}

export function planFieldEdit(input: PlanEditInput): { brief: WorkingBrief; diffs: SlotDiff[]; notices: string[]; stage: ConceptStage; settled: ProposalSettlement[] } {
  const b = cloneBrief(input.brief);
  const notices: string[] = [];
  const diffs = new Map<string, SlotDiff[]>();
  const changed = new Set<string>();
  const g: GuardContext = {
    messages: [],
    promptOptions: [],
    lists: input.lists,
    copyTitle: null,
    runId: null,
    newId: input.newId,
    nextCharKey: () => {
      const n = b.meta.next_character_no ?? 1;
      b.meta.next_character_no = n + 1;
      return `chr_${n}`;
    },
    notices,
    diffs,
    changed,
    flipLimit: input.flipLimit,
    settled: [],
  };
  const existingProposals = new Set(b.change_proposals.filter((p) => p.status === "pending").map((p) => p.id));
  const dummy = cloneBrief(b);
  const probe = applyClaim(dummy, { ...g, notices, diffs: new Map(), changed: new Set(), messages: [{ id: input.messageId, body: valueToText(input.value), channelId: "", authorKind: "user" }] }, {
    field_path: input.path,
    new_value: input.value,
    origin_claim: "user_stated",
    evidence_message_id: input.messageId,
    evidence_quote: valueToText(input.value),
    key_phrase: valueToText(input.value),
    userAction: true,
  });
  b.meta.conflicts = (b.meta.conflicts ?? []).filter((c) => c.field_path !== input.path);
  b.meta.flip_cards = (b.meta.flip_cards ?? []).filter((c) => c.field_path !== input.path);
  const empty = input.value === null || (typeof input.value === "string" && input.value.trim() === "") || (Array.isArray(input.value) && !input.value.length);
  if (empty) {
    writeSlot(b, g, input.path, undefined, "user_edited", "empty", [input.messageId], { messageId: input.messageId });
  } else if (probe.applied) {
    writeSlot(b, g, input.path, getPath(dummy.content, input.path), "user_edited", "confirmed", [input.messageId], { messageId: input.messageId });
  }
  // the user set this field by hand: its proposal is accepted (same value), superseded (another value)
  // or, if the value stayed, declined
  reconcileProposals(b, { existing: existingProposals, changed, messageId: input.messageId, acceptedResolution: "form_edit" }, g.settled);
  for (const p of b.change_proposals) if (p.status === "pending" && p.field_path === input.path && existingProposals.has(p.id)) settleProposal(p, "rejected", "form_edit", input.messageId, g.settled);
  b.checks = runDeterministicChecks(b, input.lists, []);
  let stage = input.stage;
  if (stage === "opening") stage = "diverging";
  if (stage === "diverging" && divergingDone(b)) stage = "converging";
  // direct_input: once every required field but the logline is set, offer logline candidates (2.3)
  if (input.entryMode === "direct_input" && isEmptyValue(b.content.logline) && !(b.content.logline_options ?? []).length) {
    const rest = missingRequired(b).filter((p) => p !== "logline");
    if (!rest.length) b.content.logline_options = loglineCandidates(b);
  }
  if (input.entryMode === "direct_input" && convergingDone(b) && stage !== "confirming") stage = "confirming";
  return { brief: b, diffs: [...diffs.values()].flat(), notices, stage, settled: g.settled };
}
