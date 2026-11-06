import type { z } from "zod";
import { taskListQuerySchema, taskParamsSchema, taskReassignRequestSchema } from "@ncs/shared";
import { ConflictError, type ApiRouters, type UnitOfWork } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { OrchestrationService } from "../../index.js";

type P = { params: z.output<typeof taskParamsSchema> };

/** GET /tasks (board, 08 §9.3), task detail, runs, retry/cancel/pause/resume/reassign. */
export function mountOrchestrationRoutes({ novel }: ApiRouters, svc: OrchestrationService, uow: UnitOfWork): void {
  novel.get("/tasks", validate({ query: taskListQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof taskListQuerySchema> }>(res);
    res.json({
      items: await svc.listTasks(scopeOf(res), {
        statuses: query.status,
        kinds: query.kind,
        agentRole: query.agentRole,
        arcId: query.arcId,
        episodeId: query.episodeId,
        includeCancelled: query.includeCancelled,
      }),
    });
  });
  novel.get("/tasks/:taskId", validate({ params: taskParamsSchema }), async (_req, res) => {
    res.json(await svc.getTask(scopeOf(res), valid<P>(res).params.taskId));
  });
  novel.get("/tasks/:taskId/runs", validate({ params: taskParamsSchema }), async (_req, res) => {
    res.json({ items: await svc.listRuns(scopeOf(res), valid<P>(res).params.taskId) });
  });
  novel.post("/tasks/:taskId/retry", validate({ params: taskParamsSchema }), async (_req, res) => {
    const id = valid<P>(res).params.taskId;
    await svc.retryTask(scopeOf(res), id, actorOf(res));
    res.json(await svc.getTask(scopeOf(res), id));
  });
  novel.post("/tasks/:taskId/cancel", validate({ params: taskParamsSchema }), async (_req, res) => {
    const id = valid<P>(res).params.taskId;
    await uow.run((tx) => svc.cancelTask(tx, scopeOf(res), id, actorOf(res)));
    res.json(await svc.getTask(scopeOf(res), id));
  });
  novel.post("/tasks/:taskId/pause", validate({ params: taskParamsSchema }), async (_req, res) => {
    const id = valid<P>(res).params.taskId;
    await uow.run((tx) => svc.pause(tx, scopeOf(res), { scope: "task", id }, "user", actorOf(res)));
    res.json(await svc.getTask(scopeOf(res), id));
  });
  novel.post("/tasks/:taskId/resume", validate({ params: taskParamsSchema }), async (_req, res) => {
    const id = valid<P>(res).params.taskId;
    await uow.run((tx) => svc.resume(tx, scopeOf(res), { scope: "task", id }, actorOf(res)));
    res.json(await svc.getTask(scopeOf(res), id));
  });
  novel.post("/tasks/:taskId/reassign", validate({ params: taskParamsSchema, body: taskReassignRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof taskReassignRequestSchema> }>(res);
    const result = await uow.run((tx) => svc.reassignTask(tx, scopeOf(res), params.taskId, body.toRole, actorOf(res)));
    if ("rejected" in result) {
      throw new ConflictError(
        "reassign_rejected",
        result.rejected === "terminal" ? "끝난 작업은 다시 배정할 수 없습니다." : "이 작업은 선택한 역할로 배정할 수 없습니다.",
        result,
      );
    }
    res.json({ result, task: await svc.getTask(scopeOf(res), params.taskId) });
  });
}
