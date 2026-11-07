/**
 * publication — public API (설계 추가 0021: 공개 사이트).
 * Owns: public_site_novels. Writes a static, published-only JSON snapshot for the separate read-only app
 * apps/public-reader (which never talks to this server, its DB or its secrets).
 *
 * Source of truth for "public": novel opted in (public_site_novels.enabled, default off) AND episode status
 * `published` with a `published_version_id`. Drafts, awaiting_approval and approved-but-unpublished never leave.
 * Rebuilds: after a settings change (awaited), on audit hints (episode published / unpublished, novel edits;
 * debounced) and a periodic reconcile that rebuilds only when the cheap fingerprint changed.
 */
import type { PublicSiteNovelDto, PublicSiteStatusDto, UpdatePublicSiteNovelRequest } from "@ncs/shared";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export interface PublicationService {
  getNovelSettings(scope: NovelScope): Promise<PublicSiteNovelDto>;
  /** records publication.settings_changed, then rebuilds the snapshot */
  updateNovelSettings(scope: NovelScope, patch: UpdatePublicSiteNovelRequest, actor: ActorRef): Promise<PublicSiteNovelDto>;
  status(): PublicSiteStatusDto;
  /** rebuild now (force: even when the fingerprint is unchanged) */
  rebuild(opts?: { force?: boolean }): Promise<PublicSiteStatusDto>;
  /** absolute output dir */
  readonly outputDir: string;
}

export type { PublicationModuleDeps } from "./module.js";
export { createPublicationModule } from "./module.js";
