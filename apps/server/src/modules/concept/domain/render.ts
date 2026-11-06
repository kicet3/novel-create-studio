/** ConceptBrief → content_md (사람용) and approval-question body (design/11 §5.4, §4.2 승인 요약). Pure. */
import { labelKo } from "@ncs/shared";
import { getPath, valueToText, type WorkingBrief } from "./brief.js";
import { COMMON_1, slotLabel } from "./question-set.js";

export function renderBriefMarkdown(b: WorkingBrief, title: string): string {
  const lines = [`# 컨셉 브리프 — ${title}`, ""];
  for (const def of COMMON_1) {
    const v = getPath(b.content, def.path);
    const text = valueToText(v);
    if (!text) continue;
    const p = b.field_provenance[def.path];
    const badge = p ? ` _(${labelKo("concept_field_origin", p.origin)} · ${labelKo("concept_slot_state", p.slot_state)})_` : "";
    lines.push(`- **${def.label}**: ${def.path === "age_rating" ? labelKo("age_rating", String(v)) : text}${badge}`);
  }
  const oq = b.content.open_questions ?? [];
  if (oq.length) lines.push("", "## 미결 항목", ...oq.map((q) => `- ${slotLabel(q.field_path)}: ${q.note}`));
  if ((b.content.source_documents ?? []).length) lines.push("", `원문 ${b.content.source_documents!.length}건 첨부`);
  lines.push("", "_유사성 점검은 법적 판단이 아닙니다._");
  return lines.join("\n");
}

/** short messenger/approval summary of the required fields (concept.messenger_summary_max_chars) */
export function renderApprovalSummary(b: WorkingBrief, maxChars: number): string {
  const c = b.content;
  const rows: Array<[string, unknown]> = [
    ["장르", c.category?.genre_label],
    ["연령 등급", c.age_rating ? labelKo("age_rating", c.age_rating) : undefined],
    ["로그라인", c.logline],
    ["주인공", c.protagonist?.starting_condition],
    ["욕망", c.protagonist?.desire],
    ["대립", c.opposition],
    ["핵심 훅", c.core_hook],
    ["결말 방향", c.ending_direction],
  ];
  const text = rows
    .filter(([, v]) => valueToText(v))
    .map(([k, v]) => `**${k}**: ${valueToText(v)}`)
    .join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
