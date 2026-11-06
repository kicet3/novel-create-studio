# module `imaging` (이미지 생성 탭)

- **Status:** implemented
- **Public API:** `index.ts` (`ImagingService`, `ImageAdapter` port, `IMAGE_CATALOG`). Factory `createImagingModule` in `module.ts`.
- **Owns:** `image_generations`, `image_assets` (`packages/db/src/migrations/0005_imaging.sql`, drizzle `schema/imaging.ts`).
- **Depends on:** `llm` (`resolveCredential`, `providers.list()`, `ensureImageProviderProfile`), `budget`
  (`checkDirectSpend`, `recordDirectCost`), `novel` (scope check), `audit`.

## Providers and models (`domain/catalog.ts`, prices = estimates per image, micro-USD)
| provider | lane (connection method) | models | params |
|---|---|---|---|
| OpenAI | API key → `POST /v1/images/generations` | `gpt-image-2.6-flare` (기본), `gpt-image-2.6-sunburst` (고품질), `gpt-image-1-mini` (저가) | aspect 1:1·3:2·2:3·16:9·9:16 → `size` WxH (1k/2k), quality low/medium/high, n ≤ 4 |
| OpenAI | ChatGPT sign-in → Codex backend `POST {codex}/images/generations` (ima2-gen, 비공식) | `gpt-image-2` | 1:1·3:2·2:3 at 1k, quality, n ≤ 4; plan-billed |
| xAI | API key or xAI sign-in (실험적) → `POST /v1/images/generations` | `grok-imagine-image-2.0` (기본), `grok-imagine-image` (저가) | `aspect_ratio`, `resolution` 1k/2k, `quality` low/medium (2.0), `response_format=b64_json`, n ≤ 4 |
| Google | API key → Interactions `POST /v1beta/interactions` (fallback on 404: `models/{m}:generateContent`) | `gemini-nano-banana-2.1` (기본), `gemini-3-pro-image` (고품질), `gemini-3.1-flash-lite-image` (저가, 1K) | `aspect_ratio`, `image_size` 1K/2K/4K; one call per image (loop) |
| Claude | — | none (no image-generation API) | listed as unavailable |

Not built: Imagen (shut down), xAI/OpenAI edits with reference images, OpenAI Responses `image_generation` tool, prompt planner.
Negative prompt / style notes have no native parameter anywhere: they are appended to the prompt (`composePrompt`).

## Flow
`POST /api/images/generations` → validate (catalog, lane, params) → credential (`llm.resolveCredential`) → novel scope check
→ (novel-scoped, not plan lane) `budget.checkDirectSpend(category image, estimate, pendingMicros = other open requests)`
→ insert `queued` + audit `image.requested` → in-process runner (concurrency 2, timeout 300 s)
→ `running` → adapter call (no replay except 401 refresh) → files `images/<novelId|install>/<id>/<ord>.<ext>`
→ `succeeded` + `image_assets` + cost (measured: xAI ticks / OpenAI usage tokens; else estimated; ChatGPT lane `plan`)
→ novel-scoped: `budget.recordDirectCost` (`cost_events` row, key `img:<id>`, no run) + `image.completed`.
Failure → `failed` (`error_family`, Korean `error_message`, `image.failed`). Cancel aborts the call → `cancelled`.
Cancel answers with the final status (waits for a running call to settle). Server shutdown (`stop()`) aborts running
calls with reason `shutdown` → `failed` with the "서버가 다시 시작되어 … 청구되었을 수 있습니다" message (never "취소").
Delete removes rows + files (`image.deleted`). Boot: interrupted `running` → `failed` (cost may have been billed), `queued` → requeued.
Files are served with `sendStoredFile` (`http/kit.ts`, `dotfiles: "allow"` — the default home `~/.ncs` is a dot directory).

## HTTP (`adapters/http/routes.ts`, DTO `packages/shared/src/dto/imaging.ts`)
- `GET /api/images/providers` → `{items: ImageProviderDto[]}` (models for the active method, sizes, n limit, connected, reason)
- `POST /api/images/generations` `{novelId?, provider, modelId, prompt, negativePrompt?, styleNotes?, aspectRatio, resolution, quality?, count}` → 202
- `GET /api/images/generations?novelId&scope=install|novel|all&status&limit&before` → `{items, nextCursor}`
- `GET /api/images/generations/:id` (poll) · `POST …/:id/cancel` · `DELETE …/:id` → 204
- `GET /api/images/assets/:assetId/file[?download=1]`

## Gaps
- No live call was made against real OpenAI / xAI / Google accounts (mock servers only). Gemini Interactions response
  shape (`output_image` / `steps[].content[]`) follows the docs' SDK accessors; the generateContent fallback covers a 404.
- Failed / timed-out calls (`billed: unknown`) write no ledger row.
- The runner is in-process (no orchestration task); a restart fails the running request instead of resuming it.
