import type { NavIconName } from "./icons.js";

/**
 * Sidebar navigation model. Order and labels follow docs/mockups-src/SPEC.md "Shared sidebar",
 * plus 컨셉 (design/11 §4.1 new `concept` screen). 미디어 스튜디오 (v1) is out of MVP-α scope and omitted; 이미지 생성 (module imaging) is a separate tab.
 * `screen` = mockup `data-screen` id (08 §9.1).
 */
export interface NovelNavItem {
  screen: "home" | "concept" | "cast" | "board" | "inbox" | "manuscript" | "ontology" | "foreshadow" | "images" | "audit" | "settings";
  label: string;
  /** Path relative to `/novels/:novelId`; "" = home. */
  path: string;
  icon: NavIconName;
}

export const NOVEL_NAV: readonly NovelNavItem[] = [
  { screen: "home", label: "작품 홈", path: "", icon: "home" },
  { screen: "concept", label: "컨셉", path: "concept", icon: "concept" },
  { screen: "cast", label: "캐릭터", path: "cast", icon: "cast" },
  { screen: "board", label: "작업 보드", path: "board", icon: "board" },
  { screen: "inbox", label: "인박스", path: "inbox", icon: "inbox" },
  { screen: "manuscript", label: "원고", path: "manuscript", icon: "manuscript" },
  { screen: "ontology", label: "세계관 온톨로지", path: "ontology", icon: "ontology" },
  { screen: "foreshadow", label: "떡밥", path: "setups", icon: "foreshadow" },
  { screen: "images", label: "이미지 생성", path: "images", icon: "image" },
  { screen: "audit", label: "감사 타임라인", path: "audit", icon: "audit" },
  { screen: "settings", label: "설정", path: "settings", icon: "settings" },
];

export function novelPath(novelId: string, sub = ""): string {
  const base = `/novels/${encodeURIComponent(novelId)}`;
  return sub ? `${base}/${sub}` : base;
}
