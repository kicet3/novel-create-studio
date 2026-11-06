/**
 * Install config for the CLI (08 §5.1): flags > env (NCS_*, DATABASE_URL) > `$NCS_HOME/config.json` >
 * defaults — same layering as the server's loadInstallConfig. `config.json` holds no secret values.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "@ncs/db";
import {
  INSTALL_DEFAULTS,
  installConfigFromEnv,
  mergeConfigLayers,
  installConfigSchema,
  resolveEmbeddedDataDir,
  type InstallConfig,
  type InstallConfigInput,
} from "@ncs/shared";

export type ConfigObject = Record<string, unknown>;

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.NCS_HOME ?? INSTALL_DEFAULTS.home);
}

export function configPath(home = resolveHome()): string {
  return join(home, "config.json");
}

export function readConfigFile(home = resolveHome()): ConfigObject {
  const p = configPath(home);
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${p}: JSON 객체가 아닙니다.`);
  return raw as ConfigObject;
}

/** Atomic write, file 0600, home dir 0700 (08 §5.1 permissions). */
export function writeConfigFile(obj: ConfigObject, home = resolveHome()): string {
  const p = configPath(home);
  ensureDir(dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
  return p;
}

export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {
    /* best effort */
  }
}

export interface LoadedConfig {
  config: InstallConfig;
  home: string;
  file: ConfigObject;
}

export function loadConfig(opts: { env?: NodeJS.ProcessEnv; flags?: InstallConfigInput } = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const home = resolveHome(env);
  const file = readConfigFile(home);
  const cfg = installConfigSchema.parse(mergeConfigLayers({ home } as InstallConfigInput, file as InstallConfigInput, installConfigFromEnv(env), opts.flags));
  const config: InstallConfig = { ...cfg, home: expandHome(cfg.home) };
  return { config, home: config.home, file };
}

/** Validate a config object (file layer) the way the server will see it. */
export function validateConfigObject(obj: ConfigObject, env: NodeJS.ProcessEnv = process.env): { ok: true; config: InstallConfig } | { ok: false; issues: string[] } {
  const r = installConfigSchema.safeParse(mergeConfigLayers({ home: resolveHome(env) } as InstallConfigInput, obj as InstallConfigInput, installConfigFromEnv(env)));
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export function embeddedDataDir(config: InstallConfig): string {
  return expandHome(resolveEmbeddedDataDir(config));
}

export function backupsDir(config: InstallConfig): string {
  return expandHome(config.backup.dir ?? join(config.home, "backups"));
}

export function storageRoot(config: InstallConfig): string {
  return expandHome(config.storage.root ?? join(config.home, "files"));
}

export function masterKeyFile(config: InstallConfig, env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.NCS_SECRETS_MASTER_KEY_FILE ?? config.secrets.master_key_file ?? join(config.home, "secrets", "master.key"));
}

// ── dotted key access ────────────────────────────────────────────────────────

const FORBIDDEN_KEY = /(token|secret|password|api_?key)$/i;

export function getKey(obj: unknown, key: string): unknown {
  if (!key) return obj;
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parse a CLI value: JSON literal (number, boolean, null, array, object, "quoted") else raw string. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function setKey(obj: ConfigObject, key: string, value: unknown): ConfigObject {
  const parts = key.split(".").filter(Boolean);
  if (!parts.length) throw new Error("키가 비어 있습니다.");
  const leaf = parts.at(-1)!;
  if (FORBIDDEN_KEY.test(leaf) && !leaf.endsWith("_id")) {
    throw new Error("비밀 값은 config.json 에 넣지 않습니다. `ncs secrets set` 을 쓰세요.");
  }
  const out: ConfigObject = structuredClone(obj);
  let cur: ConfigObject = out;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as ConfigObject;
  }
  if (value === undefined) delete cur[leaf];
  else cur[leaf] = value;
  return out;
}

export function unsetKey(obj: ConfigObject, key: string): ConfigObject {
  return setKey(obj, key, undefined);
}
