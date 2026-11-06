import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { actors, AppError, DomainValidationError, InvalidTransitionError } from "../../src/platform/index.js";
import { assertIssueTransition, userTransitionsFrom } from "../../src/modules/continuity/domain/transitions.js";
import { dedupeKeyOf, planReconcile, adjustSeverity } from "../../src/modules/continuity/domain/rules.js";
import { mountContinuityRoutes } from "../../src/modules/continuity/adapters/http/routes.js";
import { mountForeshadowRoutes } from "../../src/modules/foreshadow/adapters/http/routes.js";
import { createHarness, type Harness } from "../foreshadow/harness.js";

const user = actors.user("usr_1");
const editor = actors.agent("continuity_editor", "run_1");
const showrunner = actors.agent("showrunner", "run_1");

describe("ContinuityIssue state machine (03 §4.6, INV-CI-03..05)", () => {
  const g = (over: Partial<Parameters<typeof assertIssueTransition>[0]>) => assertIssueTransition({ from: "open", to: "waived", kind: "appearance", severity: "medium", actor: user, ...over });
  it("C2–C8 table", () => {
    expect(g({ to: "fixing", actor: actors.system("orchestrator") }).id).toBe("C2");
    expect(g({ from: "fixing", to: "resolved", actor: editor, resolutionKind: "rewritten" }).id).toBe("C3");
    expect(g({ from: "fixing", to: "open", actor: editor }).id).toBe("C4");
    expect(g({ to: "resolved", resolutionKind: "human_edited", humanEditAfterIssue: true }).id).toBe("C5");
    expect(g({}).id).toBe("C6");
    expect(g({ to: "false_positive" }).id).toBe("C7");
    expect(g({ from: "fixing", to: "superseded", actor: actors.system("orchestrator") }).id).toBe("C8");
    expect(() => g({ from: "resolved", to: "open" })).toThrow(InvalidTransitionError);
    expect(() => g({ from: "waived", to: "resolved", resolutionKind: "human_edited" })).toThrow(InvalidTransitionError);
  });
  it("guards", () => {
    // INV-CI-03: high → user only; medium/low → designated agent allowed
    expect(() => g({ severity: "high", actor: showrunner })).toThrow(/사용자만/);
    expect(g({ severity: "medium", actor: showrunner }).id).toBe("C6");
    expect(() => g({ severity: "low", actor: editor })).toThrow(DomainValidationError); // C6 is showrunner's
    expect(g({ to: "false_positive", severity: "low", actor: editor }).id).toBe("C7");
    expect(g({ severity: "high" }).id).toBe("C6");
    // INV-CI-05
    expect(() => g({ kind: "safety_minor_sexual", severity: "high" })).toThrow(/안전/);
    expect(() => g({ kind: "safety_real_person", to: "false_positive" })).toThrow(/안전/);
    // INV-CI-04
    expect(() => g({ kind: "published_canon_conflict", severity: "high" })).toThrow(/리트콘/);
    expect(g({ kind: "published_canon_conflict", severity: "high", retconApprovalId: "apr_1" }).id).toBe("C6");
    expect(() => g({ kind: "published_canon_conflict", to: "false_positive", retconApprovalId: "apr_1" })).toThrow(/리트콘/);
    // resolution kinds
    expect(() => g({ from: "fixing", to: "resolved", actor: editor })).toThrow(/해결 방식/);
    expect(() => g({ from: "fixing", to: "resolved", actor: editor, resolutionKind: "auto_fixed" })).toThrow(/diff/);
    expect(g({ from: "fixing", to: "resolved", actor: editor, resolutionKind: "auto_fixed", autoFixDiff: { before: "a", after: "b" } }).id).toBe("C3");
    expect(() => g({ to: "resolved", resolutionKind: "rewritten" })).toThrow(DomainValidationError);
    expect(() => g({ to: "fixing" })).toThrow(/시스템/);
    expect(userTransitionsFrom({ status: "open", kind: "safety_age_rating" })).toEqual([]);
    // C5 by a user (INV-CI-04/05): evidence of a human edit / an approval is required, safety never
    expect(() => g({ to: "resolved", resolutionKind: "human_edited" })).toThrow(/직접 고친 버전/);
    expect(() => g({ to: "resolved", resolutionKind: "human_edited", humanEditAfterIssue: true, kind: "safety_age_rating", severity: "high" })).toThrow(/안전/);
    expect(() => g({ to: "resolved", resolutionKind: "retconned" })).toThrow(/리트콘/);
    expect(g({ to: "resolved", resolutionKind: "retconned", retconApprovalId: "apr_1" }).id).toBe("C5");
    expect(() => g({ to: "resolved", resolutionKind: "canon_updated" })).toThrow(/캐논 변경/);
    expect(() => g({ to: "resolved", resolutionKind: "human_edited", humanEditAfterIssue: true, kind: "published_canon_conflict" })).toThrow(/리트콘/);
    expect(g({ to: "resolved", resolutionKind: "human_edited", actor: editor }).id).toBe("C5"); // system recheck path
    expect(userTransitionsFrom({ status: "open", kind: "published_canon_conflict" })).toEqual(["resolved", "waived"]);
  });
  it("dedupe key, severity adjustment and reconcile plan", () => {
    const k1 = dedupeKeyOf("epi_1", "death_state", "CR-01", ["fct_b", "fct_a"], ["ent_1"]);
    expect(k1).toBe(dedupeKeyOf("epi_1", "death_state", "CR-01", ["fct_a", "fct_b", "fct_a"], ["ent_1"]));
    expect(k1).not.toBe(dedupeKeyOf("epi_1", "death_state", "CR-01", ["fct_a"], ["ent_1"]));
    expect(k1.startsWith("epi_1:death_state:")).toBe(true);
    expect(adjustSeverity("appearance", "high", ["candidate", "candidate"])).toBe("low");
    expect(adjustSeverity("appearance", "high", ["candidate", "approved"])).toBe("high");
    expect(adjustSeverity("answer_constraint", "high", ["candidate"])).toBe("high");
    const t = (h: number) => new Date(1000 * h);
    const steps = planReconcile(
      [{ dedupeKey: "a" }, { dedupeKey: "b" }, { dedupeKey: "c" }, { dedupeKey: "a" }, { dedupeKey: "d" }],
      [
        { id: "i1", dedupeKey: "a", status: "fixing", manuscriptVersionId: "v1", createdAt: t(1) },
        { id: "i2", dedupeKey: "b", status: "waived", manuscriptVersionId: "v1", createdAt: t(1) },
        { id: "i3", dedupeKey: "x", status: "open", manuscriptVersionId: "v1", createdAt: t(1) },
        { id: "i4", dedupeKey: "y", status: "open", manuscriptVersionId: "v2", createdAt: t(1) },
        { id: "i5", dedupeKey: "d", status: "resolved", manuscriptVersionId: "v1", createdAt: t(1) },
      ],
      "v2",
    );
    expect(steps.map((s) => [s.op, "issueId" in s ? s.issueId : null])).toEqual([
      ["relink", "i1"],
      ["skip_waived", "i2"],
      ["create", null],
      ["create", null],
      ["resolve", "i3"],
    ]);
    expect(steps[0]).toMatchObject({ reopen: true });
    expect(steps[3]).toMatchObject({ previousIssueId: "i5" });
  });
});

