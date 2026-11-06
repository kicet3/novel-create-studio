/**
 * Single-instance guard (02 §2.3, 04 §11.1 step 1, NFR-REL-06), step 1: `$NCS_HOME/run/server.lock`.
 *
 * Node has no portable OS file lock, so the lock is an exclusively created file holding the owner's
 * PID/host/port; a file whose PID is no longer alive is stale (crash, kill -9) and is taken over.
 * Step 2 (both modes) is the DB session advisory lock `instance_lock` — see `acquireInstanceAdvisoryLock`.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { asConnection, postgresJsOptions, type DbConnection } from "./provider.js";

export interface ServerLockInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

export class InstanceLockError extends Error {
  constructor(
    message: string,
    readonly holder: ServerLockInfo | null,
  ) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export const serverLockPath = (home: string) => join(home, "run", "server.lock");

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** the lock file's content when its owner process is alive, else null (missing / stale / unreadable) */
export function readLiveServerLock(home: string): ServerLockInfo | null {
  try {
    const info = JSON.parse(readFileSync(serverLockPath(home), "utf8")) as ServerLockInfo;
    return pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export interface HeldServerLock {
  readonly path: string;
  readonly info: ServerLockInfo;
  release(): void;
}

/** take `$home/run/server.lock` or throw InstanceLockError when another live process holds it */
export function acquireServerLock(home: string, info: Omit<ServerLockInfo, "pid" | "startedAt">): HeldServerLock {
  const path = serverLockPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine: ServerLockInfo = { pid: process.pid, startedAt: new Date().toISOString(), ...info };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(mine));
      } finally {
        closeSync(fd);
      }
      return {
        path,
        info: mine,
        release() {
          try {
            const cur = JSON.parse(readFileSync(path, "utf8")) as ServerLockInfo;
            if (cur.pid === process.pid) rmSync(path, { force: true });
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLiveServerLock(home);
      if (holder && holder.pid !== process.pid) {
        throw new InstanceLockError(`이미 실행 중인 서버가 있습니다(pid ${holder.pid}, ${holder.host}:${holder.port}). 그 서버를 멈춘 뒤 다시 실행하세요.`, holder);
      }
      // stale lock (owner died): move it aside atomically, then retry the exclusive create
      const aside = `${path}.stale-${process.pid}-${attempt}`;
      try {
        renameSync(path, aside);
        rmSync(aside, { force: true });
      } catch {
        /* another process raced us; retry */
      }
    }
  }
  throw new InstanceLockError("서버 잠금 파일을 잡지 못했습니다. 잠시 뒤 다시 실행하세요.", readLiveServerLock(home));
}

/** fixed key of the session advisory lock `instance_lock` (02 §2.3 step 2) */
export const INSTANCE_LOCK_KEY = 0x4e43_5331; // "NCS1"

export interface HeldAdvisoryLock {
  release(): Promise<void>;
}

/**
 * Hold `pg_try_advisory_lock(instance_lock)` on a dedicated connection (its own one-connection client)
 * for the process lifetime. Retries briefly so a crashed predecessor's backend can notice its closed socket.
 */
export async function acquireInstanceAdvisoryLock(target: string | DbConnection, opts: { retries?: number; delayMs?: number } = {}): Promise<HeldAdvisoryLock> {
  const c = asConnection(target);
  const pg = postgresJsOptions(c);
  // session-level lock: needs a real session (direct connection / Supavisor session mode; 6543 is refused earlier)
  const conn = postgres(c.url, { max: 1, idle_timeout: 0, onnotice: () => {}, ...(pg.ssl !== undefined ? { ssl: pg.ssl } : {}), connection: pg.connection });
  const retries = opts.retries ?? 10;
  try {
    for (let i = 0; ; i++) {
      const [row] = await conn<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${INSTANCE_LOCK_KEY}) AS ok`;
      if (row?.ok) break;
      if (i >= retries) throw new InstanceLockError("다른 서버 프로세스가 같은 데이터베이스를 쓰고 있습니다(instance_lock). 그 서버를 멈춘 뒤 다시 실행하세요.", null);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 500));
    }
  } catch (err) {
    await conn.end({ timeout: 2 }).catch(() => undefined);
    throw err;
  }
  return {
    async release() {
      await conn`SELECT pg_advisory_unlock(${INSTANCE_LOCK_KEY})`.catch(() => undefined);
      await conn.end({ timeout: 2 }).catch(() => undefined);
    },
  };
}
