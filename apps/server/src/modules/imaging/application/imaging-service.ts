/**
 * Imaging application service: capabilities, request admission, in-process background runner, cancel / delete,
 * boot recovery. Files via platform.storage; credentials via llm.resolveCredential; budget via the direct-spend API.
 *
 * Runner: a FIFO of generation ids, `concurrency` at a time. Each job: CAS queued → running, resolve the credential
 * again (a refresh / re-login may have happened), call the adapter (no replay except the adapter's 401 refresh),
 * store files, then CAS running → succeeded (assets + cost + ledger in one transaction). If the row was deleted
 * meanwhile, the stored files are removed. A cancel aborts the call (→ cancelled).
 */
import {
  createImageGenerationRequestSchema,
  imageGenerationListQuerySchema,
  type CreateImageGenerationRequest,
  type ImageCostBasis,
  type ImageGenerationListQuery,
  type ImageProviderDto,
  type ImageResolution,
  type LlmProviderId,
} from "@ncs/shared";
import { ConflictError, DomainValidationError, InvalidTransitionError, NotFoundError, actors, type ActorRef, type NovelScope, type Platform, type Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BudgetService } from "../../budget/index.js";
import type { LlmService, ProviderProfile } from "../../llm/index.js";
import type { NovelService } from "../../novel/index.js";
import type { ImageAdapter, ImageGeneration, ImageGenerationWithAssets, ImagingService, ImageResult } from "../index.js";
import { IMAGE_CATALOG, composePrompt, estimateMicros, extOf, findModel, modelsForLane, openAiMeasuredMicros, validateParams, type ImageModelSpec } from "../domain/catalog.js";
import { sniffImage } from "../domain/image-meta.js";
import { IMAGE_TRANSITIONS } from "../domain/transitions.js";
import { imagingRepo as repo } from "../adapters/db/repository.js";

export interface ImagingServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  llm: LlmService;
  adapters?: ImageAdapter[];
  /** parallel provider calls (default 2) */
  concurrency?: number;
  /** per-call timeout (default 300 s — Grok Imagine measured 43–97 s per image) */
  timeoutMs?: number;
}

const PROVIDERS: LlmProviderId[] = ["anthropic", "openai", "xai", "google"];
const RUNNER = actors.system("orchestrator");
/** abort reason for jobs interrupted by `stop()` (server shutdown), distinct from a user cancel */
const SHUTDOWN = "shutdown";
const INTERRUPTED_MESSAGE = "서버가 다시 시작되어 생성이 중단되었습니다. 공급자에서 비용이 청구되었을 수 있습니다.";

