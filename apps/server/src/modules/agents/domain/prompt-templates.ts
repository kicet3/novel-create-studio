/**
 * Versioned Korean prompt templates `<role>.<task_kind>@<semver>` (04 §2.2, 03 runs.prompt_template_version).
 * Pure data + a deterministic renderer. Handlers pick a template id, pass `vars` and the ContextPack.
 *
 * Rendering (stable prefix first for prompt caching, 04 §9.5):
 *   system   = ContextPack.system + "## 이번 작업" + instruction (+ output notes)
 *   messages = ContextPack.messages + one user message with the task variables
 * Special vars: `manuscript` (string → wrapped in <manuscript>…</manuscript>), `targetChars`
 * ({min,max} → "목표 분량: min~max자(공백 포함|공백 제외 — `countBasis` var)"), `userMessage` (quoted as the author's words).
 * `{{name}}` placeholders in the instruction are replaced by the var value when present.
 */
import { LABELS_KO, type AgentRole, type TaskKind } from "@ncs/shared";
import type { ContextPack, PromptTemplate } from "../index.js";

export const TEMPLATE_VERSION = "0.1.0";

export interface PromptTemplateData {
  role: AgentRole;
  kind: TaskKind;
  version: string;
  instruction: string;
  /** extra output notes (format reminders); the JSON Schema itself is sent by the provider adapter */
  output?: string;
}

const JSON_NOTE = "응답은 지정된 JSON 스키마를 정확히 따르는 객체 하나만 출력합니다. 설명 문장이나 코드 블록 표시는 붙이지 않습니다.";
const HANDLE_NOTE = "엔티티는 이름 대신 컨텍스트의 핸들(E1, E2 …)로 가리킵니다. 목록에 없는 대상은 {\"new\": \"표기\"} 형태로 냅니다.";

const T = (role: AgentRole, kind: TaskKind, instruction: string, output: string = JSON_NOTE): PromptTemplateData => ({ role, kind, version: TEMPLATE_VERSION, instruction, output });

const DRAFT_RULES = [
  "- 분량은 아래 목표 분량 이상으로 씁니다. 최소 분량 미만으로 끝내지 않습니다(한 화 절대 하한 3,000자).",
  "- 모바일 가독성: 1~3문장 문단, 대사는 따로 줄을 바꿉니다.",
  "- 아웃라인의 비트와 씬 순서를 지키고, 배정된 떡밥 비트를 자연스럽게 넣습니다.",
  "- 마지막 문단은 다음 화가 궁금해지는 훅으로 끝냅니다.",
  "- '서술·대사에 쓰면 안 되는 표기' 목록의 이름은 쓰지 않습니다. 엔티티 핸들(E1 등)은 본문에 쓰지 않습니다.",
  "- 작품 연령 등급을 넘는 묘사는 쓰지 않습니다.",
].join("\n");

