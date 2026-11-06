/** Budget HTTP (CONVENTIONS §13): GET …/budget, PATCH …/budget/policies/:category, POST …/resume, GET …/budget/cost-events */
import type { z } from "zod";
import { budgetCategoryParamsSchema, budgetPolicyPatchSchema, costEventsQuerySchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { BudgetService } from "../../index.js";

type CategoryParams = { params: z.output<typeof budgetCategoryParamsSchema> };

export function mountBudgetRoutes({ novel }: ApiRouters, svc: BudgetService): void {
  novel.get("/budget", async (_req, res) => {
    const scope = scopeOf(res);
    const items = await svc.status(scope);
    res.json({ items, hardStopped: items.some((i) => i.status === "hard_stopped"), activeReservations: await svc.activeReservationCount(scope) });
  });
  novel.patch("/budget/policies/:category", validate({ params: budgetCategoryParamsSchema, body: budgetPolicyPatchSchema }), async (_req, res) => {
    const { params, body } = valid<CategoryParams & { body: z.output<typeof budgetPolicyPatchSchema> }>(res);
    res.json(await svc.updatePolicy(scopeOf(res), params.category, body, actorOf(res)));
  });
  novel.post("/budget/policies/:category/resume", validate({ params: budgetCategoryParamsSchema }), async (_req, res) => {
    const { params } = valid<CategoryParams>(res);
    res.json(await svc.resume(scopeOf(res), params.category, actorOf(res)));
  });
  novel.get("/budget/cost-events", validate({ query: costEventsQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof costEventsQuerySchema> }>(res);
    res.json({ items: await svc.listCostEvents(scopeOf(res), { runId: query.runId, since: query.since ? new Date(query.since) : undefined, limit: query.limit }) });
  });
}
