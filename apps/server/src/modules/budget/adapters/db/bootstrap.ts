/** N1 participant (03 INV-NOV-06): default budget policy. Implemented in the contracts phase; keep or refactor. */
import { DEFAULTS, usdToMicros } from "@ncs/shared";
import { budgetPolicies } from "@ncs/db/schema";
import type { NovelScope, Platform, Tx } from "../../../../platform/index.js";
import type { BudgetPolicy } from "../../index.js";

export async function insertDefaultBudgetPolicies(platform: Platform, tx: Tx, scope: NovelScope): Promise<BudgetPolicy[]> {
  const now = platform.clock.date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return tx.db
    .insert(budgetPolicies)
    .values({
      id: platform.ids.next("bgp"),
      novelId: scope.novelId,
      category: "all",
      budgetWindow: DEFAULTS["budget.window"],
      hardLimitMicros: usdToMicros(DEFAULTS["budget.novel_monthly_hard_limit_usd"]),
      softWarnRatio: DEFAULTS["budget.soft_warn_ratio"],
      unpricedUsagePolicy: platform.config.budget.unpriced_usage_policy,
      windowStartedAt: windowStart,
    })
    .returning();
}
