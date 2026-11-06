import { isActivityAction } from "@ncs/shared";
import type { ActorRef } from "../../../platform/types.js";

/** Validate an action name against the catalogue (@ncs/shared ACTIVITY_ACTIONS). */
export function assertActivityAction(action: string): void {
  if (!isActivityAction(action)) throw new TypeError(`unknown audit action: ${action} (add it to packages/shared/src/activity-actions.ts)`);
}

/** Columns derived from an ActorRef (agents must carry run_id — activity_log CHECK). */
export function actorColumns(actor: ActorRef): { actorType: ActorRef["type"]; actorId: string; runId: string | null } {
  if (actor.type === "agent") {
    if (!actor.runId) throw new TypeError("agent actor requires runId");
    return { actorType: "agent", actorId: actor.id, runId: actor.runId };
  }
  return { actorType: actor.type, actorId: actor.id, runId: null };
}

/** Escape LIKE wildcards in an action prefix. */
export function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}
