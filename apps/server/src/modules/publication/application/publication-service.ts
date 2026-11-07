/** 공개 사이트 use cases: per-novel opt-in settings and the published-only static snapshot. */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { and, eq, ne } from "@ncs/db/orm";
import { publicSiteNovels, type PublicSiteNovelsRow } from "@ncs/db/schema";
import { resolvePublicSiteDataDir, type PublicSiteNovelDto, type PublicSiteStatusDto, type UpdatePublicSiteNovelRequest } from "@ncs/shared";
import { isPublicSlug } from "@ncs/reader-core/snapshot";
import { ConflictError, DomainValidationError, type ActorRef, type NovelScope } from "../../../platform/index.js";
import { buildReadingText } from "../../manuscript/domain/reader.js";
import type { PublicationModuleDeps } from "../module.js";
import type { PublicationService } from "../index.js";
import { buildSnapshot, type SnapshotNovelInput } from "../domain/snapshot.js";
import { writeSite } from "../adapters/fs/site-writer.js";

export const RECONCILE_INTERVAL_MS = 60_000;

/** audit actions after which the snapshot may have changed */
export function isRebuildHint(action: string): boolean {
  return (
    action === "episode.published" ||
    action === "episode.unpublished" ||
    action === "episode.status_changed" ||
    action.startsWith("novel.") ||
    action === "publication.settings_changed"
  );
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

function resolveOutputDir(deps: PublicationModuleDeps): string {
  const raw = expandHome(resolvePublicSiteDataDir(deps.platform.config));
  return isAbsolute(raw) ? raw : resolve(raw);
}

const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export function createPublicationService(deps: PublicationModuleDeps): PublicationService {
  const { platform, audit, novel, manuscript } = deps;
  const db = platform.uow.db;
  const outputDir = resolveOutputDir(deps);
  let lastBuiltAt: Date | null = null;
  let lastError: string | null = null;
  let lastFingerprint: string | null = null;
  let counts = { novelCount: 0, episodeCount: 0 };
  let chain: Promise<unknown> = Promise.resolve();

  const rowOf = async (novelId: string) => (await db.select().from(publicSiteNovels).where(eq(publicSiteNovels.novelId, novelId)))[0] ?? null;

  const publishedEpisodes = async (scope: NovelScope) =>
    (await manuscript.listEpisodes(scope)).filter((e) => e.status === "published" && !!e.publishedVersionId).sort((a, b) => a.episodeNo - b.episodeNo);

  const toDto = async (scope: NovelScope, row: PublicSiteNovelsRow | null): Promise<PublicSiteNovelDto> => ({
    novelId: scope.novelId,
    enabled: row?.enabled ?? false,
    slug: row?.slug ?? null,
    intro: row?.intro ?? "",
    authorName: row?.authorName ?? "",
    publishedEpisodeCount: (await publishedEpisodes(scope)).length,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  });

  /** opted-in, non-archived novels with what the snapshot depends on (no manuscript bodies) */
  async function collect() {
    const rows = await db.select().from(publicSiteNovels).where(eq(publicSiteNovels.enabled, true));
    const out: Array<{ row: PublicSiteNovelsRow & { slug: string }; scope: NovelScope; n: Awaited<ReturnType<typeof novel.getNovel>>; basis: string; eps: Awaited<ReturnType<typeof publishedEpisodes>> }> = [];
    for (const row of rows) {
      if (!row.slug || !isPublicSlug(row.slug)) continue;
      const scope = { novelId: row.novelId };
      const n = await novel.getNovel(scope);
      if (n.status === "archived") continue;
      const [profile, eps] = await Promise.all([novel.getLengthProfile(scope), publishedEpisodes(scope)]);
      out.push({ row: row as PublicSiteNovelsRow & { slug: string }, scope, n, basis: profile.countBasis, eps });
    }
    return out;
  }

  function fingerprint(items: Awaited<ReturnType<typeof collect>>): string {
    const h = createHash("sha256");
    h.update(outputDir);
    for (const { row, n, basis, eps } of items) {
      h.update(JSON.stringify([row.slug, row.intro, row.authorName, n.title, n.genre, n.ageRating, basis, eps.map((e) => [e.episodeNo, e.title, e.publishedVersionId, e.publishedAt?.toISOString() ?? null])]));
    }
    return h.digest("hex");
  }

  async function doRebuild(force: boolean): Promise<PublicSiteStatusDto> {
    try {
      const items = await collect();
      const fp = fingerprint(items);
      if (!force && fp === lastFingerprint && !lastError) return status();
      const novels: SnapshotNovelInput[] = [];
      for (const { row, scope, n, basis, eps } of items) {
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
          });
        }
        novels.push({ slug: row.slug, title: n.title, genre: n.genre, ageRating: n.ageRating, authorName: row.authorName, intro: row.intro, episodes });
      }
      const snap = buildSnapshot(novels, platform.clock.date());
      await writeSite(outputDir, snap.files);
      lastFingerprint = fp;
      lastBuiltAt = platform.clock.date();
      lastError = null;
      counts = { novelCount: snap.novelCount, episodeCount: snap.episodeCount };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      platform.log.warn({ err, module: "publication" }, "public site snapshot failed");
    }
    return status();
  }

  function status(): PublicSiteStatusDto {
    return { outputDir, lastBuiltAt: lastBuiltAt?.toISOString() ?? null, lastError, ...counts };
  }

  /** one build at a time */
  function rebuild(opts: { force?: boolean } = {}): Promise<PublicSiteStatusDto> {
    const next = chain.then(() => doRebuild(!!opts.force));
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    outputDir,
    status,
    rebuild,
    async getNovelSettings(scope) {
      await novel.getNovel(scope);
      return toDto(scope, await rowOf(scope.novelId));
    },
    async updateNovelSettings(scope, patch, actor) {
      await novel.getNovel(scope);
      const before = await rowOf(scope.novelId);
      const slug = patch.slug === undefined ? (before?.slug ?? null) : patch.slug;
      const enabled = patch.enabled ?? before?.enabled ?? false;
      if (slug !== null && !isPublicSlug(slug)) throw new DomainValidationError("invalid_slug", "공개 주소 형식이 올바르지 않습니다.");
      if (enabled && !slug) throw new DomainValidationError("slug_required", "공개 사이트에 노출하려면 공개 주소를 정해 주세요.");
      if (slug) {
        const taken = await db.select({ id: publicSiteNovels.novelId }).from(publicSiteNovels).where(and(eq(publicSiteNovels.slug, slug), ne(publicSiteNovels.novelId, scope.novelId)));
        if (taken.length) throw new ConflictError("slug_taken", "이미 다른 작품이 쓰는 공개 주소입니다.");
      }
      const values = {
        enabled,
        slug,
        intro: patch.intro ?? before?.intro ?? "",
        authorName: patch.authorName ?? before?.authorName ?? "",
        updatedAt: platform.clock.date(),
      };
      try {
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
            before: before ? { enabled: before.enabled, slug: before.slug, introLength: before.intro.length, authorName: before.authorName } : null,
            after: { enabled: values.enabled, slug: values.slug, introLength: values.intro.length, authorName: values.authorName },
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError("slug_taken", "이미 다른 작품이 쓰는 공개 주소입니다.");
        throw err;
      }
      await rebuild();
      return toDto(scope, await rowOf(scope.novelId));
    },
  };
}
