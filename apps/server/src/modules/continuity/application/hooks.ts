/**
 * continuity registrations: manuscript CheckGateContributor (07 §5.3 "열린 high 이슈 0", fix_scope → E4/E5),
 * onEpisodeTransition (C2 on E4/E5 rewrite; stale-version cleanup on E6/E9), version annotator `issues`.
 */
import { actors } from "../../../platform/index.js";
import type { CheckGateContributor, EpisodeTransitionContext, VersionAnnotator } from "../../manuscript/index.js";
import { continuityRepo as repo } from "../adapters/db/continuity-repository.js";
import { strongest } from "../domain/rules.js";
import { formatIssueNo } from "../domain/transitions.js";
import type { ContinuityInternals } from "./continuity-service.js";
import type { ContinuityPorts } from "./ports.js";

export function continuityGateContributor(deps: ContinuityPorts): CheckGateContributor {
  return {
    name: "continuity",
    async evaluate(scope, episode, versionId, tx) {
      const db = tx?.db ?? deps.platform.uow.db;
      // INV-EP-02: open (or fixing) high issues on the version being gated — safety and setup issues included
      const high = (await repo.listIssues(db, scope, { episodeId: episode.id, statuses: ["open", "fixing"], severities: ["high"] })).filter((i) => i.manuscriptVersionId === versionId);
      return {
        source: "continuity",
        pass: high.length === 0,
        fixScope: high.length ? (strongest(high.map((i) => i.fixScope)) ?? "scene") : undefined,
        blockers: high.map((i) => ({ refType: "continuity_issue", refId: i.id, message: `${formatIssueNo(i.displayNo)} ${i.message}`, sceneId: i.sceneId })),
      };
    },
  };
}

export function continuityTransitionHook(deps: ContinuityPorts, svc: ContinuityInternals) {
  return async (ctx: EpisodeTransitionContext): Promise<void> => {
    const { tx, scope, episode, from, to } = ctx;
    const system = actors.system("orchestrator");
    if (from === "checking" && (to === "drafting" || to === "outlining")) {
      // E4 / E5: the rewrite cycle starts → C2 for the blocking issues
      await svc.markFixing(tx, scope, episode.id, system);
    } else if ((from === "checking" && to === "polishing") || (to === "approved" && from !== "published")) {
      // E6 / E9: the gate passed on the current version → issues left on older versions were not reproduced
      if (!episode.currentVersionId) return;
      const v = await deps.manuscript.getVersion(scope, episode.currentVersionId, tx).catch(() => null);
      await svc.closeStaleIssues(tx, scope, episode.id, episode.currentVersionId, v?.isHumanEdit ?? false, actors.system("orchestrator"));
    }
  };
}

export function issuesAnnotator(deps: ContinuityPorts): VersionAnnotator {
  return async (scope, version) => {
    const issues = await repo.listIssues(deps.platform.uow.db, scope, { episodeId: version.episodeId });
    return issues.filter((i) => i.manuscriptVersionId === version.id).map((i) => ({ ...i, displayLabel: formatIssueNo(i.displayNo) }));
  };
}
