import { describe, expect, it } from "vitest";
import { anchorFromRange, clipQuote } from "./selection.js";

describe("revision chat anchor", () => {
  it("trims the selection and keeps JS offsets", () => {
    const text = "첫 문장입니다.\n\n  둘째 문장입니다.  \n셋째";
    const a = anchorFromRange(text, "mnv_1", 9, 24)!;
    expect(a.quote).toBe("둘째 문장입니다.");
    expect(text.slice(a.start, a.end)).toBe(a.quote);
    expect(anchorFromRange(text, "mnv_1", 3, 3)).toBeNull();
    expect(anchorFromRange(text, "mnv_1", 24, 9)!.quote).toBe("둘째 문장입니다.");
  });
  it("clips long quotes on one line", () => {
    expect(clipQuote("가\n나", 10)).toBe("가 나");
    expect(clipQuote("가".repeat(100), 5)).toBe("가가가가가…");
  });
});
