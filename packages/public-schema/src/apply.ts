/**
 * Applying the public schema: `CREATE SCHEMA IF NOT EXISTS <schema>`, then `<schema>.schema_migrations` and every
 * migration not yet recorded — each in its own transaction under a transaction-scoped advisory lock (works through
 * the Supabase transaction pooler; two studios racing serialize). Nothing outside the schema is created or changed:
 * no roles, no extensions, no grants.
 */
import { assertSchemaName, quoteIdent, quoteLiteral } from "./ident.js";
import { PUBLIC_MIGRATIONS, PUBLIC_SCHEMA_LATEST_VERSION, type PublicMigration } from "./migrations.js";

/** Minimal driver-agnostic SQL port (postgres.js in production, PGlite in tests). */
export interface SqlClient {
  /** one statement with $1… bind parameters (no multi-statement text) */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** several statements without parameters (DDL) */
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export interface ApplyPublicSchemaResult {
  schema: string;
  applied: number[];
  version: number;
}

const lockKey = (schema: string) => `ncs_public_schema:${schema}`;

/** current schema version (null: the schema or its schema_migrations table does not exist yet) */
export async function publicSchemaVersion(client: SqlClient, schema: string): Promise<number | null> {
  assertSchemaName(schema);
  const exists = await client.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations') AS ok",
    [schema],
  );
  if (!exists[0]?.ok) return null;
  const rows = await client.query<{ v: number | string | null }>(`SELECT max(version) AS v FROM ${quoteIdent(schema)}.schema_migrations`);
  const v = rows[0]?.v;
  return v === null || v === undefined ? 0 : Number(v);
}

export async function applyPublicSchema(client: SqlClient, schema: string, migrations: readonly PublicMigration[] = PUBLIC_MIGRATIONS): Promise<ApplyPublicSchemaResult> {
  assertSchemaName(schema);
  const s = quoteIdent(schema);
  await client.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(schema)]);
    await tx.exec(
      `CREATE SCHEMA IF NOT EXISTS ${s};
       CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`,
    );
  });
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const did = await client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(schema)]);
      const done = await tx.query(`SELECT 1 AS x FROM ${s}.schema_migrations WHERE version = $1`, [m.version]);
      if (done.length) return false;
      await tx.exec(m.sql(s));
      await tx.exec(`INSERT INTO ${s}.schema_migrations (version, name) VALUES (${Number(m.version)}, ${quoteLiteral(m.name)});`);
      return true;
    });
    if (did) applied.push(m.version);
  }
  return { schema, applied, version: (await publicSchemaVersion(client, schema)) ?? 0 };
}

export { PUBLIC_SCHEMA_LATEST_VERSION };
