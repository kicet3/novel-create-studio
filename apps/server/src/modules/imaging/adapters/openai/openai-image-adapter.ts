/**
 * GPT Image adapter, two lanes chosen by the credential:
 * - `api_key`: `POST {api}/v1/images/generations` (OpenAI Images API; `gpt-image-*` always return `b64_json`);
 * - `chatgpt_oauth`: `POST {codex}/images/generations` on the ChatGPT Codex backend with the ChatGPT access token +
 *   `chatgpt-account-id` (ported from ima2-gen lib/oauthImages.ts "direct" mode: no planner step, JSON body,
 *   `model: gpt-image-2`, no `stream` / `response_format`, quality xhigh/max → high). Plan-billed; unofficial.
 * Usage tokens (when returned) give a measured cost on the API lane.
 */
import type { LlmCredential } from "../../../llm/index.js";
import type { ImageAdapter, ImageRequest, ImageResult } from "../../index.js";
import { openAiSize } from "../../domain/catalog.js";
import { decodeBase64, fetchWithCredential, httpFailure, linkedSignal, noImage, readJson, thrownFailure, trimSlash } from "../shared/http.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface OpenAiImageAdapterOptions {
  apiBaseUrl?: string;
  codexBaseUrl?: string;
}

export function buildImageBody(req: ImageRequest, lane: "api" | "chatgpt"): Record<string, unknown> {
  const size = openAiSize(req.aspectRatio, req.resolution);
  return {
    model: lane === "chatgpt" ? "gpt-image-2" : req.modelId,
    prompt: req.prompt,
    n: req.n,
    ...(size ? { size } : {}),
    ...(req.quality ? { quality: req.quality } : {}),
    ...(lane === "api" ? { output_format: "png" } : {}),
    moderation: "auto",
  };
}

export class OpenAiImageAdapter implements ImageAdapter {
  readonly provider = "openai";
  private readonly api: string;
  private readonly codex: string;

  constructor(opts: OpenAiImageAdapterOptions = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? OPENAI_API_BASE_URL);
    this.codex = trimSlash(opts.codexBaseUrl ?? CODEX_BASE_URL);
  }

  async generate(req: ImageRequest, opts: { credential: LlmCredential; signal: AbortSignal; timeoutMs: number }): Promise<ImageResult> {
    const lane = opts.credential.method === "chatgpt_oauth" ? "chatgpt" : "api";
    const vendor = lane === "chatgpt" ? "ChatGPT(Codex) 백엔드" : "OpenAI API";
    const url = lane === "chatgpt" ? `${this.codex}/images/generations` : `${this.api}/v1/images/generations`;
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    try {
      const res = await fetchWithCredential(
        url,
        { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(buildImageBody(req, lane)), signal: link.signal },
        opts.credential,
      );
      if (!res.ok) {
        return httpFailure(res, {
          vendor,
          auth:
            lane === "chatgpt"
              ? "ChatGPT 로그인이 만료되었거나 이미지 생성이 거부되었습니다. 설정 → AI 계정 연결에서 다시 로그인하거나 API 키로 연결하세요."
              : "OpenAI API 키가 올바르지 않거나 이미지 모델 권한이 없습니다(조직 인증이 필요할 수 있습니다).",
        });
      }
      const parsed = await readJson(res, vendor);
      if (!parsed.ok) return parsed;
      const body = parsed.body as { data?: Array<{ b64_json?: string; revised_prompt?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; output_format?: string };
      const mime = body.output_format === "jpeg" ? "image/jpeg" : body.output_format === "webp" ? "image/webp" : "image/png";
      const images = (body.data ?? [])
        .filter((d) => typeof d.b64_json === "string" && d.b64_json.length > 0)
        .map((d) => ({ data: decodeBase64(d.b64_json!), mimeType: mime, revisedPrompt: d.revised_prompt }));
      if (!images.length) return noImage(vendor);
      return {
        ok: true,
        images,
        usage: body.usage ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } : undefined,
        providerRequestId: res.headers.get("x-request-id") ?? undefined,
      };
    } catch (err) {
      return thrownFailure(err, link.timedOut(), opts.signal.aborted, vendor);
    } finally {
      link.dispose();
    }
  }
}
