/**
 * 공개 사이트 use cases: per-novel public intro, the install-level target (Supabase public schema or static
 * files) and the published-only sync to it.
 *
 * No opt-in: every non-archived novel with at least one PUBLISHED episode (status published + published_version_id)
 * is on the public site, at the lowercased novel id, under the fixed author name PUBLIC_AUTHOR_NAME. Unpublishing the
 * last episode (or archiving / deleting the novel) takes it off at the next sync. Only allow-listed fields leave the
 * studio; drafts, settings, secrets and the studio DB stay on this PC.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { eq } from "@ncs/db/orm";
import { publicSiteConfig, publicSiteNovels, type PublicSiteNovelsRow } from "@ncs/db/schema";
import { applyPublicSchema, buildReaderRoleSql, isSafeSchemaName, PUBLIC_READER_ROLE_DEFAULT, PUBLIC_SCHEMA_DEFAULT, PUBLIC_SCHEMA_LATEST_VERSION, publicSchemaVersion } from "@ncs/public-schema";
import {
  PUBLIC_AUTHOR_NAME,
  PUBLIC_SITE_ORIGIN,
  publicNovelUrl,
  publicSlugOf,
  resolvePublicSiteDataDir,
  type PublicSiteCheckDto,
  type PublicSiteNovelDto,
  type PublicSiteRevalidateStatus,
  type PublicSiteRoleSqlDto,
  type PublicSiteStatusDto,
  type PublicSiteSyncRun,
  type PublicSiteTarget,
  type UpdatePublicSiteConfigRequest,
  type UpdatePublicSiteNovelRequest,
} from "@ncs/shared";
import { isPublicSlug } from "@ncs/reader-core/snapshot";
import { DomainValidationError, type ActorRef, type NovelScope } from "../../../platform/index.js";
import { buildReadingText } from "../../manuscript/domain/reader.js";
import type { PublicationModuleDeps } from "../module.js";
import type { PublicationService } from "../index.js";
import { buildSnapshot, type SnapshotNovelInput } from "../domain/snapshot.js";
import { toPublicRows } from "../domain/public-rows.js";
import { writeSite } from "../adapters/fs/site-writer.js";
import { hostOfUrl, postgresPublicDbConnector, sanitizePublicDbError, type PublicDbConnection } from "../adapters/pg/public-db.js";
import { syncPublicDb } from "../adapters/pg/public-db-sync.js";

export const RECONCILE_INTERVAL_MS = 60_000;
/** studio secret holding the Supabase writer connection string (encrypted, never returned) */
export const PUBLIC_SITE_DB_SECRET = "public_site.database_url";
/** studio secret holding the snowpage ADMIN_TOKEN (encrypted, never returned): purges the reader's cache after a sync */
export const PUBLIC_SITE_ADMIN_TOKEN_SECRET = "public_site.admin_token";
/** POST <origin>/api/admin/revalidate — snowpage Route Handler (apps/public-reader/src/server/api.ts) */
export const PUBLIC_SITE_REVALIDATE_PATH = "/api/admin/revalidate";
export const REVALIDATE_TIMEOUT_MS = 5_000;

