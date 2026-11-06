import { describe, expect, it } from "vitest";
import { generationLine, isGenerating, statementLabel, statusTone } from "./world-view.js";

const gen = (state: "none" | "waiting_brief" | "queued" | "running" | "done" | "failed") => ({
  briefApproved: state !== "waiting_brief",
  generation: { state, taskId: null, taskStatus: null, finishedAt: null, error: null, webSearch: null, sources: [], createdAt: null },
  counts: { pending: 3, approved: 1, rejected: 0 },
  groups: [{ kind: "faction" as const, items: [{} as never, {} as never] }],
});

describe("world ontology view helpers", () => {
  it("describes the generation state in Korean", () => {
    expect(generationLine(gen("waiting_brief"))).toContain("컨셉 브리프가 승인되면");
    expect(generationLine(gen("running"))).toContain("만드는 중");
    expect(generationLine(gen("done"))).toBe("후보 3개가 검토를 기다립니다.");
    expect(generationLine({ ...gen("done"), counts: { pending: 0, approved: 4, rejected: 0 } })).toBe("모든 후보를 검토했습니다.");
    expect(generationLine({ ...gen("done"), groups: [] })).toContain("후보가 없습니다");
    expect(generationLine(gen("failed"))).toContain("다시 생성");
    expect([isGenerating("queued"), isGenerating("running"), isGenerating("done")]).toEqual([true, true, false]);
  });
  it("labels statuses and statements", () => {
    expect([statusTone("pending"), statusTone("approved"), statusTone("rejected")]).toEqual(["warn", "ok", "neutral"]);
    expect(statementLabel({ entityType: "ability", kind: "system" })).toBe("대가");
    expect(statementLabel({ entityType: "rule", kind: "constraint" })).toBe("규칙");
  });
});
