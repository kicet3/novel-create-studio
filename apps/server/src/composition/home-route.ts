/**
 * GET /api/novels/:novelId/home (08 §9.2) — read-only aggregator above modules (composition layer may
 * import every module). Sections whose module is still a placeholder come back as `null`
 * (`modules` lists implemented flags) so the web can render progressively.
 */
import { NotImplementedError, type ApiRouters } from "../platform/index.js";
import { scopeOf } from "../http/kit.js";
import type { Modules } from "./modules.js";

async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotImplementedError) return null;
    throw err;
  }
}

export function mountHomeRoute({ novel }: ApiRouters, m: Modules): void {
  novel.get("/home", async (_req, res) => {
    const scope = scopeOf(res);
    const [n, goal, arcs, episodes, reserve, questions, issues, setupsDueSoon, budget, health] = await Promise.all([
      m.novel.service.getNovel(scope),
      m.novel.service.getGoal(scope),
      m.novel.service.listArcs(scope),
      optional(() => m.manuscript.service.listEpisodes(scope)),
      optional(() => m.manuscript.service.reserveSummary(scope)),
      optional(() => m.hitl.service.pendingCounts(scope)),
      optional(() => m.continuity.service.countOpenBySeverity(scope)),
      optional(() => m.foreshadow.service.listSetups(scope, { dueWithinEpisodes: 5 })),
      optional(() => m.budget.service.status(scope)),
      m.system.service.latestHealthResults({ novelId: scope.novelId }),
    ]);
    const counts = episodes
      ? {
          total: episodes.length,
          approved: episodes.filter((e) => e.status === "approved").length,
          published: episodes.filter((e) => e.status === "published").length,
          inProgress: episodes.filter((e) => !["planned", "approved", "published"].includes(e.status)).length,
        }
      : null;
    res.json({
      novel: n,
      goal,
      arcs,
      episodes: counts,
      reserve,
      questions,
      continuityIssues: issues,
      setupsDueSoon,
      budget,
      health: health.filter((h) => h.status !== "pass"),
      modules: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.implemented])),
    });
  });
}
