/** Local mock HTTP server for provider adapter / OAuth tests (random port, no network). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage["headers"];
  raw: string;
  json: any;
  form: URLSearchParams | null;
}

export type Handler = (req: Captured, res: ServerResponse) => void | Promise<void>;

export interface MockHttp {
  base: string;
  captured: Captured[];
  /** handlers by "METHOD /path" (path without query); fallback 404 */
  on(route: string, h: Handler): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockHttp(): Promise<MockHttp> {
  const routes = new Map<string, Handler>();
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ct = req.headers["content-type"] ?? "";
      let json: unknown = null;
      if (ct.includes("json") && raw) json = JSON.parse(raw);
      const form = ct.includes("x-www-form-urlencoded") ? new URLSearchParams(raw) : null;
      const c: Captured = { method: req.method ?? "GET", path: url.pathname, url, headers: req.headers, raw, json, form };
      captured.push(c);
      const h = routes.get(`${c.method} ${c.path}`);
      if (!h) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no route ${c.method} ${c.path}` } }));
        return;
      }
      await h(c, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    captured,
    on: (route, h) => void routes.set(route, h),
    reset() {
      routes.clear();
      captured.length = 0;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** SSE response: each item is one `data:` block (optionally `event:`) */
export function sse(res: ServerResponse, events: Array<unknown | { event: string; data: unknown }>, opts: { crlf?: boolean } = {}) {
  const nl = opts.crlf ? "\r\n" : "\n";
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    const withEvent = e && typeof e === "object" && "event" in (e as object) && "data" in (e as object);
    const ev = withEvent ? (e as { event: string; data: unknown }) : null;
    res.write(`${ev ? `event: ${ev.event}${nl}` : ""}data: ${JSON.stringify(ev ? ev.data : e)}${nl}${nl}`);
  }
  res.write(`data: [DONE]${nl}${nl}`);
  res.end();
}

/** unsigned JWT (alg none) for OAuth fixtures */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none", typ: "JWT" })}.${b(claims)}.sig`;
}
