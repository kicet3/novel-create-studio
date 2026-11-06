import { describe, expect, it } from "vitest";
import { SETTING_STATE_LABEL } from "./status-badges.js";
import { autonomyOptions, LEVEL_SCOPE } from "./AutonomySection.js";

describe("settings badges", () => {
  it("uses one fixed vocabulary (no 준비 중 / v1)", () => {
    expect(Object.values(SETTING_STATE_LABEL)).toEqual(["사용 중", "기본값", "주의", "예정", "꺼짐"]);
  });
  it("every selectable autonomy level explains what is automatic and what stays with the author", () => {
    const opts = autonomyOptions("arc_approval");
    expect(opts.map((o) => o.value)).toEqual(["episode_approval", "arc_approval", "full_auto", "co_writing"]);
    expect(opts.find((o) => o.value === "co_writing")!.disabled).toBe(true);
    for (const v of ["episode_approval", "arc_approval", "full_auto"] as const) {
      expect(LEVEL_SCOPE[v].auto.length).toBeGreaterThan(0);
      expect(LEVEL_SCOPE[v].human.length).toBeGreaterThan(0);
    }
  });
});
