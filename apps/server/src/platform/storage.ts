/**
 * StorageProvider port (02 §3.2, ADR-015): binary/large files outside the DB. MVP: `local_disk`
 * rooted at `storage.root` (default `<home>/files`). Keys are relative POSIX paths such as
 * `novels/<novelId>/exports/<exportJobId>.txt`; `..` and absolute keys are rejected.
 * `put` is write-once by default (fails if the key exists) — pass `{ overwrite: true }` to replace.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

export interface StorageProvider {
  readonly root: string;
  put(key: string, data: Uint8Array | string, opts?: { overwrite?: boolean }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** keys under a prefix (recursive) */
  list(prefix: string): Promise<string[]>;
  /** absolute filesystem path (local_disk only; for streaming downloads) */
  pathOf(key: string): string;
}

export function createLocalDiskStorage(root: string): StorageProvider {
  const absRoot = resolve(root);
  const pathOf = (key: string) => {
    if (!key || key.startsWith("/") || key.split("/").includes("..")) throw new Error(`invalid storage key: ${key}`);
    const p = resolve(absRoot, key);
    if (p !== absRoot && !p.startsWith(absRoot + sep)) throw new Error(`invalid storage key: ${key}`);
    return p;
  };
  const exists = async (key: string) => {
    try {
      await stat(pathOf(key));
      return true;
    } catch {
      return false;
    }
  };
  return {
    root: absRoot,
    pathOf,
    exists,
    async put(key, data, opts = {}) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (!opts.overwrite) {
        await writeFile(p, buf, { flag: "wx" });
      } else {
        const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, buf);
        await rename(tmp, p);
      }
      return { key, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    },
    get: (key) => readFile(pathOf(key)),
    async delete(key) {
      await rm(pathOf(key), { force: true, recursive: true });
    },
    async list(prefix) {
      const base = prefix ? pathOf(prefix) : absRoot;
      const out: string[] = [];
      const walk = async (dir: string) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(full.slice(absRoot.length + 1).split(sep).join("/"));
        }
      };
      await walk(base);
      return out.sort();
    },
  };
}
