/**
 * 설계 추가 0019: 화 사이 이어짐 — episode N continues where N-1 ended.
 *
 * - `summarize_episode` (continuity_editor, one cheap structured call with a repair round): the end state of an
 *   episode version (place, time, who is present, physical / emotional state, open action / hook, last line) + a
 *   3–5 line summary, stored in episode_recaps (layer canon, one row per source version).
 * - triggers: the episode is approved (E9), its text changes while the next episode already started (full_auto
 *   starts N+1 while N is still being checked), and the scheduler starting N+1 when N has no handoff yet.
 *   Recaps of an older version get `stale_at`; the context marks a stale handoff and the continuity check reads the
 *   latest N-1 text.
 * - context sections: `prev_handoff` ("직전 화 끝 상태", never dropped for outline / draft) and `story_so_far`
 *   ("지금까지의 줄거리": recent 3 episodes in detail, older compressed, bounded, droppable).
 * - boot backfill: approved / published episodes without a recap of their latest version get one task each, once
 *   (cycle key `recap_backfill@1:<version>`; an existing task of that key — any status — is never enqueued again).
 */
import { DEFAULTS } from "@ncs/shared";
import { z } from "zod";
import { actors, type Db, type NovelScope, type Tx } from "../../../platform/index.js";
import { callWithRepair, type AgentTaskHandler, type ContextSectionProvider } from "../../agents/index.js";
import { TaskFailure, type RunHandle } from "../../orchestration/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { recapRepo, type EpisodeRecapRow } from "../adapters/db/recap-repository.js";
import { endTail, episodeRecapProposalSchema, handoffText, normalizeRecap, storySoFarText, validateRecap, type EpisodeHandoff, type EpisodeRecapProposal, type StoryEntry } from "../domain/handoff.js";
import type { Episode, EpisodeEnd, EpisodeTransitionContext } from "../index.js";
import type { Ports } from "./support.js";

export const SUMMARIZE_PROMPT_VERSION = "continuity_editor.summarize_episode@0.1.0";
export const RECAP_SCHEMA_NAME = "EpisodeRecap";
export const BACKFILL_CYCLE_PREFIX = "recap_backfill@1";
/** above the outline's reserve-scaled priority (500 + 50 × gap, 750 at the default reserve of 5); the outline gate also defers on it */
const RECAP_PRIORITY = 800;
const BACKFILL_PRIORITY = 150;
/** statuses whose text the next episode may already continue from (ED-1: N reached checking) */
const HAS_TEXT: readonly Episode["status"][] = ["checking", "polishing", "awaiting_approval", "approved", "published", "revising"];

export const SUMMARIZE_INSTRUCTION = `당신은 연속성 편집자(continuity_editor)입니다. 다음 화 작가가 이 화 끝에서 바로 이어 쓸 수 있게 <manuscript>의 원고를 JSON으로 정리합니다.
- handoff: 마지막 장면의 장소(place)·시간(time), 그 자리에 있는 인물(present, 이름), 인물들의 몸 상태(physical_state)와 마음 상태(emotional_state), 끝나지 않은 행동이나 회차 끝 훅(open_hook), 원고의 마지막 문장(last_line, 원문 그대로).
- summary_lines: 이 화에서 일어난 일을 3~5줄로 씁니다. 한 줄에 한 사건, 시간 순서대로 씁니다.
- 원고에 있는 내용만 씁니다. 추측하거나 다음 화를 예상해 쓰지 않습니다.`;

