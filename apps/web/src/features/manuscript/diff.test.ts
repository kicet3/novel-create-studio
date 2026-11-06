import { describe, expect, it } from "vitest";
import { buildLines, describeLocation, lineOffsets } from "./annotate.js";
import { diffChars, diffLines, diffStats, newSide, oldSide, toSideBySide, withContext } from "./diff.js";

describe("diffLines", () => {
  it("returns all-equal for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.op === "equal")).toBe(true);
    expect(diffStats(d)).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it("finds an inserted and a deleted line with correct numbering", () => {
    const d = diffLines("a\nb\nc\nd", "a\nc\nX\nd");
    expect(d.map((l) => `${l.op[0]}${l.text}`)).toEqual(["ea", "db", "ec", "iX", "ed"]);
    expect(d.find((l) => l.text === "X")?.newNo).toBe(3);
    expect(d.find((l) => l.text === "b")?.oldNo).toBe(2);
  });

  it("handles empty sides", () => {
    expect(diffStats(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 1, unchanged: 0 });
    expect(diffLines("x", "x")).toHaveLength(1);
  });
});

describe("diffChars", () => {
  it("merges runs and reconstructs both sides", () => {
    const segs = diffChars("무진은 오른팔을 들어", "무진은 의수를 낀 왼팔로");
    expect(oldSide(segs).map((s) => s.text).join("")).toBe("무진은 오른팔을 들어");
    expect(newSide(segs).map((s) => s.text).join("")).toBe("무진은 의수를 낀 왼팔로");
    expect(segs[0]).toEqual({ op: "equal", text: "무진은 " });
  });
});

describe("toSideBySide / withContext", () => {
  it("pairs delete+insert runs as change rows with char segments", () => {
    const rows = toSideBySide(diffLines("a\nold\nz", "a\nnew\nextra\nz"));
    expect(rows.map((r) => r.kind)).toEqual(["equal", "change", "insert", "equal"]);
    expect(rows[1]?.left?.segments?.length).toBeGreaterThan(0);
    expect(rows[2]?.right?.no).toBe(3);
  });

  it("collapses unchanged runs", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const neu = old.replace("l10", "L10");
    const out = withContext(diffLines(old, neu), 2);
    expect(out.filter((r) => "skipped" in r).map((r) => (r as { skipped: number }).skipped)).toEqual([8, 7]);
  });
});

describe("buildLines", () => {
  const content = "첫 줄\n둘째 줄\n셋째";
  it("computes offsets", () => {
    expect(lineOffsets(content).map((l) => [l.start, l.end])).toEqual([
      [0, 3],
      [4, 8],
      [9, 11],
    ]);
  });

  it("assigns authors, scenes and markers per line", () => {
    const lines = buildLines(
      content,
      [
        { start: 0, end: 6, actorType: "agent", actorId: "writer" },
        { start: 6, end: 11, actorType: "user", actorId: "usr_1" },
      ],
      [
        { id: "s1", ord: 1, charStart: 0, charEnd: 3 },
        { id: "s2", ord: 2, charStart: 3, charEnd: 11 }, // on the newline → belongs to line 2
      ],
      [{ id: "ci1", kind: "issue", start: 5, end: 7, tone: "high" }],
    );
    expect(lines.map((l) => l.author)).toEqual(["agent", "mixed", "human"]);
    expect(lines[0]?.sceneStarts.map((s) => s.id)).toEqual(["s1"]);
    expect(lines[1]?.sceneStarts.map((s) => s.id)).toEqual(["s2"]);
    expect(lines[1]?.markerStarts.map((m) => m.id)).toEqual(["ci1"]);
    const marked = lines[1]?.segments.filter((s) => s.markers.length > 0).map((s) => s.text).join("");
    expect(marked).toBe("째 ");
    expect(lines[1]?.segments.map((s) => s.text).join("")).toBe("둘째 줄");
  });

  it("describes a location as scene + paragraph", () => {
    expect(describeLocation("a\n\nb\nc", 5, [{ id: "s", ord: 2, charStart: 0, charEnd: 6 }])).toEqual({ sceneOrd: 2, paragraph: 2 });
  });
});
