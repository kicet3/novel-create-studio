/**
 * Harness of the autopilot tests (설계 추가 0014): a novel whose concept the author approved (onboarding, the
 * protagonist seeded from the brief with empty required fields, the world ontology task queued by N2) and the one
 * human action of the full-auto flow — `PUT /autonomy` with the acknowledgements.
 */
import { eq } from "@ncs/db/orm";
import { conceptBriefs, conceptSessions } from "@ncs/db/schema";
import { expect } from "vitest";
import type { TestCore } from "../support/test-core.js";
import type { ScriptedClaude } from "../support/scripted-claude.js";
import { TEST_PROFILE } from "../support/cast.js";

export type Scope = { novelId: string };

export const BRIEF_CONTENT = {
  logline: "회귀한 검사가 흉터의 비밀을 쫓는다",
  ending_direction: "흉터의 비밀을 밝히고 회귀를 끝낸다",
  serial_plan: { total_episodes_min: 12, total_episodes_max: 12, cadence_episodes_per_week: 7 },
  protagonist: { name: "한결", desire: "흉터의 비밀을 밝혀 회귀를 끝낸다", sketch: "끈질기고 침착하다", starting_condition: "몰락한 검사 가문의 막내" },
};

/** novel in onboarding: approved brief (approved by the author before full_auto), cast seeded from the brief */
export async function approvedConceptNovel(t: TestCore, title = "완전 자율 작품", content: Record<string, unknown> = BRIEF_CONTENT) {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title }, t.owner);
  const scope = { novelId: novel.id };
  const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novel.id));
  const briefId = t.platform.ids.next("cbf");
  await t.testDb.db.insert(conceptBriefs).values({
    id: briefId,
    novelId: novel.id,
    sessionId: session!.id,
    versionNo: 1,
    authorActorType: "user",
    authorActorId: t.ownerId,
    entryMode: "conversation",
    questionSetVersion: "common@1",
    content,
    contentMd: "# 브리프",
  } as typeof conceptBriefs.$inferInsert);
  // the author's approval of the concept (before full_auto): an approval row the brief points to
  const approvalId = await t.platform.uow.run(async (tx) => {
    const r = await t.modules.hitl.service.requestApproval(tx, scope, {
      approvalType: "concept_brief",
      target: { type: "concept_brief", id: briefId },
      question: { title: "컨셉 승인", body: "테스트 준비", links: [{ type: "concept_brief", id: briefId }] },
      requestedBy: t.owner,
    });
    await t.modules.hitl.service.cancelApproval(tx, scope, r.approvalId, "테스트 준비(작가가 확정한 컨셉)", t.owner);
    return r.approvalId;
  });
  await t.testDb.db.update(conceptBriefs).set({ status: "approved", approvalId, approvedAt: new Date() }).where(eq(conceptBriefs.id, briefId));
  await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "회귀 판타지", ageRating: "age_15", category: {} }, t.owner));
  return { novel, scope, briefId };
}

/** the single human action: switch full_auto on (with the acknowledgements) */
export async function enableFullAuto(t: TestCore, scope: Scope, autopilot: Record<string, unknown> = {}, publishPolicy: "manual" | "scheduled" = "manual") {
  const structureOptIn = !!(autopilot.autoApproveStructure || autopilot.autoConfirmConcept);
  const r = await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, {
    autonomyLevel: "full_auto",
    publishPolicy,
    acknowledgedFullAutoWarning: true,
    acknowledgedAutoItems: true,
    acknowledgedStructureAutoWarning: structureOptIn,
    autopilot,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** `draft_cast` fill_missing: literal values for every empty required field of the protagonist 한결 */
export function scriptCastFill(claude: ScriptedClaude, name = "한결") {
  claude.reply({
    times: Infinity,
    when: { schemaHas: ["characters"], prompt: "빈 필수 항목 채우기" },
    json: {
      characters: [
        {
          existing_id: "",
          role: "protagonist",
          name,
          aliases: [],
          age: TEST_PROFILE.age,
          gender: "",
          personality: TEST_PROFILE.personality,
          background: TEST_PROFILE.background,
          desire: TEST_PROFILE.desire,
          weakness: TEST_PROFILE.weakness,
          notes: "",
          appearance: TEST_PROFILE.appearance,
          motivation: TEST_PROFILE.motivation,
          speech_sample: TEST_PROFILE.speechSample,
          arc_start: TEST_PROFILE.arcStart,
          arc_end: TEST_PROFILE.arcEnd,
          story_role: "",
          relationships: [],
        },
      ],
    },
  });
}

export const auditActions = async (t: TestCore, scope: Scope, prefix: string) => (await t.modules.audit.service.list(scope, { actionPrefix: prefix, limit: 500 })).items;
