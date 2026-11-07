/** 설계 추가 0018: revision-chat patch scope (pure) */
import { describe, expect, it } from "vitest";
import { locatePatches } from "../../src/modules/revision/domain/patch.js";

const text = Array.from({ length: 40 }, (_x, i) => `문장 ${i}번은 여기에 있습니다.`).join(" ");

describe("locatePatches scope", () => {
  it("a short quote with a huge replacement is a rewrite (too_large)", () => {
    const r = locatePatches(text, [{ quote: "문장 3번은 여기에 있습니다.", replacement: "새 문장. ".repeat(200), reason: "x" }]);
    expect(r.located).toHaveLength(0);
    expect(r.issues.map((i) => i.code)).toEqual(["too_large"]);
  });
  it("a sentence-sized replacement is fine", () => {
    const r = locatePatches(text, [{ quote: "문장 3번은 여기에 있습니다.", replacement: "문장 3번은 저기에 있습니다.", reason: "x" }]);
    expect(r.issues).toHaveLength(0);
    expect(r.located).toHaveLength(1);
  });
});
