import { describe, expect, it } from "vitest";
import type { CastCompleteness } from "@ncs/shared";
import { completenessRows, completenessSummary, isRequiredField, missingFieldsOf, plotCompletenessSummary } from "./completeness.js";

const id = (n: number) => `chr_${String(n).padStart(26, "0")}`;
const sample: CastCompleteness = {
  complete: false,
  message: "…",
  items: [
    { characterId: id(1), name: "한결", role: "protagonist", missing: [{ field: "motivation", label: "동기" }, { field: "speechSample", label: "" }], unconfirmed: false, introducedArcId: null },
    { characterId: id(2), name: "서린", role: "sub_protagonist", missing: [], unconfirmed: true, introducedArcId: null },
  ],
};

describe("cast completeness view helpers", () => {
  it("maps missing fields to Korean labels (falls back to the shared label table)", () => {
    const rows = completenessRows(sample);
    expect(rows[0]!.missing).toEqual(["동기", "말투 예시"]);
    expect(rows[0]!.fillable).toBe(true);
    expect(rows[1]!.fillable).toBe(false);
    expect(rows[1]!.unconfirmed).toBe(true);
  });
  it("missingFieldsOf returns the fields for one character", () => {
    expect([...missingFieldsOf(sample, id(1))]).toEqual(["motivation", "speechSample"]);
    expect(missingFieldsOf(sample, id(9)).size).toBe(0);
    expect(missingFieldsOf(undefined, id(1)).size).toBe(0);
  });
  it("required fields depend on the role", () => {
    expect(isRequiredField("protagonist", "speechSample")).toBe(true);
    expect(isRequiredField("supporting", "speechSample")).toBe(false);
    expect(isRequiredField("supporting", "storyRole")).toBe(true);
    expect(isRequiredField("sub_protagonist", "relationToProtagonist")).toBe(true);
  });
  it("summary counts missing and unconfirmed characters", () => {
    expect(completenessSummary(sample)).toContain("필수 항목이 빈 인물 1명");
    expect(completenessSummary(sample)).toContain("확정하지 않은 인물 1명");
    expect(completenessSummary({ complete: true, items: [], message: "" })).toContain("모두 채워졌습니다");
    expect(completenessSummary(sample)).toContain("빈 항목을 채우고");
    const onlyUnconfirmed = { ...sample, items: sample.items.map((i) => ({ ...i, missing: [], unconfirmed: true })) };
    expect(completenessSummary(onlyUnconfirmed)).not.toContain("채우고"); // only confirming is left
    expect(plotCompletenessSummary(onlyUnconfirmed)).toContain("제안을 수락해야 그 플롯을 승인할 수 있습니다");
  });
});
