/** revision module factory: task kind revision_chat_turn, canon_change / retcon approval handlers, author-note context section, routes. */
import type { ServerModule } from "../../platform/index.js";
import type { RevisionService } from "./index.js";
import { createRevisionApp, type RevisionDeps } from "./application/revision-app.js";
import { mountRevisionRoutes } from "./adapters/http/routes.js";

export type RevisionModuleDeps = RevisionDeps;

export function createRevisionModule(deps: RevisionModuleDeps): ServerModule<RevisionService> {
  const app = createRevisionApp(deps);
  deps.orchestration.registerTaskKind(app.taskHandler());
  deps.hitl.registerApprovalHandler("canon_change", app.onSettingApproval);
  deps.hitl.registerApprovalHandler("retcon", app.onSettingApproval);
  // 설계 추가(수정 반영): facts of earlier versions follow an edited episode text (extract_facts commit)
  deps.linking?.registerFactReconciler({ reconcileEpisode: app.reconcile.reconcileEpisode });
  deps.agents.registerContextSection(app.notesSection);
  // 설계 추가(화 삭제): the chat of a deleted manuscript is removed with it
  deps.manuscript.registerEpisodeDeleteParticipant?.(app.deleteParticipant);
  const service: RevisionService = app.service;
  return {
    name: "revision",
    implemented: true,
    service,
    routes: (r) => mountRevisionRoutes(r, service, app.streams),
  };
}
