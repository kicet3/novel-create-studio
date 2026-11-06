/**
 * LlmGateway = ModelCallPort implementation (04 §6.2–6.3, §7, §8, §10).
 *
 * call(): binding → (RU-2 reuse) → checkpoint → [tx] reserve + ProviderCall P1 + attach
 *   → checkpoint (stop ⇒ P6 abandoned + release) → [tx] P2 sent → adapter.invoke (outside tx)
 *   → [tx] P3 responded + settle | P4 failed + release/settle | P5 unknown + closeUnknown
 *   → zod validation → repair retry (RU-4) / transient retry (backoff) / content-filter retry.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULTS, type AgentRole, type ErrorFamily } from "@ncs/shared";
import { NotImplementedError, type NovelScope, type Platform } from "../../../platform/index.js";
import type { BudgetService } from "../../budget/index.js";
import { RunStop, type RunHandle } from "../../orchestration/index.js";
import {
  ModelCallError,
  type LlmAdapter,
  type LlmCredential,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  type ModelCallInput,
  type ModelCallOutput,
  type ModelCallPort,
  type ProviderCall,
  type ProviderProfile,
  type RoleModelBinding,
} from "../index.js";
import { estimateTokens, findModel, inputTokensUpper, maxCallCostMicros, usageCostMicros } from "../domain/pricing.js";
import { isCallLevelRetryable } from "../domain/errors.js";
import { providerCallTransition } from "../domain/provider-call.js";
import { callProviderLabel } from "../domain/providers.js";
import { llmRepo as repo } from "../adapters/db/repository.js";

export interface GatewayDeps {
  platform: Platform;
  budget: BudgetService;
  getBinding(scope: NovelScope, role: AgentRole): Promise<RoleModelBinding>;
  getProfile(id: string): Promise<ProviderProfile>;
  getAdapter(provider: string): LlmAdapter | undefined;
  /** credential of the provider's active connection method (API key or OAuth bearer with refresh) */
  resolveCredential?(provider: string): Promise<LlmCredential | null>;
  /** legacy/test seam: plain API key per provider (used when resolveCredential is absent) */
  resolveApiKey?(provider: string): Promise<string | null>;
  /** injectable for tests */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** backoff seconds (default llm.retry_backoff_seconds) */
  backoffSeconds?: readonly number[];
}

const SAFETY_REINFORCEMENT =
  "\n\n[안전 지시 강화] 직전 응답이 안전 필터에 걸렸습니다. 작품 연령 등급을 넘는 묘사(성적·폭력적 세부)를 피하고, 필요하면 암시와 생략으로 처리하세요.";

const jsonSchemaCache = new WeakMap<object, Record<string, unknown>>();

/** zod → JSON Schema (draft-7, input side; unrepresentable parts become `{}`) */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const hit = jsonSchemaCache.get(schema);
  if (hit) return hit;
  const js = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  jsonSchemaCache.set(schema, js);
  return js;
}

