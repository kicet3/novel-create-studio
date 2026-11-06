/** HTTP adapter of `agents` (debug/read-only views). */
import { contextSnapshotParamsSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import type { AgentsService } from "../../index.js";

export function mountAgentsRoutes({ api, novel }: ApiRouters, svc: AgentsService): void {
  api.get("/agents/roles", async (_req, res) => {
    const templates = svc.listPromptTemplates();
    res.json({
      items: svc.roles.map((r) => ({ ...r, allowedWrites: [...r.allowedWrites], templates: templates.filter((t) => t.role === r.role).map((t) => t.id) })),
    });
  });
  api.get("/agents/prompt-templates", async (_req, res) => {
    res.json({
      items: svc.listPromptTemplates().map((t) => ({ id: t.id, role: t.role, kind: t.kind, version: t.version, instruction: (t as { instruction?: string }).instruction ?? null })),
    });
  });
  novel.get("/context-snapshots/:snapshotId", validate({ params: contextSnapshotParamsSchema }), async (_req, res) => {
    const { params } = valid<{ params: { snapshotId: string } }>(res);
    const scope = scopeOf(res);
    const snap = await svc.getContextSnapshot(scope, params.snapshotId);
    const pack = await svc.getContextPack(scope, params.snapshotId);
    res.json({
      ...snap,
      pack: pack
        ? {
            system: pack.system,
            messages: pack.messages.map((m) => ({ role: m.role, content: m.content })),
            handles: pack.handles,
            droppedSections: pack.droppedSections,
            sections: pack.sections ?? [],
          }
        : null,
    });
  });
}
