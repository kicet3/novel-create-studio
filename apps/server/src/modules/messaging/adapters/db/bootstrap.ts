/** N1 participant (contracts phase; keep or refactor): the always-on web channel (INV-CH-01). */
import { channels } from "@ncs/db/schema";
import type { NovelScope, Platform, Tx } from "../../../../platform/index.js";
import type { Channel } from "../../index.js";

export async function insertWebChannel(platform: Platform, tx: Tx, scope: NovelScope): Promise<Channel> {
  const [c] = await tx.db
    .insert(channels)
    .values({ id: platform.ids.next("chn"), novelId: scope.novelId, kind: "web", status: "active", label: "웹 인박스", boundAt: platform.clock.date() })
    .returning();
  return c!;
}
