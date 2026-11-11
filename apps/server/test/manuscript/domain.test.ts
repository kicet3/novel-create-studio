import { describe, expect, it } from "vitest";
import { computeSpans, coversExactly, initialSpans, lineAttribution } from "../../src/modules/manuscript/domain/attribution.js";
import { diffText, mapPosition, unchangedOverlap } from "../../src/modules/manuscript/domain/diff.js";
import { decideGate } from "../../src/modules/manuscript/domain/gate.js";
import { mapRanges, rangesFromSceneBreaks, retainSceneIds } from "../../src/modules/manuscript/domain/scenes.js";
import { outlineProposalSchema, safetyVerdictSchema } from "../../src/modules/manuscript/domain/schemas.js";
import { checkLength, countChars, factSignature, signaturesEqual } from "../../src/modules/manuscript/domain/text.js";
import { EPISODE_TRANSITIONS, findEpisodeRule } from "../../src/modules/manuscript/domain/transitions.js";
import { exportFileName, renderMarkdown, renderTxt, stripTxtHeading } from "../../src/modules/export/domain/render.js";

const apply = (a: string, b: string) => {
  const ops = diffText(a, b);
  let out = "";
  for (const op of ops) if (op.type !== "delete") out += b.slice(op.bStart, op.bEnd);
  return { ops, out };
};

describe("episode state machine (03 §4.1)", () => {
  it("contains E1–E17 and rejects transitions not in the table", () => {
    expect(new Set(EPISODE_TRANSITIONS.map((r) => r.id)).size).toBe(17);
    // 설계 추가(화 삭제): E17 back to planned from every written state but published (E14 first)
    expect(findEpisodeRule("awaiting_approval", "planned").id).toBe("E17");
    expect(findEpisodeRule("approved", "planned").action).toBe("episode.manuscript_deleted");
    expect(() => findEpisodeRule("published", "planned")).toThrow();
    expect(findEpisodeRule("planned", "outlining").id).toBe("E1");
    expect(findEpisodeRule("checking", "drafting").id).toBe("E4");
    expect(findEpisodeRule("revising", "polishing").id).toBe("E12");
    expect(findEpisodeRule("awaiting_approval", "approved").action).toBe("episode.approved");
    expect(findEpisodeRule("approved", "revising").id).toBe("E11");
    expect(findEpisodeRule("published", "approved").action).toBe("episode.unpublished");
    expect(findEpisodeRule("approved", "checking", "E16").id).toBe("E16");
    expect(() => findEpisodeRule("planned", "approved")).toThrow(/바꿀 수 없습니다/);
    expect(() => findEpisodeRule("published", "checking")).toThrow(); // INV-EP-04: no human edit on published
    expect(() => findEpisodeRule("checking", "awaiting_approval")).toThrow();
    expect(() => findEpisodeRule("revising", "checking", "E16")).toThrow();
  });
});

describe("char counts (FR-MAN-02)", () => {
  it("counts NFC code points with and without whitespace", () => {
    const decomposed = "가 b\n"; // 가(자모 분리) + space + b + newline
    expect(countChars(decomposed, "with_spaces")).toBe(4);
    expect(countChars(decomposed, "without_spaces")).toBe(2);
    expect(countChars("😀 a", "with_spaces")).toBe(3);
    expect(checkLength("abc", { minChars: 5, maxChars: 10, countBasis: "with_spaces" }).deviation).toBe("short");
    expect(checkLength("abcdef", { minChars: 5, maxChars: 10, countBasis: "with_spaces" }).deviation).toBeNull();
  });
});

describe("diff / position mapping (07 §6.2)", () => {
  it("reconstructs the new text and maps unchanged positions", () => {
    const a = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.";
    const b = "첫 문장입니다. 바뀐 둘째 문장! 셋째 문장입니다.";
    const { ops, out } = apply(a, b);
    expect(out).toBe(b);
    const p = a.indexOf("셋째");
    expect(mapPosition(ops, p)).toEqual({ pos: b.indexOf("셋째"), exact: true });
    expect(unchangedOverlap(ops, 0, a.length, 0, b.length)).toBeGreaterThan(a.length / 2);
  });
  it("handles inserts, deletes and identical texts", () => {
    expect(apply("", "abc").out).toBe("abc");
    expect(apply("abc", "").out).toBe("");
    expect(diffText("same", "same")).toEqual([{ type: "equal", aStart: 0, aEnd: 4, bStart: 0, bEnd: 4 }]);
    const long = "가나다 ".repeat(300);
    expect(apply(long, long.replace(/다/g, "라")).out).toBe(long.replace(/다/g, "라"));
  });
});

