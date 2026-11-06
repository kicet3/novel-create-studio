/**
 * Golden linking seeds G01 / G03 / G18 (06 §12.2), deterministic (no model). The full seed format
 * (packages/test-kit/golden/linking/) belongs to test-kit; these are the MA-2 gate seeds in executable form.
 */
import type { NovelScope } from "../../src/platform/index.js";
import type { LinkerInputMention } from "../../src/modules/linking/index.js";
import type { TestCore } from "../support/test-core.js";

type Tc = TestCore;

async function entity(t: Tc, scope: NovelScope, type: string, name: string, extra: { disambiguator?: string; names?: Array<{ surface: string; nameKind: "title" | "alias" }> } = {}): Promise<string> {
  return t.platform.uow.run(async (tx) => {
    const r = await t.modules.ontology.service.createEntity(tx, scope, { entityType: type as never, preferredName: { surface: name }, status: "active", disambiguator: extra.disambiguator }, t.owner);
    for (const n of extra.names ?? []) await t.modules.ontology.service.addEntityName(tx, scope, r.entity.id, { ...n, status: "active" }, t.owner);
    return r.entity.id;
  });
}

async function canon(t: Tc, scope: NovelScope, tl: string, f: { subject: string; predicate: string; object?: string; value?: unknown; from: number; to?: number | null; kind?: "relation" | "state" | "attribute" }) {
  await t.platform.uow.run((tx) =>
    t.modules.ontology.service.writeCandidateFacts(
      tx,
      scope,
      [
        {
          factKind: f.kind ?? "relation",
          subjectEntityId: f.subject,
          predicate: f.predicate,
          objectEntityId: f.object ?? null,
          value: f.value,
          timelineId: tl,
          storyRange: { from: f.from, to: f.to ?? null },
          sourceKind: "user_input",
          source: { refType: "novel", refId: scope.novelId },
          canonStatus: "approved",
        },
      ],
      t.owner,
    ),
  );
}

/** G01 칭호 승계: 선왕 아르센 [0,10003) 사망 10003, 레온 [10003,) — "폐하" at 5001 / 12001 */
export const G01 = {
  async load(t: Tc, scope: NovelScope, tl: string) {
    const old = await entity(t, scope, "character", "아르센");
    const heir = await entity(t, scope, "character", "레온");
    const crown = await entity(t, scope, "title", "국왕", { names: [{ surface: "폐하", nameKind: "title" }] });
    await canon(t, scope, tl, { subject: old, predicate: "holds_title", object: crown, from: 0, to: 10003 });
    await canon(t, scope, tl, { subject: old, predicate: "life_status", value: "dead", from: 10003, kind: "state" });
    await canon(t, scope, tl, { subject: heir, predicate: "holds_title", object: crown, from: 10003 });
    return { old, heir, crown };
  },
  mentions(_tl: string): LinkerInputMention[] {
    return [
      { surface: "폐하", charStart: 0, charEnd: 2, sceneId: "", storyPoint: 5001, mentionKind: "title" },
      { surface: "폐하", charStart: 0, charEnd: 2, sceneId: "", storyPoint: 12001, mentionKind: "title" },
    ];
  },
  expected(s: { old: string; heir: string; crown: string }) {
    return [
      [5001, "auto_linked", s.old, s.crown],
      [12001, "auto_linked", s.heir, s.crown],
    ];
  },
};

/** G03 동명 가문: 남궁세가(본가) / 남궁세가(분가) */
export const G03 = {
  async load(t: Tc, scope: NovelScope, _tl: string) {
    const main = await entity(t, scope, "organization", "남궁세가", { disambiguator: "본가" });
    const branch = await entity(t, scope, "organization", "남궁세가", { disambiguator: "분가" });
    return { main, branch };
  },
  mentions(): LinkerInputMention[] {
    return [{ surface: "남궁세가", charStart: 0, charEnd: 4, sceneId: "", storyPoint: 3001, mentionKind: "named" }];
  },
};

/** G18 스키마 위반: 생부 2명(CR-09), 사망 후 혼인(CR-11) */
export const G18 = {
  async load(t: Tc, scope: NovelScope, tl: string) {
    const child = await entity(t, scope, "character", "이안");
    const f1 = await entity(t, scope, "character", "카인");
    const f2 = await entity(t, scope, "character", "도르안");
    const wife = await entity(t, scope, "character", "세라");
    const w = (f: Parameters<typeof canon>[3]) =>
      t.platform.uow.run((tx) =>
        t.modules.ontology.service.writeCandidateFacts(
          tx,
          scope,
          [{ factKind: f.kind ?? "relation", subjectEntityId: f.subject, predicate: f.predicate, objectEntityId: f.object ?? null, value: f.value, timelineId: tl, storyRange: { from: f.from, to: f.to ?? null }, sourceKind: "user_input", source: { refType: "novel", refId: scope.novelId } }],
          t.owner,
        ),
      );
    await w({ subject: f1, predicate: "father_of", object: child, from: 0 });
    await w({ subject: f2, predicate: "father_of", object: child, from: 0 });
    await w({ subject: f1, predicate: "life_status", value: "dead", from: 5000, kind: "state" });
    await w({ subject: f1, predicate: "spouse_of", object: wife, from: 6000 });
  },
  /** spouse_of is symmetric (stored subject<object), so the dead party may be subject or object */
  expected: [/^CR-09:base@1:father_of:max_per_object$/, /^CR-11:base@1:spouse_of:no_new_after_(subject|object)_death$/],
};
