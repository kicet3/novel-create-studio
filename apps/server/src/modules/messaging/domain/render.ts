/**
 * Pure rendering of channel-neutral inputs into `RenderedMessage` (05 §3.2 block order, §5.3 limits) and
 * the callback payload codec `v1|<action>|<id>|<idx>` (05 §5.3).
 */
import type { QuestionView } from "../index.js";

/** Channel-neutral rendering stored in messenger_outbox.payload (03 §3.5). */
export interface RenderedMessage {
  text: string;
  buttons: Array<Array<{ label: string; data: string }>>;
  forceReply?: boolean;
  replyToRef?: string | null;
  /** Discord split messages: parts before this index were already delivered (set by the outbox on a partial 429) */
  resumeFromPart?: number;
}

export interface ChannelCapabilities {
  maxTextChars: number;
  maxButtons: number;
  optionLabelMaxChars: number;
  callbackMaxBytes: number;
}

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  maxTextChars: 4096,
  maxButtons: 8, // question.buttons_max_options
  optionLabelMaxChars: 40, // question.option_label_max_chars
  callbackMaxBytes: 64,
};

// ── callback payload ────────────────────────────────────────────────────
export type CallbackAction = "a" | "t" | "r" | "m" | "d" | "c";
export interface CallbackPayload {
  action: CallbackAction;
  id: string;
  idx: number;
}

/** reserved idx (05 §5.3) */
export const RESERVED_IDX = {
  directInput: 900,
  recommend: 901,
  later: 902,
  summary: 903,
  wrapUp: 904,
  delegateAll: 905,
  raiseLimit: 906,
  formInput: 907,
} as const;

export function encodeCallback(p: CallbackPayload): string {
  const s = `v1|${p.action}|${p.id}|${p.idx}`;
  if (new TextEncoder().encode(s).length > TELEGRAM_CAPABILITIES.callbackMaxBytes) throw new Error(`callback payload too long: ${s.length}`);
  return s;
}

export type DecodedCallback = { ok: true; payload: CallbackPayload } | { ok: false; reason: "expired_version" | "malformed" };

export function decodeCallback(data: string | null | undefined): DecodedCallback {
  if (!data) return { ok: false, reason: "malformed" };
  const parts = data.split("|");
  if (parts[0] !== "v1") return { ok: false, reason: parts.length >= 3 ? "expired_version" : "malformed" };
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [, action, id, idxStr] = parts as [string, string, string, string];
  if (!["a", "t", "r", "m", "d", "c"].includes(action)) return { ok: false, reason: "malformed" };
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) return { ok: false, reason: "malformed" };
  if (action === "c" ? !/^cns_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) : !/^qst_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return { ok: false, reason: "malformed" };
  return { ok: true, payload: { action: action as CallbackAction, id, idx } };
}

// ── text helpers ────────────────────────────────────────────────────────
export function truncate(s: string, max: number, suffix = "…"): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

const GRADE_LABEL: Record<QuestionView["grade"], string> = { blocking: "차단형", non_blocking: "비차단형", informational: "정보성" };

/** Header line `Q-12 · 차단형 · 인물 운명 · 12화` */
export function questionHeader(v: QuestionView, topicLabel: string): string {
  return [v.displayNo, GRADE_LABEL[v.grade], topicLabel, v.targetLabel].filter(Boolean).join(" · ");
}

/** Body blocks in 05 §3.2 order. */
export function questionText(v: QuestionView, topicLabel: string, caps: ChannelCapabilities, opts: { webHint?: string } = {}): string {
  const blocks: string[] = [`**${questionHeader(v, topicLabel)}**`, `**${v.title}**`];
  if (v.body) blocks.push(v.body);
  if (v.preview.length) {
    const p = v.preview[0]!;
    blocks.push(`> ${p.label ? `${p.label}: ` : ""}${truncate(p.text.replaceAll("\n", " "), 160)}`);
    if (v.preview.length > 1) blocks.push(`(발췌 ${v.preview.length - 1}건 더 — 웹에서 보기)`);
  }
  if (v.recommendation) blocks.push(`추천: ${v.recommendation.label}${v.recommendation.rationale ? ` — ${truncate(v.recommendation.rationale, 200)}` : ""}`);
  if (v.blockingBasisLabel || v.gradeReason) blocks.push(`판정: ${GRADE_LABEL[v.grade]}${v.blockingBasisLabel ? ` (${v.blockingBasisLabel})` : ""}`);
  if (v.deadline) blocks.push(`마감 ${v.deadline.wallClock} · ${v.deadline.afterLabel}`);
  const hidden = hiddenOptionCount(v, caps);
  if (hidden > 0) blocks.push(`선택지 ${hidden}개 더 — PC의 웹 인박스에서 답하세요.`);
  blocks.push(opts.webHint ?? `웹: ${v.webUrl}`);
  return fitText(blocks.join("\n\n"), caps.maxTextChars, v.webUrl);
}