describe("attribution spans (07 §7.2, INV-MV-02/03)", () => {
  it("inherits unchanged spans, attributes inserts, merges and covers the text", () => {
    const v1 = "에이전트가 쓴 문장. 사람이 쓴 문장. 끝.";
    const agent = { actorType: "agent" as const, actorId: "writer" };
    const s1 = initialSpans(v1.length, agent, "mnv_1");
    const v2 = v1.replace("사람이 쓴 문장.", "사람이 고친 문장.");
    const r2 = computeSpans(s1, diffText(v1, v2), v2.length, { actorType: "user", actorId: "usr_1" }, "mnv_2");
    expect(coversExactly(r2.spans, v2.length)).toBe(true);
    expect(r2.spans.some((s) => s.actorType === "user" && s.originVersionId === "mnv_2")).toBe(true);
    expect(r2.humanSpansChanged).toBe(false);
    // agent rewrites the user's words → INV-MV-03 conflict
    const v3 = v2.replace("고친", "다시 쓴");
    const r3 = computeSpans(r2.spans, diffText(v2, v3), v3.length, agent, "mnv_3");
    expect(r3.humanSpansChanged).toBe(true);
    expect(coversExactly(r3.spans, v3.length)).toBe(true);
    // agent edits only its own text → no conflict
    const v4 = v2.replace("끝.", "마지막.");
    expect(computeSpans(r2.spans, diffText(v2, v4), v4.length, agent, "mnv_4").humanSpansChanged).toBe(false);
    expect(lineAttribution("a\nb", initialSpans(3, agent, "x"))[0]!.actors[0]!.actorId).toBe("writer");
  });
});

describe("scene-ID retention (07 §6.3)", () => {
  const text = (parts: string[]) => parts.join("\n\n* * *\n\n");
  const ranges = (t: string, parts: string[]) => {
    let pos = 0;
    return parts.map((p, i) => {
      const start = t.indexOf(p, pos);
      const end = i + 1 < parts.length ? t.indexOf(parts[i + 1]!, start + p.length) : t.length;
      pos = end;
      return { start: i === 0 ? 0 : start, end };
    });
  };
  const A = "가".repeat(100);
  const B = "나".repeat(100);
  const C = "다".repeat(100);
  const old = (parts: string[]) => {
    const t = text(parts);
    return { t, scenes: ranges(t, parts).map((r, i) => ({ ...r, id: `scn_${i + 1}` })) };
  };

  it("keeps ids for edits inside a scene and for reordered scenes", () => {
    const o = old([A, B, C]);
    const edited = [A, B.replace("나나나", "나라나"), C];
    const t2 = text(edited);
    const r = retainSceneIds({ old: o.scenes, fresh: ranges(t2, edited), ops: diffText(o.t, t2), minOverlap: 0.5 });
    expect(r.assigned).toEqual(["scn_1", "scn_2", "scn_3"]);
    const swapped = [A, C, B];
    const t3 = text(swapped);
    const r3 = retainSceneIds({ old: o.scenes, fresh: ranges(t3, swapped), ops: diffText(o.t, t3), minOverlap: 0.5, oldText: o.t, newText: t3 });
    expect(r3.assigned).toEqual(["scn_1", "scn_3", "scn_2"]);
    expect(r3.retired).toEqual([]);
  });
  it("retires rewritten scenes and gives a new id to the smaller half of a split", () => {
    const o = old([A, B]);
    const rewritten = [A, "라".repeat(100)];
    const t2 = text(rewritten);
    const r = retainSceneIds({ old: o.scenes, fresh: ranges(t2, rewritten), ops: diffText(o.t, t2), minOverlap: 0.5 });
    expect(r.assigned).toEqual(["scn_1", null]);
    expect(r.retired).toEqual(["scn_2"]);
    const split = ["가".repeat(70), "가".repeat(30), B];
    const t3 = text(split);
    const r3 = retainSceneIds({ old: o.scenes, fresh: ranges(t3, split), ops: diffText(o.t, t3), minOverlap: 0.5 });
    expect(r3.assigned).toEqual(["scn_1", null, "scn_2"]);
  });
  it("validates writer scene breaks and maps boundaries through a diff", () => {
    expect(rangesFromSceneBreaks([{ outline_scene_key: "s1", char_start: 0 }, { outline_scene_key: "s2", char_start: 5 }], ["s1", "s2"], 10)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
    ]);
    expect(rangesFromSceneBreaks([{ outline_scene_key: "s2", char_start: 0 }], ["s1"], 10)).toBeNull();
    const o = old([A, B]);
    const t2 = text([A + "추가", B]);
    const mapped = mapRanges(o.scenes, diffText(o.t, t2), t2.length)!;
    expect(mapped[1]!.start).toBe(o.scenes[1]!.start + "추가".length);
    expect(mapped[1]!.end).toBe(t2.length);
  });
});