export const PROMPT_TEMPLATE_DATA: readonly PromptTemplateData[] = [
  // ── concept (11 §2) ──
  T(
    "concept_partner",
    "concept_turn",
    [
      "작가와의 컨셉 대화에서 다음 한 턴의 응답을 만듭니다.",
      "- 작가의 마지막 메시지를 읽고 의도(위임·답변·수정·기타)를 판단합니다.",
      "- 작가가 직접 말한 내용만 user_stated로 슬롯을 갱신하고, 근거 인용(evidence_quote)은 작가 메시지 원문 그대로 씁니다.",
      "- 이번에 물을 슬롯은 컨텍스트의 '다음 질문 후보'를 따르고, 질문은 하나만 합니다. 선택지는 3개 이내로 제안합니다.",
      "- 기존 작품의 고유명·고유 설정을 베끼자는 요청이면 트로프 수준의 대안을 제안합니다.",
    ].join("\n"),
  ),
  T(
    "concept_partner",
    "import_concept",
    "작가가 붙여 넣은 기존 기획 텍스트에서 컨셉 브리프 슬롯을 채웁니다. 원문에 있는 내용만 user_stated로 옮기고, 원문 인용을 근거로 남깁니다. 빠진 슬롯은 비워 두고 다음 질문 후보로 표시합니다.",
  ),
  T(
    "continuity_editor",
    "check_concept_brief",
    "승인 요청 전의 컨셉 브리프를 점검합니다. 슬롯 사이의 모순, 연령 등급과 맞지 않는 요소, 결말 방향과 로그라인의 불일치, 실존 인물·기존 작품 복제 위험을 찾아 보고합니다. 브리프 내용을 고치지 않고 지적만 합니다.",
  ),
  // ── planning (07 §2) ──
  T(
    "planner",
    "plan_series_bible",
    "승인된 컨셉 브리프와 목표(총 화수, 연재 주기, 결말 방향)를 바탕으로 연재 기획서를 씁니다. 로그라인, 세계관 규칙, 주요 인물(목표·비밀·관계), 아크 구성(화 범위), 결말 방향, 셀링 포인트를 포함합니다. 브리프에 없는 고유 설정은 제안으로 표시합니다.",
  ),
  T(
    "planner",
    "plan_structure",
    "승인된 기획서와 확정 캐스트를 바탕으로 전체 구성(1~4부와 결말)을 설계합니다. 결말을 먼저 정하고 각 부가 결말로 가는 단계가 되게 합니다. 부마다 제목·목표·전환점·화 범위·부 끝 인물 상태·플롯(큰 사건) 목록을 정하고, 인물은 캐스트 id로만 가리킵니다.",
  ),
  T(
    "planner",
    "plan_arc",
    "승인된 기획서를 바탕으로 이번 아크를 설계합니다. 아크 목표, 클라이맥스, 화별 요약과 훅을 정하고, 아크의 화 범위를 지킵니다. 앞 아크에서 남은 떡밥과 사용자 답변 제약을 반영합니다.",
  ),
  T(
    "showrunner",
    "schedule_episodes",
    "목표의 연재 주기와 예약 분량 목표에 맞춰 다음에 진행할 화의 순서와 우선순위를 정합니다. 결정적 규칙으로 충분하면 그 결과를 그대로 확인합니다.",
  ),
  T(
    "planner",
    "outline_episode",
    [
      "{{episodeLabel}}의 아웃라인을 만듭니다.",
      "- 비트 5~8개, 씬 3~5개(장소·시점 인물·등장 엔티티 핸들·씬 목표)를 정합니다.",
      "- 배정된 떡밥 비트와 답변 제약을 반드시 반영합니다.",
      "- 회차 끝 훅(cliffhanger)을 한 문장으로 적습니다.",
      `- ${HANDLE_NOTE}`,
    ].join("\n"),
  ),
  T("writer", "draft_episode", `아웃라인을 바탕으로 {{episodeLabel}}의 본문 초고를 씁니다.\n${DRAFT_RULES}`, "본문만 출력합니다. 제목·메모·설명은 붙이지 않습니다."),
  T(
    "writer",
    "revise_episode",
    `지적 사항(연속성 이슈·반려 사유·수정 지시)을 반영해 {{episodeLabel}}의 본문을 고쳐 씁니다. 지적과 무관한 부분과 사람이 쓴 구간은 그대로 둡니다.\n${DRAFT_RULES}`,
    "고친 본문 전체만 출력합니다.",
  ),
  T(
    "line_editor",
    "revise_episode",
    `지적 사항을 반영해 {{episodeLabel}}의 본문을 고칩니다. 사실 관계는 지적된 부분만 바꿉니다.\n${DRAFT_RULES}`,
    "고친 본문 전체만 출력합니다.",
  ),
  T(
    "line_editor",
    "polish_episode",
    `검사를 통과한 {{episodeLabel}} 원고의 문장·리듬·분량·훅을 다듬습니다. 사건·사실·인물 지식은 바꾸지 않습니다.\n${DRAFT_RULES}`,
    "다듬은 본문 전체만 출력합니다.",
  ),
  T(
    "writer",
    "polish_episode",
    `검사를 통과한 {{episodeLabel}} 원고의 문장과 분량을 다듬습니다. 사건·사실은 바꾸지 않습니다.\n${DRAFT_RULES}`,
    "다듬은 본문 전체만 출력합니다.",
  ),
  T(
    "showrunner",
    "plan_rework",
    "반려·수정 요청의 사유를 읽고 어디서부터 다시 할지(아웃라인/초고/다듬기)와 구체적인 수정 지시를 정합니다. 사용자의 표현을 지시에 그대로 살립니다.",
  ),
  T(
    "continuity_editor",
    "check_text_safety",
    "원고가 작품 연령 등급과 안전 기준(미성년자 성적 묘사 금지, 실존 인물 비방 금지 등)을 지키는지 검사합니다. 문제 구간은 원문 인용과 함께 보고하고, 문제가 없으면 빈 목록을 냅니다.",
  ),
  // ── ontology / linking (06, 07 §4) ──
  T(
    "world_keeper",
    "build_initial_ontology",
    `승인된 기획서에서 초기 엔티티(인물·장소·조직·물건·규칙)와 사실(관계·속성·규칙)을 추출합니다. 기획서에 적힌 내용만 씁니다. ${HANDLE_NOTE}`,
  ),
  T(
    "world_keeper",
    "build_world_ontology",
    "승인된 컨셉 브리프(있으면 캐스트·기존 세계관 항목 포함)를 바탕으로 세계관 전체 온톨로지 후보를 만듭니다. 세력·조직, 장소·지리, 체계·능력 규칙(등급·대가·한계), 핵심 물건·개념, 역사·과거 사건, 항목 사이의 관계, 반드시 지켜야 할 규칙을 냅니다. 브리프와 모순되는 설정을 만들지 않고, 브리프에 없는 설정은 브리프와 어울리는 제안으로만 냅니다. 이미 있는 항목(승인·사용자 작성)은 다시 만들지 않고 key로만 가리킵니다.",
  ),
  T(
    "world_keeper",
    "split_scenes",
    "<manuscript> 안의 원고를 씬으로 나눕니다. 각 씬의 시작·끝 문자 위치(0부터, 끝은 포함하지 않음), 장소, 시점 인물 핸들, 등장 엔티티 핸들, 한 줄 요약을 냅니다. 씬은 원고 전체를 빈틈없이 덮어야 합니다.",
  ),
  T(
    "world_keeper",
    "extract_facts",
    `<manuscript> 안의 원고에서 새로 드러난 사실(관계·상태·사건·인물 지식)과 엔티티 언급을 추출합니다. 각 사실에는 근거가 되는 원문 인용을 붙이고, 인용은 원고에 있는 문자열 그대로 씁니다. ${HANDLE_NOTE}`,
  ),
  T(
    "world_keeper",
    "link_mentions",
    "모호한 언급마다 후보 카드 중 어느 엔티티를 가리키는지 판별합니다. 확신이 낮으면 ambiguous로, 후보에 없으면 new_entity_candidate로 냅니다. 판단 근거를 짧게 적습니다.",
  ),
  T(
    "world_keeper",
    "dedupe_entities",
    "엔티티 카드 목록에서 같은 대상을 가리키는 중복 후보 쌍을 찾습니다. 이름이 비슷해도 설정이 다르면 중복이 아닙니다. 근거를 함께 냅니다.",
  ),
  T(
    "world_keeper",
    "interpret_answer",
    "질문과 사용자의 서술형 답변을 읽고, 작품에 반영할 해석(제약·결정)을 구조화합니다. 해석이 불확실하면 확인이 필요하다고 표시합니다.",
  ),
  T(
    "world_keeper",
    "apply_answer",
    "확정된 답변 해석을 캐논 사실·제약과 후속 작업 지시로 옮깁니다. 답변에 없는 내용은 추가하지 않습니다.",
  ),
  T(
    "showrunner",
    "grade_question",
    "질문 초안의 등급(blocking/non_blocking/informational)을 판정합니다. 진행을 멈춰야만 하는 결정만 blocking으로 판정하고, 기본값으로 진행할 수 있으면 non_blocking으로 판정합니다.",
  ),
  // ── continuity / foreshadow ──
  T(
    "continuity_editor",
    "check_continuity",
    "원고를 컨텍스트의 캐논 사실·제약·인물 지식과 대조해 모순(외모·나이·관계·능력 규칙·이동 시간·생사·인물 지식·정체 누설)을 찾습니다. 각 이슈에 심각도, 원문 인용, 근거 사실 핸들, 수정 제안을 붙입니다. 모순이 없으면 빈 목록을 냅니다.",
  ),
  T(
    "foreshadow_manager",
    "plan_setups",
    "이번 아크에 둘 떡밥(설치·암시·회수)을 계획합니다. 떡밥마다 중요도, 설치 화, 회수 화(또는 기한), 관련 엔티티 핸들을 정하고, 아크 범위를 넘는 회수는 기한으로 표시합니다.",
  ),
  T(
    "foreshadow_manager",
    "check_setups",
    "<manuscript> 안의 원고에서 이번 화에 배정된 떡밥 비트가 실제로 나왔는지 확인합니다. 나온 비트는 원문 인용을, 빠진 비트는 missing으로 표시합니다.",
  ),
  T(
    "foreshadow_manager",
    "review_setup_due",
    "기한이 다가온 떡밥의 처리 방안(회수 계획, 기한 연장, 포기 제안)을 정하고 이유를 적습니다. 포기는 제안만 하고 확정하지 않습니다.",
  ),
];

