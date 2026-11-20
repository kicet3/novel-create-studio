import { describe, expect, it } from "vitest";
import { findHandleTokens, renderEntityRefs, replaceHandleTokens } from "../../src/modules/agents/domain/handle-text.js";
import { entityRefResolver } from "../../src/modules/manuscript/application/writing.js";

const A = "ent_01J0000000000000000000000A";
const B = "ent_01J0000000000000000000000B";

describe("agents: entity handles never reach sentences (설계 추가 0025)", () => {
  const labels = ["", "", "", "", "", "서이온", "", "", "", "", "차경혁", "민수"];

  it("renders names in sentences; reference marks only for roles that fill entity fields", () => {
    const o = { nameOf: (id: string) => (id === A ? "서이온" : "차경혁"), handleOf: (id: string) => (id === A ? "E1" : "E2") };
    const text = `- 서이온 [{{E!:${A}}}] (인물)\n- [주인공] 차경혁 ({{E!:${B}}}) — 라이벌\n- {{E:${A}}} 무릎을 다쳤다`;
    expect(renderEntityRefs(text, { ...o, marks: true })).toBe("- 서이온 [E1] (인물)\n- [주인공] 차경혁 (E2) — 라이벌\n- 서이온 무릎을 다쳤다");
    expect(renderEntityRefs(text, { ...o, marks: false })).toBe("- 서이온 (인물)\n- [주인공] 차경혁 — 라이벌\n- 서이온 무릎을 다쳤다");
  });

  it("rewrites leaked handle tokens into names and re-agrees the particle", () => {
    const r = replaceHandleTokens("서이온(E6)의 시점. E6은 물러났다. E11과는 지겹도록 겨뤘다. “E6!” E12이 웃었다. E12을 보았다. E12으로 갔다.", labels);
    expect(r.text).toBe("서이온의 시점. 서이온은 물러났다. 차경혁과는 지겹도록 겨뤘다. “서이온!” 민수가 웃었다. 민수를 보았다. 민수로 갔다.");
    expect(r.unresolved).toEqual([]);
    expect(r.replaced).toBe(7);
  });

  it("leaves the copula, unknown handles and look-alikes alone", () => {
    expect(replaceHandleTokens("범인은 E12이었다. E6였다. E12이라는 소년. E6라고 불렸다. E6로서는 E12다.", labels).text).toBe("범인은 민수였다. 서이온이었다. 민수라는 소년. 서이온이라고 불렸다. 서이온으로서는 민수다.");
    // names with a space, an alias before the mark, and story tokens the input itself uses
    expect(replaceHandleTokens("북부 검술관 [E2]에서, 이온(E6)이 E3 구역으로.", ["", "북부 검술관", "민지", "", "", "서이온"], new Set(["E3"])).text).toBe("북부 검술관에서, 이온이 E3 구역으로.");
    const r = replaceHandleTokens("E99는 없다. E1은 이름이 없다. 등급 SE6, E6A, 2E6.", labels);
    expect(r.text).toBe("E99는 없다. E1은 이름이 없다. 등급 SE6, E6A, 2E6.");
    expect(r.unresolved).toEqual(["E99", "E1"]);
    expect(findHandleTokens("E6은 E11을, 다시 E6이")).toEqual(["E6", "E11"]);
    expect(replaceHandleTokens("E6", []).text).toBe("E6");
  });

  it("resolves outline entity references through the pack (handle, id, exact card name)", () => {
    const of = entityRefResolver({ handles: { entities: [A, B], names: [], labels: ["서이온", "차경혁"] } });
    expect(of("E2")).toBe(B);
    expect(of("[E1]")).toBe(A);
    expect(of(A)).toBe(A);
    expect(of("차경혁")).toBe(B);
    expect(of("서이온 [E1]")).toBe(A);
    expect(of("e2 (차경혁)")).toBe(B);
    expect(of("차경혁 (인물)")).toBe(B);
    expect(of("E9")).toBeNull();
    expect(of("ent_01J0000000000000000000000Z")).toBeNull();
    expect(of("모르는 이름")).toBeNull();
    expect(of(null)).toBeNull();
  });
});
