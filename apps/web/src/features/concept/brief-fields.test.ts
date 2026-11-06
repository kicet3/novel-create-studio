import { describe, expect, it } from "vitest";
import { briefValueText, editText, getBriefValue, isEmptyBriefValue, parseEditValue } from "./brief-fields.js";

const content = {
  logline: "회귀한 헌터가 붕괴를 막는다",
  category: { genre_label: "현판", trope_labels: ["회귀", "헌터"] },
  world_rules: [
    { item_key: "core", statement: "게이트는 7일마다 열린다" },
    { item_key: "regression", statement: "기억만 이월" },
  ],
  main_characters: [{ character_key: "c1", name: "최무진", role_label: "조력자" }],
  serial_plan: { total_episodes_min: 120 },
};

describe("brief field helpers", () => {
  it("reads dotted and world_rules[item_key] paths", () => {
    expect(getBriefValue(content, "category.genre_label")).toBe("현판");
    expect(getBriefValue(content, "world_rules[item_key=regression]")).toBe("기억만 이월");
    expect(getBriefValue(content, "world_rules[item_key=possession]")).toBeUndefined();
    expect(getBriefValue(content, "protagonist.name")).toBeUndefined();
  });

  it("renders values as text", () => {
    expect(briefValueText(["회귀", "헌터"])).toBe("회귀, 헌터");
    expect(briefValueText(content.main_characters)).toBe("최무진 (조력자)");
    expect(briefValueText(120)).toBe("120");
    expect(briefValueText(null)).toBe("");
  });

  it("parses edit box text per value type", () => {
    expect(parseEditValue("list", "회귀\n헌터, 상태창")).toEqual(["회귀", "헌터", "상태창"]);
    expect(parseEditValue("int", " 150 ")).toBe(150);
    expect(parseEditValue("text", "  ")).toBeNull();
    expect(editText("list", ["a", "b"])).toBe("a\nb");
  });

  it("detects empty values", () => {
    expect(isEmptyBriefValue([])).toBe(true);
    expect(isEmptyBriefValue(" ")).toBe(true);
    expect(isEmptyBriefValue(0)).toBe(false);
  });
});