describe("check gate decision (07 §5.3)", () => {
  const fail = (fixScope: "span" | "scene" | "outline") => ({ source: "continuity", pass: false, fixScope, blockers: [{ refType: "continuity_issue", refId: "cis_1", message: "x", sceneId: "scn_1" }] });
  it("waits, passes, rewrites and stops at the cap", () => {
    expect(decideGate({ tasksPending: ["link_mentions"], verdicts: [], autoRewriteCount: 0, maxAutoRewrites: 2 }).kind).toBe("wait");
    expect(decideGate({ tasksPending: [], verdicts: [{ source: "f", pass: false, blockers: [], pending: true }], autoRewriteCount: 0, maxAutoRewrites: 2 }).kind).toBe("wait");
    expect(decideGate({ tasksPending: [], verdicts: [{ source: "c", pass: true, blockers: [] }], autoRewriteCount: 0, maxAutoRewrites: 2 }).kind).toBe("pass");
    const d = decideGate({ tasksPending: [], verdicts: [fail("scene")], autoRewriteCount: 0, maxAutoRewrites: 2 });
    expect(d).toMatchObject({ kind: "draft", sceneIds: ["scn_1"] });
    expect(decideGate({ tasksPending: [], verdicts: [fail("span"), fail("outline")], autoRewriteCount: 1, maxAutoRewrites: 2 }).kind).toBe("outline");
    expect(decideGate({ tasksPending: [], verdicts: [fail("scene")], autoRewriteCount: 2, maxAutoRewrites: 2 }).kind).toBe("rewrite_limit");
  });
});

describe("LLM output schemas", () => {
  it("are lenient for sparse outputs and strict on enums", () => {
    expect(outlineProposalSchema.parse({}).outline.scenes).toEqual([]);
    expect(() => safetyVerdictSchema.parse({ violations: [{ scene_ord: 1, kind: "violence" }] })).toThrow();
  });
  it("fact signature detects number / name changes only", () => {
    const a = factSignature("철수는 3명을 만났다.", ["철수", "영희"]);
    expect(signaturesEqual(a, factSignature("철수는  3명을 만났다!", ["철수", "영희"]))).toBe(true);
    expect(signaturesEqual(a, factSignature("영희는 3명을 만났다.", ["철수", "영희"]))).toBe(false);
    expect(signaturesEqual(a, factSignature("철수는 4명을 만났다.", ["철수", "영희"]))).toBe(false);
  });
});

describe("export rendering (07 §3.8)", () => {
  const ch = [
    { episodeNo: 1, title: "시작", arc: { id: "arc_1", ord: 1, title: "1부" }, content: "본문 하나\n\n* * *\n\n둘" },
    { episodeNo: 2, title: null, arc: { id: "arc_1", ord: 1, title: "1부" }, content: "본문 둘" },
  ];
  it("renders txt / markdown and keeps body counts equal to the app", () => {
    const txt = renderTxt(ch);
    expect(txt.startsWith("1화 시작\n\n본문 하나")).toBe(true);
    expect(txt).toContain("\n\n\n2화\n\n본문 둘");
    const first = txt.split("\n\n\n")[0]!;
    expect(countChars(stripTxtHeading(first), "with_spaces")).toBe(countChars(ch[0]!.content, "with_spaces"));
    const md = renderMarkdown(ch, { arcHeadings: true });
    expect(md.startsWith("# 1부\n\n## 1화 시작")).toBe(true);
    expect(md.match(/^# /gm)!.length).toBe(1);
  });
  it("builds file names in the novel timezone and strips forbidden chars", () => {
    const at = new Date("2026-11-05T15:30:00Z");
    expect(exportFileName({ novelTitle: "회귀/자: 흉터", scope: { kind: "episode", episodeNo: 7 }, at, timeZone: "Asia/Seoul", ext: "txt" })).toBe("회귀_자_ 흉터_ep007_20261106-0030.txt");
    expect(exportFileName({ novelTitle: "x", scope: { kind: "arc", arcOrd: 2 }, at, timeZone: "UTC", ext: "md" })).toBe("x_arc02_20261105-1530.md");
  });
});
