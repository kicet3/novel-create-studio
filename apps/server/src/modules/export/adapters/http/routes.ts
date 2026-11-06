/** HTTP adapter of `export` (CONVENTIONS §13 내보내기). */
import type { z } from "zod";
import { createExportRequestSchema, exportIdParamsSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, sendStoredFile, valid, validate } from "../../../../http/kit.js";
import type { ExportService } from "../../index.js";

type Id = { params: z.output<typeof exportIdParamsSchema> };

export function mountExportRoutes({ novel }: ApiRouters, svc: ExportService): void {
  novel.post("/exports", validate({ body: createExportRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof createExportRequestSchema> }>(res);
    created(res, await svc.createExport(scopeOf(res), body, actorOf(res)));
  });
  novel.get("/exports", async (_req, res) => {
    res.json({ items: await svc.listExports(scopeOf(res)) });
  });
  novel.get("/exports/:exportId", validate({ params: exportIdParamsSchema }), async (_req, res) => {
    const { params } = valid<Id>(res);
    res.json(await svc.getExport(scopeOf(res), params.exportId));
  });
  novel.get("/exports/:exportId/download", validate({ params: exportIdParamsSchema }), async (_req, res) => {
    const { params } = valid<Id>(res);
    const file = await svc.openDownload(scopeOf(res), params.exportId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader("Cache-Control", "no-store");
    await sendStoredFile(res, file.path, file.contentType, "내보내기 파일");
  });
}
