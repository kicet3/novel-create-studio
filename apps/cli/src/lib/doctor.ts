/** `ncs doctor` checks (08 §5.6). Local checks are CLI-only (not stored); registry checks are the server's. */
import { isLoopbackHost } from "@ncs/shared";
import { describeConnection, redactDatabaseSecrets, resolveDatabaseConnection, type AppSchemaInspection, type DbConnection } from "@ncs/db";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstallConfig } from "@ncs/shared";
import { configPath, embeddedDataDir, masterKeyFile, readConfigFile, validateConfigObject } from "./config.js";
import { embeddedRuntime, openRawDb } from "./db.js";
import { detectServer, api } from "./http.js";
import { migrationStatus } from "./migrations.js";
import { portFree } from "./net.js";
import { withCore } from "./core.js";
import type { HealthResultLike } from "./server-loader.js";

export type Status = "pass" | "warn" | "fail";

export interface DoctorResult {
  name: string;
  kind: string | null;
  status: Status;
  message: string;
  remedy?: string;
  novelId?: string | null;
}

export const MIN_NODE_MAJOR = 22;

export function checkNode(version = process.versions.node): DoctorResult {
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", kind: null, status: "pass", message: `Node ${version}` }
    : { name: "node", kind: null, status: "fail", message: `Node ${version} — ${MIN_NODE_MAJOR} 이상이 필요합니다.`, remedy: "Node.js 를 업그레이드하세요." };
}

