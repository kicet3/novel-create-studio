/** Review regression: F11 range_close must not cut a published fact before its last published mention (03 §4.8 F11·F8). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { facts, factVersions } from "@ncs/db/schema";
import type { CandidateFactDraft, OntologyService } from "../../src/modules/ontology/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";

let t: TestCore;
let svc: OntologyService;
beforeAll(async () => {
  t = await createTestCore();
  svc = t.modules.ontology.service;
}, 60_000);
afterAll(() => t.close());

async function setup(title: string, mentionPoint: number) {
  const n = await t.modules.novel.service.createNovel({ title }, t.owner);
  const scope = { novelId: n.id };
  const tl = (await svc.getDefaultTimeline(scope)).id;
  const mk = (name: string, type: string = "character") =>
    t.platform.uow.run(async (tx) => (await svc.createEntity(tx, scope, { entityType: type as never, preferredName: { surface: name }, status: "active" }, t.owner)).entity);
  const a = await mk("서준");
  const p = await mk("왕도", "place");
  const q = await mk("북부", "place");
  const { mentionIds } = await t.platform.uow.run((tx) =>
    svc.writeMentions(tx, scope, [{ sourceKind: "user_input", storyPoint: mentionPoint, timelineId: tl, surface: "서준", mentionKind: "named", candidates: [], linkedEntityId: a.id, confidence: 1, linkStatus: "auto_linked", linkerVersion: "t" }], t.owner),
  );
  const d = (f: Record<string, unknown>, from: number): CandidateFactDraft =>
    ({ factKind: "state", timelineId: tl, storyRange: { from, to: null }, sourceKind: "user_input", source: { refType: "novel", refId: "x" }, subjectEntityId: a.id, predicate: "located_at", ...f }) as never;
  await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [d({ objectEntityId: p.id, episodeId: "epi_1", mentionIds }, 1001)], t.owner));
  await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, "epi_1", "approved", t.owner));
  await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, "epi_1", "published_locked", t.owner));
  return { scope, d, q };
}

describe("F11 range_close vs published mentions", () => {
  it("holds the successor as retcon_required when it would close the published fact before its mention", async () => {
    const { scope, d, q } = await setup("F11-a", 1800);
    await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [d({ objectEntityId: q.id, episodeId: "epi_3" }, 1500)], t.owner));
    const pr = await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, "epi_3", "approved", t.owner));
    const rows = await t.testDb.db.select().from(facts).where(eq(facts.novelId, scope.novelId));
    const pub = rows.find((r) => r.canonStatus === "published_locked")!;
    expect(pub.storyRange).toMatch(/^\[1001,\)$/);
    const closes = await t.testDb.db.select().from(factVersions).where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.changeReason, "range_close")));
    expect(closes).toHaveLength(0);
    expect(pr.held).toHaveLength(1);
    expect(rows.find((r) => r.id === pr.held[0])!.canonStatus).toBe("candidate");
    const audit = await t.testDb.query<{ details: { held?: Record<string, string> } }>(`SELECT details FROM activity_log WHERE novel_id = '${scope.novelId}' AND action = 'fact.status_changed' ORDER BY created_at DESC LIMIT 1`);
    expect(audit[0]!.details.held?.[pr.held[0]!]).toBe("retcon_required");
  });

  it("still closes the published fact when the successor starts after the last published mention", async () => {
    const { scope, d, q } = await setup("F11-b", 1200);
    await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [d({ objectEntityId: q.id, episodeId: "epi_3" }, 1500)], t.owner));
    await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, "epi_3", "approved", t.owner));
    const closes = await t.testDb.db.select().from(factVersions).where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.changeReason, "range_close")));
    expect(closes).toHaveLength(1);
  });
});
