/**
 * Deterministic next-question selection (design/11 §3.5) + stage rules (§3.2, §3.7) + reserved buttons
 * (§4.2 idx 900–907) + summary / logline fallbacks. Pure.
 */
import { DEFAULTS, type ConceptStage } from "@ncs/shared";
import { getPath, isEmptyValue, slotState, valueToText, type WorkingBrief } from "./brief.js";
import {
  COMMON_1,
  DEF_BY_PATH,
  hasUsableValue,
  needsAgeBands,
  requiredLevel,
  requiredPaths,
  requiredPathsForStage,
  slotLabel,
  type ConceptQuestionDef,
} from "./question-set.js";
import type { StoredOption } from "./slot-guard.js";

/** reserved idx (4.2) + extra control values */
export const CONTROL = {
  direct: { idx: 900, value: "@direct", label: "직접 입력" },
  recommend: { idx: 901, value: "@recommend", label: "추천해 줘" },
  defer: { idx: 902, value: "@defer", label: "나중에" },
  summary: { idx: 903, value: "@summary", label: "요약 보기" },
  wrapUp: { idx: 904, value: "@wrap_up", label: "이대로 정리" },
  delegateAll: { idx: 905, value: "@delegate_all", label: "전부 맡기기" },
  raiseBudget: { idx: 906, value: "@raise_budget", label: "상한 올리기" },
  formMode: { idx: 907, value: "@form_mode", label: "폼으로 마저 입력" },
  toConfirming: { idx: 910, value: "@to_confirming", label: "요약 확인으로 이동" },
  confirmDelegated: { idx: 911, value: "@confirm_delegated", label: "모두 확정" },
  confirmImported: { idx: 912, value: "@confirm_imported", label: "추출값 전체 확인" },
  retry: { idx: 913, value: "@retry", label: "다시 시도" },
  extendTurns: { idx: 914, value: "@extend_turns", label: `${DEFAULTS["concept.turn_extension"]}턴 더` },
  submit: { idx: 915, value: "@submit", label: "승인 요청" },
  none: { idx: 916, value: "@none", label: "아직 없음" },
  later: { idx: 917, value: "@later", label: "나중에 이어 하기" },
  yes: { idx: 918, value: "@yes", label: "예" },
  no: { idx: 919, value: "@no", label: "아니오" },
} as const;
export type ControlKey = keyof typeof CONTROL;

export function control(key: ControlKey): StoredOption {
  const c = CONTROL[key];
  return { idx: c.idx, label: c.label, value: c.value, source: "control" };
}

export function controlKeyOf(value: string | undefined | null): ControlKey | null {
  if (!value) return null;
  const hit = (Object.keys(CONTROL) as ControlKey[]).find((k) => CONTROL[k].value === value || String(CONTROL[k].idx) === value);
  return hit ?? null;
}

export type NextStep =
  | { kind: "conflict"; path: string; text: string; options: StoredOption[] }
  | { kind: "change_proposal"; path: string; proposalId: string; text: string; options: StoredOption[] }
  | { kind: "flip"; path: string; text: string; options: StoredOption[] }
  | { kind: "reconfirm"; path: string; text: string; options: StoredOption[] }
  | { kind: "ask"; path: string; def: ConceptQuestionDef; text: string; options: StoredOption[]; required: boolean }
  | { kind: "propose_stage"; to: ConceptStage; text: string; options: StoredOption[] }
  | { kind: "confirm_delegated"; paths: string[]; text: string; options: StoredOption[] }
  | { kind: "confirm_imported"; paths: string[]; text: string; options: StoredOption[] }
  | { kind: "ready"; text: string; options: StoredOption[] };

const opt = (idx: number, label: string, value: string, source: StoredOption["source"], field_path?: string, extra: Partial<StoredOption> = {}): StoredOption => ({
  idx,
  label,
  value,
  source,
  ...(field_path ? { field_path } : {}),
  ...extra,
});

/** "satisfied" for stage moves: confirmed, or delegated `proposed` (3.7 정상 수렴) */
export function satisfied(b: WorkingBrief, path: string): boolean {
  if (!hasUsableValue(b.content, path)) return false;
  const s = slotState(b, path);
  return s === "confirmed" || (s === "proposed" && b.field_provenance[path]?.origin === "agent_delegated");
}

export function divergingDone(b: WorkingBrief): boolean {
  return requiredPathsForStage(b.content, "diverging").every((p) => satisfied(b, p)) && charactersAgeKnown(b);
}

