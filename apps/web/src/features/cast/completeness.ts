/** 캐릭터 완성도(구성 전 필수 항목) 화면용 순수 계산. */
import {
  CHARACTER_REQUIRED_FIELDS_BY_ROLE,
  CHARACTER_REQUIREMENT_LABELS_KO,
  type CastCompleteness,
  type CharacterRequirementField,
  type CharacterRole,
} from "@ncs/shared";

export interface CompletenessRow {
  characterId: string;
  name: string;
  role: CharacterRole;
  /** 빠진 필수 항목 라벨 */
  missing: string[];
  unconfirmed: boolean;
  /** 플롯에서 새로 등장한 인물 */
  introducedArcId: string | null;
  /** AI로 채울 빈 항목이 있음 */
  fillable: boolean;
}

export function completenessRows(c: CastCompleteness): CompletenessRow[] {
  return c.items.map((i) => ({
    characterId: i.characterId,
    name: i.name,
    role: i.role,
    missing: i.missing.map((m) => m.label || CHARACTER_REQUIREMENT_LABELS_KO[m.field]),
    unconfirmed: i.unconfirmed,
    introducedArcId: i.introducedArcId,
    fillable: i.missing.length > 0,
  }));
}

/** 한 인물의 빠진 필수 항목(프로필 폼 강조용) */
export function missingFieldsOf(c: CastCompleteness | undefined, characterId: string): Set<CharacterRequirementField> {
  const item = c?.items.find((i) => i.characterId === characterId);
  return new Set(item?.missing.map((m) => m.field) ?? []);
}

/** 역할별 필수 항목인지(* 표시) */
export function isRequiredField(role: CharacterRole, field: CharacterRequirementField): boolean {
  return CHARACTER_REQUIRED_FIELDS_BY_ROLE[role].includes(field);
}

/** 체크리스트 요약 문구 */
export function completenessSummary(c: CastCompleteness): string {
  if (c.complete) return "주인공·서브 주인공과 주요 인물의 필수 항목이 모두 채워졌습니다.";
  const missing = c.items.filter((i) => i.missing.length > 0).length;
  const unconfirmed = c.items.filter((i) => i.unconfirmed && i.missing.length === 0).length;
  const parts = [missing > 0 ? `필수 항목이 빈 인물 ${missing}명` : null, unconfirmed > 0 ? `확정하지 않은 인물 ${unconfirmed}명` : null].filter(Boolean);
  if (!parts.length) return "주인공을 정해야 전체 구성을 만들 수 있습니다.";
  return `${parts.join(", ")} — ${missing > 0 ? "빈 항목을 채우고 캐스트를 확정해야" : "캐스트를 확정해야"} 전체 구성을 만들 수 있습니다.`;
}

/** 플롯에서 새로 등장한 인물 체크리스트 요약 */
export function plotCompletenessSummary(c: CastCompleteness): string {
  const missing = c.items.filter((i) => i.missing.length > 0).length;
  const unaccepted = c.items.filter((i) => i.unconfirmed && i.missing.length === 0).length;
  const parts = [missing > 0 ? `빈 항목이 있는 인물 ${missing}명` : null, unaccepted > 0 ? `AI 제안을 수락하지 않은 인물 ${unaccepted}명` : null].filter(Boolean);
  return `${parts.join(", ")} — ${missing > 0 ? "빈 항목을 채우고 제안을 수락해야" : "제안을 수락해야"} 그 플롯을 승인할 수 있습니다.`;
}
