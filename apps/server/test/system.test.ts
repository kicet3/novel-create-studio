import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSecretCipher, createLocalDiskStorage, createSecretProvider, memorySecretStore, SecretUndecryptableError } from "../src/platform/index.js";
import { createTestCore, type TestCore } from "./support/test-core.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
});
afterAll(() => t.close());

describe("platform secrets & storage", () => {
  it("AES-GCM round trip bound to the secret id; key file is 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ncs-key-"));
    try {
      const file = join(dir, "secrets", "master.key");
      const c = createLocalSecretCipher(file);
      const enc = c.encrypt("sk-test", "llm.anthropic.api_key");
      expect(enc.ciphertext).not.toContain("sk-test");
      expect(c.decrypt(enc, "llm.anthropic.api_key")).toBe("sk-test");
      expect(() => c.decrypt(enc, "other.id")).toThrow();
      expect(createLocalSecretCipher(file).decrypt(enc, "llm.anthropic.api_key")).toBe("sk-test");
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CFG-8: a lost master key is not regenerated; decrypting reports the real reason (review regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ncs-key-"));
    try {
      const file = join(dir, "secrets", "master.key");
      const store = memorySecretStore();
      await createSecretProvider(createLocalSecretCipher(file), store).set("llm.anthropic.api_key", "sk-test");
      renameSync(file, `${file}.moved`);
      const lost = createLocalSecretCipher(file);
      expect(existsSync(file)).toBe(false); // boot does not create a new key
      expect(lost.keySource()).toBe("missing");
      const p = createSecretProvider(lost, store);
      await expect(p.get("llm.anthropic.api_key")).rejects.toBeInstanceOf(SecretUndecryptableError);
      await expect(p.get("llm.anthropic.api_key")).rejects.toMatchObject({ code: "secret_undecryptable", details: { reason: "missing_key" } });
      // a different key file → wrong_key (not "unregistered")
      await p.set("other", "x"); // first encrypt creates a fresh key
      expect(existsSync(file)).toBe(true);
      await expect(p.get("llm.anthropic.api_key")).rejects.toMatchObject({ details: { reason: "wrong_key" } });
      expect(await p.get("other")).toBe("x");
      // NCS_SECRETS_MASTER_KEY has priority over the file
      const envKey = randomBytes(32).toString("base64");
      const e = createLocalSecretCipher(file, { envKey });
      expect(e.keySource()).toBe("env");
      expect(e.decrypt(e.encrypt("v", "id"), "id")).toBe("v");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("health check `secrets` fails when a stored secret cannot be decrypted", async () => {
    const sys = t.modules.system.service;
    expect((await sys.runHealthChecks({ names: ["secrets"], record: false }))[0]!.status).toBe("pass");
    await t.testDb.query(`INSERT INTO secrets (id, ciphertext, nonce, auth_tag, key_version, label) VALUES ('test.broken', 'AAAA', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA==', 1, null)`);
    const r = (await sys.runHealthChecks({ names: ["secrets"], record: false }))[0]!;
    expect(r.status).toBe("fail");
    expect(r.message).toContain("복호화할 수 없습니다");
    await t.testDb.query(`DELETE FROM secrets WHERE id = 'test.broken'`);
  });

  it("local_disk storage is write-once and rejects path escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ncs-fs-"));
    try {
      const s = createLocalDiskStorage(dir);
      const o = await s.put("novels/n1/a.txt", "가나다");
      expect(o.size).toBe(9);
      await expect(s.put("novels/n1/a.txt", "x")).rejects.toThrow();
      await s.put("novels/n1/a.txt", "x", { overwrite: true });
      expect((await s.get("novels/n1/a.txt")).toString()).toBe("x");
      expect(await s.list("novels")).toEqual(["novels/n1/a.txt"]);
      expect(() => s.pathOf("../etc/passwd")).toThrow();
      await s.delete("novels/n1/a.txt");
      expect(await s.exists("novels/n1/a.txt")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("system module", () => {
  it("stores secrets encrypted in the DB and exposes metadata only over HTTP", async () => {
    const put = await t.http("PUT", "/api/system/secrets/llm.anthropic.api_key", { value: "sk-live-xyz", label: "Anthropic" });
    expect(put.status).toBe(204);
    expect(await t.modules.system.service.secrets.get("llm.anthropic.api_key")).toBe("sk-live-xyz");
    const rows = await t.testDb.query<{ ciphertext: string }>("SELECT ciphertext FROM secrets");
    expect(rows[0]!.ciphertext).not.toContain("sk-live");
    const list = await t.http("GET", "/api/system/secrets");
    expect(JSON.stringify(list.body)).not.toContain("sk-live");
    expect(list.body.items[0].id).toBe("llm.anthropic.api_key");
    const ev = (await t.modules.audit.service.list(null, { actionPrefix: "secret." })).items;
    expect(ev[0]!.action).toBe("secret.set");
    expect(JSON.stringify(ev)).not.toContain("sk-live");
    expect((await t.http("DELETE", "/api/system/secrets/llm.anthropic.api_key")).status).toBe(204);
    expect((await t.http("DELETE", "/api/system/secrets/llm.anthropic.api_key")).status).toBe(404);
  });

  it("runs registered health checks, stores latest results and audits new failures once", async () => {
    const sys = t.modules.system.service;
    let status: "pass" | "fail" = "fail";
    sys.registerHealthCheck({ name: "test.flaky", kind: "llm_key", scope: "install", run: async () => ({ status, message: status }) });
    const r1 = await sys.runHealthChecks();
    expect(r1.find((r) => r.name === "database")!.status).not.toBe("fail");
    expect(r1.find((r) => r.name === "storage")!.status).toBe("pass");
    expect(r1.find((r) => r.name === "test.flaky")!.status).toBe("fail");
    await sys.runHealthChecks({ names: ["test.flaky"] });
    // (other checks, e.g. llm.anthropic after its key was deleted above, may fail too — count only this one)
    const flakyFailures = (await t.modules.audit.service.list(null, { actionPrefix: "system.health_check_failed" })).items.filter((e) => JSON.stringify(e).includes("test.flaky"));
    expect(flakyFailures).toHaveLength(1);
    status = "pass";
    await sys.runHealthChecks({ names: ["test.flaky"] });
    const latest = await sys.latestHealthResults();
    expect(latest.find((r) => r.name === "test.flaky")!.status).toBe("pass");
    const http = await t.http("GET", "/api/system/health-checks");
    expect(http.body.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["database", "storage", "test.flaky"]));
    expect((await t.http("GET", "/api/system/info")).body.deploymentMode).toBe("local_trusted");
  });
});
