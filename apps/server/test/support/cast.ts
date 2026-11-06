/** Test helper: finish the cast step (설계 추가: 캐릭터 설정 단계) so the goal (N3) can be saved. */
import type { TestCore } from "./test-core.js";

/** adds a protagonist when the cast has none (e.g. a brief without characters) and confirms the cast */
export async function confirmTestCast(t: TestCore, novelId: string, protagonistName = "주인공"): Promise<void> {
  const scope = { novelId };
  const cast = t.modules.cast.service;
  const items = await cast.listCharacters(scope);
  if (!items.some((c) => c.role === "protagonist")) await cast.createCharacter(scope, { role: "protagonist", name: protagonistName }, t.owner);
  await cast.confirmCast(scope, t.owner);
}
