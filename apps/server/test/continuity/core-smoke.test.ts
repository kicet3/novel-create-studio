import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, type TestCore } from "../support/test-core.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
}, 60_000);
afterAll(() => t.close());

describe("continuity + foreshadow inside the full server core", () => {
  it("boots implemented, serves the §13 routes and the home summary", async () => {
    expect(t.modules.continuity.implemented).toBe(true);
    expect(t.modules.foreshadow.implemented).toBe(true);
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const base = `/api/novels/${novel.id}`;
    const issues = await t.http("GET", `${base}/continuity-issues?status=open`);
    expect(issues).toEqual({ status: 200, body: { items: [] } });
    expect((await t.http("GET", `${base}/continuity-issues/cis_01JABCDEFGHJKMNPQRSTVWXYZ0`)).status).toBe(404);
    expect(await t.http("GET", `${base}/setups`)).toEqual({ status: 200, body: { items: [] } });
    const report = await t.http("GET", `${base}/setups/report`);
    expect(report.status).toBe(200);
    expect(report.body.r5Metrics.payoffRate).toEqual({ value: null, numerator: 0, denominator: 0 });
    const home = await t.http("GET", `${base}/home`);
    expect(home.status).toBe(200);
    expect(home.body.continuityIssues).toEqual({ high: 0, medium: 0, low: 0 });
    expect(home.body.setupsDueSoon).toEqual([]);
  });
});
