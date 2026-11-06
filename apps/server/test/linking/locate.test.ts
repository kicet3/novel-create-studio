import { describe, expect, it } from "vitest";
import { locateInText } from "../../src/modules/linking/domain/text.js";

describe("locateInText — fuzzy fallbacks never land inside a different (longer) name", () => {
  const t = "서진우가 문을 열었다. 서진은 웃었다. 서진우는 말했다.";
  it("josa-stripped stem only matches whole words / name + particle", () => {
    const r = locateInText("서진우가 문을 열었다. 서진우는 말했다.", { surface: "서진이", charStart: 0, mentionKind: "named" });
    expect(r.ok).toBe(false);
    const ok = locateInText(t, { surface: "서진이", charStart: 0, mentionKind: "named" });
    expect(ok).toMatchObject({ ok: true, start: 13, end: 15 });
  });
  it("nearest prefers word-bounded occurrences over a prefix of a longer name", () => {
    const r = locateInText(t, { surface: "서진", charStart: 1, mentionKind: "named" });
    expect(r).toMatchObject({ ok: true, start: 13, end: 15 });
  });
  it("repeated name with a scene-leading newline the model did not count (+1 drift)", () => {
    const s = "\n서이온은 걸었다. 서이온이 멈췄다.";
    expect(locateInText(s, { surface: "서이온", charStart: 0, charEnd: 3, mentionKind: "named" })).toMatchObject({ ok: true, start: 1, how: "nearest" });
  });
});

import { checkExtraction, normalizeEntityType } from "../../src/modules/linking/domain/extraction-check.js";
import { extractionResultSchema } from "../../src/modules/linking/domain/schemas.js";

describe("entity_type_hint must be a schema type (live: 'location' broke entity creation)", () => {
  const enabled = new Set(["character", "place", "organization", "item", "ability", "title", "event", "rule"]);
  it("aliases map to schema keys; unknown types are flagged, absent stays null", () => {
    expect(normalizeEntityType("location", enabled)).toBe("place");
    expect(normalizeEntityType("Organization", enabled)).toBe("organization");
    expect(normalizeEntityType("spaceship", enabled)).toBe(false);
    expect(normalizeEntityType(null, enabled)).toBeNull();
  });
  it("an unknown type becomes a critique issue (the producer fixes it in the repair dialogue)", () => {
    const ex = extractionResultSchema.parse({ mentions: [{ local_key: "m1", scene_ord: 1, surface: "판정소", mention_kind: "named", entity_type_hint: "spaceship" }, { local_key: "m2", scene_ord: 1, surface: "판정소", mention_kind: "named", entity_type_hint: "location" }] });
    const c = checkExtraction([{ sceneOrd: 1, text: "판정소에 갔다.", charOffset: 0 }], ex, { entityTypes: enabled });
    expect(c.unlocated).toEqual([]);
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.problem).toContain("spaceship");
  });
});