function modeOf(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

export function checkHomePermissions(config: InstallConfig, env: NodeJS.ProcessEnv = process.env): DoctorResult {
  if (process.platform === "win32") return { name: "home_permissions", kind: null, status: "pass", message: "Windows: 사용자 ACL 은 검사하지 않습니다." };
  const problems: string[] = [];
  const home = modeOf(config.home);
  if (home === null) {
    return { name: "home_permissions", kind: null, status: "warn", message: `설치 홈이 없습니다: ${config.home}`, remedy: "`ncs onboard` 를 실행하세요." };
  }
  if (home & 0o077) problems.push(`${config.home} ${home.toString(8)} (0700 권장)`);
  const key = masterKeyFile(config, env);
  const km = modeOf(key);
  if (km !== null && km & 0o077) problems.push(`${key} ${km.toString(8)} (0600 필요)`);
  const cm = modeOf(configPath(config.home));
  if (cm !== null && cm & 0o077) problems.push(`config.json ${cm.toString(8)} (0600 권장)`);
  if (problems.length) {
    return { name: "home_permissions", kind: null, status: km !== null && km & 0o077 ? "fail" : "warn", message: `권한이 넓습니다: ${problems.join(", ")}`, remedy: `chmod 700 ${config.home}; chmod 600 ${key}` };
  }
  return { name: "home_permissions", kind: null, status: "pass", message: `설치 홈 권한 정상 (${config.home})${km === null ? ", 마스터 키는 아직 없음" : ""}` };
}

export function checkConfigFile(home: string): DoctorResult {
  let file: Record<string, unknown>;
  try {
    file = readConfigFile(home);
  } catch (err) {
    return { name: "config", kind: null, status: "fail", message: `config.json 을 읽을 수 없습니다: ${(err as Error).message}` };
  }
  const v = validateConfigObject(file);
  if (!v.ok) return { name: "config", kind: null, status: "fail", message: `설정 검증 실패: ${v.issues.join("; ")}`, remedy: "`ncs config validate` 로 확인하고 `ncs config set` 으로 고치세요." };
  return { name: "config", kind: null, status: "pass", message: existsSync(configPath(home)) ? "설정 검증 통과" : "config.json 없음 — 기본값 사용" };
}

export function exitCodeOf(results: Array<{ status: Status }>): 0 | 1 | 2 {
  if (results.some((r) => r.status === "fail")) return 2;
  if (results.some((r) => r.status === "warn")) return 1;
  return 0;
}

const REMEDY: Record<string, string> = {
  llm_key: "`ncs secrets set llm.anthropic.api_key` 로 Claude API 키를 입력하세요 (또는 웹 설정 → 비밀 값, 환경 변수 ANTHROPIC_API_KEY)",
  bot_token: "BotFather 에서 토큰을 확인하고 웹 설정에서 다시 입력하세요.",
  channel_reach: "다른 기기에서 같은 봇을 수신 중이면 끄거나 봇 토큰을 재발급하세요.",
  database:
    "`ncs doctor` 의 포트·마이그레이션 항목을 확인하세요. 외부 DB면 btree_gist 확장이 필요합니다. Supabase 는 Direct connection(5432) 또는 Session pooler(5432) 주소를 쓰고, 트랜잭션 풀러(6543)는 쓰지 마세요.",
  backup_location: "`ncs backup` 으로 즉시 백업하고, 외부 디스크 경로를 쓰세요.",
  storage: "storage.root 경로의 쓰기 권한을 확인하세요.",
  ontology_integrity: "웹의 온톨로지 화면에서 문제 항목을 확인하세요.",
};

/** URL-level check of an external DB (no connection): provider, masked host, pooler mode, TLS, schema. */
export function describeExternalTarget(conn: DbConnection): DoctorResult {
  const d = describeConnection(conn);
  const parts = [
    d.provider === "supabase" ? "Supabase" : "PostgreSQL",
    `${d.host ?? "?"}:${d.port ?? "?"}`,
    d.pooler === "session" ? "Session pooler" : d.pooler === "direct" ? "직접 연결" : null,
    `TLS ${d.sslMode ?? "기본"}`,
    `스키마 ${d.schema ?? "public(기본)"}`,
    `풀 ${d.poolMax}`,
  ].filter(Boolean);
  const weakTls = d.provider === "supabase" && (d.sslMode === "disable" || d.sslMode === null);
  return weakTls
    ? { name: "database_target", kind: null, status: "warn", message: `${parts.join(" · ")} — TLS 없이 연결합니다(로컬 supabase start 전용).`, remedy: "운영 Supabase 는 sslmode=require 이상을 쓰세요(기본값)." }
    : { name: "database_target", kind: null, status: "pass", message: parts.join(" · ") };
}

export function schemaResult(insp: AppSchemaInspection): DoctorResult {
  const missingGist = !insp.installed.btree_gist && !insp.available.includes("btree_gist");
  const msg = `대상 스키마 ${insp.schema}: ${insp.appOwned ? "이 앱의 스키마" : insp.exists ? "비어 있음" : "아직 없음(생성 예정)"}. 계획: ${insp.plan.join("; ")}`;
  if (missingGist) return { name: "database_schema", kind: null, status: "fail", message: `${msg} — btree_gist 확장을 쓸 수 없습니다.`, remedy: REMEDY.database };
  return { name: "database_schema", kind: null, status: "pass", message: msg };
}

export interface DoctorOptions {
  offline?: boolean;
  log?: (m: string) => void;
}

export async function runDoctor(config: InstallConfig, o: DoctorOptions = {}): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [checkNode(), checkHomePermissions(config), checkConfigFile(config.home)];
  const server = await detectServer(config);

  // ports + orphan postmaster (S-9)
  if (server.running) results.push({ name: "port", kind: null, status: "pass", message: `서버가 ${server.url} 에서 응답합니다.` });
  else {
    const free = await portFree(config.server.port, config.server.host).catch(() => false);
    results.push(
      free
        ? { name: "port", kind: null, status: "pass", message: `포트 ${config.server.port} 사용 가능` }
        : { name: "port", kind: null, status: "fail", message: `포트 ${config.server.port} 를 다른 프로세스가 쓰고 있습니다.`, remedy: "`ncs config set server.port <포트>`" },
    );
  }
  // CFG-6: a Tailscale bind without MagicDNS names rejects http://<machine>:<port> (Host guard, 403)
  if (!isLoopbackHost(config.server.host) && config.server.allowed_hostnames.length === 0) {
    results.push({
      name: "allowed_hostnames",
      kind: null,
      status: "warn",
      message: `server.host=${config.server.host} 이지만 server.allowed_hostnames 가 비어 있어 이름(예: MagicDNS)으로 접속하면 403 이 됩니다.`,
      remedy: "`ncs config set server.allowed_hostnames <짧은이름>,<전체 MagicDNS 이름>` 또는 NCS_ALLOWED_HOSTNAMES",
    });
  }
  if (config.database.mode === "embedded") {
    const st = embeddedRuntime(config).status();
    if (st.running && !server.running) {
      results.push({ name: "embedded_pg", kind: null, status: "warn", message: `서버 없이 내장 PostgreSQL(pid ${st.pid})이 실행 중입니다(고아 postmaster).`, remedy: "다음 `ncs run` 이 연결해 재사용합니다. 필요하면 해당 프로세스를 종료하세요." });
    } else if (!st.running && !(await portFree(config.database.embedded_port).catch(() => false))) {
      results.push({ name: "embedded_pg", kind: null, status: "fail", message: `내장 PostgreSQL 포트 ${config.database.embedded_port} 를 다른 프로세스가 씁니다.`, remedy: "`ncs config set database.embedded_port <포트>`" });
    } else {
      results.push({ name: "embedded_pg", kind: null, status: "pass", message: `${st.initialized ? "초기화됨" : "아직 초기화 안 됨"} (${embeddedDataDir(config)}, 포트 ${config.database.embedded_port})` });
    }
  }

  // external DB (plain PostgreSQL / Supabase): URL rules first (TLS, no transaction pooler, schema)
  if (config.database.mode === "external") {
    try {
      results.push(describeExternalTarget(resolveDatabaseConnection(config)));
    } catch (err) {
      results.push({ name: "database_target", kind: null, status: "fail", message: redactDatabaseSecrets((err as Error).message, config.database.url), remedy: REMEDY.database });
    }
  }

  // migrations
  let dbOk = true;
  try {
    const raw = await openRawDb(config);
    try {
      if (raw.schemaInspection) results.push(schemaResult(raw.schemaInspection));
      const st = await migrationStatus(raw.target);
      if (!st.ok) results.push({ name: "migrations", kind: null, status: "fail", message: `DB가 더 새 버전이거나 체크섬이 다릅니다: ${[...st.unknown, ...st.checksumMismatch].join(", ")}`, remedy: "앱을 해당 버전으로 업그레이드하거나 백업에서 복원하세요." });
      else if (st.pending.length) results.push({ name: "migrations", kind: null, status: "warn", message: `적용 대기: ${st.pending.join(", ")}`, remedy: "`ncs migrate apply` 또는 서버 시작 시 자동 적용" });
      else results.push({ name: "migrations", kind: null, status: "pass", message: `최신 (${st.applied.at(-1)?.id ?? "-"})` });
    } finally {
      await raw.close();
    }
  } catch (err) {
    dbOk = false;
    results.push({
      name: "database",
      kind: "database",
      status: "fail",
      message: `DB에 연결할 수 없습니다: ${redactDatabaseSecrets((err as Error).message, config.database.url)}`,
      remedy: REMEDY.database,
    });
  }

  // registry checks (shared with the server's periodic checks; results stored)
  if (!o.offline && dbOk) {
    try {
      const items: HealthResultLike[] = server.running
        ? (await api<{ items: HealthResultLike[] }>(config, "POST", "/api/system/health-checks/run", {})).items
        : await withCore(config, (core) => core.modules.system.service.runHealthChecks({}));
      for (const h of items) {
        results.push({ name: h.name, kind: h.kind, status: h.status, message: h.message, novelId: h.novelId, remedy: h.status === "pass" ? undefined : REMEDY[h.kind] });
      }
    } catch (err) {
      results.push({ name: "health_checks", kind: null, status: "fail", message: `서버 점검을 실행할 수 없습니다: ${(err as Error).message}` });
    }
  }
  if (!existsSync(join(config.home, "secrets"))) {
    results.push({ name: "master_key", kind: null, status: "warn", message: "비밀 마스터 키가 아직 없습니다(첫 비밀 저장 시 생성).", remedy: "생성 후 master.key 를 백업과 다른 곳에 따로 보관하세요." });
  }
  return results;
}
