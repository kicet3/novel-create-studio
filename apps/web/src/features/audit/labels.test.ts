import { describe, expect, it } from "vitest";
import { summarizeChange } from "./api.js";
import { displayChanges, shortId } from "./labels.js";

describe("audit diff display (review3 visual #9)", () => {
  it("Korean field / enum labels, empty pairs dropped, ids shortened", () => {
    const rows = displayChanges(
      summarizeChange(
        { status: "running", stopReason: null, errorFamily: null, kind: "check_setups" },
        { status: "done", stopReason: "completed", errorFamily: null, kind: "check_setups", agentRole: "foreshadow_manager" },
        8,
      ),
    );
    expect(rows.map((r) => [r.label, r.from, r.to])).toEqual([
      ["상태", "실행 중", "완료"],
      ["종료 사유", "없음", rows[1]!.to],
      ["역할", "—", rows[2]!.to],
    ]);
    expect(rows[1]!.to).not.toBe("completed");
    expect(rows[2]!.to).not.toBe("foreshadow_manager");
    expect(shortId("mnv_01J9Z3K4ABCDEFGHJKMNPQRS")).toBe("mnv_…PQRS");
    expect(shortId("일반 텍스트")).toBe("일반 텍스트");
  });
});

describe("target-aware value labels", () => {
  it("status uses the target's enum first; money fields are formatted", () => {
    const issue = displayChanges(summarizeChange(null, { status: "open" }), "continuity_issue");
    expect(issue[0]!.to).not.toBe("답변 대기");
    expect(issue[0]!.to).not.toBe("open");
    expect(displayChanges(summarizeChange({ amountMicros: 1_500_000 }, { amountMicros: 4_200_000 }))[0]).toMatchObject({ label: "금액", from: "$1.50", to: "$4.20" });
  });
});
