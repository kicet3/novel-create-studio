/** HTTP adapter of `linking` (설계 추가 0015): the entity resolver backlog cleanup ("에이전트가 정리" in the web inbox). */
import type { LinkingBacklogDto, LinkingResolveBacklogResponse } from "@ncs/shared";
import type { ApiRouters, NovelScope } from "../../../../platform/index.js";
import { actorOf, created, scopeOf } from "../../../../http/kit.js";

export interface BacklogPort {
  openBacklog(scope: NovelScope): Promise<number>;
  request(scope: NovelScope, actor: { type: "user"; id: string }): Promise<{ taskId: string; created: boolean; openQuestions: number }>;
}

export function mountLinkingRoutes({ novel }: ApiRouters, backlog: BacklogPort): void {
  /** GET /api/novels/:novelId/linking/backlog → open entity questions the resolver can clean up */
  novel.get("/linking/backlog", async (_req, res) => {
    const body: LinkingBacklogDto = { openQuestions: await backlog.openBacklog(scopeOf(res)) };
    res.json(body);
  });
  /** POST /api/novels/:novelId/linking/resolve-backlog → resolve_entities task (an active one is returned) */
  novel.post("/linking/resolve-backlog", async (_req, res) => {
    const r = await backlog.request(scopeOf(res), actorOf(res));
    const body: LinkingResolveBacklogResponse = { taskId: r.taskId, created: r.created, openQuestions: r.openQuestions };
    if (r.created) created(res, body);
    else res.json(body);
  });
}
