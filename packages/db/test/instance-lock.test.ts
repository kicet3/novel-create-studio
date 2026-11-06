/** 02 §2.3 step 1: `$NCS_HOME/run/server.lock` (review regression: a second server/restore must not attach to a live install) */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServerLock, InstanceLockError, readLiveServerLock, serverLockPath } from "../src/index.js";

describe("server.lock", () => {
  it("is exclusive while the holder lives, readable for the CLI, and released on stop", () => {
    const home = mkdtempSync(join(tmpdir(), "ncs-lock-"));
    try {
      const held = acquireServerLock(home, { host: "100.75.75.99", port: 3100 });
      expect(readLiveServerLock(home)).toMatchObject({ pid: process.pid, host: "100.75.75.99", port: 3100 });
      // another process with a live pid holds it → refused
      writeFileSync(serverLockPath(home), JSON.stringify({ pid: process.ppid, host: "127.0.0.1", port: 3200, startedAt: "x" }));
      expect(() => acquireServerLock(home, { host: "127.0.0.1", port: 3300 })).toThrow(InstanceLockError);
      held.release(); // not ours any more → left alone
      expect(readLiveServerLock(home)?.pid).toBe(process.ppid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("takes over a stale lock left by a dead process (kill -9)", () => {
    const home = mkdtempSync(join(tmpdir(), "ncs-lock-"));
    try {
      mkdirSync(join(home, "run"), { recursive: true });
      writeFileSync(serverLockPath(home), JSON.stringify({ pid: 2 ** 22 + 12345, host: "127.0.0.1", port: 3100, startedAt: "x" }));
      expect(readLiveServerLock(home)).toBeNull();
      const held = acquireServerLock(home, { host: "127.0.0.1", port: 3101 });
      expect(readLiveServerLock(home)).toMatchObject({ pid: process.pid, port: 3101 });
      held.release();
      expect(readLiveServerLock(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