function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** RU-1: hash of the normalized request (no secrets, no run id / time). */
export function requestHash(provider: string, req: LlmRequest, sampleIndex: number): string {
  const output = req.output.kind === "object" ? { kind: "object", schemaName: req.output.schemaName, schemaHash: sha256(canonical(req.output.jsonSchema)) } : { kind: "text" };
  return sha256(
    canonical({
      provider,
      model_id: req.modelId,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output,
      max_output_tokens: req.maxOutputTokens,
      temperature: req.temperature ?? null,
      seed: req.seed ?? null,
      sample_index: sampleIndex,
    }),
  );
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

/** FIFO counting semaphore; `acquire` resolves false when `signal` aborts while waiting */
export function createSlotLimiter(max: number) {
  let busy = 0;
  const waiting: Array<() => void> = [];
  return {
    get busy() {
      return busy;
    },
    get waiting() {
      return waiting.length;
    },
    acquire(signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (busy < max) {
        busy++;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const grant = () => {
          signal.removeEventListener("abort", onAbort);
          busy++;
          resolve(true);
        };
        const onAbort = () => {
          const i = waiting.indexOf(grant);
          if (i >= 0) waiting.splice(i, 1);
          resolve(false);
        };
        waiting.push(grant);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    release(): void {
      busy = Math.max(0, busy - 1);
      const next = waiting.shift();
      if (next) next();
    },
  };
}
type SlotLimiter = ReturnType<typeof createSlotLimiter>;

interface Attempt {
  ok: true;
  call: ProviderCall | null;
  result: Extract<LlmResult, { ok: true }>;
  costMicros: number;
  reused: boolean;
}

/** cost_events.is_rerun = cost of a rerun after reclaim (03 cost_events, FR-AGT-02 (4)), not an ordinary retry */
function isRerunOf(run: RunHandle): boolean {
  return run.rerunOfRunId != null || (run.runChain?.length ?? 0) > 0;
}

export function createLlmGateway(deps: GatewayDeps): ModelCallPort & { readonly budgetUnavailable: boolean } {
  const { platform } = deps;
  const { uow, clock, ids, log, config } = platform;
  const sleep = deps.sleep ?? defaultSleep;
  const backoff = deps.backoffSeconds ?? DEFAULTS["llm.retry_backoff_seconds"];
  const maxRetries = DEFAULTS["llm.max_retries_per_call"];
  const rateLimitMaxWaitMs = DEFAULTS["llm.rate_limit_max_wait_seconds"] * 1000;
  const margin = DEFAULTS["budget.input_token_margin_ratio"];
  let budgetUnavailable = false;
  // per-provider concurrency (adapter.limits.maxConcurrent, e.g. claude_code: local `claude -p` processes)
  const limiters = new Map<string, SlotLimiter>();
  const limiterOf = (adapter: LlmAdapter): SlotLimiter | null => {
    const max = adapter.limits?.maxConcurrent;
    if (!max) return null;
    let l = limiters.get(adapter.provider);
    if (!l) limiters.set(adapter.provider, (l = createSlotLimiter(max)));
    return l;
  };
  /** list-price cost a subscription adapter reports is an estimate only: the ledger records the profile price (0) */
  const ledgerReported = (adapter: LlmAdapter, modelId: string, usage: LlmUsage | undefined) =>
    adapter.capabilities(modelId).billing === "subscription" ? undefined : usage?.reportedCostMicros;
  const resolveCredential = async (provider: string): Promise<LlmCredential | null> => {
    if (deps.resolveCredential) return deps.resolveCredential(provider);
    const key = await deps.resolveApiKey?.(provider);
    return key ? { method: "api_key", token: key } : null;
  };

  /** One provider round trip with journaling. Throws ModelCallError on budget/journal problems; returns adapter failures as results. */
  async function attemptOnce(
    run: RunHandle,
    scope: NovelScope,
    profile: ProviderProfile,
    adapter: LlmAdapter,
    req: LlmRequest,
    hash: string,
    retryOf: string | null,
  ): Promise<Attempt | { ok: false; call: ProviderCall | null; result: Extract<LlmResult, { ok: false }> }> {
    const model = findModel(profile.models, req.modelId);
    const inputEstimate = estimateTokens(req.system + "\n" + req.messages.map((m) => m.content).join("\n"));
    let inputUpper = inputTokensUpper(inputEstimate, margin);
    let credential: LlmCredential | undefined;
    try {
      credential = (await resolveCredential(adapter.provider)) ?? undefined;
    } catch (err) {
      // CFG-8: stored key cannot be decrypted → auth failure with the real reason (not "키 없음")
      return { ok: false, call: null, result: { ok: false, errorFamily: "auth_failed", message: (err as Error).message, billed: "no" } };
    }
    const apiKey = credential?.token ?? "";
    if (adapter.countInputTokens && apiKey) {
      inputUpper = await adapter.countInputTokens(req, { apiKey, credential, signal: run.signal }).catch(() => inputUpper);
    }
    const maxCost = maxCallCostMicros(model, inputUpper, req.maxOutputTokens);
    const callMeta = { provider: adapter.provider, modelId: req.modelId, providerProfileId: profile.id, providerProfileVersion: profile.versionNo, isRerun: isRerunOf(run) };
    const timeoutMs = adapter.limits?.callTimeoutMs ?? config.llm.call_timeout_seconds * 1000;
    const limiter = limiterOf(adapter);

    if (!apiKey) {
      return { ok: false, call: null, result: { ok: false, errorFamily: "auth_failed", message: `${callProviderLabel(adapter.provider)} 연결이 없습니다. 설정 → AI 계정 연결에서 연결하세요.`, billed: "no" } };
    }

    await run.checkpoint();

    // ── budget-less mode (budget module still a placeholder): call without journaling ──
    if (budgetUnavailable) {
      if (limiter && !(await limiter.acquire(run.signal))) {
        await run.checkpoint();
        throw new RunStop("lease_lost", "호출이 중단되었습니다.");
      }
      let r: LlmResult;
      try {
        r = await adapter.invoke(req, { apiKey, credential, signal: run.signal, timeoutMs });
      } finally {
        limiter?.release();
      }
      if (!r.ok) return { ok: false, call: null, result: r };
      return { ok: true, call: null, result: r, costMicros: usageCostMicros(model, r.usage) ?? 0, reused: false };
    }

    // ── P1: reserve + prepared ──
    let prepared: ProviderCall;
    try {
      prepared = await uow.run(async (tx) => {
        const rsv = await deps.budget.reserve(tx, scope, { runId: run.runId, category: "text", maxCostMicros: maxCost });
        if (!rsv.ok) {
          throw new ModelCallError("budget_blocked", null, undefined, rsv.reason === "unpriced" ? "모델 단가가 등록되지 않아 호출할 수 없습니다." : "예산 한도 때문에 호출할 수 없습니다.");
        }
        const seq = await repo.nextSeq(tx.db, scope, run.runId);
        const id = ids.next("pcl");
        const call = await repo.insertCall(tx.db, {
          id,
          novelId: scope.novelId,
          runId: run.runId,
          seq,
          providerKind: "llm",
          provider: adapter.provider,
          modelId: req.modelId,
          idempotencyKey: `${run.taskId}:${run.runId}:${seq}`,
          requestHash: hash,
          maxOutputTokens: req.maxOutputTokens,
          maxCostMicros: maxCost ?? 0,
          reservationId: rsv.reservationId,
          status: "prepared",
          retryOfCallId: retryOf,
        });
        const att = await deps.budget.attachToCall(tx, scope, rsv.reservationId, id, callMeta);
        if (!att.attached) throw new ModelCallError("internal", id, undefined, "예산 예약이 만료되어 호출을 다시 준비합니다.");
        return call;
      });
    } catch (err) {
      if (err instanceof NotImplementedError) {
        if (!budgetUnavailable) log.warn("budget module not implemented — LLM calls run WITHOUT provider_calls journaling / reservations");
        budgetUnavailable = true;
        return attemptOnce(run, scope, profile, adapter, req, hash, retryOf);
      }
      throw err;
    }

    // ── wait for a provider slot (stays `prepared` while waiting), then P6 on stop before sending ──
    let slot = false;
    try {
      if (limiter) {
        slot = await limiter.acquire(run.signal);
        if (!slot) {
          await run.checkpoint();
          throw new RunStop("lease_lost", "호출이 중단되었습니다.");
        }
      }
      await run.checkpoint();
    } catch (stop) {
      if (slot) limiter?.release();
      await uow.run(async (tx) => {
        const t = providerCallTransition("P6");
        const c = await repo.casCall(tx.db, scope, prepared.id, t.from, { status: t.to }, clock.date());
        if (c) await deps.budget.release(tx, scope, prepared.reservationId);
      });
      throw stop;
    }

    // ── P2: sent (commit before the external call) ──
    let r: LlmResult;
    let sent: ProviderCall | null;
    try {
      sent = await uow.run(async (tx) => {
        const t = providerCallTransition("P2");
        return repo.casCall(tx.db, scope, prepared.id, t.from, { status: t.to, sentAt: clock.date() }, clock.date());
      });
      if (!sent) throw new ModelCallError("internal", prepared.id, undefined, "호출 기록 상태가 바뀌어 발송하지 않았습니다.");
      try {
        r = await adapter.invoke(req, { apiKey, credential, signal: run.signal, timeoutMs, idempotencyKey: sent.idempotencyKey });
      } catch (err) {
        r = { ok: false, errorFamily: run.signal.aborted ? "timeout" : "internal", message: (err as Error).message, billed: "unknown" };
      }
    } finally {
      if (slot) limiter?.release();
    }
    const now = clock.date();
    const isRerun = isRerunOf(run);

    if (r.ok) {
      const response = { text: r.text ?? null, object: r.object ?? null, finishReason: r.finishReason, modelVersion: r.modelVersion ?? null, providerRequestId: r.providerRequestId ?? null };
      const measured = usageCostMicros(model, r.usage);
      const amount = ledgerReported(adapter, req.modelId, r.usage) ?? measured ?? maxCost ?? 0;
      const basis = r.usage.reportedCostMicros !== undefined || adapter.capabilities(req.modelId).reportsUsage ? "measured" : "estimated";
      run.noteModelUsed?.({ provider: adapter.provider, modelId: req.modelId, modelVersion: r.modelVersion ?? null });
      const saved = await uow.run(async (tx) => {
        const t = providerCallTransition("P3");
        const c = await repo.casCall(tx.db, scope, sent.id, t.from, { status: t.to, response, usage: r.usage, respondedAt: now, modelVersion: r.modelVersion ?? null }, now);
        if (c) {
          await deps.budget.settle(tx, scope, {
            providerCallId: c.id,
            reservationId: c.reservationId,
            category: "text",
            basis,
            amountMicros: amount,
            usage: r.usage,
            provider: adapter.provider,
            modelId: req.modelId,
            providerProfileId: profile.id,
            providerProfileVersion: profile.versionNo,
            isRerun,
          });
          return c;
        }
        // P7: the call was closed as `unknown` (reclaim) while we waited — keep the response, ledger correction is budget's (INV-COST-04)
        const t7 = providerCallTransition("P7");
        const late = await repo.casCall(tx.db, scope, sent.id, t7.from, { status: t7.to, response, usage: r.usage, respondedAt: now, modelVersion: r.modelVersion ?? null }, now);
        if (late) {
          // INV-COST-04: the unknown row stays; budget writes a correction row `pcl:<id>:late`
          await deps.budget.recordLateResponse(tx, scope, { providerCallId: late.id, amountMicros: amount, usage: r.usage, basis });
        }
        return late;
      });
      return { ok: true, call: saved, result: r, costMicros: saved ? amount : 0, reused: false };
    }

    // failures
    await uow.run(async (tx) => {
      if (r.errorFamily === "timeout" || r.billed === "unknown") {
        const t = providerCallTransition("P5");
        const c = await repo.casCall(tx.db, scope, sent.id, t.from, { status: t.to, errorFamily: r.errorFamily, usage: r.usage ?? null }, now);
        if (c) await deps.budget.closeUnknown(tx, scope, c.id, c.reservationId, callMeta);
        return;
      }
      const t = providerCallTransition("P4");
      const c = await repo.casCall(tx.db, scope, sent.id, t.from, { status: t.to, errorFamily: r.errorFamily, usage: r.usage ?? null, respondedAt: now }, now);
      if (!c) return;
      if (r.billed === "yes" && r.usage) {
        await deps.budget.settle(tx, scope, {
          providerCallId: c.id,
          reservationId: c.reservationId,
          category: "text",
          basis: "measured",
          amountMicros: ledgerReported(adapter, req.modelId, r.usage) ?? usageCostMicros(model, r.usage) ?? 0,
          usage: r.usage,
          provider: adapter.provider,
          modelId: req.modelId,
          providerProfileId: profile.id,
          providerProfileVersion: profile.versionNo,
          isRerun,
        });
      } else {
        await deps.budget.release(tx, scope, c.reservationId);
      }
    });
    return { ok: false, call: sent, result: r };
  }

  async function call<T>(input: ModelCallInput<T>): Promise<ModelCallOutput<T>> {
    const { run } = input;
    const scope: NovelScope = { novelId: run.novelId };
    const binding = await deps.getBinding(scope, run.role);
    const profile = await deps.getProfile(binding.providerProfileId);
    const adapter = deps.getAdapter(profile.provider);
    if (!adapter) throw new ModelCallError("provider_unavailable", null, undefined, `LLM 어댑터가 없습니다: ${profile.provider}`);
    const maxOutputTokens = Math.min(input.maxOutputTokens ?? binding.maxOutputTokens, binding.maxOutputTokens);
    const output: LlmRequest["output"] =
      input.output.kind === "object" ? { kind: "object", schemaName: input.output.schemaName, jsonSchema: toJsonSchema(input.output.schema) } : { kind: "text" };
    const sampleIndex = input.sampleIndex ?? 0;

    let system = input.system;
    let messages: LlmMessage[] = input.messages;
    let repairAttempt = 0;
    let transientRetries = 0;
    let rateLimitWaitedMs = 0;
    let contentFilterRetried = false;
    let lastCallId: string | null = null;

    for (;;) {
      const req: LlmRequest = {
        modelId: binding.modelId,
        system,
        messages,
        output,
        maxOutputTokens,
        temperature: input.temperature,
        meta: { purpose: input.purpose, role: run.role, sampleIndex, repairAttempt },
      };
      const hash = requestHash(adapter.provider, req, sampleIndex);

      // RU-2: reuse a stored response of the same task with the same request
      let attempt: Awaited<ReturnType<typeof attemptOnce>> | null = null;
      if (!budgetUnavailable) {
        const prev = await repo.findReusable(uow.db, scope, run.taskId, hash, run.runChain ?? (run.rerunOfRunId ? [run.rerunOfRunId] : []), run.runId);
        if (prev && prev.response) {
          const resp = prev.response as { text?: string | null; object?: unknown; finishReason?: string; modelVersion?: string | null };
          attempt = {
            ok: true,
            call: prev,
            reused: true,
            costMicros: 0,
            result: {
              ok: true,
              text: resp.text ?? undefined,
              object: resp.object ?? undefined,
              finishReason: (resp.finishReason as "stop") ?? "stop",
              usage: (prev.usage as LlmUsage) ?? { inputTokens: 0, outputTokens: 0 },
              modelVersion: resp.modelVersion ?? undefined,
              raw: null,
            },
          };
        }
      }
      if (!attempt) {
        try {
          attempt = await attemptOnce(run, scope, profile, adapter, req, hash, lastCallId);
        } catch (err) {
          if (err instanceof RunStop || err instanceof ModelCallError) throw err;
          throw new ModelCallError("internal", lastCallId, undefined, `LLM 호출 기록 중 오류: ${(err as Error).message}`);
        }
      }
      lastCallId = attempt.call?.id ?? lastCallId;
      const callId = attempt.call?.id ?? "pcl_unrecorded";

      if (!attempt.ok && run.signal.aborted) {
        // the run was hard-stopped (shutdown deadline, lease loss): a stop, not a model failure —
        // the engine takes the paused/lease_lost path and does not use an attempt (02 §7.3, 04 §5.2)
        await run.checkpoint();
        throw new RunStop("lease_lost", "호출이 중단되었습니다.");
      }
      if (!attempt.ok) {
        const f: ErrorFamily = attempt.result.errorFamily;
        if (f === "content_filtered" && !contentFilterRetried) {
          contentFilterRetried = true;
          system = input.system + SAFETY_REINFORCEMENT;
          continue;
        }
        if (isCallLevelRetryable(f) && transientRetries < maxRetries) {
          let waitMs = (backoff[Math.min(transientRetries, backoff.length - 1)] ?? 5) * 1000;
          if (f === "rate_limited" && attempt.result.retryNotBefore) waitMs = Math.max(0, attempt.result.retryNotBefore.getTime() - clock.now());
          if (f !== "rate_limited" || rateLimitWaitedMs + waitMs <= rateLimitMaxWaitMs) {
            transientRetries++;
            rateLimitWaitedMs += f === "rate_limited" ? waitMs : 0;
            await sleep(waitMs, run.signal);
            continue;
          }
        }
        if (f === "invalid_output" && repairAttempt < maxRetries) {
          repairAttempt++;
          messages = [...input.messages, { role: "user", content: "직전 출력이 요구 형식과 맞지 않았습니다. 지정한 JSON 스키마를 정확히 따르는 값만 다시 출력하세요." }];
          continue;
        }
        throw new ModelCallError(f, callId, attempt.result.retryNotBefore, attempt.result.message);
      }

      const r = attempt.result;
      if (input.output.kind === "text") {
        const text = r.text ?? (typeof r.object === "string" ? r.object : "");
        return { providerCallId: callId, reused: attempt.reused, value: text, usage: r.usage, costMicros: attempt.costMicros, modelId: binding.modelId, modelVersion: r.modelVersion };
      }

      // structured output: finishReason=length → invalid_output (04 §7.2); then zod
      let problem: string | null = null;
      let value: T | undefined;
      if (r.finishReason === "length") problem = "출력이 출력 토큰 상한에서 잘렸습니다. 더 간결하게 같은 스키마로 출력하세요.";
      else {
        let raw = r.object;
        if (raw === undefined && typeof r.text === "string") {
          try {
            raw = JSON.parse(r.text);
          } catch {
            problem = "출력이 JSON이 아닙니다.";
          }
        }
        if (!problem) {
          const parsed = input.output.schema.safeParse(raw);
          if (parsed.success) value = parsed.data;
          else problem = `스키마 검증 실패:\n${formatZodIssues(parsed.error)}`;
        }
      }
      if (value !== undefined && !problem) {
        return { providerCallId: callId, reused: attempt.reused, value, usage: r.usage, costMicros: attempt.costMicros, modelId: binding.modelId, modelVersion: r.modelVersion };
      }
      if (repairAttempt >= maxRetries) throw new ModelCallError("invalid_output", callId, undefined, `구조화 출력 검증에 ${repairAttempt + 1}회 실패했습니다. ${problem ?? ""}`.trim());
      repairAttempt++;
      messages = [
        ...input.messages,
        { role: "assistant", content: r.text ?? JSON.stringify(r.object ?? null) },
        { role: "user", content: `직전 출력에 문제가 있습니다.\n${problem}\n같은 스키마를 정확히 지켜 전체 JSON을 다시 출력하세요.` },
      ];
    }
  }

  return {
    call,
    get budgetUnavailable() {
      return budgetUnavailable;
    },
  };
}
