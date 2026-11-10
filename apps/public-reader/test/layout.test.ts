/** screen classes + the PC reader's page box (must equal the studio viewer's geometry at the same size). */
import { describe, expect, it } from "vitest";
import { pageGeometry } from "@ncs/reader-core/layout";
import { DEFAULT_READER_SETTINGS, READER_MARGIN_PX, READER_MAX_EM, READER_STEPS3, fontPxOf } from "@ncs/reader-core/model";
import { desktopPageGeometry, screenClass, usesDesktopReader } from "../src/lib/layout";

describe("screen classes", () => {
  it("phones / foldables / tablets / PC", () => {
    expect(screenClass(390)).toBe("mobile");
    expect(screenClass(673)).toBe("mobile"); // Fold inner screen
    expect(screenClass(767)).toBe("mobile");
    expect(screenClass(768)).toBe("tablet");
    expect(screenClass(1023)).toBe("tablet");
    expect(screenClass(1024)).toBe("desktop");
    expect(screenClass(1920)).toBe("desktop");
  });

  it("the PC reader only on flat screens ≥ 1024px (a fold keeps the foldable reader)", () => {
    expect(usesDesktopReader(1024, null)).toBe(true);
    expect(usesDesktopReader(1440, [])).toBe(true);
    expect(usesDesktopReader(1023, null)).toBe(false);
    expect(usesDesktopReader(673, null)).toBe(false);
    expect(usesDesktopReader(1280, [{}, {}])).toBe(false);
  });
});

describe("PC page geometry = studio viewer", () => {
  const studio = (w: number, h: number, fontStep: number, margin: (typeof READER_STEPS3)[number]) =>
    pageGeometry({ viewportWidth: w, viewportHeight: h, fontPx: fontPxOf(fontStep), maxEm: READER_MAX_EM[margin], sidePad: READER_MARGIN_PX[margin], topPad: h >= 720 ? 52 : 40, bottomPad: h >= 720 ? 52 : 40 });

  it("same box at the PC sizes, every margin / a few font steps, centered and inside the screen", () => {
    for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [1024, 640]] as const) {
      for (const margin of READER_STEPS3) {
        for (const fontStep of [0, DEFAULT_READER_SETTINGS.fontStep, 9]) {
          const g = desktopPageGeometry(w, h, { fontStep, margin });
          expect(g, `${w}x${h} ${margin} ${fontStep}`).toEqual(studio(w, h, fontStep, margin));
          expect(g.left).toBeGreaterThanOrEqual(0);
          expect(g.left + g.width).toBeLessThanOrEqual(w);
          expect(g.top + g.height).toBeLessThanOrEqual(h);
          expect(Math.abs(g.left - (w - g.left - g.width))).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("line length follows 좌우 여백 (em of the font), not the screen width", () => {
    const g = desktopPageGeometry(1920, 1080, DEFAULT_READER_SETTINGS);
    expect(g.width).toBe(Math.floor(READER_MAX_EM.normal * fontPxOf(DEFAULT_READER_SETTINGS.fontStep)));
    expect(desktopPageGeometry(1440, 900, DEFAULT_READER_SETTINGS).width).toBe(g.width);
  });
});
