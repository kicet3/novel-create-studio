import { describe, expect, it } from "vitest";
import {
  EPISODE_HARD_MIN_CHARS,
  structureDecisionRequestSchema,
  updateLengthProfileRequestSchema,
  updateStructureEndingRequestSchema,
  storyEndingSchema,
  castDraftRequestSchema,
} from "../src/dto/index.js";
import { labelKo } from "../src/labels.ko.js";

describe("설계 추가 0008 DTOs", () => {
  it("length profile: min/max under the 3,000-char floor are refused with a Korean message", () => {
    expect(EPISODE_HARD_MIN_CHARS).toBe(3000);
    const low = updateLengthProfileRequestSchema.safeParse({ minChars: 2999 });
    expect(low.success).toBe(false);
    expect(JSON.stringify(low.error?.issues)).toContain("3,000자");
    expect(updateLengthProfileRequestSchema.safeParse({ minChars: 3000 }).success).toBe(true);
    expect(updateLengthProfileRequestSchema.safeParse({ maxChars: 2000 }).success).toBe(false);
  });

  it("structure decision: a rejection needs a note", () => {
    expect(structureDecisionRequestSchema.safeParse({ decision: "rejected", expectedRevision: 1 }).success).toBe(false);
    expect(structureDecisionRequestSchema.safeParse({ decision: "rejected", note: "다시", expectedRevision: 1 }).success).toBe(true);
    expect(structureDecisionRequestSchema.safeParse({ decision: "approved", expectedRevision: 1 }).success).toBe(true);
  });

  it("ending patch keeps missing keys absent (no default wipes other fields); empty patch refused", () => {
    const r = updateStructureEndingRequestSchema.parse({ expectedRevision: 2, ending: { worldState: "평화" } });
    expect(r.ending).toEqual({ worldState: "평화" });
    expect(updateStructureEndingRequestSchema.safeParse({ expectedRevision: 2, ending: {} }).success).toBe(false);
    expect(storyEndingSchema.parse({})).toMatchObject({ worldState: "", protagonistChange: { from: "", to: "" }, characterFinalStates: [] });
  });

  it("cast draft fillMissing defaults to false; labels exist", () => {
    expect(castDraftRequestSchema.parse({}).fillMissing).toBe(false);
    expect(labelKo("approval_type", "story_structure")).toBe("전체 구성");
    expect(labelKo("task_kind", "plan_structure")).toBe("전체 구성 기획");
    expect(labelKo("arc_plan_flag", "ending_changed")).toBe("결말 변경 확인 필요");
    expect(labelKo("continuity_issue_kind", "plan_deviation")).toBe("기획 이탈");
  });
});
