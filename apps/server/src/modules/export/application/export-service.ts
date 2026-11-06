/**
 * Export (07 §3.8 FR-MAN-04a): synchronous TXT/Markdown export of an episode / arc / the novel.
 * Version: default = published ?? approved; current = current_version_id. Episodes without a target
 * version are excluded and listed in `excluded`. File: StorageProvider `novels/<novelId>/exports/<id>.<ext>`.
 */
import { DomainValidationError, NotFoundError, type ActorRef, type NovelScope } from "../../../platform/index.js";
import type { Episode } from "../../manuscript/index.js";
import { exportRepo as repo } from "../adapters/db/export-repository.js";
import { exportFileName, renderMarkdown, renderTxt, type ExportChapter } from "../domain/render.js";
import type { CreateExportInput, ExportJob, ExportService } from "../index.js";
import type { ExportModuleDeps } from "../module.js";

export interface ExportItem {
  episode_id: string;
  episode_no: number;
  manuscript_version_id: string;
  char_count_with_spaces: number;
  char_count_without_spaces: number;
}

export function createExportService(deps: ExportModuleDeps): ExportService {
  const { platform, audit, novel, manuscript } = deps;
  const { uow, ids, clock, storage } = platform;
  const ext = (f: CreateExportInput["format"]) => (f === "markdown" ? "md" : "txt");

  const mustJob = async (scope: NovelScope, id: string) => {
    const j = await repo.get(uow.db, scope, id);
    if (!j) throw new NotFoundError("내보내기", id);
    return j;
  };

  const resolveEpisodes = async (scope: NovelScope, input: CreateExportInput): Promise<{ episodes: Episode[]; label: { kind: "episode" | "arc" | "novel"; episodeNo?: number; arcOrd?: number } }> => {
    if (input.scopeKind === "novel") {
      if (input.targetId) throw new DomainValidationError("target_not_allowed", "작품 전체 내보내기에는 대상을 지정하지 않습니다.");
      return { episodes: await manuscript.listEpisodes(scope), label: { kind: "novel" } };
    }
    if (!input.targetId) throw new DomainValidationError("target_required", "내보낼 화나 아크를 지정하세요.");
    if (input.scopeKind === "episode") {
      const ep = await manuscript.getEpisode(scope, input.targetId);
      return { episodes: [ep], label: { kind: "episode", episodeNo: ep.episodeNo } };
    }
    const arc = await novel.getArc(scope, input.targetId);
    return { episodes: await manuscript.listEpisodes(scope, { arcId: arc.id }), label: { kind: "arc", arcOrd: arc.ord } };
  };

  return {
    async createExport(scope, input, actor: ActorRef): Promise<ExportJob> {
      if (input.format !== "txt" && input.format !== "markdown") throw new DomainValidationError("format_not_supported", "MVP에서는 TXT와 Markdown만 내보낼 수 있습니다.");
      const n = await novel.getNovel(scope);
      const { episodes, label } = await resolveEpisodes(scope, input);
      const arcs = new Map((await novel.listArcs(scope)).map((a) => [a.id, a]));
      const items: ExportItem[] = [];
      const excluded: Array<{ episode_id: string; episode_no: number; reason: string }> = [];
      const chapters: ExportChapter[] = [];
      for (const ep of [...episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
        const versionId = input.versionSelection === "current" ? ep.currentVersionId : (ep.publishedVersionId ?? ep.approvedVersionId);
        if (!versionId) {
          excluded.push({ episode_id: ep.id, episode_no: ep.episodeNo, reason: input.versionSelection === "current" ? "no_current_version" : "not_approved" });
          continue;
        }
        const v = await manuscript.getVersion(scope, versionId);
        items.push({
          episode_id: ep.id,
          episode_no: ep.episodeNo,
          manuscript_version_id: v.id,
          char_count_with_spaces: manuscript.countChars(v.content, "with_spaces"),
          char_count_without_spaces: manuscript.countChars(v.content, "without_spaces"),
        });
        const arc = arcs.get(ep.arcId);
        chapters.push({ episodeNo: ep.episodeNo, title: ep.title, arc: arc ? { id: arc.id, ord: arc.ord, title: arc.title } : null, content: v.content });
      }
      if (!items.length) {
        throw new DomainValidationError("nothing_to_export", "내보낼 수 있는 화가 없습니다. 승인된 화가 있거나 '현재 버전'을 골라야 합니다.", { excluded });
      }
      const body = input.format === "markdown" ? renderMarkdown(chapters, { arcHeadings: input.scopeKind !== "episode" }) : renderTxt(chapters);
      const id = ids.next("exp");
      const key = `novels/${scope.novelId}/exports/${id}.${ext(input.format)}`;
      const stored = await storage.put(key, body);
      try {
        return await uow.run(async (tx) => {
          await repo.insert(tx.db, {
            id,
            novelId: scope.novelId,
            scopeKind: input.scopeKind,
            scopeTargetId: input.scopeKind === "novel" ? null : input.targetId!,
            exportFormat: input.format,
            versionSelection: input.versionSelection,
            items,
            excluded,
            requestedByActorType: actor.type,
            requestedByActorId: actor.id,
          });
          const job = await repo.complete(tx.db, scope, id, { storageKey: key, contentHash: stored.sha256, completedAt: clock.date() });
          await audit.record(tx, {
            novelId: scope.novelId,
            actor,
            action: "export.created",
            target: { type: "novel", id: scope.novelId },
            after: { exportId: id, scopeKind: input.scopeKind, targetId: input.targetId ?? null, format: input.format, versionSelection: input.versionSelection, contentHash: stored.sha256 },
            details: {
              versions: items.map((i) => ({ episodeNo: i.episode_no, versionId: i.manuscript_version_id })),
              excluded: excluded.map((e) => e.episode_no),
              count: items.length,
              fileName: exportFileName({ novelTitle: n.title, scope: label, at: clock.date(), timeZone: n.timezone, ext: ext(input.format) }),
            },
          });
          return job;
        });
      } catch (err) {
        await storage.delete(key).catch(() => undefined);
        throw err;
      }
    },
    listExports: (scope) => repo.list(uow.db, scope),
    getExport: mustJob,
    async openDownload(scope, exportId) {
      const job = await mustJob(scope, exportId);
      if (!job.completedAt || !job.storageKey) throw new DomainValidationError("export_incomplete", "아직 완료되지 않은 내보내기입니다.");
      const n = await novel.getNovel(scope);
      let label: { kind: "episode" | "arc" | "novel"; episodeNo?: number; arcOrd?: number } = { kind: "novel" };
      if (job.scopeKind === "episode") label = { kind: "episode", episodeNo: (job.items as ExportItem[])[0]?.episode_no };
      if (job.scopeKind === "arc" && job.scopeTargetId) label = { kind: "arc", arcOrd: (await novel.getArc(scope, job.scopeTargetId)).ord };
      const e = job.exportFormat === "markdown" ? "md" : "txt";
      if (!(await storage.exists(job.storageKey))) throw new NotFoundError("내보내기 파일", exportId);
      return {
        path: storage.pathOf(job.storageKey),
        fileName: exportFileName({ novelTitle: n.title, scope: label, at: job.createdAt, timeZone: n.timezone, ext: e }),
        contentType: e === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
      };
    },
  };
}
