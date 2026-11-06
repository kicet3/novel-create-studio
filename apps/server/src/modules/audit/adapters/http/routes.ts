import { activityQuerySchema } from "@ncs/shared";
import type { z } from "zod";
import type { ApiRouters } from "../../../../platform/index.js";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import type { ActivityFilter, AuditService } from "../../index.js";

type Q = { query: z.output<typeof activityQuerySchema> };

function toFilter(q: Q["query"]): ActivityFilter {
  return {
    actorType: q.actorType,
    actorId: q.actorId,
    targetType: q.targetType,
    targetIds: q.targetId ? q.targetId.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    actionPrefix: q.actionPrefix,
    afterSeq: q.afterSeq,
    beforeSeq: q.beforeSeq,
    limit: q.limit,
  };
}

export function mountAuditRoutes(r: ApiRouters, audit: AuditService): void {
  const v = validate({ query: activityQuerySchema });
  /** GET /api/novels/:novelId/activity */
  r.novel.get("/activity", v, async (_req, res) => {
    res.json(await audit.list(scopeOf(res), toFilter(valid<Q>(res).query)));
  });
  /** GET /api/activity — install-level events (novel_id IS NULL) */
  r.api.get("/activity", v, async (_req, res) => {
    res.json(await audit.list(null, toFilter(valid<Q>(res).query)));
  });
}
