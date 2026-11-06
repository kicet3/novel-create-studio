/** N1 participant (contracts phase; keep or refactor): ontology schema v1 (`base@1`) + default main timeline. */
import { ontologySchemaVersions, timelines } from "@ncs/db/schema";
import type { NovelScope, Platform, Tx } from "../../../../platform/index.js";

export async function initializeNovelOntology(platform: Platform, tx: Tx, scope: NovelScope, schemaVersionId: string) {
  await tx.db.insert(ontologySchemaVersions).values({ id: schemaVersionId, novelId: scope.novelId, versionNo: 1, baseSchemaKey: "base@1" });
  const mainTimelineId = platform.ids.next("tln");
  await tx.db.insert(timelines).values({ id: mainTimelineId, novelId: scope.novelId, kind: "main", label: "본편", isDefault: true });
  return { schemaVersionId, mainTimelineId };
}
