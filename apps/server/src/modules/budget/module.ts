/** budget module factory (03 §7, 04 §8): service, N1 participant (order 30), routes, stale-reservation sweeper. */
import { DEFAULTS } from "@ncs/shared";
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { NovelService } from "../novel/index.js";
import type { BudgetService } from "./index.js";
import { createBudgetService } from "./application/budget-service.js";
import { mountBudgetRoutes } from "./adapters/http/routes.js";

export interface BudgetModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
}

export function createBudgetModule(deps: BudgetModuleDeps): ServerModule<BudgetService> {
  const service = createBudgetService(deps);
  deps.novel.registerCreationParticipant({
    module: "budget",
    order: 30,
    async onNovelCreated(ctx) {
      const [policy] = await service.createDefaultPolicies(ctx.tx, ctx.scope);
      ctx.outputs.budgetPolicyId = policy!.id;
    },
  });
  return {
    name: "budget",
    implemented: true,
    service,
    routes: (r) => mountBudgetRoutes(r, service),
    loops: [
      {
        name: "budget.reservation_sweeper",
        intervalMs: DEFAULTS["reclaim.scan_interval_seconds"] * 1000,
        runOnStart: false,
        async tick() {
          await service.sweepStaleReservations();
        },
      },
    ],
  };
}
