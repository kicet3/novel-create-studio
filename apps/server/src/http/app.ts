/**
 * Express 5 app: host guard (CFG-6), JSON body, request log, `/api` routes (install-level + tenant-guarded
 * `/api/novels/:novelId`), static web UI with SPA fallback (production), error handler.
 */
import express, { type Express, type NextFunction, type Request, type Response, Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { isLoopbackHost, type InstallConfig, type HealthResponse } from "@ncs/shared";
import { AppError, novelScope, type ApiRouters, type Logger } from "../platform/index.js";

/** @deprecated alias kept for older imports — use AppError from platform/errors. */
export { AppError as HttpError };

export interface AppDeps {
  config: InstallConfig;
  version: string;
  log?: Logger;
  checkDatabase: () => Promise<"pass" | "warn" | "fail">;
  /** tenant guard: resolve true when the novel exists (03 T-4 → 404 otherwise) */
  novelExists?: (novelId: string) => Promise<boolean>;
  /** acting user id for the request (local_trusted: owner) */
  resolveUserId?: (req: Request) => Promise<string | null>;
  /** mount module routes */
  registerRoutes?: (r: ApiRouters) => void;
}

/** host part of a Host header value (`[::1]:3100` → `[::1]`, `name.:3100` → `name`), lower-cased */
export function hostnameOf(raw: string): string {
  const v = raw.trim().toLowerCase();
  const host = v.startsWith("[") ? v.slice(0, v.indexOf("]") + 1) : v.split(":")[0]!;
  return host.endsWith(".") ? host.slice(0, -1) : host; // FQDN trailing dot (snowfall-macmini.tail….ts.net.)
}

/** Hosts accepted in the Host header: loopback, the configured bind host and extra allowed names. */
function hostGuard(config: InstallConfig) {
  const norm = (h: string) => {
    const v = h.trim().toLowerCase().replace(/\.$/, "");
    return v.includes(":") && !v.startsWith("[") ? `[${v}]` : v; // bare IPv6 → Host-header form
  };
  const allowed = new Set([config.server.host, ...config.server.allowed_hostnames].map(norm));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (config.deployment_mode !== "local_trusted") return next();
    const host = hostnameOf(req.headers.host ?? "");
    if (isLoopbackHost(host) || allowed.has(host)) return next();
    next(new AppError(403, "forbidden_host", `Host not allowed: ${host}`));
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF / mutation guard (02 §9.3, 10 PM-16, NFR-SEC-03) for state-changing `/api` requests, in every
 * deployment mode: no CORS, so a browser request must be same-origin.
 *  - `Origin` present → it must equal this request's own origin (scheme-less host:port of the Host header);
 *  - no `Origin` → a browser's `Sec-Fetch-Site` must be `same-origin` or `none`;
 *  - a request body must be JSON (blocks "simple" text/plain and form posts).
 * Requests without Origin and Sec-Fetch-Site (CLI, scripts, Telegram mock) pass.
 */
export function mutationGuard() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const host = (req.headers.host ?? "").trim().toLowerCase();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = (u.protocol === "http:" || u.protocol === "https:") && u.host.toLowerCase() === host;
      } catch {
        ok = false; // "null" or malformed
      }
      if (!ok) return next(new AppError(403, "forbidden_origin", "다른 사이트에서 보낸 요청은 처리하지 않습니다."));
    } else {
      const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
      if (site && site !== "same-origin" && site !== "none") return next(new AppError(403, "forbidden_origin", "다른 사이트에서 보낸 요청은 처리하지 않습니다."));
    }
    const len = Number(req.headers["content-length"] ?? 0);
    const hasBody = len > 0 || req.headers["transfer-encoding"] !== undefined;
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if ((hasBody || type) && !(type.startsWith("application/json") || (!hasBody && type === ""))) {
      return next(new AppError(415, "unsupported_media_type", "요청 본문은 JSON(application/json)이어야 합니다."));
    }
    next();
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");
  app.use(hostGuard(deps.config));
  app.use("/api", mutationGuard());
  app.use(express.json({ limit: "5mb" }));

  if (deps.log) {
    const log = deps.log;
    app.use("/api", (req, res, next) => {
      const t0 = performance.now();
      res.on("finish", () => {
        const ms = Math.round(performance.now() - t0);
        const lvl = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "debug";
        log[lvl]({ method: req.method, url: req.originalUrl, status: res.statusCode, ms }, "http");
      });
      next();
    });
  }

  const api = Router();
  api.get("/health", async (_req, res) => {
    const database = await deps.checkDatabase().catch(() => "fail" as const);
    const body: HealthResponse = { status: database === "pass" ? "ok" : "degraded", version: deps.version, database };
    res.status(database === "fail" ? 503 : 200).json(body);
  });

  api.use(async (req, res, next) => {
    res.locals.userId = (await deps.resolveUserId?.(req)) ?? null;
    next();
  });

  const novel = Router({ mergeParams: true });
  api.use(
    "/novels/:novelId",
    async (req: Request<{ novelId: string }>, res, next) => {
      const { novelId } = req.params;
      if (!/^nov_[0-9A-HJKMNP-TV-Z]{26}$/.test(novelId) || (deps.novelExists && !(await deps.novelExists(novelId)))) {
        throw new AppError(404, "not_found", "작품을 찾을 수 없습니다.", { id: novelId });
      }
      res.locals.scope = novelScope(novelId);
      next();
    },
    novel,
  );
  deps.registerRoutes?.({ api, novel });
  api.use((_req, _res, next) => next(new AppError(404, "not_found", "API 경로를 찾을 수 없습니다.")));
  app.use("/api", api);

  const webDist = deps.config.server.web_dist_dir;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (_req, res) => res.sendFile(join(webDist, "index.html"), { dotfiles: "allow" }));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: "validation_failed", message: "요청 형식이 올바르지 않습니다.", details: err.issues } });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "invalid_json", message: "JSON 본문을 해석할 수 없습니다." } });
      return;
    }
    deps.log?.error({ err }, "unhandled error");
    res.status(500).json({ error: { code: "internal", message: "서버 내부 오류" } });
  });
  return app;
}
