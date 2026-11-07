/**
 * publication — public API (설계 추가 0021/0022: 공개 사이트).
 * Owns: public_site_novels, public_site_config. Publishes the published-only content to the public reader
 * (apps/public-reader, "snowpage" on Vercel), which never talks to this server, its DB or its secrets:
 *
 *   target "supabase" (default once a writer URL is saved): upserts rows into the public schema (default `ncs_public`)
 *     of the user's Supabase database — the studio applies that schema's own migrations (@ncs/public-schema).
 *   target "files": writes the static JSON snapshot (offline / dev fallback).
 *
 * Source of truth for "public": novel opted in (public_site_novels.enabled, default off) AND episode status
 * `published` with a `published_version_id`. Drafts, awaiting_approval and approved-but-unpublished never leave.
 * Syncs: after a settings change (awaited), on audit hints (episode published / unpublished, novel edits;
 * debounced) and a periodic reconcile that syncs only when the cheap fingerprint changed.
 * The writer connection string is the secret `public_site.database_url` (encrypted); it is never returned or logged.
 */
import type {
  PublicSiteCheckDto,
  PublicSiteNovelDto,
  PublicSiteRoleSqlDto,
  PublicSiteStatusDto,
  UpdatePublicSiteConfigRequest,
  UpdatePublicSiteNovelRequest,
} from "@ncs/shared";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export interface PublicationService {
  getNovelSettings(scope: NovelScope): Promise<PublicSiteNovelDto>;
  /** records publication.settings_changed, then syncs */
  updateNovelSettings(scope: NovelScope, patch: UpdatePublicSiteNovelRequest, actor: ActorRef): Promise<PublicSiteNovelDto>;
  status(): PublicSiteStatusDto;
  /** sync now (force: even when the fingerprint is unchanged) */
  rebuild(opts?: { force?: boolean }): Promise<PublicSiteStatusDto>;
  /** install-level target / writer URL (write-only) / schema; records publication.config_changed, then syncs */
  updateConfig(patch: UpdatePublicSiteConfigRequest, actor: ActorRef): Promise<PublicSiteStatusDto>;
  /** [연결 확인]: SELECT 1 + schema version (reads only, never migrates) */
  check(): Promise<PublicSiteCheckDto>;
  /** SQL for the restricted reader role — for the user to run by hand (never run by the studio) */
  roleSql(): Promise<PublicSiteRoleSqlDto>;
  /** load the install config (module start) */
  init(): Promise<void>;
  /** close the writer pool (module stop) */
  close(): Promise<void>;
  /** absolute output dir (files target) */
  readonly outputDir: string;
}

export type { PublicationModuleDeps } from "./module.js";
export type { PublicDbConnector, PublicDbConnection } from "./adapters/pg/public-db.js";
export { createPublicationModule } from "./module.js";
export { PUBLIC_SITE_DB_SECRET } from "./application/publication-service.js";
