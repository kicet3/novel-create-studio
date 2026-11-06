import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/client.js";
import { displayNo, formatRelative } from "./format.js";
import { isMissingRoute, isNotImplemented, isUnavailable } from "./QueryState.js";

describe("query state helpers", () => {
  it("treats 501 and missing API routes as 준비 중", () => {
    const notImpl = new ApiRequestError(501, "not_implemented", "준비 중");
    const missing = new ApiRequestError(404, "not_found", "API 경로를 찾을 수 없습니다.");
    const realNotFound = new ApiRequestError(404, "not_found", "작품을 찾을 수 없습니다.");
    expect(isNotImplemented(notImpl)).toBe(true);
    expect(isMissingRoute(missing)).toBe(true);
    expect(isUnavailable(missing)).toBe(true);
    expect(isUnavailable(realNotFound)).toBe(false);
    expect(isUnavailable(new Error("x"))).toBe(false);
  });

  it("formats relative time and display numbers", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(formatRelative("2026-11-05T11:50:00Z", now)).toBe("10분 전");
    expect(formatRelative("2026-11-05T15:00:00Z", now)).toBe("3시간 후");
    expect(formatRelative(null, now)).toBe("—");
    expect(displayNo("Q", 12)).toBe("Q-12");
    expect(displayNo("Q", "Q-3")).toBe("Q-3");
  });
});
