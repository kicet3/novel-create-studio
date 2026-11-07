/**
 * Upserts the published content into the public schema (Supabase): one transaction per changed novel, episodes in
 * batches, unchanged rows skipped by content hash, rows that are no longer public deleted (episode unpublished, novel
 * opted out / archived / slug changed). Reaction tables are never touched here (comments of a removed episode stay;
 * the reader API serves nothing for a target that is not published).
 *
 * Every value goes as a bind parameter (row sets as one JSON text parameter → jsonb_to_recordset); the schema is a
 * validated, quoted identifier.
 */
import { assertSchemaName, quoteIdent, type SqlClient } from "@ncs/public-schema";
import type { PublicSiteSyncRun } from "@ncs/shared";
import type { PublicNovelRows } from "../../domain/public-rows.js";

const EPISODE_BATCH = 25;

export interface PublicDbSyncResult extends PublicSiteSyncRun {
  novelCount: number;
  episodeCount: number;
}

export async function syncPublicDb(client: SqlClient, schema: string, novels: readonly PublicNovelRows[], now: Date): Promise<PublicDbSyncResult> {
  const s = quoteIdent(assertSchemaName(schema));
  const at = now.toISOString();
  const run: PublicSiteSyncRun = { upsertedNovels: 0, upsertedEpisodes: 0, deletedNovels: 0, deletedEpisodes: 0, unchangedNovels: 0 };

  const remoteNovels = new Map((await client.query<{ slug: string; content_hash: string }>(`SELECT slug, content_hash FROM ${s}.novels`)).map((r) => [r.slug, r.content_hash]));
  const remoteEps = new Map<string, Map<number, string>>();
  for (const r of await client.query<{ novel_slug: string; episode_no: number | string; content_hash: string }>(`SELECT novel_slug, episode_no, content_hash FROM ${s}.episodes`)) {
    let m = remoteEps.get(r.novel_slug);
    if (!m) remoteEps.set(r.novel_slug, (m = new Map()));
    m.set(Number(r.episode_no), r.content_hash);
  }

  const local = new Set<string>();
  for (const { novel, episodes } of novels) {
    local.add(novel.slug);
    const have = remoteEps.get(novel.slug) ?? new Map<number, string>();
    const keep = new Set(episodes.map((e) => e.episode_no));
    const changed = episodes.filter((e) => have.get(e.episode_no) !== e.content_hash);
    const gone = [...have.keys()].filter((no) => !keep.has(no));
    const novelChanged = remoteNovels.get(novel.slug) !== novel.content_hash;
    if (!novelChanged && !changed.length && !gone.length) {
      run.unchangedNovels++;
      continue;
    }
    await client.transaction(async (tx) => {
      if (novelChanged) {
        await tx.query(
          `INSERT INTO ${s}.novels (slug, title, author_name, intro, genre, age_rating, episode_count, latest_published_at, content_hash, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::int, $8::timestamptz, $9, $10::timestamptz)
           ON CONFLICT (slug) DO UPDATE SET title = excluded.title, author_name = excluded.author_name, intro = excluded.intro, genre = excluded.genre,
             age_rating = excluded.age_rating, episode_count = excluded.episode_count, latest_published_at = excluded.latest_published_at,
             content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
          [novel.slug, novel.title, novel.author_name, novel.intro, novel.genre, novel.age_rating, novel.episode_count, novel.latest_published_at, novel.content_hash, at],
        );
      }
      if (gone.length) {
        await tx.query(`DELETE FROM ${s}.episodes WHERE novel_slug = $1 AND episode_no IN (SELECT (jsonb_array_elements_text($2::text::jsonb))::int)`, [novel.slug, JSON.stringify(gone)]);
      }
      for (let i = 0; i < changed.length; i += EPISODE_BATCH) {
        const batch = changed.slice(i, i + EPISODE_BATCH);
        await tx.query(
          `INSERT INTO ${s}.episodes (novel_slug, episode_no, title, body, char_count, published_at, content_hash, updated_at)
           SELECT x.novel_slug, x.episode_no, x.title, x.body, x.char_count, x.published_at, x.content_hash, $2::timestamptz
           FROM jsonb_to_recordset($1::text::jsonb) AS x(novel_slug text, episode_no integer, title text, body text, char_count integer, published_at timestamptz, content_hash text)
           ON CONFLICT (novel_slug, episode_no) DO UPDATE SET title = excluded.title, body = excluded.body, char_count = excluded.char_count,
             published_at = excluded.published_at, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
          [JSON.stringify(batch), at],
        );
      }
    });
    if (novelChanged) run.upsertedNovels++;
    run.upsertedEpisodes += changed.length;
    run.deletedEpisodes += gone.length;
  }

  const removed = [...remoteNovels.keys()].filter((slug) => !local.has(slug));
  if (removed.length) {
    await client.transaction(async (tx) => {
      // episodes go with their novel (FK ON DELETE CASCADE)
      await tx.query(`DELETE FROM ${s}.novels WHERE slug IN (SELECT jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(removed)]);
    });
    run.deletedNovels += removed.length;
    for (const slug of removed) run.deletedEpisodes += remoteEps.get(slug)?.size ?? 0;
  }

  return { ...run, novelCount: novels.length, episodeCount: novels.reduce((n, x) => n + x.episodes.length, 0) };
}
