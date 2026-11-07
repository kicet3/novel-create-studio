/**
 * SQL for the RESTRICTED role the Vercel reader app logs in with. Generated for the user to copy and run by hand in
 * the Supabase SQL editor — the studio never runs it (it creates a role, which is outside the app schema).
 *
 * The role can: read novels / episodes (published content), and read/write only the anonymous reaction tables.
 * It cannot write content, create objects, or see anything outside the schema. Re-running the snippet is safe
 * (role created only when missing, policies dropped and re-created) — re-run it after a public schema upgrade.
 */
import { assertRoleName, assertSchemaName, PUBLIC_READER_ROLE_DEFAULT, quoteIdent, quoteLiteral } from "./ident.js";
import { PUBLIC_CONTENT_TABLES, PUBLIC_REACTION_TABLES } from "./migrations.js";

export const ROLE_PASSWORD_PLACEHOLDER = "<직접 입력>";

export interface ReaderRoleSqlOptions {
  schema: string;
  role?: string;
  /** default: the placeholder the user replaces (tests pass a value) */
  password?: string;
}

export function buildReaderRoleSql(o: ReaderRoleSqlOptions): string {
  const schema = assertSchemaName(o.schema);
  const role = assertRoleName(o.role ?? PUBLIC_READER_ROLE_DEFAULT);
  const s = quoteIdent(schema);
  const r = quoteIdent(role);
  const password = quoteLiteral(o.password ?? ROLE_PASSWORD_PLACEHOLDER);
  const content = PUBLIC_CONTENT_TABLES.map((t) => `${s}.${t}`).join(", ");
  const reactions = PUBLIC_REACTION_TABLES.map((t) => `${s}.${t}`).join(", ");
  const lines: string[] = [
    `-- 공개 독자 사이트(Vercel) 전용 제한 역할 ${role} — Supabase 대시보드 SQL Editor 에서 직접 실행하세요.`,
    `-- 1) 아래 ${ROLE_PASSWORD_PLACEHOLDER} 를 긴 무작위 비밀번호로 바꿉니다(작은따옴표는 그대로 둡니다).`,
    `-- 2) 스튜디오에서 먼저 [지금 동기화]를 해 ${schema} 스키마와 테이블을 만든 뒤 실행합니다. 다시 실행해도 안전합니다(스키마 버전이 오르면 다시 실행).`,
    `-- 3) Supabase 설정 → Data API → Exposed schemas 에 ${schema} 를 넣지 마세요(공개 사이트는 REST/GraphQL 이 아니라 이 역할로 직접 접속합니다).`,
    `-- 이 역할은 ${schema} 스키마 밖의 어떤 것에도 권한이 없습니다. 비밀번호를 바꿀 때: ALTER ROLE ${r} WITH PASSWORD '새 비밀번호';`,
    "",
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN`,
    `    CREATE ROLE ${r} LOGIN PASSWORD ${password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
    "  END IF;",
    "END",
    "$$;",
    `ALTER ROLE ${r} SET statement_timeout = '5s';`,
    "",
    `GRANT USAGE ON SCHEMA ${s} TO ${r};`,
    `GRANT SELECT ON ${content} TO ${r};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${reactions} TO ${r};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${r};`,
    "",
    "-- RLS: 스키마의 모든 테이블에 켜져 있습니다(스튜디오 마이그레이션). 이 역할에만 정책을 줍니다(anon/authenticated 정책 없음).",
  ];
  for (const t of PUBLIC_CONTENT_TABLES) {
    lines.push(`DROP POLICY IF EXISTS ncs_reader_select ON ${s}.${t};`);
    lines.push(`CREATE POLICY ncs_reader_select ON ${s}.${t} FOR SELECT TO ${r} USING (true);`);
  }
  for (const t of PUBLIC_REACTION_TABLES) {
    lines.push(`DROP POLICY IF EXISTS ncs_reader_all ON ${s}.${t};`);
    lines.push(`CREATE POLICY ncs_reader_all ON ${s}.${t} FOR ALL TO ${r} USING (true) WITH CHECK (true);`);
  }
  lines.push(
    "",
    "-- Supabase API 역할(anon, authenticated)에는 이 스키마 권한을 주지 않습니다(있으면 회수).",
    "DO $$",
    "DECLARE api_role text;",
    "BEGIN",
    "  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP",
    "    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN",
    `      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${quoteLiteral(schema)}, api_role);`,
    `      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${quoteLiteral(schema)}, api_role);`,
    `      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${quoteLiteral(schema)}, api_role);`,
    "    END IF;",
    "  END LOOP;",
    "END",
    "$$;",
    "",
  );
  return lines.join("\n");
}
