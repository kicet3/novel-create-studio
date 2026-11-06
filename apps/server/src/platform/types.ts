/**
 * Cross-module kernel types (design/03 §2.2 T-3, §6.1). Every module imports these from platform.
 */
import type { AgentRole, RefType, SystemComponent } from "@ncs/shared";

/** Tenant scope: first argument of every novel-owned repository / service method (03 T-3). */
export interface NovelScope {
  readonly novelId: string;
}

export function novelScope(novelId: string): NovelScope {
  return { novelId };
}

/** Who performs an action (03 §6.1). Agents always carry their run id (activity_log CHECK). */
export type ActorRef =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "agent"; readonly id: AgentRole; readonly runId: string }
  | { readonly type: "system"; readonly id: SystemComponent };

export const actors = {
  user: (userId: string): ActorRef => ({ type: "user", id: userId }),
  agent: (role: AgentRole, runId: string): ActorRef => ({ type: "agent", id: role, runId }),
  system: (component: SystemComponent): ActorRef => ({ type: "system", id: component }),
};

/** Reference to any domain object (enum ref_type). */
export interface Ref {
  readonly type: RefType;
  readonly id: string;
}

/** Cursor page returned by list queries. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
