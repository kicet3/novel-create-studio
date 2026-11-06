/**
 * Prompt templates of the concept tasks (design/11 §2.6 context sections S1–S6, §2.7 output contract).
 * Defined locally (agents owns the registry; we also register them there when it is available).
 * Context is structured state, not the full transcript (2.6).
 */
import { valueToText, getPath, type WorkingBrief } from "../domain/brief.js";
import { COMMON_1, requiredLevel } from "../domain/question-set.js";
import type { NextStep } from "../domain/next-question.js";
import type { TurnMessage } from "../domain/turn.js";
import type { LlmMessage } from "../../llm/index.js";

export const TURN_TEMPLATE_ID = "concept_partner.concept_turn@0.1.0";
export const IMPORT_TEMPLATE_ID = "concept_partner.import_concept@0.1.0";
export const CHECK_TEMPLATE_ID = "continuity_editor.check_concept_brief@0.1.0";
/** "다른 추천 받기" (concept_turn with input.titles=true) */
export const TITLES_TEMPLATE_ID = "concept_partner.suggest_titles@0.1.0";

const TITLE_STYLE = "웹소설 플랫폼식 제목(대개 4~25자, 필요하면 문장형), 따옴표 없이, 기존 작품 제목 그대로 쓰기 금지";

const ROLE_RULES = [
  "당신은 한국 웹소설 작가의 컨셉 파트너(concept_partner)입니다. 사용자의 씨앗 아이디어를 존중하고, 결정은 사용자가 합니다.",
  "규칙: 한 턴에 질문 1개(같은 슬롯 묶음이면 최대 2개). 질문은 120자 이내 존댓말 평서문/의문문.",
  "사용자가 말하지 않은 슬롯은 채우지 않습니다(비추측). 사용자 발화로 채운 값에는 evidence_message_id, 원문 그대로의 evidence_quote, 새 값의 핵심 명사구 key_phrase를 붙입니다.",
  "사용자가 정한 값(user_stated, user_edited)은 바꾸지 말고 change_proposals로 제안만 합니다.",
  "후보는 최대 3개, 서로 다른 축으로 내고, 각 후보에 한 줄 근거와 위험 1개를 붙입니다. 흔한 선택이면 is_common_choice=true.",
  "수렴 단계에서는 weakness_notes(연재 지속성·훅·대립 강도 약점)를 먼저 1~2개 냅니다. 칭찬만 하지 않습니다.",
  "기존 작품의 인물명·고유 기술명·고유 지명·고유 조직명과 고유 설정을 제안하지 않습니다. 사용자가 특정 작품을 그대로 따라 하자고 하면 copy_request_detected를 채우고 트로프 수준 대안을 냅니다.",
  "연령 등급 상한(미정이면 15세)을 넘는 소재, 미성년 인물의 성적 맥락, 실존 인물의 지어낸 행동은 safety_flags로 표시합니다.",
  "묻는 슬롯은 코드가 정한 '다음 질문 대상'을 그대로 따릅니다(questions[0].slot_key).",
  `working_title: 지금까지 대화에 나온 장르·주인공·핵심 훅을 반영한 작품 가제 1개를 냅니다. ${TITLE_STYLE}. 대화가 진행되면 더 나은 가제로 바꿔도 됩니다. 판단할 내용이 거의 없거나 '작품 제목' 줄이 '확정'이면 null.`,
  `title_suggestions: 장르·주인공·핵심 훅 중 하나라도 정해졌으면 사용자가 고를 추천 제목 3~5개를 서로 다른 느낌(직설형·문장형·키워드형 등)으로 내고, 각 제목에 한 줄 이유(reason)를 붙입니다. ${TITLE_STYLE}. 내용이 거의 없거나, '현재 추천 제목'이 지금 대화와 여전히 맞거나, '작품 제목' 줄이 '확정'이면 빈 배열.`,
].join("\n");

function briefSection(b: WorkingBrief): string {
  const rows = COMMON_1.map((d) => {
    const p = b.field_provenance[d.path];
    const v = valueToText(getPath(b.content, d.path));
    return `- ${d.path} (${d.label}, ${requiredLevel(d, b.content)}): ${v || "(비어 있음)"} [${p?.slot_state ?? "empty"}${p ? `/${p.origin}` : ""}]`;
  });
  return rows.join("\n");
}

export interface TurnPromptInput {
  brief: WorkingBrief;
  /** current novel title and whether the user fixed it (user → the model must return working_title=null) */
  novelTitle?: { title: string; source: "provisional" | "auto" | "user" };
  /** titles already suggested in this session */
  titleSuggestions?: ReadonlyArray<{ title: string }>;
  stage: string;
  next: NextStep;
  recent: TurnMessage[];
  newMessages: TurnMessage[];
  ageCeiling: string;
  maxReplyChars: number;
}

