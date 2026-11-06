import type { Platform } from "../../../platform/index.js";
import { redactDeep } from "../../../platform/index.js";
import type { ActivityEvent, ActivityRecordInput, AuditService } from "../index.js";
import { actorColumns, assertActivityAction } from "../domain/activity.js";
import { createActivityRepository, type ActivityInsert } from "../adapters/db/activity-repository.js";

const MAX_LIMIT = 200;

export function createAuditService(platform: Platform): AuditService {
  const repo = createActivityRepository();
  const listeners = new Set<(e: ActivityEvent) => void>();

  const toRow = (input: ActivityRecordInput): ActivityInsert => {
    assertActivityAction(input.action);
    return {
      id: platform.ids.next("act"),
      novelId: input.novelId,
      occurredAt: platform.clock.date(),
      ...actorColumns(input.actor),
      questionId: input.questionId ?? null,
      approvalId: input.approvalId ?? null,
      answerId: input.answerId ?? null,
      action: input.action,
      targetType: input.target.type,
      targetId: input.target.id,
      before: input.before === undefined ? null : redactDeep(input.before),
      after: input.after === undefined ? null : redactDeep(input.after),
      reason: input.reason ?? null,
      details: input.details === undefined ? null : redactDeep(input.details),
    };
  };

  const publish = (events: ActivityEvent[]) => {
    for (const e of events) {
      for (const l of listeners) {
        try {
          l(e);
        } catch (err) {
          platform.log.warn({ err }, "activity listener failed");
        }
      }
    }
  };

  const recordMany: AuditService["recordMany"] = async (tx, inputs) => {
    const events = await repo.insert(tx.db, inputs.map(toRow));
    if (events.length) tx.afterCommit(() => publish(events));
    return events;
  };

  return {
    async record(tx, input) {
      const [event] = await recordMany(tx, [input]);
      return event!;
    },
    recordMany,
    async list(scope, filter = {}) {
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_LIMIT);
      const novelId = scope?.novelId ?? null;
      const [items, latestSeq] = await Promise.all([
        repo.list(platform.uow.db, novelId, { ...filter, limit: limit + 1 }),
        repo.latestSeq(platform.uow.db, novelId),
      ]);
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;
      return { items: page, nextCursor: hasMore ? String(page[page.length - 1]!.seq) : null, latestSeq };
    },
    latestSeq: (scope) => repo.latestSeq(platform.uow.db, scope?.novelId ?? null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
