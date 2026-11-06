/**
 * audit — public API (design/03 §6, 02 §5.1–5.2, ADR-017).
 *
 * Every state-changing use case calls `audit.record(tx, …)` INSIDE its transaction (02 M-5).
 * After COMMIT the event is published in-process to `subscribe()` listeners (UI refresh / realtime
 * hints only — business logic must not consume it, 02 §5.1).
 */
import type { ActivityAction, ActorType, RefType } from "@ncs/shared";
import type { ActorRef, NovelScope, Ref, Tx } from "../../platform/index.js";

export interface ActivityRecordInput {
  /** null = install-level event (settings, secrets, backups …) */
  novelId: string | null;
  actor: ActorRef;
  action: ActivityAction;
  target: Ref;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** bulk events: put id lists + counts here (03 §6.2 대량 이벤트 규칙) */
  details?: unknown;
  questionId?: string | null;
  approvalId?: string | null;
  answerId?: string | null;
}

export interface ActivityEvent {
  seq: number;
  id: string;
  novelId: string | null;
  occurredAt: Date;
  actorType: ActorType;
  actorId: string;
  runId: string | null;
  questionId: string | null;
  approvalId: string | null;
  answerId: string | null;
  action: string;
  targetType: RefType;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  details: unknown;
}

export interface ActivityFilter {
  actorType?: ActorType;
  actorId?: string;
  targetType?: RefType;
  targetIds?: string[];
  actionPrefix?: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

export interface ActivityPage {
  items: ActivityEvent[];
  /** pass as `beforeSeq` to get the next (older) page */
  nextCursor: string | null;
  latestSeq: number;
}

export interface AuditService {
  /** append one row in the caller's transaction; secrets in before/after/details are masked */
  record(tx: Tx, input: ActivityRecordInput): Promise<ActivityEvent>;
  recordMany(tx: Tx, inputs: ActivityRecordInput[]): Promise<ActivityEvent[]>;
  /** novel timeline (scope) or install-level events (scope = null → novel_id IS NULL) — seq DESC */
  list(scope: NovelScope | null, filter?: ActivityFilter): Promise<ActivityPage>;
  /** highest seq visible in the scope (0 when empty) */
  latestSeq(scope: NovelScope | null): Promise<number>;
  /** post-commit listener; returns unsubscribe */
  subscribe(listener: (event: ActivityEvent) => void): () => void;
}

export type { AuditModuleDeps } from "./module.js";
export { createAuditModule } from "./module.js";
