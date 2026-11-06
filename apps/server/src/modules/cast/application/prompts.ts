/**
 * Prompts + output schemas of the cast task kinds:
 *  - `draft_cast` (concept_partner.draft_cast@0.1.0): cast draft from the approved brief + current cast
 *  - `draft_design_sheet` (world_keeper.draft_design_sheet@0.1.0): visual spec from a character profile
 */
import { z } from "zod";
import { CHARACTER_ROLE, labelKo } from "@ncs/shared";
import type { DesignSheetSpec } from "@ncs/shared";
import type { Character } from "../index.js";

export const DRAFT_CAST_TEMPLATE_ID = "concept_partner.draft_cast@0.1.0";
export const DRAFT_SHEET_TEMPLATE_ID = "world_keeper.draft_design_sheet@0.1.0";

export const castDraftProposalSchema = z.object({
  characters: z
    .array(
      z.object({
        /** id of an existing character this entry refines; "" = new character */
        existing_id: z.string(),
        role: z.enum(CHARACTER_ROLE),
        name: z.string(),
        aliases: z.array(z.string()),
        age: z.string(),
        gender: z.string(),
        personality: z.string(),
        background: z.string(),
        desire: z.string(),
        weakness: z.string(),
        notes: z.string(),
        /** 0008 required fields (lenient: older drafts without them stay valid) */
        appearance: z.string().default(""),
        motivation: z.string().default(""),
        speech_sample: z.string().default(""),
        arc_start: z.string().default(""),
        arc_end: z.string().default(""),
        story_role: z.string().default(""),
        relationships: z.array(z.object({ target_name: z.string(), kind: z.string(), description: z.string() })),
      }),
    )
    .max(16),
});
export type CastDraftProposal = z.infer<typeof castDraftProposalSchema>;

export const sheetDraftProposalSchema = z.object({
  face: z.string(),
  hair: z.string(),
  eyes: z.string(),
  build: z.string(),
  height: z.string(),
  outfits: z.array(z.object({ name: z.string(), description: z.string() })).max(4),
  color_palette: z.array(z.object({ name: z.string(), hex: z.string() })).max(8),
  distinguishing_marks: z.string(),
  art_style: z.string(),
  avoid: z.string(),
});
export type SheetDraftProposal = z.infer<typeof sheetDraftProposalSchema>;

const CAST_SYSTEM = `당신은 웹소설 공동 기획자(concept_partner)입니다. 승인된 컨셉 브리프(스토리라인)를 바탕으로 등장인물 초안을 JSON으로 제안합니다.
- 주인공은 정확히 1명(role=protagonist)입니다. 이미 있는 주인공은 existing_id로 가리키고 이름을 바꾸지 않습니다.
- 서브 주인공(sub_protagonist)은 요청한 수만큼, 수가 없으면 이야기에 필요한 만큼(0명도 가능) 제안합니다.
- 적대자(antagonist)와 조연(supporting)은 이야기에 필요할 때만 제안합니다.
- 이미 있는 캐릭터를 보완할 때는 existing_id에 그 ID를 넣습니다. 새 캐릭터는 existing_id를 ""로 둡니다.
- "사용자 확정" 표시가 있는 항목은 사용자가 정한 값입니다. 바꾸지 말고 빈 문자열로 두세요.
- 성격(장점과 결점)·욕망(목표)·동기·약점(두려움)은 각 2~4문장, 배경(핵심 과거사)은 2~3줄, 말투 예시(speech_sample)는 그 인물이 실제로 할 대사 1~2줄, 외형(appearance)은 1~2문장, 변화 아크는 시작(arc_start)과 끝(arc_end) 상태를 한 문장씩 한국어로 씁니다.
- 조연·적대자는 story_role(이야기 속 역할)과 욕망(목표), 주인공과의 관계를 반드시 채웁니다.
- 관계는 다른 캐릭터 이름(target_name)과 관계 이름(kind)으로 적습니다.
- "빈 필수 항목 채우기" 요청이 있으면 그 인물들만 existing_id로 가리키고, 목록의 빈 항목만 채우며 나머지는 빈 문자열로 둡니다. 새 인물은 만들지 않습니다.
- 그 목록에 "이름(name)"이 있으면 이름이 "이름 미정"인 인물입니다. 장르와 세계관에 맞는 새 이름을 지어 name에 넣습니다(다른 인물과 겹치지 않게). 이 경우에만 이미 있는 인물의 이름을 정합니다.
- 연령 등급을 넘는 설정은 넣지 않습니다. 실존 인물·기존 작품 캐릭터를 베끼지 않습니다.`;

