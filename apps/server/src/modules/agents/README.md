# module `agents`

- **Status:** implemented (MVP-α)
- **Owner:** A2 llm+agents
- **Public API:** `index.ts`. Factory `createAgentsModule` in `module.ts`.

## Responsibilities
- 10 role definitions (8 MVP + 2 v1) with Korean missions, allowed writes (04 §2.3) and context layer (`domain/roles.ts`).
- Versioned Korean prompt templates `<role>.<task_kind>@0.1.0` for every MVP-α task kind, plus the reassign combos
  `line_editor.revise_episode`, `writer.polish_episode` (`domain/prompt-templates.ts`).
- ContextBuilder (04 §9, `application/context-builder.ts`): seeds → ontology (cards, 1/2-hop canon, knowledge,
  constraints, safe candidates, unresolved surfaces, forbidden surfaces for writer/line_editor) + registered providers,
  token budget per role (ranks 4–7 droppable, ranks 1–3 over limit → `TaskFailure(internal)`), one `context_snapshots`
  row per run with every id used (FR-AGT-04), rendered pack stored at `novels/<novelId>/context/<snapshotId>.json`.
- `defineAgentTask(h)`: checks role = `TASK_KIND_ROLE[kind]`, warns on writes not allowed for the role / unknown template,
  clones the previous snapshot when the previous run stopped at a safe point (RU-3), then buildContext → execute → commit.

## Writing a task handler
```ts
orchestration.registerTaskKind(agents.defineAgentTask({
  kind: "outline_episode", role: "planner", promptTemplateVersion: "planner.outline_episode@0.1.0",
  inputSchema, allowedWrites: ["manuscript.createVersion"],
  buildContext: (run, input, builder) => builder.build(run, agents.defaultContextSpec("planner", {
    anchor: { storyPoint: ep.episodeNo * 1000, timelineId: "" },   // "" → default timeline
    seeds: { entityIds, setupIds: [], answerIds: input.answer_ids ?? [], mentionIds: [] },
    episodeId: ep.id,
  })),
  async execute(run, input, pack, llm) {
    const { system, messages } = agents.renderPrompt("planner.outline_episode@0.1.0", { episodeNo: ep.episodeNo, targetChars: { min: 5000, max: 5500 } }, pack);
    return (await llm.call({ run, purpose: "outline", system, messages, output: { kind: "object", schemaName: "outline_episode", schema } })).value;
  },
  async commit(tx, run, input, proposal) { /* module APIs; handles → ids via agents.resolveEntityHandle(pack, "E2") */ },
}));
```
Template vars: `manuscript` → `<manuscript>…</manuscript>`, `targetChars: {min,max}` → `목표 분량: min~max자(공백 포함)`,
`userMessage` → quoted author message, `episodeNo` → `{{episodeLabel}}` = "제N화"; other vars are rendered as
`### key` + value/JSON.

## Context section providers
`agents.registerContextSection({ section, module, build(scope, spec, run) })` — return `{ text, tokenEstimate, refs }`.
Refer to entities in `text` as `{{E:<entity_id>}}`; the builder swaps in the pack handle and records the id.
`refs` keys map to snapshot columns (`factVersionIds`, `candidateFactVersionIds`, `constraintFactIds`, `setupIds`,
`answerIds`, `entityIds`, `entityNameIds`, `conceptMessageIds`, `recapIds`, `questionIds`, `versionIds` → `manuscript_version_ids` (0002)). The snapshot id is linked to `runs.context_snapshot_id` via `run.attachContextSnapshot`.

## Owned tables
- context_snapshots

## HTTP endpoints
- `GET /api/agents/roles` · `GET /api/agents/prompt-templates`
- `GET …/context-snapshots/:snapshotId` → snapshot + stored pack (debug)