export function createImagingService(deps: ImagingServiceDeps): ImagingService {
  const { platform, audit, budget, llm } = deps;
  const { uow, clock, ids, storage, log } = platform;
  const adapters = new Map<string, ImageAdapter>();
  for (const a of deps.adapters ?? []) adapters.set(a.provider, a);
  const concurrency = deps.concurrency ?? 2;
  const timeoutMs = deps.timeoutMs ?? 300_000;

  const queue: string[] = [];
  const running = new Map<string, AbortController>();
  /** id → settles when that job's runJob has finished (cancel waits on it to answer the final status) */
  const jobDone = new Map<string, Promise<void>>();
  const cancelRequested = new Set<string>();
  let active = 0;
  let stopped = false;
  let idleWaiters: Array<() => void> = [];
  const profiles = new Map<string, ProviderProfile>();

  const notifyIdle = () => {
    if (active === 0 && queue.length === 0) {
      const w = idleWaiters;
      idleWaiters = [];
      for (const f of w) f();
    }
  };

  async function profileOf(provider: LlmProviderId): Promise<ProviderProfile> {
    const hit = profiles.get(provider);
    if (hit) return hit;
    const spec = IMAGE_CATALOG[provider];
    const p = await llm.ensureImageProviderProfile(
      provider,
      spec.models.map((m) => ({ id: m.id, label: m.label, pricePerImageMicros: m.pricePerImageMicros })),
      spec.priceSourceUrl,
    );
    profiles.set(provider, p);
    return p;
  }

  /** per-image price override stored in the profile (the user may have edited it) */
  function priceOverride(profile: ProviderProfile | undefined, modelId: string): Partial<Record<ImageResolution, number | null>> | undefined {
    const models = Array.isArray(profile?.models) ? (profile!.models as Array<{ id?: unknown; pricePerImageMicros?: unknown }>) : [];
    const m = models.find((x) => x.id === modelId);
    const p = m?.pricePerImageMicros;
    return p && typeof p === "object" ? (p as Partial<Record<ImageResolution, number | null>>) : undefined;
  }

  const toDtoModel = (provider: LlmProviderId, m: ImageModelSpec, profile?: ProviderProfile) => {
    const override = priceOverride(profile, m.id);
    return {
      id: m.id,
      label: m.label,
      tier: m.tier,
      note: m.note,
      aspectRatios: m.aspectRatios,
      resolutions: m.resolutions,
      qualities: m.qualities,
      maxImages: m.maxImages,
      estimatedMicrosPerImage: Object.fromEntries(m.resolutions.map((r) => [r, estimateMicros(provider, m, { aspectRatio: "1:1", resolution: r, n: 1 }, override)])),
    };
  };

  async function withAssets(rows: ImageGeneration[]): Promise<ImageGenerationWithAssets[]> {
    const assets = await repo.assetsOf(uow.db, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, assets: assets.filter((a) => a.generationId === r.id) }));
  }

  async function mustGet(id: string): Promise<ImageGeneration> {
    const g = await repo.getGeneration(uow.db, id);
    if (!g) throw new NotFoundError("이미지 생성 기록", id);
    return g;
  }

  const target = (id: string) => ({ type: "media_asset" as const, id });

  // ── runner ──
  function schedule(id: string) {
    if (stopped || queue.includes(id) || running.has(id)) return;
    queue.push(id);
    pump();
  }

  function pump() {
    while (!stopped && active < concurrency && queue.length) {
      const id = queue.shift()!;
      active++;
      const done = runJob(id)
        .catch((err: unknown) => log.error({ err, generationId: id }, "image generation job crashed"))
        .finally(() => {
          active--;
          running.delete(id);
          jobDone.delete(id);
          cancelRequested.delete(id);
          pump();
          notifyIdle();
        });
      jobDone.set(id, done);
    }
    notifyIdle();
  }

  async function finishFailed(g: ImageGeneration, family: string, message: string, status: "failed" | "cancelled" = "failed") {
    const t = status === "cancelled" ? IMAGE_TRANSITIONS.cancel : IMAGE_TRANSITIONS.fail;
    await uow.run(async (tx) => {
      const u = await repo.transition(tx.db, g.id, t.from, {
        status: t.to,
        errorFamily: status === "cancelled" ? null : family,
        errorMessage: message,
        completedAt: clock.date(),
        updatedAt: clock.date(),
      });
      if (!u) return;
      await audit.record(tx, {
        novelId: g.novelId,
        actor: RUNNER,
        action: "image.failed",
        target: target(g.id),
        details: { provider: g.provider, modelId: g.modelId, status: t.to, errorFamily: status === "cancelled" ? null : family },
      });
    });
  }

  async function runJob(id: string) {
    const ac = new AbortController();
    running.set(id, ac);
    const started = await repo.transition(uow.db, id, IMAGE_TRANSITIONS.start.from, { status: "running", startedAt: clock.date(), updatedAt: clock.date() });
    if (!started) return; // cancelled / deleted while queued
    const g = started;
    if (cancelRequested.has(id)) return finishFailed(g, "internal", "생성이 취소되었습니다.", "cancelled");
    const provider = g.provider as LlmProviderId;
    const adapter = adapters.get(provider);
    if (!adapter) return finishFailed(g, "internal", "이 공급자의 이미지 어댑터가 없습니다.");
    const credential = await llm.resolveCredential(provider).catch(() => null);
    if (!credential) return finishFailed(g, "auth_failed", "공급자 연결이 해제되어 이미지를 만들 수 없습니다. 설정 → AI 계정 연결을 확인하세요.");
    const params = g.params as { finalPrompt?: string; aspectRatio: string; resolution: ImageResolution; quality?: "low" | "medium" | "high" };

    let result: ImageResult;
    try {
      result = await adapter.generate(
        { modelId: g.modelId, prompt: params.finalPrompt ?? g.prompt, n: g.imageCount, aspectRatio: params.aspectRatio, resolution: params.resolution, quality: params.quality },
        { credential, signal: ac.signal, timeoutMs },
      );
    } catch (err) {
      result = { ok: false, errorFamily: "internal", message: "이미지 생성 중 오류가 났습니다.", billed: "unknown" };
      log.error({ err, generationId: id }, "image adapter threw");
    }
    if (ac.signal.aborted && cancelRequested.has(id)) return finishFailed(g, "internal", "생성이 취소되었습니다.", "cancelled");
    // aborted by a server shutdown (not by the user): the request may already have reached the provider and been billed
    if (!result.ok && ac.signal.aborted && ac.signal.reason === SHUTDOWN) return finishFailed(g, "timeout", INTERRUPTED_MESSAGE);
    if (!result.ok) return finishFailed(g, result.errorFamily, result.message);

    // store files first (outside the transaction), then commit rows
    const folder = `images/${g.novelId ?? "install"}/${g.id}`;
    const stored: Array<{ key: string; size: number; sha256: string; mime: string; width: number | null; height: number | null; revisedPrompt: string | null; ord: number }> = [];
    try {
      for (const [ord, img] of result.images.entries()) {
        const meta = sniffImage(img.data);
        const mime = meta?.mimeType ?? img.mimeType;
        const key = `${folder}/${ord}.${extOf(mime)}`;
        const o = await storage.put(key, img.data, { overwrite: true });
        stored.push({ key, size: o.size, sha256: o.sha256, mime, width: meta?.width ?? null, height: meta?.height ?? null, revisedPrompt: img.revisedPrompt ?? null, ord });
      }
    } catch (err) {
      log.error({ err, generationId: id }, "image file write failed");
      await storage.delete(folder).catch(() => {});
      return finishFailed(g, "internal", "이미지 파일을 저장하지 못했습니다. 저장 공간을 확인하세요.");
    }

    const plan = credential.method === "chatgpt_oauth";
    let costMicros: number | null;
    let basis: ImageCostBasis;
    if (plan) {
      costMicros = null;
      basis = "plan";
    } else if (result.reportedCostMicros !== undefined) {
      costMicros = result.reportedCostMicros;
      basis = "measured";
    } else if (provider === "openai" && result.usage && openAiMeasuredMicros(g.modelId, result.usage) !== null) {
      costMicros = openAiMeasuredMicros(g.modelId, result.usage);
      basis = "measured";
    } else {
      const model = findModel(provider, g.modelId);
      const profile = profiles.get(provider);
      costMicros = model ? estimateMicros(provider, model, { ...params, n: result.images.length }, priceOverride(profile, g.modelId)) : g.estimatedMicros;
      basis = "estimated";
    }
    const revised = result.images.find((i) => i.revisedPrompt)?.revisedPrompt ?? null;

    const committed = await uow.run(async (tx) => {
      const u = await repo.transition(tx.db, g.id, IMAGE_TRANSITIONS.succeed.from, {
        status: "succeeded",
        costMicros,
        costBasis: basis,
        revisedPrompt: revised,
        imageCount: result.images.length,
        errorMessage: result.partialFailure ?? null,
        completedAt: clock.date(),
        updatedAt: clock.date(),
      });
      if (!u) return false;
      await repo.insertAssets(
        tx.db,
        stored.map((s) => ({
          id: ids.next("ast"),
          generationId: g.id,
          novelId: g.novelId,
          ord: s.ord,
          storageKey: s.key,
          mimeType: s.mime,
          byteSize: s.size,
          sha256: s.sha256,
          width: s.width,
          height: s.height,
          revisedPrompt: s.revisedPrompt,
          createdAt: clock.date(),
        })),
      );
      let costEventId: string | null = null;
      if (g.novelId && !plan && costMicros !== null && g.providerProfileId) {
        const profile = profiles.get(provider) ?? (await profileOf(provider));
        const e = await budget.recordDirectCost(tx, { novelId: g.novelId }, {
          idempotencyKey: `img:${g.id}`,
          category: "image",
          provider,
          modelId: g.modelId,
          providerProfileId: g.providerProfileId,
          providerProfileVersion: profile.versionNo,
          basis: basis === "measured" ? "measured" : "estimated",
          amountMicros: costMicros,
          reservedMicros: g.estimatedMicros ?? 0,
          units: { images: result.images.length },
        });
        costEventId = e.costEventId;
        await repo.transition(tx.db, g.id, ["succeeded"], { costEventId });
      }
      await audit.record(tx, {
        novelId: g.novelId,
        actor: RUNNER,
        action: "image.completed",
        target: target(g.id),
        details: { provider, modelId: g.modelId, images: result.images.length, costMicros, costBasis: basis, costEventId },
      });
      return true;
    });
    if (!committed) {
      // deleted or cancelled while the call was in flight
      await storage.delete(folder).catch(() => {});
      const now = await repo.getGeneration(uow.db, g.id);
      if (now && now.status === "running") await finishFailed(g, "internal", "생성이 취소되었습니다.", "cancelled");
    }
  }

  const service: ImagingService = {
    registerAdapter(a) {
      adapters.set(a.provider, a);
    },

    async listProviders(): Promise<ImageProviderDto[]> {
      const statuses = await llm.providers.list();
      const out: ImageProviderDto[] = [];
      for (const provider of PROVIDERS) {
        const spec = IMAGE_CATALOG[provider];
        const st = statuses.find((s) => s.provider === provider)!;
        if (!spec.available) {
          out.push({
            provider,
            label: st.label,
            available: false,
            connected: st.connected,
            activeMethod: st.activeMethod,
            unavailableReason: spec.unavailableReason,
            models: [],
            defaultModelId: null,
            notes: [],
            termsNote: st.termsNote,
          });
          continue;
        }
        const profile = await profileOf(provider).catch(() => undefined);
        const lane = st.activeMethod;
        const models = modelsForLane(provider, lane);
        let reason: string | null = null;
        if (!st.connected) reason = "연결되지 않았습니다. 설정 → AI 계정 연결에서 먼저 연결하세요.";
        else if (st.health === "reauth_required") reason = "로그인이 만료되었습니다. 설정 → AI 계정 연결에서 다시 로그인하세요.";
        else if (!models.length) reason = "현재 연결 방식으로는 이미지를 만들 수 없습니다. API 키로 연결하세요.";
        else if (!adapters.has(provider)) reason = "이 공급자의 이미지 어댑터가 없습니다.";
        const laneNote = lane ? spec.laneNotes[lane] : spec.laneNotes.api_key;
        out.push({
          provider,
          label: st.label,
          available: true,
          connected: st.connected,
          activeMethod: lane,
          unavailableReason: reason,
          models: models.map((m) => toDtoModel(provider, m, profile)),
          defaultModelId: models.find((m) => m.tier === "default")?.id ?? models[0]?.id ?? null,
          notes: [...(laneNote ? [laneNote] : []), ...spec.notes],
          termsNote: st.termsNote,
        });
      }
      return out;
    },

    async createGeneration(raw: CreateImageGenerationRequest, actor: ActorRef) {
      const input = createImageGenerationRequestSchema.parse(raw);
      const provider = input.provider;
      const spec = IMAGE_CATALOG[provider];
      if (!spec.available) throw new DomainValidationError("image_unsupported", spec.unavailableReason ?? "이 공급자는 이미지를 만들 수 없습니다.");
      const adapter = adapters.get(provider);
      if (!adapter) throw new DomainValidationError("image_unsupported", "이 공급자의 이미지 어댑터가 없습니다.");
      const model = findModel(provider, input.modelId);
      if (!model) throw new DomainValidationError("image_model_unknown", `알 수 없는 이미지 모델입니다: ${input.modelId}`);
      const credential = await llm.resolveCredential(provider);
      if (!credential) throw new DomainValidationError("provider_not_connected", `${(await llm.providers.status(provider)).label} 공급자가 연결되지 않았습니다. 설정 → AI 계정 연결에서 먼저 연결하세요.`);
      if (!model.lanes.includes(credential.method)) {
        throw new DomainValidationError(
          "image_model_lane",
          credential.method === "chatgpt_oauth"
            ? `ChatGPT 로그인으로는 ${model.label}을(를) 쓸 수 없습니다. GPT Image 2 (ChatGPT)를 고르거나 API 키로 연결하세요.`
            : `${model.label}은(는) 현재 연결 방식으로 쓸 수 없습니다.`,
        );
      }
      const problem = validateParams(model, { aspectRatio: input.aspectRatio, resolution: input.resolution, quality: input.quality, count: input.count });
      if (problem) throw new DomainValidationError("image_params_invalid", problem);
      const quality = model.qualities.length ? (input.quality ?? (provider === "openai" ? "medium" : undefined)) : undefined;
      const scope: NovelScope | null = input.novelId ? { novelId: input.novelId } : null;
      if (scope) await deps.novel.getNovel(scope);
      const profile = await profileOf(provider);
      const plan = credential.method === "chatgpt_oauth";
      const estimate = estimateMicros(provider, model, { aspectRatio: input.aspectRatio, resolution: input.resolution, quality, n: input.count }, priceOverride(profile, model.id));
      const id = ids.next("img");
      const finalPrompt = composePrompt(input.prompt, input.styleNotes, input.negativePrompt);

      const row = await uow.run(async (tx: Tx) => {
        if (scope && !plan) {
          if (estimate === null) throw new ConflictError("budget_unpriced", "이 모델은 단가가 없어 작품 예산 안에서 생성할 수 없습니다.");
          const pending = await repo.pendingEstimate(tx.db, scope.novelId);
          const d = await budget.checkDirectSpend(tx, scope, { category: "image", amountMicros: estimate, pendingMicros: pending });
          if (!d.ok) {
            throw new ConflictError(
              "budget_blocked",
              d.reason === "hard_limit"
                ? "작품 예산 한도에 닿아 이미지를 만들 수 없습니다. 설정 → 예산에서 한도를 확인하세요."
                : "진행 중인 작업의 예약 금액 때문에 지금은 예산이 부족합니다. 잠시 후 다시 시도하세요.",
              { policyId: d.policyId, reason: d.reason },
            );
          }
        }
        const g = await repo.insertGeneration(tx.db, {
          id,
          novelId: scope?.novelId ?? null,
          provider,
          modelId: model.id,
          credentialMethod: credential.method,
          prompt: input.prompt,
          params: {
            aspectRatio: input.aspectRatio,
            resolution: input.resolution,
            ...(quality ? { quality } : {}),
            ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
            ...(input.styleNotes ? { styleNotes: input.styleNotes } : {}),
            finalPrompt,
          },
          imageCount: input.count,
          status: "queued",
          estimatedMicros: estimate,
          costBasis: plan ? "plan" : null,
          providerProfileId: profile.id,
          requestedByActorType: actor.type,
          requestedByActorId: actor.id,
          createdAt: clock.date(),
          updatedAt: clock.date(),
        });
        await audit.record(tx, {
          novelId: g.novelId,
          actor,
          action: "image.requested",
          target: target(g.id),
          details: { provider, modelId: model.id, count: input.count, aspectRatio: input.aspectRatio, resolution: input.resolution, estimatedMicros: estimate, method: credential.method },
        });
        return g;
      });
      schedule(row.id);
      return { ...row, assets: [] };
    },

    async listGenerations(raw: ImageGenerationListQuery) {
      const q = imageGenerationListQuerySchema.parse(raw);
      const scope = q.scope ?? (q.novelId ? "novel" : "install");
      if (scope === "novel" && !q.novelId) throw new DomainValidationError("novel_required", "작품을 지정하세요.");
      const before = q.before ? await repo.getGeneration(uow.db, q.before) : null;
      const rows = await repo.list(uow.db, { novelId: q.novelId, scope, status: q.status, limit: q.limit + 1, before });
      const page = rows.slice(0, q.limit);
      return { items: await withAssets(page), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
    },

    async getGeneration(id) {
      return (await withAssets([await mustGet(id)]))[0]!;
    },

    async cancelGeneration(id, actor) {
      const g = await mustGet(id);
      if (!(IMAGE_TRANSITIONS.cancel.from as readonly string[]).includes(g.status)) throw new InvalidTransitionError("이미지 생성", g.status, "cancelled");
      cancelRequested.add(id);
      const ac = running.get(id);
      if (ac) {
        ac.abort();
        // answer with the final status (cancelled — or succeeded/failed if the provider answered first)
        await jobDone.get(id);
      } else {
        await uow.run(async (tx) => {
          const u = await repo.transition(tx.db, id, ["queued"], { status: "cancelled", errorMessage: "생성이 취소되었습니다.", completedAt: clock.date(), updatedAt: clock.date() });
          if (u) await audit.record(tx, { novelId: g.novelId, actor, action: "image.failed", target: target(id), details: { status: "cancelled" } });
        });
        const i = queue.indexOf(id);
        if (i >= 0) queue.splice(i, 1);
        cancelRequested.delete(id);
        notifyIdle();
      }
      return service.getGeneration(id);
    },

    async deleteGeneration(id, actor) {
      const g = await mustGet(id);
      cancelRequested.add(id);
      running.get(id)?.abort();
      const i = queue.indexOf(id);
      if (i >= 0) queue.splice(i, 1);
      const assets = await repo.assetsOf(uow.db, [id]);
      await uow.run(async (tx) => {
        await repo.deleteGeneration(tx.db, id);
        await audit.record(tx, {
          novelId: g.novelId,
          actor,
          action: "image.deleted",
          target: target(id),
          details: { provider: g.provider, modelId: g.modelId, status: g.status, assets: assets.length },
        });
      });
      await storage.delete(`images/${g.novelId ?? "install"}/${id}`).catch((err: unknown) => log.warn({ err, generationId: id }, "image files not removed"));
      notifyIdle();
    },

    async openAsset(assetId) {
      const a = await repo.getAsset(uow.db, assetId);
      if (!a) throw new NotFoundError("이미지", assetId);
      if (!(await storage.exists(a.storageKey))) throw new NotFoundError("이미지 파일", assetId);
      return { path: storage.pathOf(a.storageKey), mimeType: a.mimeType, fileName: `${a.generationId}-${a.ord + 1}.${extOf(a.mimeType)}` };
    },

    whenIdle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>((r) => idleWaiters.push(r));
    },

    async recover() {
      let failed = 0;
      for (const g of await repo.openIds(uow.db, "running")) {
        if (running.has(g.id)) continue;
        await finishFailed(g, "timeout", INTERRUPTED_MESSAGE);
        failed++;
      }
      let requeued = 0;
      for (const g of await repo.openIds(uow.db, "queued")) {
        schedule(g.id);
        requeued++;
      }
      return { failed, requeued };
    },

    async stop() {
      stopped = true;
      queue.length = 0;
      for (const ac of running.values()) ac.abort(SHUTDOWN);
      if (active > 0) await new Promise<void>((r) => idleWaiters.push(r));
    },
  };
  return service;
}