export function renderTurnPrompt(i: TurnPromptInput): { system: string; messages: LlmMessage[] } {
  const nextPath = "path" in i.next ? i.next.path : null;
  const def = nextPath ? COMMON_1.find((d) => d.path === nextPath) : null;
  const s6 = [
    `연령 등급 상한: ${i.ageCeiling}`,
    i.brief.checks.similarity.copy_requests.length ? `복제 요청 기록: ${i.brief.checks.similarity.copy_requests.map((c) => c.work_title).join(", ")}` : "",
    (i.brief.content.avoid_list ?? []).length ? `회피 요소: ${i.brief.content.avoid_list!.map((a) => a.statement).join(", ")}` : "",
    i.brief.checks.safety.age_rating_flags.length ? `등급 초과 신호: ${i.brief.checks.safety.age_rating_flags.map((f) => f.keyword).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const system = [
    ROLE_RULES,
    `현재 단계: ${i.stage}`,
    "## S1 작업 중 브리프",
    briefSection(i.brief),
    i.novelTitle
      ? `- 작품 제목: ${i.novelTitle.title} [${i.novelTitle.source === "user" ? "확정(사용자)" : i.novelTitle.source === "auto" ? "가제(자동)" : "임시"}]`
      : "",
    i.titleSuggestions?.length ? `- 현재 추천 제목: ${i.titleSuggestions.map((x) => x.title).join(" / ")}` : "",
    "## S2 다음 질문 대상(코드 결정)",
    nextPath ? `${nextPath}${def ? ` — 씨앗 질문: ${def.ask_ko}` : ""}` : `${i.next.kind}: ${i.next.text}`,
    def?.option_seeds.length ? `## S5 선택지 씨앗\n${def.option_seeds.map((o) => `- ${o.label} (${o.value})`).join("\n")}` : "",
    "## S4 씨앗 원문",
    (i.brief.content.seed_notes ?? "(없음)").slice(0, 4000),
    "## S6 금지 목록·상한",
    s6 || "(없음)",
    `reply_text는 ${i.maxReplyChars}자 이내. 출력은 ConceptTurnProposal JSON입니다.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const transcript = i.recent
    .map((m) => `[${m.authorKind}${m.authorKind === "user" ? ` id=${m.id}` : ""}] ${m.body}`)
    .join("\n");
  const fresh = i.newMessages.map((m) => `- id=${m.id} (${m.kind}): ${m.body}`).join("\n");
  return {
    system,
    messages: [{ role: "user", content: `## S3 최근 대화\n${transcript || "(없음)"}\n\n## 이번에 처리할 사용자 메시지\n${fresh || "(없음)"}` }],
  };
}

export interface TitlesPromptInput {
  brief: WorkingBrief;
  novelTitle: { title: string; source: "provisional" | "auto" | "user" };
  /** previous suggestions (the new set must not repeat them) */
  previous: ReadonlyArray<{ title: string }>;
  recent: TurnMessage[];
}

/** "다른 추천 받기": a fresh set of 3–5 titles, different from the previous set. */
export function renderTitlesPrompt(i: TitlesPromptInput): { system: string; messages: LlmMessage[] } {
  const system = [
    "당신은 한국 웹소설 작가의 컨셉 파트너(concept_partner)입니다. 지금까지 정한 컨셉으로 작품 제목 후보를 추천합니다. 결정은 사용자가 합니다.",
    `규칙: 추천 제목 3~5개를 suggestions로 냅니다. 서로 다른 느낌(직설형·문장형·키워드형·분위기형 등)으로, 각 제목에 왜 어울리는지 한 줄 이유(reason, 80자 이내)를 붙입니다. ${TITLE_STYLE}.`,
    "브리프에 없는 설정(새 인물 이름·고유 지명 등)을 만들어 넣지 않습니다. 기존 작품의 고유 제목·고유명사를 쓰지 않습니다.",
    i.previous.length ? `이전에 추천한 제목과 겹치거나 거의 같은 제목은 내지 않습니다: ${i.previous.map((x) => x.title).join(" / ")}` : "",
    "## 작업 중 브리프",
    briefSection(i.brief),
    `- 지금 작품 제목: ${i.novelTitle.title} [${i.novelTitle.source === "user" ? "확정(사용자)" : i.novelTitle.source === "auto" ? "가제(자동)" : "임시"}]`,
    "## 씨앗 원문",
    (i.brief.content.seed_notes ?? "(없음)").slice(0, 4000),
    "출력은 TitleSuggestions JSON입니다.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const transcript = i.recent.map((m) => `[${m.authorKind}] ${m.body}`).join("\n");
  return { system, messages: [{ role: "user", content: `## 최근 대화\n${transcript || "(없음)"}\n\n다른 제목 추천을 부탁합니다.` }] };
}

export function renderImportPrompt(b: WorkingBrief, text: string): { system: string; messages: LlmMessage[] } {
  return {
    system: [
      "당신은 컨셉 파트너입니다. 사용자가 붙여 넣은 시놉시스·메모에서 브리프 필드만 뽑습니다. 원문에 없는 값은 만들지 않습니다. 사실 후보는 만들지 않습니다.",
      "가능한 field_path:",
      COMMON_1.map((d) => `- ${d.path} (${d.label})`).join("\n"),
      `현재 브리프:\n${briefSection(b)}`,
    ].join("\n\n"),
    messages: [{ role: "user", content: text }],
  };
}

export function renderCheckPrompt(b: WorkingBrief): { system: string; messages: LlmMessage[] } {
  return {
    system:
      [
        "당신은 연속성 편집자(continuity_editor)입니다. 컨셉 브리프를 점검해 (1) 알려진 작품과 겹치는 요소(llm_overlap_signals, 검증되지 않은 신호), (2) 연령 등급 초과·미성년 성적 맥락·실존 인물 위험(safety_flags)을 냅니다. 브리프를 고치지 않습니다.",
        "real_person은 브리프에 실제로 존재하는(존재했던) 사람 — 연예인·정치인·운동선수 등 공인이나 특정 가능한 실존 인물 — 이 이름으로 등장할 때만 냅니다. 이 작품을 위해 지어낸 가상 인물은 실존 인물이 아닙니다. real_person을 낼 때는 name에 브리프에 적힌 그 사람 이름을 그대로 적습니다.",
        "위험이 없으면 safety_flags는 빈 배열입니다.",
      ].join("\n"),
    messages: [{ role: "user", content: briefSection(b) }],
  };
}
