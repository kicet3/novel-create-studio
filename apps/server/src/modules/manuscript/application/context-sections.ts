/**
 * Context sections owned by manuscript (04 §9.5): `outline` (current episode outline) and `recent_text`
 * (end of the previous episode — 07 §3.2 "직전 화 끝부분(가정: 마지막 씬 1개)"). Never the whole manuscript (PR-09).
 * 설계 추가 0019: prev_handoff / story_so_far live in handoff.ts.
 */
import type { ContextSectionProvider } from "../../agents/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import type { OutlineData } from "../domain/schemas.js";
import { episodeEnd } from "./handoff.js";
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
        // 설계 추가 0019: the LATEST text of N-1 (full_auto may change it after N started), last scene ≈ 1,200–2,000 chars
        const end = prev ? await episodeEnd(db(), scope, prev) : null;
        if (!end || !end.tail) return null;
        const text = `${end.episodeNo}화 마지막 장면(이번 화는 이 장면 바로 뒤에서 이어집니다):\n${end.tail}`;
        return { text, tokenEstimate: tokens(text), refs: { versionIds: [end.versionId] } };
      },
    },
  ];
}
