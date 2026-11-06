import { z } from "zod";
import { runHealthChecksRequestSchema, secretIdSchema, setSecretRequestSchema } from "@ncs/shared";
import { NotFoundError, type ApiRouters, type UnitOfWork } from "../../../../platform/index.js";
import { actorOf, valid, validate } from "../../../../http/kit.js";
import type { AuditService } from "../../../audit/index.js";
import type { SystemService } from "../../index.js";

const secretParams = z.object({ secretId: secretIdSchema });

export function mountSystemRoutes({ api, novel }: ApiRouters, svc: SystemService, audit: AuditService, uow: UnitOfWork): void {
  api.get("/system/info", (_req, res) => {
    res.json(svc.info());
  });
  api.get("/system/health-checks", async (_req, res) => {
    res.json({ checks: svc.listHealthChecks(), items: await svc.latestHealthResults() });
  });
  api.post("/system/health-checks/run", validate({ body: runHealthChecksRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof runHealthChecksRequestSchema> }>(res);
    res.json({ items: await svc.runHealthChecks(body) });
  });
  novel.get("/health-checks", async (_req, res) => {
    res.json({ items: await svc.latestHealthResults({ novelId: res.locals.scope.novelId }) });
  });

  // secrets: metadata only, values are write-only over HTTP (NFR-SEC-02)
  api.get("/system/secrets", async (_req, res) => {
    res.json({ items: await svc.secrets.list() });
  });
  api.put("/system/secrets/:secretId", validate({ params: secretParams, body: setSecretRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: z.output<typeof secretParams>; body: z.output<typeof setSecretRequestSchema> }>(res);
    const existed = await svc.secrets.has(params.secretId);
    await svc.secrets.set(params.secretId, body.value, body.label);
    await uow.run((tx) =>
      audit.record(tx, {
        novelId: null,
        actor: actorOf(res),
        action: "secret.set",
        target: { type: "settings", id: `secret.${params.secretId}` },
        details: { secretId: params.secretId, replaced: existed },
      }),
    );
    res.status(204).end();
  });
  api.delete("/system/secrets/:secretId", validate({ params: secretParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof secretParams> }>(res);
    if (!(await svc.secrets.delete(params.secretId))) throw new NotFoundError("비밀", params.secretId);
    await uow.run((tx) =>
      audit.record(tx, {
        novelId: null,
        actor: actorOf(res),
        action: "secret.deleted",
        target: { type: "settings", id: `secret.${params.secretId}` },
        details: { secretId: params.secretId },
      }),
    );
    res.status(204).end();
  });
}