export function convergingDone(b: WorkingBrief): boolean {
  return requiredPathsForStage(b.content, "converging").every((p) => satisfied(b, p)) && charactersAgeKnown(b);
}

export function charactersAgeKnown(b: WorkingBrief): boolean {
  if (!needsAgeBands(b.content)) return true;
  return (b.content.main_characters ?? []).every((m) => m.age_band && m.age_band !== "unknown");
}

export function missingRequired(b: WorkingBrief): string[] {
  return requiredPaths(b.content).filter((p) => slotState(b, p) !== "confirmed" || !hasUsableValue(b.content, p));
}

function seedOptions(def: ConceptQuestionDef, base = 1): StoredOption[] {
  return def.option_seeds.slice(0, 10).map((s, i) => opt(base + i, s.label, s.value, s.value.startsWith("@") ? "control" : "seed", def.path));
}

export function fallbackCandidates(def: ConceptQuestionDef, b: WorkingBrief): StoredOption[] {
  if (def.path === "logline") return loglineCandidates(b).map((l, i) => opt(i + 1, l, l, "agent", "logline", { is_recommended: i === 0, rationale: "브리프 필드를 조합한 후보입니다." }));
  const list = def.fallback_candidates.length ? def.fallback_candidates : def.option_seeds.map((s) => s.value);
  return list.slice(0, 3).map((v, i) => {
    const seed = def.option_seeds.find((s) => s.value === v);
    return opt(i + 1, seed?.label ?? v, v, "agent", def.path, { is_recommended: i === 0, rationale: i === 0 ? "가장 무난하게 이어지는 선택입니다." : "다른 방향의 후보입니다." });
  });
}

/** CQ-21 deterministic fallback (no model): three distinct framings from the brief fields */
export function loglineCandidates(b: WorkingBrief): string[] {
  const c = b.content;
  const who = valueToText(c.protagonist?.starting_condition) || "주인공";
  const want = valueToText(c.protagonist?.desire) || "목표";
  const against = valueToText(c.opposition) || "거대한 장애물";
  const hook = valueToText(c.core_hook);
  const genre = valueToText(c.category?.genre_label);
  return [
    `${who}, ${against}에 맞서 ${want}에 도전한다.`,
    `${genre ? `[${genre}] ` : ""}${hook ? `${hook} — ` : ""}${who}의 ${want}.`,
    `${against}이 가로막는 세계에서, ${who}는 ${want}을 향해 나아간다.`,
  ].map((s) => s.replace(/\s+/g, " ").trim());
}

