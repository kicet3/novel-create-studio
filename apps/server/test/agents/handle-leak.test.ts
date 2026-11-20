import { describe, expect, it } from "vitest";
import {
  HandleLeakError,
  NO_HANDLE_RULE,
  assertNoHandleTokens,
  findHandleTokens,
  handleLeakIssue,
  handleLeakRepairIssues,
  humanHandleTokens,
  isHandleShaped,
  leakedHandleTokens,
  replaceHandleTokens,
  rewriteHandlesDeep,
  storyHandleTokens,
} from "../../src/modules/agents/index.js";

describe("agents: a handle never stays in a stored sentence (설계 추가 0026)", () => {
  const labels = ["", "북부 검술관", "민지", "", "", "서이온", "E7", "  ", "", "", "차경혁", "민수"];

  it("knows a handle-shaped text from a real name", () => {
    for (const s of ["E6", " E11 ", "E123", "[E6]", "(E6)", "（E6）", "E6\n"]) expect(isHandleShaped(s), s).toBe(true);
    for (const s of ["", "  ", "E", "E1234", "e6", "E6은", "E3 구역", "서이온", "SE6", "E6A", "서이온(E6)", null, undefined]) expect(isHandleShaped(s), String(s)).toBe(false);
  });

  it("never substitutes a label that is empty, blank or itself handle-shaped", () => {
    const r = replaceHandleTokens("E7은 웃었다. 누군가(E7)가 왔다. E8이 갔다. E1도. E6은 남았다.", labels);
    expect(r.text).toBe("E7은 웃었다. 누군가(E7)가 왔다. E8이 갔다. E1도. 서이온은 남았다.");
    expect(r.replaced).toBe(1);
    expect(r.unresolved).toEqual(["E7", "E8", "E1"]);
    expect(replaceHandleTokens("E1이 E2를", ["[E9]", "(E2)"]).text).toBe("E1이 E2를");
  });

  it("re-agrees particles after the replaced name and drops '이름(E6)' marks", () => {
    const r = replaceHandleTokens("서이온(E6)과 민수 [E12]는 걸었다. E11이 E12에게 말했다. E6의 검은 E3로 향했다. E12과 E6를 불렀다.", labels);
    expect(r.text).toBe("서이온과 민수는 걸었다. 차경혁이 민수에게 말했다. 서이온의 검은 민지로 향했다. 민수와 서이온을 불렀다.");
    expect(r.unresolved).toEqual([]);
  });

  it("collects story tokens only from real names", () => {
    expect([...storyHandleTokens(["E3 구역", "서이온", "E11", "[E6]", null, undefined, "", "실험체 E7호", "E3 구역 E12동"])]).toEqual(["E3", "E7", "E12"]);
    expect([...storyHandleTokens(new Set(["프로젝트 E9"]))]).toEqual(["E9"]);
    expect([...humanHandleTokens("E7이 누구죠?", null, undefined, "E7, E2 고쳐 주세요")]).toEqual(["E7", "E2"]);
    expect(humanHandleTokens().size).toBe(0);
  });

  it("scans every string leaf of an output", () => {
    const value = {
      summary: "E6은 E3 구역으로 갔다.",
      beats: [{ text: "서이온이 걷는다." }, { text: "E11과 E6이 겨룬다.", entities: ["E6", "E11"] }],
      nested: { deep: { note: null, n: 3, ok: true, line: "“E12!”" } },
      povEntity: "E6",
    };
    expect(leakedHandleTokens(value, new Set(["E3"]), { skipKeys: ["entities", "povEntity"] })).toEqual([
      { path: "summary", token: "E6" },
      { path: "beats[1].text", token: "E11" },
      { path: "beats[1].text", token: "E6" },
      { path: "nested.deep.line", token: "E12" },
    ]);
    expect(leakedHandleTokens(value).map((l) => l.path)).toContain("povEntity");
    expect(leakedHandleTokens(value).map((l) => l.path)).toContain("beats[1].entities[0]");
    expect(leakedHandleTokens("E6은 갔다")).toEqual([{ path: "", token: "E6" }]);
    expect(leakedHandleTokens(["가", "E2"])).toEqual([{ path: "[1]", token: "E2" }]);
    expect(leakedHandleTokens({ a: "서이온은 SE6 등급, 2E6" })).toEqual([]);
    expect(leakedHandleTokens(null)).toEqual([]);
    expect(leakedHandleTokens(undefined)).toEqual([]);
    expect(leakedHandleTokens(42)).toEqual([]);
  });

  it("rewrites deep, keeps story tokens and reference fields, reports what is left", () => {
    const value = {
      summary: "E6은 E3 구역에서 E11을 만났다.",
      beats: [{ text: "서이온(E6)이 E99를 본다.", entities: ["E6"] }, { text: "E7은 모른다." }],
      count: 2,
    };
    const r = rewriteHandlesDeep(value, labels, new Set(["E3"]), { skipKeys: ["entities"] });
    expect(r.value).toEqual({
      summary: "서이온은 E3 구역에서 차경혁을 만났다.",
      beats: [{ text: "서이온이 E99를 본다.", entities: ["E6"] }, { text: "E7은 모른다." }],
      count: 2,
    });
    expect(r.replaced).toBe(3);
    expect(r.unresolved).toEqual([
      { path: "beats[0].text", token: "E99" },
      { path: "beats[1].text", token: "E7" },
    ]);
    // the input is not mutated
    expect(value.summary).toBe("E6은 E3 구역에서 E11을 만났다.");
    expect(rewriteHandlesDeep("E12이 왔다", labels)).toEqual({ value: "민수가 왔다", replaced: 1, unresolved: [] });
    // no labels (pack stored before 0025): nothing replaced, everything unresolved
    expect(rewriteHandlesDeep({ a: "E6은" }, [])).toEqual({ value: { a: "E6은" }, replaced: 0, unresolved: [{ path: "a", token: "E6" }] });
  });

  it("builds the Korean repair message", () => {
    expect(handleLeakIssue(["E7"])).toBe("문장에 'E7' 같은 기호가 남아 있습니다. 'E숫자' 기호는 이름이 아닙니다. 기호 대신 인물·장소의 실제 이름을 쓰세요.");
    expect(handleLeakIssue([{ path: "a", token: "E7" }, { path: "b", token: "E7" }, "E2", "E3", "E4"])).toContain("'E7', 'E2', 'E3' 같은 기호");
    expect(handleLeakIssue([])).toContain("'E7' 같은 기호");
    expect(handleLeakRepairIssues([{ path: "summary", token: "E6" }, { path: "beats[1].text", token: "E11" }, { path: "summary", token: "E2" }, { path: "", token: "E5" }], "계획")).toEqual([
      { item: "계획 summary", problem: handleLeakIssue(["E6", "E2"]) },
      { item: "계획 beats[1].text", problem: handleLeakIssue(["E11"]) },
      { item: "계획", problem: handleLeakIssue(["E5"]) },
    ]);
    expect(handleLeakRepairIssues([])).toEqual([]);
    expect(findHandleTokens(NO_HANDLE_RULE)).toEqual(["E7"]);
  });

  it("guards a storage point", () => {
    expect(() => assertNoHandleTokens({ body: "서이온은 E3 구역으로 갔다." }, "manuscript body", new Set(["E3"]))).not.toThrow();
    expect(() => assertNoHandleTokens({ ref: "E6", body: "서이온" }, "plan", new Set(), { skipKeys: ["ref"] })).not.toThrow();
    let err: unknown;
    try {
      assertNoHandleTokens({ body: "E6은 E3 구역으로 갔다." }, "manuscript body", new Set(["E3"]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HandleLeakError);
    expect((err as HandleLeakError).leaks).toEqual([{ path: "body", token: "E6" }]);
    expect((err as HandleLeakError).what).toBe("manuscript body");
    expect((err as HandleLeakError).message).toBe("entity handle left in stored text (manuscript body): body=E6");
  });
});
