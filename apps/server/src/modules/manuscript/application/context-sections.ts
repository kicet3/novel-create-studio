/**
 * Context sections owned by manuscript (04 §9.5): `outline` (current episode outline) and `recent_text`
 * (end of the previous episode — 07 §3.2 "직전 화 끝부분(가정: 마지막 씬 1개)"). Never the whole manuscript (PR-09).
 */
import type { ContextSectionProvider } from "../../agents/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import type { OutlineData } from "../domain/schemas.js";
import type { Ports } from "./support.js";

const tokens = (s: string) => Math.ceil(s.length / 2);

export function createContextSections(ports: Ports): ContextSectionProvider[] {
  const db = () => ports.deps.platform.uow.db;
  return [
    {
      section: "outline",
      module: "manuscript",
      async build(scope, spec) {
        if (!spec.episodeId) return null;
        const ep = await repo.getEpisode(db(), scope, spec.episodeId);
        if (!ep?.outlineVersionId) return null;
        const v = await repo.getVersion(db(), scope, ep.outlineVersionId);
        if (!v) return null;
        const data = (v.outlineData ?? {}) as Partial<OutlineData>;
        const scenes = (data.scenes ?? []).map((s) => `- [${s.key}] ${s.summary}${s.setup_beat_ids?.length ? ` (떡밥 비트: ${s.setup_beat_ids.join(", ")})` : ""}`);
        const text = [`${ep.episodeNo}화 아웃라인`, v.content, scenes.length ? `씬 계획:\n${scenes.join("\n")}` : "", data.hook ? `회차 말 훅: ${data.hook}` : ""]
          .filter(Boolean)
          .join("\n");
        return { text, tokenEstimate: tokens(text), refs: { versionIds: [v.id] } };
      },
    },
    {
      section: "recent_text",
      module: "manuscript",
      async build(scope, spec) {
        if (!spec.episodeId) return null;
        const ep = await repo.getEpisode(db(), scope, spec.episodeId);
        if (!ep || ep.episodeNo <= 1) return null;
        const prev = await repo.getEpisodeByNo(db(), scope, ep.episodeNo - 1);
        const versionId = prev?.approvedVersionId ?? prev?.currentVersionId;
        if (!prev || !versionId) return null;
        const v = await repo.getVersion(db(), scope, versionId);
        if (!v) return null;
        const scenes = await repo.listScenes(db(), scope, prev.id);
        const last = scenes[scenes.length - 1];
        const tail = (last ? v.content.slice(last.charStart, last.charEnd) : v.content.slice(-1500)).slice(-2000);
        const text = `${prev.episodeNo}화 마지막 장면:\n${tail}`;
        return { text, tokenEstimate: tokens(text), refs: { versionIds: [v.id] } };
      },
    },
  ];
}