function characterLine(c: Character): string {
  const userFields = Object.entries(c.fieldOrigins ?? {})
    .filter(([, o]) => o === "user")
    .map(([k]) => k);
  return JSON.stringify({
    id: c.id,
    role: c.role,
    role_label: labelKo("character_role", c.role),
    status: c.status,
    name: c.name,
    aliases: c.aliases,
    age: c.age,
    gender: c.gender,
    personality: c.personality,
    background: c.background,
    desire: c.desire,
    weakness: c.weakness,
    notes: c.notes,
    appearance: c.appearance,
    motivation: c.motivation,
    speech_sample: c.speechSample,
    arc_start: c.arcStart,
    arc_end: c.arcEnd,
    story_role: c.storyRole,
    relationships: (c.relationships ?? []).map((r) => ({ target_id: r.targetCharacterId, kind: r.kind })),
    사용자_확정: userFields,
  });
}

export function renderCastDraftPrompt(v: {
  novel: { title: string; genre: string | null; ageRating: string };
  brief: unknown;
  /** 설계 추가(world): approved world ontology + candidates flagged 미확정 (empty = none yet) */
  world?: string;
  cast: Character[];
  request: { subProtagonistCount?: number; includeAntagonist: boolean; instructions?: string; fillMissing?: Array<{ id: string; name: string; fields: string[] }> };
}): { system: string; messages: Array<{ role: "user"; content: string }> } {
  const fill = v.request.fillMissing;
  const want = fill
    ? [
        "# 빈 필수 항목 채우기 — 아래 인물의 빈 항목만 채우세요. 이미 값이 있는 항목과 새 인물은 만들지 않습니다.",
        ...fill.map((f) => `- ${f.name} (existing_id: ${f.id}): ${f.fields.join(", ")}`),
        v.request.instructions ? `추가 요청: ${v.request.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : [
    v.request.subProtagonistCount !== undefined ? `서브 주인공 수: ${v.request.subProtagonistCount}명(이미 있는 서브 주인공 포함)` : "서브 주인공 수: 이야기에 맞게",
    v.request.includeAntagonist ? "적대자: 필요하면 제안" : "적대자: 제안하지 않음",
    v.request.instructions ? `추가 요청: ${v.request.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    system: CAST_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `# 작품\n제목: ${v.novel.title}\n장르: ${v.novel.genre ?? "미정"}\n연령 등급: ${labelKo("age_rating", v.novel.ageRating)}`,
          `# 승인된 컨셉 브리프\n${JSON.stringify(v.brief ?? {})}`,
          ...(v.world?.trim() ? [`# 세계관 온톨로지 (인물의 소속·능력·배경은 승인된 설정을 따르고, [미확정 후보]는 참고만)\n${v.world.trim()}`] : []),
          `# 지금 캐스트 (${v.cast.length}명)\n${v.cast.map(characterLine).join("\n") || "(없음)"}`,
          `# 요청\n${want}`,
        ].join("\n\n"),
      },
    ],
  };
}

const SHEET_SYSTEM = `당신은 웹소설 세계관 관리자(world_keeper)입니다. 캐릭터 프로필을 읽고 이미지 생성에 쓸 캐릭터 디자인 시트(외형 스펙)를 JSON으로 씁니다.
- face(얼굴형·인상), hair(색·길이·스타일), eyes(색·모양), build(체형), height(키, 예: "172cm")를 구체적으로 씁니다.
- outfits는 대표 의상 1~3벌(name, description), color_palette는 3~6색(name, hex "#RRGGBB")입니다.
- distinguishing_marks는 흉터·점·장신구처럼 매번 그려야 하는 특징, art_style은 그림체 지시, avoid는 그리면 안 되는 것입니다.
- "사용자 확정" 항목은 사용자가 정한 값입니다. 그대로 두고 빈 값("" 또는 [])으로 답하세요.
- 프로필과 모순되는 외형을 만들지 않습니다. 한국어로 씁니다(색상 hex 제외).`;

export function renderSheetDraftPrompt(v: { novel: { title: string; genre: string | null }; character: Character; spec: DesignSheetSpec; userFields: string[] }) {
  const c = v.character;
  return {
    system: SHEET_SYSTEM,
    messages: [
      {
        role: "user" as const,
        content: [
          `# 작품\n제목: ${v.novel.title}\n장르: ${v.novel.genre ?? "미정"}`,
          `# 캐릭터 프로필\n${characterLine(c)}`,
          `# 지금 디자인 시트\n${JSON.stringify(v.spec)}\n사용자 확정: ${JSON.stringify(v.userFields)}`,
        ].join("\n\n"),
      },
    ],
  };
}
