import { describe, expect, it } from "vitest";
import { atBottom } from "./chat-scroll.js";

describe("chat log pinning", () => {
  it("is pinned only near the bottom", () => {
    expect(atBottom(1000, 600, 400)).toBe(true);
    expect(atBottom(1000, 530, 400)).toBe(true);
    expect(atBottom(1000, 300, 400)).toBe(false);
  });
});
