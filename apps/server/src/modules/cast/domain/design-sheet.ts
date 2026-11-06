/**
 * Character design sheet (설계 추가, PRD 6.14 캐릭터 시트 / VisualReference): structured visual spec, the reference
 * text reused by every later image prompt of the character, and per-view image prompts. Pure — no I/O.
 */
import { designSheetSpecSchema, type CharacterSheetView, type DesignSheetSpec } from "@ncs/shared";
import type { CharacterProfile } from "./cast.js";

export function normalizeSpec(raw: unknown): DesignSheetSpec {
  const r = designSheetSpecSchema.safeParse(raw ?? {});
  return r.success ? r.data : designSheetSpecSchema.parse({});
}

export function specIsEmpty(spec: DesignSheetSpec): boolean {
  return Object.values(spec).every((v) => (Array.isArray(v) ? v.length === 0 : !String(v).trim()));
}

const line = (label: string, v: string) => (v.trim() ? `${label}: ${v.trim()}` : "");

/**
 * Reference text for the character: stable wording so that every image prompt of this character (design sheet
 * views now, scene illustrations later) describes the same person.
 */
export function referenceText(c: Pick<CharacterProfile, "name" | "age" | "gender">, spec: DesignSheetSpec, outfitIndex = 0): string {
  const outfit = spec.outfits[outfitIndex] ?? spec.outfits[0];
  const palette = spec.colorPalette.map((p) => `${p.name} ${p.hex}`).join(", ");
  return [
    `캐릭터: ${c.name}`,
    line("나이", c.age),
    line("성별", c.gender),
    line("얼굴", spec.face),
    line("머리", spec.hair),
    line("눈", spec.eyes),
    line("체형", spec.build),
    line("키", spec.height),
    outfit ? `의상(${outfit.name}): ${outfit.description}` : "",
    palette ? `색상 팔레트: ${palette}` : "",
    line("특징", spec.distinguishingMarks),
  ]
    .filter(Boolean)
    .join("\n");
}

const VIEW_DIRECTIONS: Record<CharacterSheetView, string> = {
  front: "Character design sheet, full-body FRONT view, standing in a neutral A-pose, plain white background, even studio lighting, whole figure visible from head to toe.",
  side: "Character design sheet, full-body SIDE view (profile facing left), neutral standing pose, plain white background, even lighting, whole figure visible.",
  back: "Character design sheet, full-body BACK view, neutral standing pose, plain white background, even lighting, whole figure visible.",
  expressions:
    "Character expression sheet: the same character's face in a 3x2 grid of close-ups — neutral, smiling, angry, sad, surprised, determined. Plain white background, consistent face, hair and colors in every panel.",
};

/** default aspect ratio per view (turnaround views are tall, the expression grid is square) */
export const VIEW_ASPECT: Record<CharacterSheetView, string> = { front: "2:3", side: "2:3", back: "2:3", expressions: "1:1" };

export function buildViewPrompt(
  c: Pick<CharacterProfile, "name" | "age" | "gender">,
  spec: DesignSheetSpec,
  view: CharacterSheetView,
  outfitIndex = 0,
): { prompt: string; styleNotes: string; negativePrompt: string; referenceText: string } {
  const ref = referenceText(c, spec, outfitIndex);
  const prompt = [VIEW_DIRECTIONS[view], "Keep the design exactly consistent with this reference:", ref].join("\n\n");
  return {
    prompt,
    styleNotes: spec.artStyle.trim(),
    negativePrompt: ["text, letters, watermark, extra characters", spec.avoid.trim()].filter(Boolean).join(", "),
    referenceText: ref,
  };
}
