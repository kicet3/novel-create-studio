/** 설계 추가(수정 반영): pure planning of fact reconciliation after a text edit (revision/domain/reconcile.ts). */
import { describe, expect, it } from "vitest";
import { evidenceSentence, planReconcile, previewFactEffects } from "../../src/modules/revision/domain/reconcile.js";

const old = (factId: string, predicate: string, sentences: string[], extra: Partial<{ canonStatus: string; groundedElsewhere: boolean; heldSuccessor: boolean }> = {}) => ({
  factId,
  canonStatus: extra.canonStatus ?? "approved",
  subjectEntityId: "ent_a",
  predicate,
  sentences,
  groundedElsewhere: extra.groundedElsewhere ?? false,
  heldSuccessor: extra.heldSuccessor ?? false,
});

describe("evidenceSentence", () => {
  it("returns the sentence around a mention", () => {
    const text = "첫 문장이다. 서율은 늘 반말을 썼다. 마지막.";
    const at = text.indexOf("서율");
    expect(evidenceSentence(text, at, at + 2)).toBe("서율은 늘 반말을 썼다");
  });
});

describe("planReconcile", () => {
  const text = "서율은 늘 존댓말을 썼다. 서율은 살아 있었다.";
  it("keeps supported facts, pairs one lost / one gained value of the same predicate, retracts the rest", () => {
    const plan = planReconcile(
      [old("f_alive", "life_status", ["서율은 살아 있었다"]), old("f_ban", "personality", ["서율은 늘 반말을 썼다"]), old("f_gender", "gender", ["서율은 키가 큰 사내였다"])],
      [{ factId: "f_jon", subjectEntityId: "ent_a", predicate: "personality", conflictWith: null }],
      text,
    );
    expect(plan.kept).toEqual(["f_alive"]);
    expect(plan.retire).toEqual([
      { factId: "f_ban", canonStatus: "approved", successor: "f_jon" },
      { factId: "f_gender", canonStatus: "approved", successor: null },
    ]);
  });

  it("a conflict on a single-valued slot is the successor; facts grounded elsewhere or without evidence stay", () => {
    const plan = planReconcile(
      [old("f_f", "gender", ["서율은 여인이었다"]), old("f_x", "gender", ["다른 화 문장"], { groundedElsewhere: true }), old("f_none", "age", [])],
      [{ factId: "f_m", subjectEntityId: "ent_a", predicate: "gender", conflictWith: "f_f" }],
      text,
    );
    expect(plan.kept.sort()).toEqual(["f_none", "f_x"]);
    expect(plan.retire).toEqual([{ factId: "f_f", canonStatus: "approved", successor: "f_m" }]);
  });

  it("ambiguous pairing (two lost, one gained) retracts without a successor", () => {
    const plan = planReconcile(
      [old("a", "personality", ["서율은 겁이 많았다"]), old("b", "personality", ["서율은 말이 없었다"])],
      [{ factId: "n", subjectEntityId: "ent_a", predicate: "personality", conflictWith: null }],
      text,
    );
    expect(plan.retire.map((r) => r.successor)).toEqual([null, null]);
  });
});

describe("planReconcile (pending replacement)", () => {
  it("a held replacing candidate is not paired: the newer value replaces the approved fact", () => {
    const plan = planReconcile(
      [old("a", "personality", ["서율은 늘 반말을 썼다"]), old("b", "personality", ["서율은 늘 존댓말을 썼다"], { canonStatus: "candidate", heldSuccessor: true })],
      [{ factId: "c", subjectEntityId: "ent_a", predicate: "personality", conflictWith: null }],
      "서율은 늘 해요체를 썼다.",
    );
    expect(plan.retire).toEqual([
      { factId: "a", canonStatus: "approved", successor: "c" },
      { factId: "b", canonStatus: "candidate", successor: null },
    ]);
  });
});

describe("previewFactEffects", () => {
  it("an expected keep never asks for confirmation", () => {
    const cur = "서율은 늘 반말을 썼다. 끝.";
    const quote = "서율은 늘 반말을 썼다.";
    const replacement = "서율이 반말을 쓴다는 소문이 돌았다.";
    const fx = previewFactEffects(
      [{ factId: "ban", canonStatus: "approved", text: "성격: 반말", valueText: "반말을 쓴다", surfaces: ["서율"], sentences: ["서율은 늘 반말을 썼다"] }],
      cur,
      cur.replace(quote, replacement),
      [{ start: 0, end: quote.length, replacement }],
    );
    expect(fx.map((e) => [e.effect, e.needsConfirm])).toEqual([["keep", false]]);
  });

  it("judges each fact by the patch covering its sentence; untouched facts are not listed", () => {
    const cur = "서율은 늘 반말을 썼다. 서율은 키가 큰 사내였다. 서율은 살아 있었다.";
    const p1 = { quote: "서율은 늘 반말을 썼다.", replacement: "서율은 늘 존댓말을 썼다." };
    const p2 = { quote: "서율은 키가 큰 사내였다.", replacement: "" };
    const patches = [p1, p2].map((p) => ({ start: cur.indexOf(p.quote), end: cur.indexOf(p.quote) + p.quote.length, replacement: p.replacement }));
    const next = cur.replace(p1.quote, p1.replacement).replace(p2.quote, p2.replacement);
    const fx = previewFactEffects(
      [
        { factId: "ban", canonStatus: "approved", text: "성격: 반말", valueText: "반말을 쓴다", surfaces: ["서율"], sentences: ["서율은 늘 반말을 썼다"] },
        { factId: "gen", canonStatus: "candidate", text: "성별: 남성", valueText: "남성", surfaces: ["서율"], sentences: ["서율은 키가 큰 사내였다"] },
        { factId: "alive", canonStatus: "approved", text: "생존", valueText: "alive", surfaces: ["서율"], sentences: ["서율은 살아 있었다"] },
      ],
      cur,
      next,
      patches,
    );
    expect(fx.map((e) => [e.factId, e.effect, e.certain, e.needsConfirm])).toEqual([
      ["ban", "change", false, true],
      ["gen", "retract", false, false],
    ]);
  });
});
