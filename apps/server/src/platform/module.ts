/**
 * Server module contract. Every `modules/<name>/index.ts` exports a factory
 * `create<Name>Module(deps): ServerModule<<Name>Service>` (sync) — the composition root
 * (`apps/server/src/composition/modules.ts`) calls the factories in dependency order.
 */
import type { Router } from "express";
import type { WorkSignalKind } from "./work-signal.js";

export const MODULE_NAMES = [
  "audit",
  "system",
  "novel",
  "budget",
  "llm",
  "ontology",
  "orchestration",
  "agents",
  "messaging",
  "hitl",
  "linking",
  "manuscript",
  "foreshadow",
  "continuity",
  "concept",
  "export",
  "imaging",
  "cast",
  "world",
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** Routers handed to a module's `routes()`. */
export interface ApiRouters {
  /** mounted at `/api` — install-level routes (e.g. `/api/novels`, `/api/system/...`) */
  api: Router;
  /**
   * mounted at `/api/novels/:novelId` with `mergeParams` — every handler here runs AFTER the tenant
   * guard (novel exists, else 404; 03 T-4). Read the scope with `scopeOf(res)` from http/kit.
   */
  novel: Router;
}

/** A periodic background job driven by the runtime (scheduler loop). */
export interface BackgroundLoop {
  /** unique, e.g. "orchestration.dispatcher" */
  name: string;
  /** poll interval (02 §5.1: consumers poll even without hints) */
  intervalMs: number;
  /** WorkSignal kinds that trigger an immediate tick */
  wakeOn?: WorkSignalKind[];
  /** run a tick right after start (default true) */
  runOnStart?: boolean;
  /** one tick; must return promptly when `signal` aborts (shutdown) */
  tick(signal: AbortSignal): Promise<void>;
}

export interface ServerModule<S> {
  readonly name: ModuleName;
  /** public service — the only thing other modules may call */
  readonly service: S;
  /** mount HTTP routes */
  routes?(r: ApiRouters): void;
  /** background loops started after HTTP is listening */
  loops?: BackgroundLoop[];
  /** after ALL modules are built (cross-module registration, recovery on boot) — called in module order */
  start?(): Promise<void>;
  /** graceful shutdown — called in reverse module order after loops stopped */
  stop?(): Promise<void>;
  /** false while the module is still the placeholder generated in the contracts phase */
  readonly implemented: boolean;
}