export function templateId(role: AgentRole, kind: TaskKind, version = TEMPLATE_VERSION): string {
  return `${role}.${kind}@${version}`;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** deterministic render of task variables into the final user message */
export function renderVars(vars: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null || k === "episodeLabel" || k === "countBasis") continue;
    if (k === "manuscript") parts.push(`<manuscript>\n${String(v)}\n</manuscript>`);
    else if (k === "targetChars" && typeof v === "object") {
      const t = v as { min?: number; max?: number };
      const basis = vars.countBasis === "without_spaces" ? "공백 제외" : "공백 포함";
      parts.push(`목표 분량: ${t.min ?? "?"}~${t.max ?? "?"}자(${basis})`);
    } else if (k === "userMessage") parts.push(`### 작가의 메시지\n"""\n${String(v)}\n"""`);
    else parts.push(`### ${k}\n${stringify(v)}`);
  }
  return parts.join("\n\n") || "위 컨텍스트로 작업을 수행하세요.";
}

export function fillPlaceholders(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v !== undefined && v !== null) return String(v);
    if (k === "episodeLabel") return typeof vars.episodeNo === "number" ? `제${vars.episodeNo}화` : "이번 화";
    return "";
  });
}

export function buildTemplate(d: PromptTemplateData): PromptTemplate<Record<string, unknown>> & { instruction: string } {
  const kindLabel = (LABELS_KO.task_kind as Record<string, string>)[d.kind] ?? d.kind;
  return {
    id: templateId(d.role, d.kind, d.version),
    role: d.role,
    kind: d.kind,
    version: d.version,
    instruction: d.instruction,
    render(vars: Record<string, unknown>, context: ContextPack) {
      const system = [context.system, `## 이번 작업: ${kindLabel}`, fillPlaceholders(d.instruction, vars), d.output ? `## 출력\n${d.output}` : ""].filter(Boolean).join("\n\n");
      return { system, messages: [...context.messages, { role: "user" as const, content: renderVars(vars) }] };
    },
  };
}