/** audit actions after which the public content may have changed */
export function isRebuildHint(action: string): boolean {
  return (
    action === "episode.published" ||
    action === "episode.unpublished" ||
    action === "episode.status_changed" ||
    action === "episode.retitled" ||
    action.startsWith("novel.") ||
    action === "publication.settings_changed" ||
    action === "publication.config_changed"
  );
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

function resolveOutputDir(deps: PublicationModuleDeps): string {
  const raw = expandHome(resolvePublicSiteDataDir(deps.platform.config));
  return isAbsolute(raw) ? raw : resolve(raw);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface ConfigState {
  /** null = default (supabase when a writer URL is saved, else files) */
  explicitTarget: PublicSiteTarget | null;
  schema: string;
  configured: boolean;
  host: string | null;
  /** a snowpage ADMIN_TOKEN is saved */
  adminTokenConfigured: boolean;
}

const NO_REVALIDATE: PublicSiteRevalidateStatus = { configured: false, lastAt: null, lastOk: null, lastMessage: null };

/** a sync run that changed rows on the public site (the reader's cache is stale after it) */
const changedRows = (r: PublicSiteSyncRun | null) => !!r && r.upsertedNovels + r.upsertedEpisodes + r.deletedNovels + r.deletedEpisodes > 0;

/** user-facing, short, never the token / headers / body of the request */
function revalidateFailureMessage(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return `응답이 없습니다(${REVALIDATE_TIMEOUT_MS / 1000}초 초과).`;
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : null;
  return code ? `연결 실패(${code}).` : "연결 실패.";
}

const UNDECRYPTABLE_MSG = "저장된 연결 문자열을 복호화할 수 없습니다(마스터 키가 없거나 다릅니다). 다시 입력하세요.";

export function createPublicationService(deps: PublicationModuleDeps): PublicationService {
  const { platform, audit, novel, manuscript, secrets } = deps;
  const connect = deps.publicDbConnector ?? postgresPublicDbConnector;
  const db = platform.uow.db;
  const outputDir = resolveOutputDir(deps);
  const log = platform.log.child({ module: "publication" });
  let config: ConfigState | null = null;
  let lastBuiltAt: Date | null = null;
  let lastError: string | null = null;
  let lastFingerprint: string | null = null;
  let lastRun: PublicSiteSyncRun | null = null;
  let schemaVersion: number | null = null;
  let revalidateState: Omit<PublicSiteRevalidateStatus, "configured"> = { lastAt: null, lastOk: null, lastMessage: null };
  let counts = { novelCount: 0, episodeCount: 0 };
  let chain: Promise<unknown> = Promise.resolve();
  /** one writer pool, re-created when the URL changes; the schema is migrated once per pool + schema */
  let conn: { key: string; c: PublicDbConnection; migrated: Set<string> } | null = null;

  const targetOf = (c: ConfigState): PublicSiteTarget => c.explicitTarget ?? (c.configured ? "supabase" : "files");
  // resolved per call so a test can stub globalThis.fetch after the module was built
  const fetchImpl: typeof fetch = (input, init) => (deps.fetchImpl ?? globalThis.fetch)(input, init);

  async function loadConfig(): Promise<ConfigState> {
    const row = (await db.select().from(publicSiteConfig).where(eq(publicSiteConfig.id, "install")))[0];
    const configured = await secrets.has(PUBLIC_SITE_DB_SECRET);
    let host: string | null = null;
    if (configured) {
      try {
        host = hostOfUrl(await secrets.get(PUBLIC_SITE_DB_SECRET));
      } catch {
        // e.g. SecretUndecryptableError (master key lost / DB restored elsewhere): never block the studio
        lastError = UNDECRYPTABLE_MSG;
      }
    }
    config = {
      explicitTarget: row?.target === "supabase" || row?.target === "files" ? row.target : null,
      schema: row?.schemaName && isSafeSchemaName(row.schemaName) ? row.schemaName : PUBLIC_SCHEMA_DEFAULT,
      configured,
      host,
      adminTokenConfigured: await secrets.has(PUBLIC_SITE_ADMIN_TOKEN_SECRET),
    };
    return config;
  }
  const ensureConfig = async () => config ?? (await loadConfig());

  /** the writer URL; an undecryptable secret (lost master key / restored elsewhere) becomes a friendly validation error */
  async function readUrl(): Promise<string | null> {
    try {
      return await secrets.get(PUBLIC_SITE_DB_SECRET);
    } catch {
      throw new DomainValidationError("public_db_undecryptable", UNDECRYPTABLE_MSG);
    }
  }

  async function closeConn(): Promise<void> {
    const c = conn;
    conn = null;
    if (c) await c.c.close().catch(() => undefined);
  }

  function connection(url: string) {
    const key = sha(url);
    if (conn?.key !== key) {
      void closeConn();
      conn = { key, c: connect(url), migrated: new Set() };
    }
    return conn;
  }

  const rowOf = async (novelId: string) => (await db.select().from(publicSiteNovels).where(eq(publicSiteNovels.novelId, novelId)))[0] ?? null;

  const publishedEpisodes = async (scope: NovelScope) =>
    manuscript.withUnitInfo(
      scope,
      (await manuscript.listEpisodes(scope)).filter((e) => e.status === "published" && !!e.publishedVersionId).sort((a, b) => a.episodeNo - b.episodeNo),
    );

  const toDto = async (scope: NovelScope, row: PublicSiteNovelsRow | null): Promise<PublicSiteNovelDto> => {
    const n = await novel.getNovel(scope);
    const slug = publicSlugOf(scope.novelId);
    const publishedEpisodeCount = (await publishedEpisodes(scope)).length;
    const archived = n.status === "archived";
    return {
      novelId: scope.novelId,
      slug,
      publicUrl: publicNovelUrl(slug),
      exposed: !archived && publishedEpisodeCount > 0 && isPublicSlug(slug),
      archived,
      intro: row?.intro ?? "",
      authorName: PUBLIC_AUTHOR_NAME,
      publishedEpisodeCount,
      lastSyncedAt: lastBuiltAt?.toISOString() ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  };

  /**
   * every non-archived novel with at least one published episode, with what the public content depends on (no
   * manuscript bodies). Ordered by id so the fingerprint does not depend on novel edit times.
   */
  async function collect() {
    const intros = new Map((await db.select({ novelId: publicSiteNovels.novelId, intro: publicSiteNovels.intro }).from(publicSiteNovels)).map((r) => [r.novelId, r.intro]));
    const all = (await novel.listNovels()).filter((n) => n.status !== "archived").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out: Array<{ slug: string; intro: string; scope: NovelScope; n: (typeof all)[number]; basis: string; eps: Awaited<ReturnType<typeof publishedEpisodes>> }> = [];
    for (const n of all) {
      const slug = publicSlugOf(n.id);
      if (!isPublicSlug(slug)) {
        log.warn({ novelId: n.id }, "novel id is not a valid public slug; skipped");
        continue;
      }
      const scope = { novelId: n.id };
      const eps = await publishedEpisodes(scope);
      if (!eps.length) continue;
      const profile = await novel.getLengthProfile(scope);
      out.push({ slug, intro: intros.get(n.id) ?? "", scope, n, basis: profile.countBasis, eps });
    }
    return out;
  }

  function fingerprint(items: Awaited<ReturnType<typeof collect>>, dest: string): string {
    const h = createHash("sha256");
    h.update(dest);
    h.update(PUBLIC_AUTHOR_NAME);
    for (const { slug, intro, n, basis, eps } of items) {
      h.update(JSON.stringify([slug, intro, n.title, n.genre, n.ageRating, basis, eps.map((e) => [e.episodeNo, e.title, e.publishedVersionId, e.publishedAt?.toISOString() ?? null, e.unitTitle, e.unitPartNo, e.unitPartCount])]));
    }
    return h.digest("hex");
  }

  /** published versions only, as reading text */
  async function inputs(items: Awaited<ReturnType<typeof collect>>): Promise<SnapshotNovelInput[]> {
    const novels: SnapshotNovelInput[] = [];
    for (const { slug, intro, scope, n, basis, eps } of items) {
      const episodes: SnapshotNovelInput["episodes"] = [];
      for (const e of eps) {
        const version = await manuscript.getVersion(scope, e.publishedVersionId!);
        const scenes = (await manuscript.listScenes(scope, e.id, { versionId: version.id, includeRetired: true })).filter((s) => s.manuscriptVersionId === version.id);
        episodes.push({
          episodeNo: e.episodeNo,
          title: e.title,
          text: buildReadingText(version.content, scenes.map((s) => s.charStart)),
          charCount: basis === "without_spaces" ? version.charCountWithoutSpaces : version.charCountWithSpaces,
          publishedAt: e.publishedAt,
          unitTitle: e.unitTitle,
          unitPartNo: e.unitPartNo,
          unitPartCount: e.unitPartCount,
        });
      }
      novels.push({ slug, title: n.title, genre: n.genre, ageRating: n.ageRating, authorName: PUBLIC_AUTHOR_NAME, intro, episodes });
    }
    return novels;
  }

  /**
   * Best effort: tell snowpage its content cache is stale (POST /api/admin/revalidate, bearer ADMIN_TOKEN, 5 s). A
   * failure never fails the sync — the reader falls back to its 30 s time-based revalidate; only the sanitized outcome
   * (status code + short text) is kept and logged. The token goes in a header only, never in the URL or the logs.
   */
  async function revalidatePublicSite(): Promise<void> {
    const at = platform.clock.date();
    let token: string | null;
    try {
      token = await secrets.get(PUBLIC_SITE_ADMIN_TOKEN_SECRET);
    } catch {
      revalidateState = { lastAt: at.toISOString(), lastOk: false, lastMessage: "저장된 운영 토큰을 복호화할 수 없습니다. 다시 입력하세요." };
      log.warn({ error: revalidateState.lastMessage }, "public site cache revalidate skipped");
      return;
    }
    if (!token) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REVALIDATE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetchImpl(`${PUBLIC_SITE_ORIGIN}${PUBLIC_SITE_REVALIDATE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ scope: "all" }),
        signal: ac.signal,
        redirect: "manual",
      });
      const text = await res.text().catch(() => "");
      let detail = "";
      try {
        const j = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof j?.error?.message === "string") detail = j.error.message;
      } catch {
        /* non-JSON body (e.g. an HTML error page): status only */
      }
      const ok = res.ok;
      const message = ok ? "독자 페이지 캐시를 비웠습니다." : `HTTP ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ""}`;
      revalidateState = { lastAt: at.toISOString(), lastOk: ok, lastMessage: message };
      if (!ok) log.warn({ status: res.status }, "public site cache revalidate rejected");
    } catch (err) {
      revalidateState = { lastAt: at.toISOString(), lastOk: false, lastMessage: revalidateFailureMessage(err) };
      log.warn({ error: revalidateState.lastMessage }, "public site cache revalidate failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function doRebuild(force: boolean): Promise<PublicSiteStatusDto> {
    const cfg = await ensureConfig();
    const target = targetOf(cfg);
    let url: string | null = null;
    try {
      if (target === "supabase") {
        url = await readUrl();
        if (!url) throw new DomainValidationError("public_db_missing", "공개 사이트 DB 연결 문자열이 설정되지 않았습니다. 설치 설정 → 공개 사이트에서 입력하세요.");
      }
      const items = await collect();
      const fp = fingerprint(items, target === "supabase" ? `supabase:${cfg.schema}:${sha(url!)}` : `files:${outputDir}`);
      if (!force && fp === lastFingerprint && !lastError) return status();
      const novels = await inputs(items);
      const now = platform.clock.date();
      if (target === "files") {
        const snap = buildSnapshot(novels, now);
        await writeSite(outputDir, snap.files);
        counts = { novelCount: snap.novelCount, episodeCount: snap.episodeCount };
        lastRun = null;
      } else {
        const c = connection(url!);
        if (!c.migrated.has(cfg.schema)) {
          const applied = await applyPublicSchema(c.c.client, cfg.schema);
          schemaVersion = applied.version;
          if (applied.applied.length) log.info({ schemaVersion: applied.version, applied: applied.applied }, "public schema migrated");
          c.migrated.add(cfg.schema);
        }
        const r = await syncPublicDb(c.c.client, cfg.schema, novels.map(toPublicRows), now);
        counts = { novelCount: r.novelCount, episodeCount: r.episodeCount };
        lastRun = { upsertedNovels: r.upsertedNovels, upsertedEpisodes: r.upsertedEpisodes, deletedNovels: r.deletedNovels, deletedEpisodes: r.deletedEpisodes, unchangedNovels: r.unchangedNovels };
      }
      lastFingerprint = fp;
      lastBuiltAt = now;
      lastError = null;
      // the reader caches its reads: purge right away when rows changed (or the user forced a sync)
      if (target === "supabase" && cfg.adminTokenConfigured && (force || changedRows(lastRun))) await revalidatePublicSite();
    } catch (err) {
      lastError = err instanceof DomainValidationError ? err.message : target === "supabase" ? sanitizePublicDbError(err, url) : err instanceof Error ? err.message : String(err);
      // the raw error may carry the connection string (driver messages): log the sanitized text only
      log.warn({ target, error: lastError }, "public site sync failed");
      if (target === "supabase") await closeConn();
    }
    return status();
  }

  function status(): PublicSiteStatusDto {
    const cfg: ConfigState = config ?? { explicitTarget: null, schema: PUBLIC_SCHEMA_DEFAULT, configured: false, host: null, adminTokenConfigured: false };
    return {
      target: targetOf(cfg),
      targetSource: cfg.explicitTarget ? "explicit" : "default",
      outputDir,
      lastBuiltAt: lastBuiltAt?.toISOString() ?? null,
      lastError,
      ...counts,
      lastRun,
      supabase: { configured: cfg.configured, schema: cfg.schema, host: cfg.host, schemaVersion, latestSchemaVersion: PUBLIC_SCHEMA_LATEST_VERSION },
      revalidate: cfg.adminTokenConfigured ? { configured: true, ...revalidateState } : NO_REVALIDATE,
    };
  }

  /** one sync at a time */
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  }
  const rebuild = (opts: { force?: boolean } = {}) => serialize(() => doRebuild(!!opts.force));

  return {
    outputDir,
    status,
    rebuild,
    async init() {
      await loadConfig();
    },
    async close() {
      await serialize(closeConn);
    },
    async updateConfig(patch: UpdatePublicSiteConfigRequest, actor: ActorRef) {
      if (patch.schema !== undefined && !isSafeSchemaName(patch.schema))
        throw new DomainValidationError("invalid_schema", "이 스키마 이름은 쓸 수 없습니다(public·auth·storage 등 Supabase/PostgreSQL 예약 스키마, pg_·supabase 로 시작하는 이름 제외).");
      const before = await ensureConfig();
      const values = {
        target: patch.target === undefined ? before.explicitTarget : patch.target,
        schemaName: patch.schema ?? before.schema,
        updatedAt: platform.clock.date(),
      };
      await serialize(async () => {
        if (patch.databaseUrl !== undefined) {
          if (patch.databaseUrl === null) await secrets.delete(PUBLIC_SITE_DB_SECRET);
          else await secrets.set(PUBLIC_SITE_DB_SECRET, patch.databaseUrl, "공개 사이트 DB(Supabase) 쓰기 연결");
          await closeConn();
        }
        if (patch.adminToken !== undefined) {
          if (patch.adminToken === null) await secrets.delete(PUBLIC_SITE_ADMIN_TOKEN_SECRET);
          else await secrets.set(PUBLIC_SITE_ADMIN_TOKEN_SECRET, patch.adminToken, "공개 사이트(snowpage) 운영 토큰");
          revalidateState = { lastAt: null, lastOk: null, lastMessage: null };
        }
        await platform.uow.run(async (tx) => {
          await tx.db
            .insert(publicSiteConfig)
            .values({ id: "install", ...values })
            .onConflictDoUpdate({ target: publicSiteConfig.id, set: values });
          await audit.record(tx, {
            novelId: null,
            actor,
            action: "publication.config_changed",
            target: { type: "settings", id: "public_site" },
            before: { target: before.explicitTarget, schema: before.schema, databaseUrlConfigured: before.configured, adminTokenConfigured: before.adminTokenConfigured },
            // never the connection string or the token: only whether they changed
            after: { target: values.target, schema: values.schemaName, databaseUrlChanged: patch.databaseUrl !== undefined, adminTokenChanged: patch.adminToken !== undefined },
          });
        });
        if (values.schemaName !== before.schema) schemaVersion = null;
        await loadConfig();
        lastFingerprint = null;
      });
      return rebuild({ force: true });
    },
    async check(): Promise<PublicSiteCheckDto> {
      const cfg = await loadConfig();
      const latestSchemaVersion = PUBLIC_SCHEMA_LATEST_VERSION;
      let url: string | null;
      try {
        url = await readUrl();
      } catch {
        return { ok: false, message: UNDECRYPTABLE_MSG, schemaVersion: null, latestSchemaVersion };
      }
      if (!url) return { ok: false, message: "공개 사이트 DB 연결 문자열이 설정되지 않았습니다.", schemaVersion: null, latestSchemaVersion };
      // a separate short-lived connection: never disturbs a running sync
      const c = connect(url);
      try {
        await c.client.query("SELECT 1 AS ok");
        const v = await publicSchemaVersion(c.client, cfg.schema);
        schemaVersion = v;
        const message =
          v === null
            ? `연결되었습니다. ${cfg.schema} 스키마는 아직 없습니다([지금 동기화]가 만듭니다).`
            : v < latestSchemaVersion
              ? `연결되었습니다. 스키마 버전 ${v} → 다음 동기화 때 ${latestSchemaVersion}(으)로 올립니다.`
              : `연결되었습니다. 스키마 버전 ${v}(최신).`;
        return { ok: true, message, schemaVersion: v, latestSchemaVersion };
      } catch (err) {
        return { ok: false, message: sanitizePublicDbError(err, url), schemaVersion: null, latestSchemaVersion };
      } finally {
        await c.close().catch(() => undefined);
      }
    },
    async roleSql(): Promise<PublicSiteRoleSqlDto> {
      const cfg = await ensureConfig();
      return { role: PUBLIC_READER_ROLE_DEFAULT, schema: cfg.schema, sql: buildReaderRoleSql({ schema: cfg.schema }) };
    },
    async getNovelSettings(scope) {
      await novel.getNovel(scope);
      return toDto(scope, await rowOf(scope.novelId));
    },
    async updateNovelSettings(scope, patch, actor) {
      await novel.getNovel(scope);
      const before = await rowOf(scope.novelId);
      // only the intro is per-novel: exposure (≥1 published episode), address (lowercased id) and author are fixed
      const values = { intro: patch.intro ?? before?.intro ?? "", updatedAt: platform.clock.date() };
      await platform.uow.run(async (tx) => {
        await tx.db
          .insert(publicSiteNovels)
          .values({ novelId: scope.novelId, ...values })
          .onConflictDoUpdate({ target: publicSiteNovels.novelId, set: values });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "publication.settings_changed",
          target: { type: "novel", id: scope.novelId },
          before: before ? { introLength: before.intro.length } : null,
          after: { introLength: values.intro.length },
        });
      });
      await rebuild();
      return toDto(scope, await rowOf(scope.novelId));
    },
  };
}
