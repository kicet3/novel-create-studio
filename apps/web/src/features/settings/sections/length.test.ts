import { describe, expect, it } from "vitest";
import { EPISODE_HARD_MAX_MESSAGE, EPISODE_HARD_MIN_MESSAGE } from "@ncs/shared";
import { lengthFormError } from "./length.js";

describe("lengthFormError (한 화 최소 3,000자)", () => {
  it("rejects a minimum below 3,000", () => {
    expect(lengthFormError(2999, 5500)).toBe(EPISODE_HARD_MIN_MESSAGE);
    expect(lengthFormError(3000, 2999)).toBe(EPISODE_HARD_MAX_MESSAGE);
  });
  it("accepts 3,000 and the 5,000~5,500 default", () => {
    expect(lengthFormError(3000, 3000)).toBeNull();
    expect(lengthFormError(5000, 5500)).toBeNull();
  });
  it("rejects max < min and non-integers", () => {
    expect(lengthFormError(5000, 4000)).toContain("최대 글자 수");
    expect(lengthFormError(Number.NaN, 5000)).toContain("정수");
  });
});
