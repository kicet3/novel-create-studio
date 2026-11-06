/**
 * DTOs of the `agents` module (roles, prompt templates, context snapshots).
 * Owned by the agents module agent (CONVENTIONS §0). Never import server code here.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

export const agentRoleDtoSchema = z.object({
  role: z.enum(ENUMS.agent_role),
  label: z.string(),
  mission: z.string(),
  allowedWrites: z.array(z.string()),
  contextLayer: z.enum(["canon", "reader", "pov"]),
  mvp: z.boolean(),
  /** prompt template ids registered for this role */
  templates: z.array(z.string()),
});
export type AgentRoleDto = z.infer<typeof agentRoleDtoSchema>;
export const agentRoleListSchema = z.object({ items: z.array(agentRoleDtoSchema) });

export const promptTemplateDtoSchema = z.object({
  id: z.string(),
  role: z.enum(ENUMS.agent_role),
  kind: z.enum(ENUMS.task_kind),
  version: z.string(),
  /** Korean task instruction (body of the template) */
  instruction: z.string().nullable(),
});
export type PromptTemplateDto = z.infer<typeof promptTemplateDtoSchema>;
export const promptTemplateListSchema = z.object({ items: z.array(promptTemplateDtoSchema) });

export const contextSnapshotParamsSchema = z.object({ snapshotId: z.string().regex(/^ctx_/) });

export const contextSnapshotDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  runId: z.string(),
  storyPoint: z.number().int().nullable(),
  timelineId: z.string().nullable(),
  conceptMessageIds: z.array(z.string()),
  povEntityId: z.string().nullable(),
  factVersionIds: z.array(z.string()),
  candidateFactVersionIds: z.array(z.string()),
  constraintFactIds: z.array(z.string()),
  setupIds: z.array(z.string()),
  answerIds: z.array(z.string()),
  entityIds: z.array(z.string()),
  entityNameIds: z.array(z.string()),
  schemaVersionId: z.string(),
  episodeRecapIds: z.array(z.string()),
  provisionalQuestionIds: z.array(z.string()),
  clonedFromSnapshotId: z.string().nullable(),
  tokenEstimate: z.number().int(),
  buildMs: z.number().int(),
  createdAt: isoDateTime,
  /** rendered pack stored next to the snapshot (debug view); null when the file is missing */
  pack: z
    .object({
      system: z.string(),
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
      handles: z.object({ entities: z.array(z.string()), names: z.array(z.string()) }),
      droppedSections: z.array(z.string()),
      sections: z.array(z.object({ section: z.string(), module: z.string(), tokenEstimate: z.number().int() })),
    })
    .nullable(),
});
export type ContextSnapshotDto = z.infer<typeof contextSnapshotDtoSchema>;
