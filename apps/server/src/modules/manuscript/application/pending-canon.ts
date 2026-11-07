/**
 * 설계 추가(미확정 사실 선행 집필): full_auto with autoApproveEpisodes=false writes episodes ahead of the author's approval.
 * Facts extracted from an earlier episode that still waits for approval stay `candidate` — canon_1hop / 2hop only carry
 * approved / published facts, so episode N would not see what N-1 (awaiting approval) established.
 *
 * `pending_canon` ("미확정 사실 (앞 화 승인 대기 — 확정 설정이 우선)"): live candidate facts whose source episode is
 *   - earlier than N and not approved / published yet,
 *   - relevant to the run's seed entities or the previous episode's outline cast,
 *   - not in conflict with canon (`conflictWith`) and not held for a canon-change decision (`reconcilePending`),
 *   - still valid at N (story range open past N's start).
 * Newest source episode first, bounded. Each line names its source episode ("(6화, 미확정)"). The fact versions are
 * recorded in the context snapshot (factVersionIds + candidateFactVersionIds) so a later change of those facts can
 * flag the episodes written on them (continuity: pending-dependents).
 */
import type { EpisodeStatus } from "@ncs/shared";
import type { NovelScope, Tx } from "../../../platform/index.js";
import type { ContextSectionProvider } from "../../agents/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import type { Episode, PendingPriorFact } from "../index.js";
import { soft, type Ports } from "./support.js";

/** source episodes whose facts are still provisional (written, not approved / published) */
export const PENDING_SOURCE_STATUSES: readonly EpisodeStatus[] = ["outlining", "drafting", "checking", "polishing", "awaiting_approval", "revising"];
/** how many earlier episodes are looked at (newest first) */
export const PENDING_CANON_MAX_EPISODES = 10;
export const PENDING_CANON_MAX_FACTS = 40;
/** section text bound (≈ tokens for Hangul) */
export const PENDING_CANON_MAX_CHARS = 2400;

export const PENDING_CANON_HEADER =
  "아래 사실은 아직 작가 승인을 기다리는 앞 화에서 나온 미확정 설정입니다. 확정 설정(제약·캐논 사실·아웃라인)과 어긋나지 않는 한 이 설정과 일관되게 이어 씁니다. 어긋나면 확정 설정과 아웃라인을 따릅니다.";

export const pendingLabel = (episodeNo: number) => `(${episodeNo}화, 미확정)`;

function outlineCast(v: { outlineData?: unknown } | null): string[] {
  const scenes = ((v?.outlineData as { scenes?: Array<{ pov_entity_id?: unknown; location_entity_id?: unknown; participant_entity_ids?: unknown }> } | null)?.scenes ?? []);
  const ids = new Set<string>();
  for (const s of scenes) {
    for (const x of [s.pov_entity_id, s.location_entity_id, ...(Array.isArray(s.participant_entity_ids) ? s.participant_entity_ids : [])]) if (typeof x === "string" && x.startsWith("ent_")) ids.add(x);
  }
  return [...ids];
}

export function createPendingCanon(ports: Ports) {
  const { ontology, platform } = ports.deps;
  const dbOf = (tx?: Tx) => tx?.db ?? platform.uow.db;

  async function listPendingPriorFacts(scope: NovelScope, episodeNo: number, opts: { entityIds?: string[]; limit?: number } = {}, tx?: Tx): Promise<PendingPriorFact[]> {
    if (episodeNo <= 1) return [];
    const eps = (await repo.listEpisodes(dbOf(tx), scope, { statuses: [...PENDING_SOURCE_STATUSES], toNo: episodeNo - 1 }))
      .sort((a, b) => b.episodeNo - a.episodeNo)
      .slice(0, PENDING_CANON_MAX_EPISODES);
    if (!eps.length) return [];
    const wanted = new Set(opts.entityIds ?? []);
    const startOfN = episodeNo * 1000;
    const out: PendingPriorFact[] = [];
    for (const ep of eps) {
      const facts = await soft(() => ontology.listEpisodeFacts(scope, ep.id, tx), []);
      const live = facts.filter(
        (f) =>
          f.canonStatus === "candidate" &&
          !f.conflictWith &&
          !f.reconcilePending &&
          !!f.subjectEntityId &&
          (f.storyRange.to === null || f.storyRange.to > startOfN),
      );
      if (!live.length) continue;
      // merged entities → survivor (seeds are survivors)
      const raw = [...new Set(live.flatMap((f) => [f.subjectEntityId, f.objectEntityId ?? ""]).filter(Boolean))];
      const map = wanted.size ? await soft(() => ontology.resolveEntityIds(scope, raw, tx), new Map<string, string>()) : new Map<string, string>();
      const rid = (id: string | null | undefined) => (id ? (map.get(id) ?? id) : "");
      const relevant = wanted.size ? live.filter((f) => wanted.has(rid(f.subjectEntityId)) || wanted.has(rid(f.objectEntityId))) : live;
      relevant.sort((x, y) => y.storyRange.from - x.storyRange.from);
      for (const f of relevant) out.push({ ...f, sourceEpisodeId: ep.id, sourceEpisodeNo: ep.episodeNo, sourceEpisodeStatus: ep.status });
      if (out.length >= (opts.limit ?? PENDING_CANON_MAX_FACTS)) break;
    }
    return out.slice(0, opts.limit ?? PENDING_CANON_MAX_FACTS);
  }

  /** the run's seeds + the previous episode's outline cast */
  async function relevantEntities(scope: NovelScope, ep: Episode, seeds: string[]): Promise<string[]> {
    const ids = new Set(seeds);
    const prev = await repo.getEpisodeByNo(dbOf(), scope, ep.episodeNo - 1);
    if (prev?.outlineVersionId) {
      const v = await soft(() => repo.getVersion(dbOf(), scope, prev.outlineVersionId!), null);
      for (const id of outlineCast(v)) ids.add(id);
    }
    if (!ids.size) return [];
    const map = await soft(() => ontology.resolveEntityIds(scope, [...ids]), new Map<string, string>());
    return [...new Set([...ids].map((id) => map.get(id) ?? id))];
  }

  const section: ContextSectionProvider = {
    section: "pending_canon",
    module: "manuscript",
    async build(scope, spec) {
      if (!spec.episodeId) return null;
      const ep = await repo.getEpisode(dbOf(), scope, spec.episodeId);
      if (!ep || ep.episodeNo <= 1) return null;
      const entityIds = await relevantEntities(scope, ep, spec.seeds.entityIds);
      const facts = await listPendingPriorFacts(scope, ep.episodeNo, { entityIds });
      if (!facts.length) return null;
      const lines: string[] = [];
      const used: PendingPriorFact[] = [];
      let chars = PENDING_CANON_HEADER.length;
      for (const f of facts) {
        const line = `- {{E:${f.subjectEntityId}}} ${f.text} ${pendingLabel(f.sourceEpisodeNo)}`;
        if (chars + line.length > PENDING_CANON_MAX_CHARS && used.length) break;
        chars += line.length + 1;
        lines.push(line);
        used.push(f);
      }
      const text = [PENDING_CANON_HEADER, ...lines].join("\n");
      const versionIds = used.map((f) => f.factVersionId);
      return { text, tokenEstimate: 0, refs: { factVersionIds: versionIds, candidateFactVersionIds: versionIds } };
    },
  };

  return { listPendingPriorFacts, section };
}
