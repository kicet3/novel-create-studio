import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { ENUMS, type EnumName } from "@ncs/shared/enums";
import { checksumOf, loadMigrations, MigrationError, pgliteTarget, runMigrations, validateMigrations } from "../src/index.js";
import { createTestDb } from "../src/testing/index.js";

describe("migration runner", () => {
  it("loads contiguous NNNN_slug.sql files", () => {
    const ms = loadMigrations();
    expect(ms.length).toBeGreaterThan(0);
    expect(ms[0]!.id).toBe("0001");
    expect(ms[0]!.checksum).toBe(checksumOf(ms[0]!.sql));
  });

  it("applies all migrations on PGlite and records them; re-run is a no-op", async () => {
    const pg = await PGlite.create();
    const target = pgliteTarget(pg);
    const first = await runMigrations(target, { appVersion: "t" });
    expect(first.applied).toEqual(loadMigrations().map((m) => m.id));
    const second = await runMigrations(target, { appVersion: "t" });
    expect(second.applied).toEqual([]);
    const rows = (await pg.query<{ id: string; app_version: string }>("SELECT id, app_version FROM app_migrations")).rows;
    expect(rows.map((r) => r.id)).toEqual(first.applied);
    await pg.close();
  });

  it("refuses a modified applied migration (checksum mismatch) and unknown applied ids", async () => {
    const pg = await PGlite.create();
    const target = pgliteTarget(pg);
    const mig = [{ id: "0001", name: "x", sql: "CREATE TABLE t1 (a int);", checksum: checksumOf("CREATE TABLE t1 (a int);") }];
    await runMigrations(target, { appVersion: "t", migrations: mig });
    const changed = [{ ...mig[0]!, sql: "CREATE TABLE t1 (a int, b int);", checksum: checksumOf("CREATE TABLE t1 (a int, b int);") }];
    await expect(runMigrations(target, { appVersion: "t", migrations: changed })).rejects.toMatchObject({ code: "checksum_mismatch" });
    await expect(runMigrations(target, { appVersion: "t", migrations: [] })).rejects.toMatchObject({ code: "unknown_applied" });
    await pg.close();
  });

  it("rolls back a failing migration file as a whole", async () => {
    const pg = await PGlite.create();
    const sql = "CREATE TABLE ok_t (a int); SELECT * FROM missing_table;";
    await expect(
      runMigrations(pgliteTarget(pg), { appVersion: "t", migrations: [{ id: "0001", name: "bad", sql, checksum: checksumOf(sql) }] }),
    ).rejects.toBeInstanceOf(MigrationError);
    const r = await pg.query("SELECT to_regclass('ok_t') AS t");
    expect((r.rows[0] as { t: unknown }).t).toBeNull();
    await pg.close();
  });

  it("validates numbering and destructive markers", () => {
    const m = (id: string, sql = "SELECT 1;") => ({ id, name: "a", sql, checksum: checksumOf(sql) });
    expect(() => validateMigrations([m("0001"), m("0003")])).toThrow(/numbering/);
    expect(() => validateMigrations([m("0001", "ALTER TABLE x DROP COLUMN y;")])).toThrow(/destructive/);
    expect(() => validateMigrations([m("0001", "-- ncs:destructive remove legacy column\nALTER TABLE x DROP COLUMN y;")])).not.toThrow();
  });
});

