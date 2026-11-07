import { describe, expect, it } from "vitest";
import { sequentialWait, sequentialWaitText } from "./SequentialWait.js";

describe("한 화씩 진행 line", () => {
  const eps = [
    { episodeNo: 1, status: "approved" as const },
    { episodeNo: 2, status: "awaiting_approval" as const },
    { episodeNo: 3, status: "planned" as const },
  ];
  it("names the waiting episode and the next one", () => {
    const w = sequentialWait({ autonomyLevel: "episode_approval", sequentialEpisodes: true }, eps)!;
    expect(sequentialWaitText(w)).toBe("2화 승인 대기 — 승인하면 3화를 씁니다");
  });
  it("is off for other levels or when disabled", () => {
    expect(sequentialWait({ autonomyLevel: "full_auto", sequentialEpisodes: true }, eps)).toBeNull();
    expect(sequentialWait({ autonomyLevel: "episode_approval", sequentialEpisodes: false }, eps)).toBeNull();
  });
});
