import { describe, expect, it } from "vitest";
import { parseInstallConfig } from "@ncs/shared";
import { resolveDatabaseConnection } from "@ncs/db";
import { describeExternalTarget, runDoctor } from "../src/lib/doctor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PW = "Sup3r%2Fsecret";
const REF = "abcdefghijklmnopqrst";

describe("ncs doctor — Supabase target", () => {
  it("describes a session-pooler URL without the password or the full project ref", () => {
    const cfg = parseInstallConfig({ database: { mode: "external", url: `postgresql://postgres.${REF}:${PW}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres` } });
    const r = describeExternalTarget(resolveDatabaseConnection(cfg));
    expect(r.status).toBe("pass");
    expect(r.message).toMatch(/Supabase/);
    expect(r.message).toMatch(/Session pooler/);
    expect(r.message).toMatch(/TLS require/);
    expect(r.message).toMatch(/스키마 ncs/);
    expect(r.message).not.toContain("secret");
    expect(r.message).not.toContain(REF);
  });

  it("fails the transaction pooler URL (6543) before connecting, without leaking the password", async () => {
    const home = mkdtempSync(join(tmpdir(), "ncs-doctor-sb-"));
    try {
      const cfg = parseInstallConfig({
        home,
        server: { port: 3999 },
        database: { mode: "external", url: `postgresql://postgres.${REF}:${PW}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres` },
      });
      const results = await runDoctor(cfg, { offline: true });
      const target = results.find((x) => x.name === "database_target");
      expect(target?.status).toBe("fail");
      expect(target?.message).toMatch(/6543/);
      expect(JSON.stringify(results)).not.toContain("secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