describe("schema (0001_init)", () => {
  it("creates all MVP-α tables", async () => {
    const t = await createTestDb();
    const rows = await t.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const required of [
      "novels", "goals", "series_bibles", "arcs", "length_profiles", "notification_policies", "novel_counters", "users",
      "concept_sessions", "concept_messages", "concept_briefs",
      "episodes", "manuscript_versions", "episode_rejections", "scenes", "scene_participants", "episode_recaps",
      "tasks", "task_dependencies", "wake_requests", "runs", "provider_calls", "context_snapshots",
      "questions", "question_options", "question_links", "question_deliveries", "answers", "answer_interpretations",
      "answer_reflections", "answer_reflection_items", "answer_sessions", "approvals", "digest_batches",
      "channels", "messenger_bots", "channel_binding_tokens", "messenger_inbox", "messenger_outbox",
      "continuity_issues", "continuity_issue_evidence", "setups", "setup_beats", "setup_due_changes", "setup_links",
      "provider_profiles", "role_model_bindings", "budget_policies", "budget_reservations", "cost_events",
      "activity_log", "export_jobs", "app_migrations", "secrets", "backup_records", "health_check_results",
      "entities", "entity_names", "mentions", "narrative_frames", "facts", "fact_versions", "timelines",
      "ontology_schema_versions", "schema_change_proposals", "glossary_terms", "identity_decisions",
      "identity_decision_moves", "entity_distinct_pairs", "fact_cardinality_slots",
    ]) {
      expect(names, required).toContain(required);
    }
    await t.close();
  });

  it("enum CHECK lists in the catalog equal @ncs/shared ENUMS (check-enum-sync)", async () => {
    const t = await createTestDb();
    const cols = await t.query<{ table_name: string; column_name: string; attnum: number; relid: number; comment: string }>(`
      SELECT c.relname AS table_name, a.attname AS column_name, a.attnum, c.oid::int AS relid,
             col_description(c.oid, a.attnum) AS comment
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND col_description(c.oid, a.attnum) LIKE 'enum:%'`);
    expect(cols.length).toBeGreaterThan(150);
    const checks = await t.query<{ relid: number; conkey: number[]; def: string }>(`
      SELECT conrelid::int AS relid, conkey, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE contype = 'c' AND array_length(conkey, 1) = 1`);
    for (const col of cols) {
      const enumName = col.comment.slice("enum:".length) as EnumName;
      expect(ENUMS, `${col.table_name}.${col.column_name}`).toHaveProperty(enumName);
      const candidates = checks.filter(
        (c) => c.relid === col.relid && c.conkey[0] === col.attnum && !/~/.test(c.def),
      );
      // the enum check is the one listing all values; other single-column checks may exist
      const parsed = candidates.map((c) => [...c.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!).sort());
      const expected = [...(ENUMS[enumName] as readonly string[])].sort();
      expect(parsed, `${col.table_name}.${col.column_name} (${enumName})`).toContainEqual(expected);
    }
    // every *_enum constraint has a marker comment
    const enumConstraints = await t.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%\\_enum' ESCAPE '\\'",
    );
    expect(enumConstraints[0]!.n).toBe(cols.length);
    await t.close();
  });

  it("every novel-scoped table has novel_id NOT NULL and UNIQUE (novel_id, id) (T-1)", async () => {
    const t = await createTestDb();
    const rows = await t.query<{ table_name: string; is_nullable: string; has_id: boolean; has_tenant_key: boolean }>(`
      SELECT c.table_name, c.is_nullable,
        EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_name = c.table_name AND i.column_name = 'id') AS has_id,
        EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.table_name::regclass AND k.contype = 'u'
                AND pg_get_constraintdef(k.oid) = 'UNIQUE (novel_id, id)') AS has_tenant_key
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'novel_id'`);
    const nullableTenant = new Set(["length_profiles", "messenger_inbox", "activity_log", "health_check_results", "image_generations", "image_assets"]);
    for (const r of rows) {
      if (!nullableTenant.has(r.table_name)) expect(r.is_nullable, r.table_name).toBe("NO");
      if (r.has_id) expect(r.has_tenant_key, r.table_name).toBe(true);
    }
    await t.close();
  });

  it("reports btree_gist availability (EXCLUDE constraints guarded)", async () => {
    const t = await createTestDb();
    const ex = await t.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE contype = 'x' ORDER BY conname");
    if (t.extensions.includes("btree_gist")) {
      expect(ex.map((r) => r.conname)).toEqual(["arcs_no_overlap", "entity_names_no_dup", "fact_cardinality_slots_no_overlap"]);
    } else {
      expect(ex).toEqual([]);
    }
    await t.close();
  });
});
