import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@ncs/shared";
import { schema } from "../src/index.js";
import { eq } from "../src/orm.js";
import { createTestDb, seedArc, seedNovel, type SeededNovel, type TestDb } from "../src/testing/index.js";

let t: TestDb;
let a: SeededNovel;
let b: SeededNovel;

beforeEach(async () => {
  t = await createTestDb();
  a = await seedNovel(t.db);
  b = await seedNovel(t.db, { userId: a.userId });
});
afterEach(async () => {
  await t.close();
});

/** Assert a statement fails with a SQLSTATE code. */
async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    expect(err.code ?? err.cause?.code, String((e as Error).message)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but statement succeeded`);
}

function episodeValues(novelId: string, arcId: string, timelineId: string, no = 1) {
  return { id: newId("epi"), novelId, arcId, episodeNo: no, primaryTimelineId: timelineId };
}

describe("seed + drizzle round trip", () => {
  it("creates a concept-stage novel with N1 rows", async () => {
    const [n] = await t.db.select().from(schema.novels).where(eq(schema.novels.id, a.novelId));
    expect(n!.status).toBe("concept");
    expect(n!.defaultNarrationMode).toBe("third_limited");
    expect(n!.category).toEqual({});
    const sessions = await t.db.select().from(schema.conceptSessions).where(eq(schema.conceptSessions.novelId, a.novelId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.budgetLimitMicros).toBe(6_000_000);
  });

  it("rejects malformed ids and enum values", async () => {
    await expectPgError(t.exec(`INSERT INTO users (id, display_name) VALUES ('usr_bad', 'x')`), "23514");
    await expectPgError(t.exec(`UPDATE novels SET status = 'drafting' WHERE id = '${a.novelId}'`), "23514");
  });
});

describe("tenant rules T-1 / T-2", () => {
  it("rejects a row that references another novel's row (composite FK)", async () => {
    const arcB = await seedArc(t.db, b.novelId);
    await expectPgError(t.db.insert(schema.episodes).values(episodeValues(a.novelId, arcB, a.timelineId)), "23503");
    const arcA = await seedArc(t.db, a.novelId);
    await t.db.insert(schema.episodes).values(episodeValues(a.novelId, arcA, a.timelineId));
    // timeline of the other novel is rejected too
    await expectPgError(t.db.insert(schema.episodes).values(episodeValues(a.novelId, arcA, b.timelineId, 2)), "23503");
  });

  it("rejects cross-novel references from the novel root (approved brief / schema version)", async () => {
    await expectPgError(
      t.pg.transaction(async (tx) => {
        await tx.query(`UPDATE novels SET active_schema_version_id = $1 WHERE id = $2`, [b.schemaVersionId, a.novelId]);
      }),
      "23503",
    );
  });

  it("keeps episode_no unique per novel only (INV-EP-01)", async () => {
    const arcA = await seedArc(t.db, a.novelId);
    const arcB = await seedArc(t.db, b.novelId);
    await t.db.insert(schema.episodes).values(episodeValues(a.novelId, arcA, a.timelineId, 1));
    await t.db.insert(schema.episodes).values(episodeValues(b.novelId, arcB, b.timelineId, 1));
    await expectPgError(t.db.insert(schema.episodes).values(episodeValues(a.novelId, arcA, a.timelineId, 1)), "23505");
  });
});

describe("concept invariants", () => {
  it("INV-CON-01: at most one open concept session per novel", async () => {
    const second = {
      id: newId("cns"),
      novelId: a.novelId,
      budgetLimitMicros: 1,
      activeChannelId: a.webChannelId,
      createdByUserId: a.userId,
    };
    await expectPgError(t.db.insert(schema.conceptSessions).values(second), "23505");
    await t.db.update(schema.conceptSessions).set({ status: "abandoned" }).where(eq(schema.conceptSessions.id, a.conceptSessionId));
    await t.db.insert(schema.conceptSessions).values(second);
  });

  it("INV-CON-02: at most one approved concept brief per novel", async () => {
    const brief = (versionNo: number) => ({
      id: newId("cbf"),
      novelId: a.novelId,
      sessionId: a.conceptSessionId,
      versionNo,
      authorActorType: "user" as const,
      authorActorId: a.userId,
      entryMode: "conversation" as const,
      questionSetVersion: "common@1",
      content: {},
      contentMd: "",
    });
    const b1 = brief(1);
    const b2 = brief(2);
    await t.db.insert(schema.conceptBriefs).values([b1, b2]);
    // approval needs a question (ADR-014); create both
    const qid = newId("qst");
    const aid = newId("apr");
    await t.exec(`
      INSERT INTO questions (id, novel_id, display_no, grade, question_type, topic, title, body, recommendation, rationale,
        blocking_basis, grade_reason, deadline_at)
      VALUES ('${qid}', '${a.novelId}', 1, 'blocking', 'approve_reject', 'concept_confirm', 't', 'b', '{}', 'r',
        'approval_gate', 'g', now());
      INSERT INTO approvals (id, novel_id, approval_type, subject_type, subject_id, question_id, requested_by_actor_type, requested_by_actor_id)
      VALUES ('${aid}', '${a.novelId}', 'concept_brief', 'concept_brief', '${b1.id}', '${qid}', 'agent', 'concept_partner');`);
    const approve = (id: string) =>
      t.db.update(schema.conceptBriefs).set({ status: "approved", approvalId: aid, approvedAt: new Date() }).where(eq(schema.conceptBriefs.id, id));
    await approve(b1.id);
    await expectPgError(approve(b2.id), "23505");
  });
});

describe("task invariants", () => {
  const task = (novelId: string, over: Record<string, unknown>) => ({
    id: newId("tsk"),
    novelId,
    displayNo: Math.floor(Math.random() * 1e6),
    agentRole: "planner" as const,
    targetType: "novel" as const,
    targetId: novelId,
    createdByActorType: "system" as const,
    createdByActorId: "orchestrator",
    kind: "plan_series_bible" as const,
    ...over,
  });

  it("INV-CON-08: goal_id NULL only for concept tasks targeting a concept session", async () => {
    await expectPgError(t.db.insert(schema.tasks).values(task(a.novelId, {})), "23514");
    await t.db.insert(schema.tasks).values(
      task(a.novelId, { kind: "concept_turn", agentRole: "concept_partner", targetType: "concept_session", targetId: a.conceptSessionId }),
    );
    await expectPgError(
      t.db.insert(schema.tasks).values(task(a.novelId, { kind: "concept_turn", agentRole: "concept_partner" })),
      "23514",
    );
  });

  it("accepts a non-concept task once a goal exists, and enforces goal tenant FK", async () => {
    const goalB = newId("gol");
    await t.db.insert(schema.goals).values({ id: goalB, novelId: b.novelId, totalEpisodesMin: 100, cadenceEpisodesPerWeek: 7, endingDirection: "해피엔딩" });
    await expectPgError(t.db.insert(schema.tasks).values(task(a.novelId, { goalId: goalB })), "23503");
    await t.db.insert(schema.tasks).values(task(b.novelId, { goalId: goalB }));
  });
});

describe("ledger and questions", () => {
  it("cost_events are append-only (INV-COST-04) and one row per provider call (INV-COST-01)", async () => {
    const prv = newId("prv");
    await t.exec(`INSERT INTO provider_profiles (id, provider_kind, provider, version_no, price_source_url, verified_at)
      VALUES ('${prv}', 'llm', 'anthropic', 1, 'https://example.invalid', now())`);
    const cost = (key: string) => ({
      id: newId("cst"),
      novelId: a.novelId,
      idempotencyKey: key,
      category: "text" as const,
      provider: "anthropic",
      modelId: "claude-test-1",
      providerProfileId: prv,
      providerProfileVersion: 1,
      costBasis: "measured" as const,
      amountMicros: 1200,
    });
    const c1 = cost("k1");
    await t.db.insert(schema.costEvents).values(c1);
    await expectPgError(t.db.insert(schema.costEvents).values(cost("k1")), "23505");
    await expectPgError(t.db.update(schema.costEvents).set({ amountMicros: 1 }).where(eq(schema.costEvents.id, c1.id)), "23514");
    await expectPgError(t.db.insert(schema.costEvents).values({ ...cost("k2"), amountMicros: -5 }), "23514");
  });

  it("INV-Q-01: blocking_basis <> none ⇔ grade = blocking", async () => {
    const q = (grade: string, basis: string) => `
      INSERT INTO questions (id, novel_id, display_no, grade, question_type, topic, title, body, recommendation, rationale,
        blocking_basis, grade_reason, deadline_at)
      VALUES ('${newId("qst")}', '${a.novelId}', ${Math.floor(Math.random() * 1e6)}, '${grade}', 'single_choice', 'direction',
        't', 'b', '{}', 'r', '${basis}', 'g', now())`;
    await t.exec(q("blocking", "arc_goal"));
    await t.exec(q("non_blocking", "none"));
    await expectPgError(t.exec(q("non_blocking", "arc_goal")), "23514");
    await expectPgError(t.exec(q("blocking", "none")), "23514");
  });

  it("INV-CH-01: exactly one web channel per novel", async () => {
    await expectPgError(
      t.db.insert(schema.channels).values({ id: newId("chn"), novelId: a.novelId, kind: "web", label: "dup" }),
      "23505",
    );
  });
});

describe("ontology constraints", () => {
  it("INV-ONT-02: one active preferred name per entity", async () => {
    const ent = newId("ent");
    await t.db.insert(schema.entities).values({ id: ent, novelId: a.novelId, entityType: "character", createdByActorType: "user", createdByActorId: a.userId });
    const name = (surface: string, preferred: boolean) => ({
      id: newId("enm"),
      novelId: a.novelId,
      entityId: ent,
      surface,
      normalizedKey: surface,
      jamoKey: surface,
      translitKey: surface,
      nameKind: "alias" as const,
      isPreferred: preferred,
      sourceKind: "user_input" as const,
      sourceRefType: "entity" as const,
      sourceRefId: ent,
    });
    await t.db.insert(schema.entityNames).values(name("에린", true));
    await expectPgError(t.db.insert(schema.entityNames).values(name("에린 공주", true)), "23505");
    await t.db.insert(schema.entityNames).values(name("에린 공주", false));
  });

  it("INV-ONT-05: canonical cardinality slots cannot overlap (when btree_gist is available)", async ({ skip }) => {
    if (!t.extensions.includes("btree_gist")) skip();
    const ent = newId("ent");
    await t.db.insert(schema.entities).values({ id: ent, novelId: a.novelId, entityType: "character", createdByActorType: "user", createdByActorId: a.userId });
    const fact = () => ({
      id: newId("fct"),
      novelId: a.novelId,
      factKind: "relation" as const,
      subjectEntityId: ent,
      predicate: "holds_title",
      slotKey: `o:x|holds_title`,
      timelineId: a.timelineId,
      storyRange: "[0,11000)",
      sourceKind: "user_input" as const,
      sourceRefType: "novel" as const,
      sourceRefId: a.novelId,
      schemaVersionId: a.schemaVersionId,
    });
    const f1 = fact();
    const f2 = fact();
    await t.db.insert(schema.facts).values([f1, f2]);
    const slot = (factId: string, range: string) => ({ novelId: a.novelId, factId, timelineId: a.timelineId, slotKey: "o:x|holds_title", storyRange: range });
    await t.db.insert(schema.factCardinalitySlots).values(slot(f1.id, "[0,11000)"));
    await expectPgError(t.db.insert(schema.factCardinalitySlots).values(slot(f2.id, "[10000,20000)")), "23P01");
    await t.db.insert(schema.factCardinalitySlots).values(slot(f2.id, "[11000,20000)"));
    const [row] = await t.db.select().from(schema.factCardinalitySlots).where(eq(schema.factCardinalitySlots.factId, f2.id));
    expect(row!.storyRange).toBe("[11000,20000)");
  });
});
