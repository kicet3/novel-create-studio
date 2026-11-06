/** HTTP adapter of `foreshadow` (CONVENTIONS §13: GET …/setups, …/setups/report, …/setups/:setupNo). */
import { listSetupsQuerySchema, setupParamsSchema, setupReportQuerySchema, type ListSetupsQuery, type SetupReportQuery } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import { formatSetupNo } from "../../domain/transitions.js";
import type { ForeshadowService, SetupListItem } from "../../index.js";

function toDto<T extends SetupListItem>(s: T) {
  return { ...s, displayLabel: formatSetupNo(s.displayNo) };
}

export function mountForeshadowRoutes({ novel }: ApiRouters, svc: ForeshadowService): void {
  novel.get("/setups", validate({ query: listSetupsQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: ListSetupsQuery }>(res);
    const items = await svc.listSetups(scopeOf(res), {
      narrativeStatuses: query.narrative,
      canonStatuses: query.canon,
      importance: query.importance,
      overdueOnly: query.overdue,
      dueWithinEpisodes: query.dueWithin,
    });
    res.json({ items: items.map(toDto) });
  });
  // registered before /setups/:setupNo so "report" is not taken as a number
  novel.get("/setups/report", validate({ query: setupReportQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: SetupReportQuery }>(res);
    res.json(await svc.report(scopeOf(res), query.asOf));
  });
  novel.get("/setups/:setupNo", validate({ params: setupParamsSchema }), async (_req, res) => {
    const { params } = valid<{ params: { setupNo: string } }>(res);
    res.json(toDto(await svc.getSetup(scopeOf(res), params.setupNo)));
  });
}