function fitText(text: string, max: number, url: string): string {
  if (text.length <= max) return text;
  const tail = `\n\n(본문이 길어 잘랐습니다. 전문: ${url})`;
  return truncate(text, max - tail.length) + tail;
}

function hiddenOptionCount(v: QuestionView, caps: ChannelCapabilities): number {
  const tooMany = v.options.length > caps.maxButtons || v.options.some((o) => o.label.length > caps.optionLabelMaxChars);
  return tooMany ? Math.max(0, v.options.length - 4) : 0;
}

/** Buttons per 05 §5.3: ≤ max → all (1–2 per row); more or long labels → top 4 + web. */
export function questionButtons(v: QuestionView, caps: ChannelCapabilities): RenderedMessage["buttons"] {
  if (v.grade === "informational") return [];
  const rows: RenderedMessage["buttons"] = [];
  const tooMany = v.options.length > caps.maxButtons || v.options.some((o) => o.label.length > caps.optionLabelMaxChars);
  const shown = tooMany ? v.options.slice(0, 4) : v.options;
  const action = (idx: number): CallbackAction => {
    if (v.questionType === "multi_choice") return "m";
    if (v.questionType === "approve_reject" && idx === 1) return "r";
    return "a";
  };
  const btns = shown.map((o) => ({
    label: truncate(`${o.isRecommended ? "★ " : ""}${o.label}`, caps.optionLabelMaxChars),
    data: encodeCallback({ action: action(Number(o.optionId)), id: v.questionId, idx: Number(o.optionId) }),
  }));
  const perRow = btns.some((b) => b.label.length > 16) ? 1 : 2;
  for (let i = 0; i < btns.length; i += perRow) rows.push(btns.slice(i, i + perRow));
  const extra: Array<{ label: string; data: string }> = [];
  if (v.questionType === "multi_choice") extra.push({ label: "선택 완료", data: encodeCallback({ action: "d", id: v.questionId, idx: 0 }) });
  if (v.allowFreeText) extra.push({ label: "직접 입력", data: encodeCallback({ action: "t", id: v.questionId, idx: RESERVED_IDX.directInput }) });
  if (extra.length) rows.push(extra);
  return rows;
}

export function renderQuestion(v: QuestionView, topicLabel: string, caps: ChannelCapabilities = TELEGRAM_CAPABILITIES): RenderedMessage {
  return { text: questionText(v, topicLabel, caps), buttons: questionButtons(v, caps) };
}

export function renderDigest(header: string, views: Array<{ view: QuestionView; topicLabel: string }>, caps: ChannelCapabilities = TELEGRAM_CAPABILITIES): RenderedMessage {
  const parts = [`**${header}**`];
  const buttons: RenderedMessage["buttons"] = [];
  views.forEach(({ view: v, topicLabel }, i) => {
    parts.push(
      [
        `${i + 1}. **${v.displayNo} ${v.title}** (${topicLabel})`,
        v.recommendation ? `추천: ${v.recommendation.label}` : null,
        v.deadline ? `마감 ${v.deadline.wallClock} · ${v.deadline.afterLabel}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const row = questionButtons(v, { ...caps, maxButtons: 4 }).flat();
    // one row per question: prefix labels with the item number
    buttons.push(row.slice(0, 5).map((b) => ({ ...b, label: truncate(`${i + 1}) ${b.label}`, caps.optionLabelMaxChars) })));
  });
  return { text: fitText(parts.join("\n\n"), caps.maxTextChars, views[0]?.view.webUrl ?? ""), buttons };
}

export function renderNotice(text: string, buttons: Array<{ label: string; data: string }> = [], forceReply = false, caps: ChannelCapabilities = TELEGRAM_CAPABILITIES): RenderedMessage {
  const rows: RenderedMessage["buttons"] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2).map((b) => ({ ...b, label: truncate(b.label, caps.optionLabelMaxChars) })));
  return { text: truncate(text, caps.maxTextChars), buttons: forceReply ? [] : rows, forceReply };
}

/** 05 §6.4 MVP-α "컨셉 고치기" keyword detection (deterministic; false positives only produce guidance). */
export function looksLikeConceptChangeRequest(text: string): boolean {
  return text.includes("컨셉") && /(고치|바꾸|바꿔|수정)/.test(text);
}

export const HELP_TEXT =
  "사용법\n- 질문 메시지의 버튼을 눌러 답하세요.\n- 서술형 답은 [직접 입력]을 누른 뒤 답장으로 보내세요.\n- 질문 메시지에 답장하면 그 질문의 답으로 받습니다.\n전체 질문은 PC의 웹 인박스에서 볼 수 있습니다.";

export const CONCEPT_CHANGE_GUIDANCE =
  "연재 중 컨셉 개정은 다음 버전에서 제공합니다. 지금은 기획서 수정·캐논 변경·결말 변경으로 바꿀 수 있습니다. (PC 웹: 작품 설정 › 기획서)";
