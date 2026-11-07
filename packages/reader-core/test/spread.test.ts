import { describe, expect, it } from "vitest";
import { screenStep, spreadLayout, spreadStart } from "../src/layout.js";

const mode = (w: number, h: number) => spreadLayout({ viewportWidth: w, viewportHeight: h }).mode;

describe("spreadLayout (single page vs. book spread)", () => {
  it("keeps phones, Flip, Fold cover and Flip cover screens on a single page", () => {
    expect(mode(390, 844)).toBe("single");
    expect(mode(360, 740)).toBe("single");
    expect(mode(412, 915)).toBe("single"); // Galaxy Z Flip
    expect(mode(344, 882)).toBe("single"); // Galaxy Z Fold cover
    expect(mode(260, 512)).toBe("single"); // Flip cover-ish
  });

  it("shows two pages on the Fold inner screen (portrait and landscape), tablets and desktops", () => {
    expect(mode(673, 841)).toBe("spread");
    expect(mode(841, 673)).toBe("spread");
    expect(mode(768, 1024)).toBe("spread");
    expect(mode(1440, 900)).toBe("spread");
    const s = spreadLayout({ viewportWidth: 673, viewportHeight: 841 });
    expect(s.gap).toBeGreaterThanOrEqual(32);
    expect(s.folded).toBe("none");
  });

  it("stays single on wide but very tall screens and narrow landscape phones", () => {
    expect(mode(600, 1000)).toBe("single"); // aspect 0.6
    expect(mode(560, 360)).toBe("single"); // below the width threshold
    expect(spreadLayout({ viewportWidth: 700, viewportHeight: 1000, minSpreadAspect: 0.6 }).mode).toBe("spread");
  });

  it("puts one page per segment around a vertical hinge (side-by-side segments)", () => {
    const s = spreadLayout({
      viewportWidth: 840,
      viewportHeight: 673,
      segments: [
        { x: 0, y: 0, width: 410, height: 673 },
        { x: 430, y: 0, width: 410, height: 673 },
      ],
    });
    expect(s).toMatchObject({ mode: "spread", gap: 20, folded: "vertical-hinge" });
  });

  it("uses only the top segment on a horizontal fold (Flip flex mode)", () => {
    const s = spreadLayout({
      viewportWidth: 412,
      viewportHeight: 915,
      segments: [
        { x: 0, y: 470, width: 412, height: 445 },
        { x: 0, y: 0, width: 412, height: 440 },
      ],
    });
    expect(s).toMatchObject({ mode: "single", folded: "horizontal-hinge", area: { left: 0, top: 0, width: 412, height: 440 } });
  });

  it("ignores a single segment / invalid segments", () => {
    expect(spreadLayout({ viewportWidth: 390, viewportHeight: 844, segments: [{ x: 0, y: 0, width: 390, height: 844 }] }).mode).toBe("single");
    expect(spreadLayout({ viewportWidth: 390, viewportHeight: 844, segments: [{ x: 0, y: 0, width: 0, height: 0 }, { x: 1, y: 0, width: 0, height: 9 }] }).mode).toBe("single");
    expect(mode(0, 0)).toBe("single");
  });

  it("aligns pages to spreads", () => {
    expect(spreadStart(5, true)).toBe(4);
    expect(spreadStart(4, true)).toBe(4);
    expect(spreadStart(5, false)).toBe(5);
    expect(screenStep(true)).toBe(2);
    expect(screenStep(false)).toBe(1);
  });
});