describe("check_continuity + issue lifecycle (07 §5.1, §5.3)", () => {
  let h: Harness;
  let arcId: string;
  let ep: string;
  let v1: { versionId: string; sceneIds: string[] };
  let deadId: string;
  let issues: Awaited<ReturnType<Harness["continuity"]["listIssues"]>>;
  beforeAll(async () => {
    h = await createHarness();
    arcId = await h.createArc(1, 5, "active");
    ep = await h.createEpisode(arcId, 1);
    v1 = await h.createVersion(ep, "죽은 백작이 문을 열고 들어왔다. 그는 웃었다.\n둘째 씬에서 비가 왔다.", { scenes: [[0, 26], [26, 39]] });
    deadId = await h.createEntity();
    const leakEntity = await h.createEntity();
    const dead = await h.createFact(deadId, "life_status", "dead", { text: "백작은 사망했다" });
    const eyes = await h.createFact(deadId, "appearance.eye_color", "blue", { text: "백작의 눈은 파랗다" });
    const rule = await h.createFact(leakEntity, "rule_statement", "마법은 밤에만", { factKind: "rule", text: "마법은 밤에만 쓸 수 있다" });
    const bad = await h.createFact(leakEntity, "spouse_of", "x", { canonStatus: "candidate" });
    h.ontology.mentions = [
      { id: "mnt_1", linkedEntityId: deadId, linkStatus: "auto_linked", sceneId: v1.sceneIds[0], charStart: 0, charEnd: 5, surface: "죽은 백작", narrativeFrameId: null },
      { id: "mnt_2", linkedEntityId: leakEntity, linkStatus: "confirmed", sceneId: v1.sceneIds[1], charStart: 27, charEnd: 30, surface: "가면 기사", narrativeFrameId: null },
    ];
    h.ontology.canon = [dead, eyes, rule];
    h.ontology.leaks = [{ mentionId: "mnt_2", nameId: "enm_1", viewer: leakEntity, message: "정체를 모르는 인물이 본명을 부릅니다." }];
    h.ontology.violations = [{ factId: bad.factId, rule: "cardinality:spouse_of", message: "배우자는 한 명만 둘 수 있습니다." }];
  }, 60_000);
  afterAll(() => h.close());

  async function runCheck(versionId: string, responder: Parameters<Harness["llm"]>[0], factIds?: string[]) {
    const handler = h.reg.taskHandlers.get("check_continuity");
    const run = await h.createRun("check_continuity", "continuity_editor", "episode", ep);
    const input = { episode_id: ep, manuscript_version_id: versionId, fact_ids: factIds };
    const llm = h.llm(responder);
    const proposal = await handler.execute(run, input, h.context, llm);
    const outcome: any = await h.tx((tx) => handler.commit(tx, run, input, proposal, run.task));
    return { proposal, outcome, llm, run };
  }

  it("prefilter + LLM verdicts open issues with evidence and location; the gate blocks on high issues", async () => {
    const factIds = h.ontology.violations.map((v) => v.factId);
    const { proposal, outcome, llm } = await runCheck(
      v1.versionId,
      (input) => {
        const prompt = input.messages.at(-1)!.content;
        const cands = [...prompt.matchAll(/\[CANDIDATE\] id=(C\d+) rule=(\S+)/g)].map((m) => ({ id: m[1]!, rule: m[2]! }));
        const fEyes = /(F\d+): 백작의 눈은 파랗다/.exec(prompt)![1];
        return {
          verdicts: cands.map((c) => (c.rule === "CR-01" ? { candidate_id: c.id, verdict: "violation", message: "사망한 백작이 걸어 들어옵니다.", quote: "죽은 백작이 문을 열고 들어왔다.", fix_scope: "scene" } : { candidate_id: c.id, verdict: "not_violation" })),
          issues: [
            { kind: "appearance", severity: "medium", quote: "그는 웃었다.", message: "눈 색 묘사가 캐논과 다릅니다.", evidence: [fEyes] },
            { kind: "relationship", severity: "high", message: "근거 없는 의심", evidence: [] }, // dropped (INV-CI-01)
          ],
        };
      },
      factIds,
    );
    expect(llm.inputs[0]!.output).toMatchObject({ kind: "object", schemaName: "ContinuityReview" });
    expect(proposal.drafts.map((d: any) => d.kind).sort()).toEqual(["appearance", "death_state", "identity_leak", "schema_violation"]);
    expect(outcome.kind).toBe("done");
    expect(h.calls.advanceCheckGate).toContain(ep);
    issues = await h.continuity.listIssues(h.scope, { episodeId: ep });
    expect(issues).toHaveLength(4);
    const byKind = Object.fromEntries(issues.map((i) => [i.kind, i]));
    expect(byKind.death_state).toMatchObject({ severity: "high", status: "open", detector: "continuity_editor", sceneId: v1.sceneIds[0], charStart: 0, fixScope: "scene" });
    expect(byKind.identity_leak).toMatchObject({ severity: "high", detector: "linker", sceneId: v1.sceneIds[1] });
    expect(byKind.schema_violation).toMatchObject({ severity: "high", detector: "schema_validator" });
    expect(byKind.appearance).toMatchObject({ severity: "medium", charStart: 19 });
    const ev = await h.continuity.getIssue(h.scope, byKind.death_state!.id);
    expect(ev.evidence.map((e) => e.refType).sort()).toEqual(["fact", "mention"]);
    expect(ev.evidence.find((e) => e.refType === "fact")!.factVersionId).toMatch(/^fcv_/);
    const sv = await h.continuity.getIssue(h.scope, byKind.schema_violation!.id);
    expect(sv.evidence[0]).toMatchObject({ refType: "fact", schemaRuleKey: "cardinality:spouse_of" });
    expect(issues.map((i) => i.displayNo).sort()).toEqual([1, 2, 3, 4]);

    const gate = h.reg.contributors.find((c) => c.name === "continuity")!;
    const epRow = (await h.testDb.query<any>(`SELECT id, episode_no AS "episodeNo" FROM episodes WHERE id = '${ep}'`))[0];
    const verdict = await gate.evaluate(h.scope, epRow, v1.versionId);
    expect(verdict.pass).toBe(false);
    expect(verdict.blockers).toHaveLength(3);
    expect(verdict.fixScope).toBe("scene");
    expect(await h.continuity.countOpenBySeverity(h.scope)).toEqual({ high: 3, medium: 1, low: 0 });
    const acts = (await h.audit.list(h.scope, { actionPrefix: "continuity_issue.", limit: 50 })).items;
    expect(acts.filter((a) => a.action === "continuity_issue.opened")).toHaveLength(4);
    expect(acts.every((a) => a.actorType === "agent" && a.runId)).toBe(true);
  });

  it("a rerun on the same version re-links by dedupe key instead of duplicating (C1)", async () => {
    await runCheck(
      v1.versionId,
      (input) => {
        const prompt = input.messages.at(-1)!.content;
        const cands = [...prompt.matchAll(/\[CANDIDATE\] id=(C\d+) rule=(\S+)/g)].map((m) => ({ id: m[1]!, rule: m[2]! }));
        return { verdicts: cands.map((c) => ({ candidate_id: c.id, verdict: c.rule === "CR-01" ? "violation" : "not_violation", quote: "죽은 백작이 문을 열고 들어왔다." })), issues: [] };
      },
      h.ontology.violations.map((v) => v.factId),
    );
    const again = await h.continuity.listIssues(h.scope, { episodeId: ep });
    expect(again).toHaveLength(4); // appearance (same version, not reproduced) stays open
    expect(again.filter((i) => i.status === "open")).toHaveLength(4);
  });

  it("E4 marks high issues fixing (C2); a fixed rewrite resolves them (C3) or supersedes when the scene vanished (C8)", async () => {
    await h.fireTransition(ep, "checking", "drafting");
    const fixing = await h.continuity.listIssues(h.scope, { episodeId: ep, statuses: ["fixing"] });
    expect(fixing.map((i) => i.kind).sort()).toEqual(["death_state", "identity_leak", "schema_violation"]);
    // new version: one scene only (scene 2 retired); the dead count is gone, leak/violation gone
    const v2 = await h.createVersion(ep, "백작의 초상화가 벽에 걸려 있었다.", { scenes: [[0, 18]] });
    h.ontology.leaks = [];
    h.ontology.violations = [];
    h.ontology.mentions = [];
    await runCheck(v2.versionId, () => ({ verdicts: [], issues: [] }));
    const all = await h.continuity.listIssues(h.scope, { episodeId: ep });
    const byKind = Object.fromEntries(all.map((i) => [i.kind, i]));
    expect(byKind.death_state).toMatchObject({ status: "resolved", resolutionKind: "rewritten", resolvedByActorType: "agent" });
    expect(byKind.identity_leak).toMatchObject({ status: "superseded", resolvedByActorType: "system" }); // its scene was retired
    expect(byKind.schema_violation).toMatchObject({ status: "resolved", resolutionKind: "rewritten" });
    expect(byKind.appearance).toMatchObject({ status: "resolved", resolutionKind: "rewritten" }); // open → C2 → C3
    const actions = (await h.audit.list(h.scope, { targetIds: [byKind.appearance!.id] })).items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["continuity_issue.opened", "continuity_issue.status_changed", "continuity_issue.resolved"]));
    const gate = h.reg.contributors.find((c) => c.name === "continuity")!;
    expect((await gate.evaluate(h.scope, { id: ep, episodeNo: 1 } as any, v2.versionId)).pass).toBe(true);
  });

  it("C4: reproduced after the rewrite → back to open on the new version", async () => {
    const v3 = await h.createVersion(ep, "죽은 백작이 다시 나타났다.", { scenes: [[0, 14]] });
    const dead = h.ontology.canon.find((f) => f.predicate === "life_status")!;
    h.ontology.mentions = [{ id: "mnt_9", linkedEntityId: deadId, linkStatus: "confirmed", sceneId: v3.sceneIds[0], charStart: 0, charEnd: 5, surface: "죽은 백작", narrativeFrameId: null }];
    const violation = (input: any) => {
      const cands = [...input.messages.at(-1)!.content.matchAll(/\[CANDIDATE\] id=(C\d+) rule=(\S+)/g)].map((m: any) => ({ id: m[1], rule: m[2] }));
      return { verdicts: cands.map((c: any) => ({ candidate_id: c.id, verdict: c.rule === "CR-01" ? "violation" : "not_violation" })), issues: [] };
    };
    await runCheck(v3.versionId, violation);
    const open1 = (await h.continuity.listIssues(h.scope, { episodeId: ep, statuses: ["open"], kinds: ["death_state"] }))[0]!;
    expect(open1.manuscriptVersionId).toBe(v3.versionId);
    expect(open1.previousIssueId).not.toBeNull(); // regression after resolved → new issue linked to the old one
    await h.fireTransition(ep, "checking", "drafting");
    expect((await h.continuity.getIssue(h.scope, open1.id)).status).toBe("fixing");
    const v4 = await h.createVersion(ep, "죽은 백작이 여전히 서 있었다.", { scenes: [[0, 16]] });
    h.ontology.mentions = [{ id: "mnt_10", linkedEntityId: deadId, linkStatus: "confirmed", sceneId: v4.sceneIds[0], charStart: 0, charEnd: 5, surface: "죽은 백작", narrativeFrameId: null }];
    await runCheck(v4.versionId, violation);
    const reopened = await h.continuity.getIssue(h.scope, open1.id);
    expect(reopened).toMatchObject({ status: "open", manuscriptVersionId: v4.versionId });
    void dead;
  });

  it("user transitions via HTTP: waive (C6), INV-CI-03/04/05 errors, resolved (C5)", async () => {
    const app = express();
    app.use(express.json());
    const novel = express.Router({ mergeParams: true });
    app.use("/api/novels/:novelId", (_req, res, next) => {
      res.locals.scope = h.scope;
      res.locals.userId = h.owner.id;
      next();
    }, novel);
    mountContinuityRoutes({ api: express.Router(), novel }, h.continuity, h.platform.uow);
    mountForeshadowRoutes({ api: express.Router(), novel }, h.foreshadow);
    app.use((err: any, _req: any, res: any, _next: any) => {
      if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      if (err?.name === "ZodError") return res.status(400).json({ error: { code: "validation_failed", message: "x" } });
      res.status(500).json({ error: { code: "internal", message: String(err) } });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/novels/${h.scope.novelId}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json()) as any };
    };
    try {
      const list = await call("GET", `/continuity-issues?episodeId=${ep}&status=open,fixing&severity=high`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      const id = list.body.items[0].id;
      expect(list.body.items[0].displayLabel).toMatch(/^CI-\d+$/);
      const detail = await call("GET", `/continuity-issues/${id}`);
      expect(detail.body.allowedTransitions).toEqual(["resolved", "waived", "false_positive"]);
      expect(detail.body.evidence.length).toBeGreaterThan(0);
      expect((await call("POST", `/continuity-issues/${id}/transition`, { to: "waived" })).status).toBe(422); // note required
      const w = await call("POST", `/continuity-issues/${id}/transition`, { to: "waived", note: "부활 설정입니다" });
      expect(w.status).toBe(200);
      expect(w.body).toMatchObject({ status: "waived", resolvedByActorType: "user" });
      expect((await call("POST", `/continuity-issues/${id}/transition`, { to: "resolved" })).status).toBe(409);
      expect((await call("GET", `/continuity-issues/cis_nope`)).status).toBe(404);

      // safety issue through the manuscript sink: cannot be waived (INV-CI-05)
      const v = (await h.testDb.query<any>(`SELECT current_version_id AS v FROM episodes WHERE id = '${ep}'`))[0].v;
      const safetyRun = await h.createRun("check_text_safety", "continuity_editor", "episode", ep);
      const safety = await h.tx((tx) => h.reg.safetySinks[0]!(tx, h.scope, { kind: "safety_age_rating", severity: "high", episodeId: ep, manuscriptVersionId: v, sceneId: null, charStart: null, charEnd: null, message: "수위 초과", fixScope: "scene" }, actors.agent("continuity_editor", safetyRun.runId)));
      const again = await h.tx((tx) => h.reg.safetySinks[0]!(tx, h.scope, { kind: "safety_age_rating", severity: "high", episodeId: ep, manuscriptVersionId: v, sceneId: null, charStart: null, charEnd: null, message: "수위 초과", fixScope: "scene" }, actors.agent("continuity_editor", safetyRun.runId)));
      expect(again.issueId).toBe(safety.issueId); // dedupe
      const sw = await call("POST", `/continuity-issues/${safety.issueId}/transition`, { to: "waived", note: "괜찮음" });
      expect(sw.status).toBe(422);
      expect(sw.body.error.code).toBe("issue_safety_not_waivable");
      const r = await call("POST", `/continuity-issues/${safety.issueId}/transition`, { to: "resolved", resolutionKind: "human_edited" });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("issue_safety_recheck_only");

      // published canon conflict needs a retcon approval (INV-CI-04)
      const f = h.ontology.canon[0]!;
      const pcc = await h.tx((tx) => h.continuity.openIssue(tx, h.scope, { kind: "published_canon_conflict", severity: "high", detector: "continuity_editor", episodeId: ep, manuscriptVersionId: v, message: "공개 사실과 충돌", evidence: [{ factId: f.factId, factVersionId: f.factVersionId }] }, h.owner));
      expect((await call("POST", `/continuity-issues/${pcc.id}/transition`, { to: "waived", note: "x" })).body.error.code).toBe("issue_retcon_required");
      expect((await call("POST", `/continuity-issues/${pcc.id}/transition`, { to: "resolved", resolutionKind: "retconned" })).body.error.code).toBe("issue_retcon_required");
      const retcon = await h.createApproval("retcon", "fact", f.factId, "approved");
      const ok = await call("POST", `/continuity-issues/${pcc.id}/transition`, { to: "waived", note: "리트콘 승인", approvalId: retcon });
      expect(ok.body).toMatchObject({ status: "waived", approvalId: retcon });

      // INV-CI-01
      await expect(h.tx((tx) => h.continuity.openIssue(tx, h.scope, { kind: "age", severity: "medium", detector: "continuity_editor", episodeId: ep, manuscriptVersionId: v, message: "나이", evidence: [] }, h.owner))).rejects.toMatchObject({ code: "issue_evidence_required" });

      // foreshadow routes
      const setups = await call("GET", `/setups?narrative=planned,planted&dueWithin=5`);
      expect(setups.status).toBe(200);
      expect(Array.isArray(setups.body.items)).toBe(true);
      const report = await call("GET", `/setups/report`);
      expect(report.status).toBe(200);
      expect(report.body).toHaveProperty("r5Metrics");
      expect((await call("GET", `/setups/S-99`)).status).toBe(404);
      expect((await call("GET", `/setups?narrative=bogus`)).status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("E6 closes issues left on older versions (stale cleanup)", async () => {
    const v = (await h.testDb.query<any>(`SELECT current_version_id AS v FROM episodes WHERE id = '${ep}'`))[0].v;
    const f = h.ontology.canon[1]!;
    const stale = await h.tx((tx) => h.continuity.openIssue(tx, h.scope, { kind: "appearance", severity: "high", detector: "continuity_editor", episodeId: ep, manuscriptVersionId: v, message: "눈 색", evidence: [{ factId: f.factId, factVersionId: f.factVersionId }] }, h.owner));
    const v5 = await h.createVersion(ep, "평온한 아침이었다.", { scenes: [[0, 9]] });
    await h.fireTransition(ep, "checking", "polishing");
    expect(await h.continuity.getIssue(h.scope, stale.id)).toMatchObject({ status: "resolved", resolutionKind: "rewritten" });
    const after = await h.continuity.listIssues(h.scope, { episodeId: ep, statuses: ["open", "fixing"] });
    expect(after.filter((i) => i.manuscriptVersionId !== v5.versionId)).toHaveLength(0);
  });
});
