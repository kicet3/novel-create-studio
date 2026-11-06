/**
 * Grok Imagine adapter: `POST {api}/v1/images/generations` with `response_format: b64_json` (xAI URLs are temporary,
 * and base64 avoids an outbound download), `aspect_ratio`, `resolution` (1k | 2k), `quality` (2.0 only), `n`.
 * Bearer = xAI API key or the xAI OAuth access token (experimental; may get 403). Cost from
 * `usage.cost_in_usd_ticks` when present. A `url` without `b64_json` is downloaded only from an https `*.x.ai` host.
 */
import type { LlmCredential } from "../../../llm/index.js";
import type { GeneratedImage, ImageAdapter, ImageRequest, ImageResult } from "../../index.js";
import { xaiTicksToMicros } from "../../domain/catalog.js";
import { sniffImage } from "../../domain/image-meta.js";
import { decodeBase64, fetchWithCredential, httpFailure, linkedSignal, noImage, readJson, thrownFailure, trimSlash } from "../shared/http.js";

export const XAI_API_BASE_URL = "https://api.x.ai";
const VENDOR = "xAI";
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function buildXaiImageBody(req: ImageRequest): Record<string, unknown> {
  return {
    model: req.modelId,
    prompt: req.prompt,
    n: req.n,
    response_format: "b64_json",
    aspect_ratio: req.aspectRatio,
    resolution: req.resolution === "2k" ? "2k" : "1k",
    ...(req.quality && req.modelId.startsWith("grok-imagine-image-2") ? { quality: req.quality === "high" ? "medium" : req.quality } : {}),
  };
}

function trustedImageUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
  } catch {
    return false;
  }
}

export class XaiImageAdapter implements ImageAdapter {
  readonly provider = "xai";
  private readonly api: string;

  constructor(opts: { apiBaseUrl?: string } = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? XAI_API_BASE_URL);
  }

  async generate(req: ImageRequest, opts: { credential: LlmCredential; signal: AbortSignal; timeoutMs: number }): Promise<ImageResult> {
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    try {
      const res = await fetchWithCredential(
        `${this.api}/v1/images/generations`,
        { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(buildXaiImageBody(req)), signal: link.signal },
        opts.credential,
      );
      if (!res.ok) {
        return httpFailure(res, {
          vendor: VENDOR,
          auth:
            opts.credential.method === "xai_oauth"
              ? "xAI 로그인으로는 이미지 생성이 거부되었습니다(xAI가 문서화한 방식은 API 키뿐입니다). 설정 → AI 계정 연결에서 API 키로 연결하세요."
              : "xAI API 키가 올바르지 않거나 권한이 없습니다. 설정 → AI 계정 연결에서 키를 확인하세요.",
        });
      }
      const parsed = await readJson(res, VENDOR);
      if (!parsed.ok) return parsed;
      const body = parsed.body as { data?: Array<{ b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string }>; usage?: { cost_in_usd_ticks?: number } };
      const images: GeneratedImage[] = [];
      for (const d of body.data ?? []) {
        let bytes: Uint8Array | null = null;
        if (d.b64_json) bytes = decodeBase64(d.b64_json);
        else if (d.url && trustedImageUrl(d.url)) {
          const r = await fetch(d.url, { signal: link.signal, redirect: "error" });
          if (r.ok) {
            const buf = new Uint8Array(await r.arrayBuffer());
            if (buf.length <= MAX_DOWNLOAD_BYTES) bytes = buf;
          }
        }
        if (!bytes?.length) continue;
        images.push({ data: bytes, mimeType: d.mime_type ?? sniffImage(bytes)?.mimeType ?? "image/jpeg", revisedPrompt: d.revised_prompt });
      }
      if (!images.length) return noImage(VENDOR);
      const ticks = body.usage?.cost_in_usd_ticks;
      return {
        ok: true,
        images,
        reportedCostMicros: typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0 ? xaiTicksToMicros(ticks) : undefined,
        providerRequestId: res.headers.get("x-request-id") ?? undefined,
      };
    } catch (err) {
      return thrownFailure(err, link.timedOut(), opts.signal.aborted, VENDOR);
    } finally {
      link.dispose();
    }
  }
}
