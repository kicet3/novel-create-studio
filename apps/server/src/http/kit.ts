/**
 * HTTP helpers for module route adapters (`modules/<m>/adapters/http/routes.ts`).
 *
 *   novel.get("/arcs/:arcId", validate({ params: z.object({ arcId: z.string() }) }), async (req, res) => {
 *     const { params } = valid<{ params: { arcId: string } }>(res);
 *     res.json(await service.getArc(scopeOf(res), params.arcId));
 *   });
 *
 * Express 5 forwards rejected promises to the error handler, so handlers can simply throw
 * AppError subclasses (platform/errors.ts) or let ZodError bubble up (→ 400 validation_failed).
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { AppError, NotFoundError, type ActorRef, type NovelScope } from "../platform/index.js";

export interface ValidationSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

export type Validated<S extends ValidationSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

/** zod validation middleware; parsed values land in `res.locals.valid` (req.query is read-only in Express 5). */
export function validate<S extends ValidationSchemas>(schemas: S): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const out: Record<string, unknown> = {};
    if (schemas.params) out.params = schemas.params.parse(req.params);
    if (schemas.query) out.query = schemas.query.parse(req.query);
    if (schemas.body) out.body = schemas.body.parse(req.body ?? {});
    res.locals.valid = out;
    next();
  };
}

/** Typed access to the values parsed by `validate()`. */
export function valid<T>(res: Response): T {
  if (!res.locals.valid) throw new Error("valid(res) used without validate() middleware");
  return res.locals.valid as T;
}

/** Parse a value with a schema inline (throws ZodError → 400). */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}

/** Tenant scope set by the `/api/novels/:novelId` guard. */
export function scopeOf(res: Response): NovelScope {
  const scope = res.locals.scope as NovelScope | undefined;
  if (!scope) throw new AppError(500, "internal", "scope guard not applied");
  return scope;
}

/** Acting user (local_trusted: the single owner, INV-USR-01). */
export function actorOf(res: Response): Extract<ActorRef, { type: "user" }> {
  const userId = res.locals.userId as string | undefined;
  if (!userId) throw new AppError(401, "unauthenticated", "사용자를 확인할 수 없습니다.");
  return { type: "user", id: userId };
}

/** 201 + JSON helper */
export function created(res: Response, body: unknown): void {
  res.status(201).json(body);
}

/**
 * Streams a file the server itself stored (absolute path derived from a DB row, never from the URL).
 * `dotfiles: "allow"` because the install home may sit under a dot directory (default `~/.ncs`) — Express's
 * `send` would otherwise ignore the whole path and answer 404. A missing file maps to 404 `not_found`.
 */
export function sendStoredFile(res: Response, absPath: string, contentType: string, what = "파일"): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    res.sendFile(absPath, { dotfiles: "allow", headers: { "Content-Type": contentType } }, (err?: Error & { status?: number; statusCode?: number; code?: string }) => {
      if (!err) return resolve();
      if (!res.headersSent && (err.status === 404 || err.statusCode === 404 || err.code === "ENOENT" || err.code === "ENOTDIR")) return reject(new NotFoundError(what));
      reject(err);
    }),
  );
}