/** 3.9 / 903 summary line: "지금까지: … 남은 필수: …" */
export function summaryText(b: WorkingBrief, maxChars = 3500, o: { omitStatus?: boolean } = {}): string {
  const c = b.content;
  const parts = [
    c.category?.genre_label && `장르 ${c.category.genre_label}${(c.category.trope_labels ?? []).length ? `·${c.category.trope_labels!.join("·")}` : ""}`,
    c.age_rating && `등급 ${c.age_rating}`,
    c.protagonist?.starting_condition && `주인공 ${c.protagonist.starting_condition}`,
    c.protagonist?.desire && `욕망 ${c.protagonist.desire}`,
    c.opposition && `대립 ${c.opposition}`,
    c.core_hook && `훅 ${c.core_hook}`,
    c.ending_direction && `결말 ${c.ending_direction}`,
    c.logline && `로그라인 ${c.logline}`,
  ].filter(Boolean);
  const missing = missingRequired(b).map(slotLabel);
  const status = missing.length ? `남은 필수: ${missing.join(", ")}.` : o.omitStatus ? "" : "필수 항목이 모두 확정됐습니다.";
  const text = `지금까지: ${parts.length ? parts.join(", ") : "아직 정한 항목이 없습니다"}.${status ? ` ${status}` : ""}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function labelOf(v: unknown): string {
  const t = valueToText(v);
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || "(비어 있음)";
}

/**
 * 3.5 order: (1) confirmations → (2) stage required empty → (3) template (none in MVP-α) →
 * (4) optional (detail mode only) → (5) stage move proposal.
 */
export function selectNext(b: WorkingBrief, stage: ConceptStage, opts: { candidatesFor?: string | null; messenger?: boolean } = {}): NextStep {
  const c = b.content;
  // (1) confirmations
  const conflict = (b.meta.conflicts ?? [])[0];
  if (conflict) {
    return {
      kind: "conflict",
      path: conflict.field_path,
      text: `'${slotLabel(conflict.field_path)}'에 서로 다른 답이 왔습니다. 어느 쪽입니까? ${conflict.values.map((v, i) => `${i + 1}) ${labelOf(v.value)}`).join(" / ")}`,
      options: conflict.values.slice(0, 3).map((v, i) => opt(i + 1, labelOf(v.value), valueToText(v.value), "seed", conflict.field_path)),
    };
  }
  const cp = b.change_proposals.find((p) => p.status === "pending");
  if (cp) {
    return {
      kind: "change_proposal",
      path: cp.field_path,
      proposalId: cp.id,
      text: `'${slotLabel(cp.field_path)}'을(를) "${labelOf(cp.new_value)}"(으)로 바꾸자는 제안이 있습니다. 지금 값: "${labelOf(getPath(c, cp.field_path))}". ${cp.reason} 바꿀까요?`,
      options: [opt(1, "제안 수락", `@accept_proposal:${cp.id}`, "control", cp.field_path), opt(2, "지금 값 유지", `@reject_proposal:${cp.id}`, "control", cp.field_path)],
    };
  }
  const flip = (b.meta.flip_cards ?? [])[0];
  if (flip) {
    return {
      kind: "flip",
      path: flip.field_path,
      text: `'${slotLabel(flip.field_path)}'이(가) 여러 번 바뀌었습니다. ${flip.values.map(labelOf).join(" ↔ ")}, 어느 쪽으로 고정할까요?`,
      options: flip.values.slice(0, 3).map((v, i) => opt(i + 1, labelOf(v), valueToText(v), "seed", flip.field_path)),
    };
  }
  for (const def of COMMON_1) {
    const p = b.field_provenance[def.path];
    if (p?.slot_state !== "proposed" || isEmptyValue(getPath(c, def.path))) continue;
    if (p.origin === "agent_delegated" || p.origin === "imported") continue;
    return {
      kind: "reconfirm",
      path: def.path,
      text: `'${def.label}'을(를) "${labelOf(getPath(c, def.path))}"(으)로 이해했습니다. 맞습니까?`,
      options: [opt(1, "맞습니다", `@confirm_field:${def.path}`, "control", def.path)],
    };
  }
  // [추천해 줘] on a slot → candidates for that same slot next (3.5 위임 1회)
  if (opts.candidatesFor && stage !== "opening") {
    const def = DEF_BY_PATH.get(opts.candidatesFor);
    if (def && !satisfied(b, def.path)) {
      return { kind: "ask", path: def.path, def, text: def.ask_ko, options: fallbackCandidates(def, b), required: requiredLevel(def, c) === "core" };
    }
  }
  // (2) required empty for stages ≤ current
  const order: ConceptStage[] = ["opening", "diverging", "converging", "confirming"];
  if (stage === "opening") {
    const def = DEF_BY_PATH.get("seed_notes")!;
    return { kind: "ask", path: def.path, def, text: def.ask_ko, options: seedOptions(def), required: false };
  }
  const upto = order.indexOf(stage);
  for (const def of COMMON_1) {
    if (order.indexOf(def.stage) > upto || requiredLevel(def, c) !== "core") continue;
    if (def.path === "logline" && stage !== "confirming") continue;
    if (satisfied(b, def.path)) continue;
    if (slotState(b, def.path) === "proposed" && !isEmptyValue(getPath(c, def.path)) && b.field_provenance[def.path]?.origin !== "agent_delegated") continue;
    const options = opts.candidatesFor === def.path || def.path === "logline" ? fallbackCandidates(def, b) : seedOptions(def);
    return { kind: "ask", path: def.path, def, text: def.ask_ko, options, required: true };
  }
  if (!charactersAgeKnown(b)) {
    const def = DEF_BY_PATH.get("main_characters")!;
    const unknown = (c.main_characters ?? []).filter((m) => !m.age_band || m.age_band === "unknown").map((m) => m.name ?? m.character_key);
    return {
      kind: "ask",
      path: "main_characters",
      def,
      text: `${unknown.join(", ")}의 나이대(아동·청소년·성인)를 알려 주세요. 연애·학원 요소가 있어 꼭 필요합니다.`,
      options: [],
      required: true,
    };
  }
  // (4) optional slots only in detail mode
  if (b.meta.detail_mode) {
    for (const def of COMMON_1) {
      if (def.stage !== stage || requiredLevel(def, c) === "core") continue;
      const s = slotState(b, def.path);
      if (s !== "empty") continue;
      return { kind: "ask", path: def.path, def, text: def.ask_ko, options: opts.candidatesFor === def.path ? fallbackCandidates(def, b) : seedOptions(def), required: false };
    }
  }
  // (5) stage move / confirmation cards — a complete brief (every required field confirmed, e.g. through the form)
  // goes straight to the confirmation cards / ready: no extra "요약 확인으로 이동" round trip
  if ((stage === "diverging" || stage === "converging") && !briefComplete(b)) {
    return {
      kind: "propose_stage",
      to: "confirming",
      text: "필수 항목이 거의 정리됐습니다. 요약 확인 단계로 가서 로그라인을 고를까요?",
      options: [control("toConfirming")],
    };
  }
  const delegated = Object.entries(b.field_provenance)
    .filter(([path, p]) => p.origin === "agent_delegated" && p.slot_state === "proposed" && !isEmptyValue(getPath(c, path)))
    .map(([path]) => path);
  if (delegated.length) {
    return {
      kind: "confirm_delegated",
      paths: delegated,
      text: `에이전트가 정한 항목 ${delegated.length}개: ${delegated.map((p) => `${slotLabel(p)}="${labelOf(getPath(c, p))}"`).join(", ")}. 이대로 확정할까요? 항목별로 고칠 수도 있습니다.`,
      options: [control("confirmDelegated")],
    };
  }
  const imported = Object.entries(b.field_provenance)
    .filter(([path, p]) => p.origin === "imported" && p.slot_state === "proposed" && !isEmptyValue(getPath(c, path)))
    .map(([path]) => path);
  if (imported.length) {
    return { kind: "confirm_imported", paths: imported, text: `붙여 넣은 원문에서 뽑은 항목 ${imported.length}개를 확인해 주세요.`, options: [control("confirmImported")] };
  }
  return { kind: "ready", text: READY_TEXT, options: [control("submit")] };
}

/**
 * 설계 변경: the conversation ends when every required brief field is confirmed — the partner then closes with a
 * summary and points to [승인 요청] instead of asking a new question (final confirmation stays manual).
 */
export const READY_TEXT =
  "필수 항목이 모두 확정돼 컨셉 브리프가 완성됐습니다. 더 묻지 않겠습니다. 브리프 패널을 검토한 뒤 [승인 요청]을 눌러 컨셉을 확정해 주세요. 고칠 부분이 있으면 말씀해 주시거나 브리프 패널에서 직접 고칠 수 있습니다.";

/** brief complete: every required field confirmed (the conversation's natural end) */
export function briefComplete(b: WorkingBrief): boolean {
  return missingRequired(b).length === 0;
}

/** notice when the hidden turn safety ceiling is hit (설계 변경: 대화는 브리프 완성까지, 상한은 폭주 방지용) */
export function turnCapText(s: { turnLimit: number }, b: WorkingBrief, ready: boolean, canExtend: boolean, canDelegate = true): string {
  const missing = missingRequired(b).map(slotLabel);
  const head = `대화가 안전 상한(${s.turnLimit}턴)에 닿아 잠시 멈췄습니다.`;
  const state = missing.length
    ? `아직 확정되지 않은 필수 항목 ${missing.length}개: ${missing.join(", ")}.`
    : ready
      ? "필수 항목은 모두 확정됐으니 [승인 요청]으로 컨셉을 확정할 수 있습니다."
      : "필수 항목은 모두 확정됐지만 승인 요청 전에 해결할 항목이 있습니다(브리프 패널 확인).";
  const how = canExtend
    ? `대화를 이어 가려면 [${CONTROL.extendTurns.label}]를 누르거나, 컨셉 화면 아래 '진행 방식 바꾸기'에서 대화 안전 상한을 ${DEFAULTS["concept.turn_extension"]}턴씩 올리세요.`
    : "대화 안전 상한은 더 올릴 수 없습니다.";
  const alt = !missing.length
    ? ""
    : canDelegate
      ? " 남은 항목은 [전부 맡기기]로 추천안을 받거나(상한과 관계없이 한 번 더 실행) [폼으로 마저 입력]으로 직접 채울 수 있습니다."
      : " 남은 항목은 [폼으로 마저 입력]으로 직접 채워 주세요.";
  return `${head} ${state} ${how}${alt}`;
}

/** reserved buttons appended to an ask (R2) */
export function escapeButtons(step: NextStep): StoredOption[] {
  if (step.kind === "ready") return []; // the closing reply already carries the summary (설계 변경: 브리프 완성 = 대화 마무리)
  if (step.kind !== "ask") return [control("summary")];
  const out = [control("direct"), control("recommend")];
  if (!step.required) out.push(control("defer"));
  out.push(control("wrapUp"), control("delegateAll"), control("summary"));
  return out;
}
