import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_READER_SETTINGS } from "@ncs/reader-core";
import { CommentItem } from "../src/components/social";
import { pageBoxes } from "../src/reader/PagedView";
import { formatDate } from "../src/components/format";

describe("comments render as plain text", () => {
  it("escapes markup in nicknames and bodies (never HTML)", () => {
    const html = renderToStaticMarkup(
      <CommentItem
        c={{ id: 1, nickname: "<b>x</b>", body: `<img src=x onerror=alert(1)><script>alert(1)</script>`, createdAt: new Date().toISOString(), state: "visible", mine: false, pending: false, replies: [] }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows a placeholder for removed comments", () => {
    const html = renderToStaticMarkup(<CommentItem c={{ id: 1, nickname: null, body: null, createdAt: new Date().toISOString(), state: "hidden", mine: false, pending: false, replies: [] }} />);
    expect(html).toContain("숨겨진 댓글");
  });
});

describe("page boxes (foldables)", () => {
  const s = DEFAULT_READER_SETTINGS;
  const vp = (width: number, height: number, segments: Array<{ x: number; y: number; width: number; height: number }> | null = null) => ({ width, height, segments, safeTop: 0, safeBottom: 0 });

  it("one page that fits the screen on phones and cover screens", () => {
    for (const [w, h] of [[390, 844], [360, 740], [344, 882], [412, 915], [260, 512]] as const) {
      const g = pageBoxes(vp(w, h), s);
      expect(g.spread, `${w}x${h}`).toBe(false);
      expect(g.boxes).toHaveLength(1);
      const b = g.boxes[0]!;
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(w);
      expect(b.top + b.height).toBeLessThanOrEqual(h);
    }
  });

  it("two pages side by side on the Fold inner screen, both inside the screen", () => {
    for (const [w, h] of [[673, 841], [841, 673]] as const) {
      const g = pageBoxes(vp(w, h), s);
      expect(g.spread).toBe(true);
      const a = g.boxes[0]!;
      const b = g.boxes[1]!;
      expect(a.left + a.width).toBeLessThan(b.left);
      expect(b.left + b.width).toBeLessThanOrEqual(w);
    }
  });

  it("keeps pages off a vertical hinge and inside the top segment on a horizontal fold", () => {
    const hinge = pageBoxes(vp(840, 673, [{ x: 0, y: 0, width: 410, height: 673 }, { x: 430, y: 0, width: 410, height: 673 }]), s);
    expect(hinge.spread).toBe(true);
    expect(hinge.boxes[0]!.left + hinge.boxes[0]!.width).toBeLessThanOrEqual(410);
    expect(hinge.boxes[1]!.left).toBeGreaterThanOrEqual(430);
    const flex = pageBoxes(vp(412, 915, [{ x: 0, y: 0, width: 412, height: 440 }, { x: 0, y: 470, width: 412, height: 445 }]), s);
    expect(flex.spread).toBe(false);
    expect(flex.boxes[0]!.top + flex.boxes[0]!.height).toBeLessThanOrEqual(440);
  });
});

describe("dates", () => {
  it("formats in Korea time regardless of the server time zone", () => {
    expect(formatDate("2026-11-01T16:30:00Z")).toBe("2026.11.02");
    expect(formatDate(null)).toBe("");
  });
});
