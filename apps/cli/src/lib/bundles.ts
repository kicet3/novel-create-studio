import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface BundleInfo {
  dir: string;
  name: string;
  backupId: string | null;
  createdAt: string | null;
  trigger: string | null;
  engine: string | null;
  valid: boolean;
}

export function listBundles(backupsDir: string): BundleInfo[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((n) => !n.endsWith(".partial") && statSync(join(backupsDir, n)).isDirectory())
    .sort()
    .reverse()
    .map((name) => {
      const dir = join(backupsDir, name);
      try {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, string>;
        return { dir, name, backupId: m.backupId ?? null, createdAt: m.createdAt ?? null, trigger: m.trigger ?? null, engine: m.engine ?? null, valid: true };
      } catch {
        return { dir, name, backupId: null, createdAt: null, trigger: null, engine: null, valid: false };
      }
    });
}

/** `<path>` | `<bundle dir name>` | `bkp_…` id | `latest` → absolute bundle dir. */
export function resolveBundle(arg: string, backupsDir: string): string {
  if (arg === "latest") {
    const b = listBundles(backupsDir).find((x) => x.valid);
    if (!b) throw new Error(`백업이 없습니다: ${backupsDir}`);
    return b.dir;
  }
  const asPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (existsSync(join(asPath, "manifest.json"))) return asPath;
  const inDir = join(backupsDir, arg);
  if (existsSync(join(inDir, "manifest.json"))) return inDir;
  if (/^bkp_/.test(arg)) {
    const b = listBundles(backupsDir).find((x) => x.backupId === arg);
    if (b) return b.dir;
  }
  throw new Error(`백업 묶음을 찾을 수 없습니다: ${arg} (경로, 묶음 이름, bkp_ ID 또는 latest)`);
}
