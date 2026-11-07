/**
 * Database access (server only): one postgres.js pool per process (kept on globalThis across `next dev` hot
 * reloads), configured for the Supabase transaction pooler — unprepared statements, a tiny pool, short idle timeout
 * (serverless functions freeze between requests). The URL is never sent to the client or logged.
 */
import "server-only";
import postgres from "postgres";
import { postgresJsSqlClient, type SqlClient } from "@ncs/public-schema";
import { getEnv, requireDatabaseUrl } from "./env";

interface Pool {
  url: string;
  sql: postgres.Sql;
  client: SqlClient;
}

const g = globalThis as typeof globalThis & { __snowpagePool?: Pool };

const isSupabaseHost = (host: string) => /(^|\.)supabase\.(co|com|net)$/i.test(host);

function create(url: string): Pool {
  let ssl: "require" | undefined;
  try {
    const u = new URL(url);
    if (!u.searchParams.get("sslmode") && isSupabaseHost(u.hostname)) ssl = "require";
  } catch {
    /* postgres.js reports a bad URL */
  }
  const sql = postgres(url, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: "snowpage" },
    ...(ssl ? { ssl } : {}),
  });
  return { url, sql, client: postgresJsSqlClient(sql as never) };
}

export function getDb(): { client: SqlClient; schema: string } {
  const env = getEnv();
  const url = requireDatabaseUrl(env);
  if (!g.__snowpagePool || g.__snowpagePool.url !== url) g.__snowpagePool = create(url);
  return { client: g.__snowpagePool.client, schema: env.schema };
}
