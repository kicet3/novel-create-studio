import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { parseInstallConfig } from "@ncs/shared";
import { createApp } from "../src/http/app.js";

async function withApp(fn: (base: string) => Promise<void>, configInput: Parameters<typeof parseInstallConfig>[0] = {}) {
  const app = createApp({
    config: parseInstallConfig(configInput),
    version: "t",
    checkDatabase: async () => "pass",
    registerRoutes: ({ api }) => {
      api.post("/echo", (req, res) => void res.status(201).json({ ok: true, body: req.body ?? null }));
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("http app", () => {
  it("serves /api/health", async () => {
    await withApp(async (base) => {
      const r = await fetch(`${base}/api/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ status: "ok", version: "t", database: "pass" });
    });
  });
  it("rejects foreign Host headers in local_trusted (CFG-6) and 404s unknown API routes", async () => {
    await withApp(async (base) => {
      const { request } = await import("node:http");
      const status = await new Promise<number>((res) => {
        const u = new URL(`${base}/api/health`);
        request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.example" } }, (r) => res(r.statusCode ?? 0)).end();
      });
      expect(status).toBe(403);
      expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    });
  });

  it("mutation guard: cross-site browser requests and non-JSON bodies are refused (02 §9.3, review regression)", async () => {
    await withApp(async (base) => {
      const host = new URL(base).host;
      const post = (headers: Record<string, string>, body?: string) => fetch(`${base}/api/echo`, { method: "POST", headers, body });
      expect((await post({ origin: "http://evil.example", "content-type": "text/plain" }, "x")).status).toBe(403);
      expect((await post({ origin: "http://evil.example", "content-type": "application/json" }, "{}")).status).toBe(403);
      expect((await post({ origin: "null" })).status).toBe(403);
      expect((await post({ "sec-fetch-site": "cross-site", "content-type": "application/json" }, "{}")).status).toBe(403);
      expect((await post({ "sec-fetch-site": "same-site", "content-type": "application/json" }, "{}")).status).toBe(403);
      // simple (CORS-less) form / text posts are refused even without an Origin
      expect((await post({ "content-type": "application/x-www-form-urlencoded" }, "a=1")).status).toBe(415);
      expect((await post({ "content-type": "text/plain" }, "x")).status).toBe(415);
      // same-origin web UI, CLI (no Origin / Sec-Fetch-*) and bodiless posts pass
      expect((await post({ origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, "{}")).status).toBe(201);
      expect((await post({ "content-type": "application/json" }, '{"a":1}')).status).toBe(201);
      expect((await post({})).status).toBe(201);
      // GET is not guarded
      expect((await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } })).status).toBe(200);
    });
  });
  it("host guard accepts allowed MagicDNS names case-insensitively and with a trailing dot (CFG-6)", async () => {
    await withApp(
      async (base) => {
        const { request } = await import("node:http");
        const u = new URL(`${base}/api/health`);
        const status = (host: string) =>
          new Promise<number>((res) => request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (r) => res(r.statusCode ?? 0)).end());
        expect(await status(`snowfall-macmini:${u.port}`)).toBe(200);
        expect(await status(`Snowfall-MacMini.tail447a11.ts.net.:${u.port}`)).toBe(200);
        expect(await status(`other-machine:${u.port}`)).toBe(403);
      },
      { server: { allowed_hostnames: ["snowfall-macmini", "snowfall-macmini.tail447a11.ts.net"] } },
    );
  });
});

describe("NotFoundError message", () => {
  it("picks 을/를 by the final consonant (review3 #19: '화을(를)')", async () => {
    const { NotFoundError } = await import("../src/platform/errors.js");
    expect(new NotFoundError("회차").message).toBe("회차를 찾을 수 없습니다.");
    expect(new NotFoundError("3화").message).toBe("3화를 찾을 수 없습니다.");
    expect(new NotFoundError("작품").message).toBe("작품을 찾을 수 없습니다.");
    expect(new NotFoundError("API").message).toBe("API을(를) 찾을 수 없습니다.");
  });
});
