/**
 * Writes the 공개 사이트 snapshot into the output dir: atomic per file (tmp + rename), unchanged files untouched,
 * files that are no longer public (unpublished episode, opted-out novel) removed.
 *
 * Safety: the writer only manages `novels.json`, `novels/**` and its marker file. It refuses a non-empty
 * directory without the marker (a mis-configured output_dir must never lose someone else's files).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const SITE_MARKER = ".ncs-public-site";

export class SiteDirError extends Error {}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureOwnedDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const marker = join(dir, SITE_MARKER);
  if (await exists(marker)) return;
  const entries = (await readdir(dir)).filter((n) => n !== ".DS_Store");
  if (entries.length) throw new SiteDirError(`공개 사이트 출력 폴더(${dir})에 다른 파일이 있어 쓰지 않았습니다. 빈 폴더를 지정해 주세요.`);
  await writeFile(marker, "novel-create-studio public site snapshot (managed; files here are regenerated)\n", { mode: 0o644 });
}

async function writeAtomic(path: string, content: string): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")) === content) return false;
  } catch {
    /* missing → write */
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, content, { mode: 0o644 });
  await rename(tmp, path);
  return true;
}

async function walk(dir: string): Promise<string[]> {
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** remove empty directories under `root` (deepest first), keeping `root` */
async function pruneEmpty(root: string): Promise<void> {
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const p = join(root, d.name);
    await pruneEmpty(p);
    if (!(await readdir(p)).length) await rmdir(p).catch(() => undefined);
  }
}

export interface WriteResult {
  written: number;
  removed: number;
}

/** files: relative POSIX path → content (must be `novels.json` or under `novels/`) */
export async function writeSite(dir: string, files: ReadonlyMap<string, string>): Promise<WriteResult> {
  for (const rel of files.keys()) {
    if (!(rel === "novels.json" || /^novels\/[a-z0-9-]+\/(index\.json|episodes\/\d+\.json)$/.test(rel))) throw new SiteDirError(`bad snapshot path: ${rel}`);
  }
  await ensureOwnedDir(dir);
  let written = 0;
  // pages first, the list last (a listed novel always has its files)
  const order = [...files.keys()].sort((a, b) => (a === "novels.json" ? 1 : b === "novels.json" ? -1 : b.length - a.length || a.localeCompare(b)));
  for (const rel of order) if (await writeAtomic(join(dir, ...rel.split("/")), files.get(rel)!)) written++;
  let removed = 0;
  const novelsDir = join(dir, "novels");
  for (const abs of await walk(novelsDir)) {
    const rel = relative(dir, abs).split(sep).join("/");
    if (files.has(rel)) continue;
    await rm(abs, { force: true });
    removed++;
  }
  await pruneEmpty(novelsDir);
  return { written, removed };
}