export const summarizeInputSchema = z
  .object({
    episode_id: z.string(),
    manuscript_version_id: z.string().optional(),
    cycle_key: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type SummarizeInput = z.infer<typeof summarizeInputSchema>;

export interface SummarizeProposal {
  episodeId: string;
  versionId: string;
  recap: EpisodeRecapProposal;
}

/** the version the next episode continues from: the latest text (current), else the approved copy */
export const latestVersionId = (ep: Pick<Episode, "currentVersionId" | "approvedVersionId">) => ep.currentVersionId ?? ep.approvedVersionId ?? null;
const freshIds = (ep: Pick<Episode, "currentVersionId" | "approvedVersionId">) => [ep.currentVersionId, ep.approvedVersionId].filter((x): x is string => !!x);

/** the recap matching the episode's current text, else the newest one (stale) */
export function pickRecap(recaps: EpisodeRecapRow[], ep: Pick<Episode, "currentVersionId" | "approvedVersionId">): { recap: EpisodeRecapRow | null; stale: boolean } {
  const ids = freshIds(ep);
  const fresh = recaps.find((r) => ids.includes(r.sourceVersionId));
  if (fresh) return { recap: fresh, stale: false };
  return { recap: recaps[0] ?? null, stale: recaps.length > 0 };
}

const summaryLinesOf = (r: EpisodeRecapRow | null) => (r?.summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** end of an episode: latest version, bounded last-scene tail, stored handoff */
export async function episodeEnd(db: Db, scope: NovelScope, ep: Episode): Promise<EpisodeEnd | null> {
  const versionId = latestVersionId(ep);
  if (!versionId) return null;
  const v = await repo.getVersion(db, scope, versionId);
  if (!v) return null;
  const scenes = await repo.listScenes(db, scope, ep.id, { versionId });
  const tail = endTail(v.content, scenes.at(-1) ?? null);
  const { recap, stale } = pickRecap(await recapRepo.listForEpisode(db, scope, ep.id), ep);
  return {
    episodeId: ep.id,
    episodeNo: ep.episodeNo,
    versionId,
    tail,
    recapId: recap?.id ?? null,
    recapVersionId: recap?.sourceVersionId ?? null,
    handoff: (recap?.handoff as EpisodeHandoff | null | undefined) ?? null,
    summaryLines: summaryLinesOf(recap),
    stale,
  };
}

/** text sent to the summarizer: whole episodes are short; very long texts keep their head and a long end */
function clipForSummary(content: string, max = 14_000): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.3);
  return `${content.slice(0, head)}\n\n…(중략)…\n\n${content.slice(content.length - (max - head))}`;
}

export function createHandoff(ports: Ports) {
  const { platform, orchestration } = ports.deps;
  const log = platform.log.child({ module: "manuscript", part: "handoff" });
  const db = () => platform.uow.db;
  const system = actors.system("orchestrator");

  /** summarize_episode for the episode's latest version unless it already has a fresh recap (or an active task) */
  async function enqueueRecap(tx: Tx, scope: NovelScope, ep: Episode, reason: string, opts: { cycleKey?: string; priority?: number } = {}): Promise<string | null> {
    if (!ports.isRegistered("summarize_episode")) return null;
    const versionId = latestVersionId(ep);
    if (!versionId) return null;
    if (await recapRepo.getForVersion(tx.db, scope, ep.id, versionId)) return null;
    try {
      return await ports.createTask(tx, scope, {
        kind: "summarize_episode",
        targetType: "episode",
        targetId: ep.id,
        episodeId: ep.id,
        arcId: ep.arcId,
        input: { episode_id: ep.id, manuscript_version_id: versionId, reason },
        createdBy: system,
        cycleKey: opts.cycleKey ?? `recap:${versionId}`,
        priority: opts.priority ?? RECAP_PRIORITY,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "goal_required") return null;
      throw err;
    }
  }

  /** the scheduler starts episode `ep` (outline): the previous episode needs a handoff of its latest text */
  async function ensurePrevRecap(tx: Tx, scope: NovelScope, ep: Pick<Episode, "episodeNo">): Promise<string | null> {
    if (ep.episodeNo <= 1) return null;
    const prev = await repo.getEpisodeByNo(tx.db, scope, ep.episodeNo - 1);
    if (!prev || !HAS_TEXT.includes(prev.status)) return null;
    return enqueueRecap(tx, scope, prev, "next_episode_started");
  }

  /** onEpisodeTransition: stale marking + (re)summarize on approval / text change after the next episode started */
  async function onTransition(ctx: EpisodeTransitionContext): Promise<void> {
    const { tx, scope, episode: ep, to } = ctx;
    const ids = freshIds(ep);
    if (ids.length) await recapRepo.markStale(tx.db, scope, ep.id, ids, platform.clock.date());
    if (to === "approved") {
      await enqueueRecap(tx, scope, ep, "approved");
      return;
    }
    if (to === "checking" || to === "awaiting_approval") {
      const next = await repo.getEpisodeByNo(tx.db, scope, ep.episodeNo + 1);
      if (next && next.status !== "planned") await enqueueRecap(tx, scope, ep, "changed_after_next_started");
    }
    // the episode itself (re)starts from its outline: make sure the previous one has a handoff
    if (to === "outlining") await ensurePrevRecap(tx, scope, ep);
  }

  // ── context sections ──
  const sections: ContextSectionProvider[] = [
    {
      section: "prev_handoff",
      module: "manuscript",
      async build(scope, spec) {
        if (!spec.episodeId) return null;
        const ep = await repo.getEpisode(db(), scope, spec.episodeId);
        if (!ep || ep.episodeNo <= 1) return null;
        const prev = await repo.getEpisodeByNo(db(), scope, ep.episodeNo - 1);
        if (!prev) return null;
        const { recap, stale } = pickRecap(await recapRepo.listForEpisode(db(), scope, prev.id), prev);
        if (!recap?.handoff) return null;
        const text = handoffText(prev.episodeNo, recap.handoff as EpisodeHandoff, { stale });
        return { text, tokenEstimate: 0, refs: { recapIds: [recap.id], versionIds: [recap.sourceVersionId] } };
      },
    },
    {
      section: "story_so_far",
      module: "manuscript",
      async build(scope, spec) {
        if (!spec.episodeId) return null;
        const ep = await repo.getEpisode(db(), scope, spec.episodeId);
        if (!ep || ep.episodeNo <= 1) return null;
        const rows = await recapRepo.listBefore(db(), scope, ep.episodeNo);
        const byEp = new Map<number, typeof rows>();
        for (const r of rows) byEp.set(r.episodeNo, [...(byEp.get(r.episodeNo) ?? []), r]);
        const entries: StoryEntry[] = [];
        const recapIds: string[] = [];
        for (const [no, list] of byEp) {
          const { recap } = pickRecap(list, list[0]!);
          const lines = summaryLinesOf(recap);
          if (!recap || !lines.length) continue;
          entries.push({ episodeNo: no, lines });
          recapIds.push(recap.id);
        }
        const text = storySoFarText(entries);
        return text ? { text, tokenEstimate: 0, refs: { recapIds } } : null;
      },
    },
  ];

  // ── task kind summarize_episode ──
  const handler: AgentTaskHandler<SummarizeInput, SummarizeProposal> = {
    kind: "summarize_episode",
    role: "continuity_editor",
    promptTemplateVersion: SUMMARIZE_PROMPT_VERSION,
    inputSchema: summarizeInputSchema,
    allowedWrites: ["manuscript.recordEpisodeRecap"],
    async buildContext(run, input, builder) {
      const scope = { novelId: run.novelId };
      const ep = await repo.getEpisode(db(), scope, input.episode_id);
      if (!ep) throw new TaskFailure("internal", `화를 찾을 수 없습니다: ${input.episode_id}`, false);
      return builder.build(run, {
        anchor: { storyPoint: ep.episodeNo * 1000, timelineId: ep.primaryTimelineId },
        seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
        sections: [],
        maxInputTokens: DEFAULTS["context.max_input_tokens.default"],
        hopPredicates: { hop2: [] },
        episodeId: ep.id,
        manuscriptVersionId: input.manuscript_version_id ?? latestVersionId(ep) ?? undefined,
      });
    },
    async execute(run: RunHandle, input, context, llm) {
      const scope = { novelId: run.novelId };
      const ep = await repo.getEpisode(db(), scope, input.episode_id);
      if (!ep) throw new TaskFailure("internal", `화를 찾을 수 없습니다: ${input.episode_id}`, false);
      const versionId = input.manuscript_version_id ?? latestVersionId(ep);
      const v = versionId ? await repo.getVersion(db(), scope, versionId) : null;
      if (!v) throw new TaskFailure("internal", "정리할 원고 버전이 없습니다.", false);
      const content = v.content;
      const user = [`[EPISODE] no=${ep.episodeNo}${ep.title ? ` title=${ep.title}` : ""} version=${v.id}`, `<manuscript>\n${clipForSummary(content)}\n</manuscript>`].join("\n");
      const r = await callWithRepair({
        llm,
        request: {
          run,
          purpose: "summarize",
          system: [context.system, SUMMARIZE_INSTRUCTION].filter(Boolean).join("\n\n"),
          messages: [...context.messages, { role: "user", content: user }],
          output: { kind: "object", schemaName: RECAP_SCHEMA_NAME, schema: episodeRecapProposalSchema },
          maxOutputTokens: 2_000,
        },
        validate: (p) => ({ result: null, issues: validateRecap(p, content) }),
        label: "화 정리 검사",
        critic: "연속성 검사 에이전트",
        instruction: "원고에 근거해 빠진 항목을 채우고 줄거리를 3~5줄로 맞추세요.",
        maxRounds: 1,
        repairPurpose: "summarize_repair",
      });
      const recap = normalizeRecap(r.value, content);
      if (!recap.summary_lines.length) throw new TaskFailure("invalid_output", "화 정리에 줄거리가 없습니다.", true);
      return { episodeId: ep.id, versionId: v.id, recap };
    },
    async commit(tx, run, _input, p) {
      const scope = { novelId: run.novelId };
      const ep = await repo.getEpisode(tx.db, scope, p.episodeId);
      // the text moved on meanwhile: the newer version has (or gets) its own recap
      if (!ep || !freshIds(ep).includes(p.versionId)) return { kind: "done", outputRefs: [] };
      await recapRepo.upsert(tx.db, {
        id: platform.ids.next("rcp"),
        novelId: scope.novelId,
        episodeId: ep.id,
        sourceVersionId: p.versionId,
        layer: "canon",
        povEntityId: null,
        summary: p.recap.summary_lines.join("\n"),
        handoff: p.recap.handoff,
        createdByRunId: run.runId,
      });
      await recapRepo.markStale(tx.db, scope, ep.id, freshIds(ep), platform.clock.date());
      return { kind: "done", outputRefs: [{ refType: "episode", refId: ep.id }] };
    },
  };

  /** boot: approved / published episodes without a recap of their latest version → one task each, once */
  async function backfill(scope: NovelScope): Promise<string[]> {
    if (!ports.isRegistered("summarize_episode")) return [];
    const eps = (await repo.listEpisodes(db(), scope, { statuses: ["approved", "published"] })).filter((e) => latestVersionId(e));
    if (!eps.length) return [];
    const withRecap = await recapRepo.episodeIdsWithRecap(db(), scope, eps.map((e) => latestVersionId(e)!));
    const missing = eps.filter((e) => !withRecap.has(latestVersionId(e)!));
    if (!missing.length) return [];
    const prior = new Set(
      (await orchestration.listTasks(scope, { kinds: ["summarize_episode"], includeCancelled: true, limit: 2000 }))
        .map((t) => (t.input as { cycle_key?: string } | null)?.cycle_key)
        .filter((k): k is string => !!k),
    );
    const created: string[] = [];
    await platform.uow.run(async (tx) => {
      for (const e of missing) {
        const key = `${BACKFILL_CYCLE_PREFIX}:${latestVersionId(e)}`;
        if (prior.has(key)) continue;
        const id = await enqueueRecap(tx, scope, e, "backfill", { cycleKey: key, priority: BACKFILL_PRIORITY });
        if (id) created.push(id);
      }
    });
    return created;
  }

  async function backfillAll(): Promise<void> {
    let novels: Awaited<ReturnType<typeof ports.deps.novel.listNovels>> = [];
    try {
      novels = await ports.deps.novel.listNovels();
    } catch {
      return;
    }
    for (const n of novels) {
      try {
        const ids = await backfill({ novelId: n.id });
        if (ids.length) log.info({ novelId: n.id, tasks: ids.length }, "episode recap backfill enqueued");
      } catch (err) {
        log.warn({ err: (err as Error).message, novelId: n.id }, "episode recap backfill not enqueued");
      }
    }
  }

  return {
    sections,
    handler,
    onTransition,
    ensurePrevRecap,
    backfill,
    backfillAll,
    getEpisodeEnd: async (scope: NovelScope, episodeNo: number, tx?: Tx) => {
      const d = tx?.db ?? db();
      const ep = await repo.getEpisodeByNo(d, scope, episodeNo);
      return ep ? episodeEnd(d, scope, ep) : null;
    },
  };
}
