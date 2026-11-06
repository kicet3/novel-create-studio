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

/** literal profile values used for every required field the test cast leaves empty (0008 completeness) */
export const TEST_PROFILE = {
  age: "27세",
  appearance: "검은 머리를 짧게 묶고 왼손등에 흉터가 있다.",
  personality: "장점: 끈질기고 침착하다. 결점: 남을 쉽게 믿지 못한다.",
  desire: "흉터의 비밀을 밝혀 회귀를 끝낸다.",
  motivation: "회귀 전 지키지 못한 사람들을 이번에는 지키고 싶다.",
  weakness: "다시 배신당할까 두려워한다.",
  background: "몰락한 검사 가문의 막내였다.\n회귀 전 길드에게 버림받고 죽었다.",
  speechSample: "\"이번에는 내가 먼저 움직인다.\"",
  arcStart: "아무도 믿지 않는 외톨이",
  arcEnd: "동료에게 등을 맡기는 검사",
  storyRole: "주인공을 돕는 조력자",
};

/**
 * Fills every empty required field (protagonist / sub-protagonist / supporting / antagonist), links each other
 * character to the protagonist and confirms the cast — the structure gate (cast completeness) passes afterwards.
 */
export async function completeTestCast(t: TestCore, novelId: string, protagonistName = "주인공"): Promise<void> {
  const scope = { novelId };
  const cast = t.modules.cast.service;
  if (!(await cast.listCharacters(scope)).some((c) => c.role === "protagonist")) {
    await cast.createCharacter(scope, { role: "protagonist", name: protagonistName }, t.owner);
  }
  const items = await cast.listCharacters(scope);
  const hero = items.find((c) => c.role === "protagonist")!;
  for (const c of items) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(TEST_PROFILE)) {
      if (k === "storyRole" && (c.role === "protagonist" || c.role === "sub_protagonist")) continue;
      if (!String((c as unknown as Record<string, unknown>)[k] ?? "").trim()) patch[k] = v;
    }
    if (c.id !== hero.id && !(c.relationships ?? []).some((r) => r.targetCharacterId === hero.id)) {
      patch.relationships = [...(c.relationships ?? []), { targetCharacterId: hero.id, kind: "동료", description: "" }];
    }
    if (Object.keys(patch).length) await cast.updateCharacter(scope, c.id, patch, t.owner);
  }
  await cast.confirmCast(scope, t.owner);
}
