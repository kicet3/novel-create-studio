/**
 * Gemini image adapter ("Nano Banana"), Google AI Studio API key (`x-goog-api-key`).
 * Primary: Interactions API `POST {api}/v1beta/interactions` (header `Api-Revision: 2026-05-20`, `store:false`,
 * `response_format: {type:"image", mime_type, aspect_ratio, image_size:"1K|2K|4K"}`) — the form current docs use.
 * The image is `output_image.data` or an `image` block in `steps[type=model_output].content[]`.
 * Fallback when the Interactions endpoint is missing (404): legacy `models/{m}:generateContent` with
 * `generationConfig.responseModalities:["TEXT","IMAGE"]` + `imageConfig{aspectRatio,imageSize}` →
 * `candidates[0].content.parts[].inlineData`. No `n`: one call per image (sequential).
 * `finishReason: SAFETY` / blocked prompt without an image → content_filtered.
 */
import type { LlmCredential } from "../../../llm/index.js";
import type { GeneratedImage, ImageAdapter, ImageRequest, ImageResult } from "../../index.js";
import { geminiImageSize } from "../../domain/catalog.js";
import { sniffImage } from "../../domain/image-meta.js";
import { decodeBase64, fetchWithCredential, httpFailure, linkedSignal, readJson, thrownFailure, trimSlash, type ImageFailure } from "../shared/http.js";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_REVISION = "2026-05-20";
const VENDOR = "Gemini API";
const authHeader = (c: LlmCredential) => ({ "x-goog-api-key": c.token });
const AUTH_COPY = "Gemini API 키가 올바르지 않거나 권한이 없습니다. 설정 → AI 계정 연결에서 키를 확인하세요.";

type One = { ok: true; image: GeneratedImage; text?: string } | ImageFailure;

export function buildInteractionsBody(req: ImageRequest): Record<string, unknown> {
  return {
    model: req.modelId,
    input: [{ type: "text", text: req.prompt }],
    response_format: { type: "image", mime_type: "image/png", aspect_ratio: req.aspectRatio, image_size: geminiImageSize(req.resolution) },
    store: false,
  };
}

interface Block {
  type?: string;
  data?: string;
  mime_type?: string;
  text?: string;
}

/** Interactions response → first image (+ text) */
export function parseInteraction(body: unknown): { image: GeneratedImage | null; text: string; blocked: boolean } {
  const b = (body ?? {}) as { output_image?: Block; output_text?: string; steps?: Array<{ type?: string; content?: Block[] }>; status?: string; finish_reason?: string };
  let text = typeof b.output_text === "string" ? b.output_text : "";
  let img: Block | undefined = b.output_image?.data ? b.output_image : undefined;
  for (const s of b.steps ?? []) {
    if (s.type && s.type !== "model_output") continue;
    for (const c of s.content ?? []) {
      if (c.type === "image" && c.data && !img) img = c;
      if (c.type === "text" && c.text && !text) text = c.text;
    }
  }
  const blocked = /safety|blocked|prohibited/i.test(`${b.status ?? ""} ${b.finish_reason ?? ""}`);
  if (!img?.data) return { image: null, text, blocked };
  const data = decodeBase64(img.data);
  return { image: { data, mimeType: img.mime_type ?? sniffImage(data)?.mimeType ?? "image/png" }, text, blocked };
}

/** generateContent response → first image (+ text) */
export function parseGenerateContent(body: unknown): { image: GeneratedImage | null; text: string; blocked: boolean } {
  const b = (body ?? {}) as {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  const cand = b.candidates?.[0];
  let text = "";
  let image: GeneratedImage | null = null;
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue;
    if (p.inlineData?.data && !image) {
      const data = decodeBase64(p.inlineData.data);
      image = { data, mimeType: p.inlineData.mimeType ?? sniffImage(data)?.mimeType ?? "image/png" };
    } else if (p.text) text += p.text;
  }
  const blocked = !!b.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|IMAGE_SAFETY/.test(cand?.finishReason ?? "");
  return { image, text, blocked };
}

export class GeminiImageAdapter implements ImageAdapter {
  readonly provider = "google";
  private readonly api: string;
  /** set after the Interactions endpoint answered 404 once */
  private legacyOnly = false;

  constructor(opts: { apiBaseUrl?: string } = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? GEMINI_API_BASE_URL);
  }

  private async one(req: ImageRequest, credential: LlmCredential, signal: AbortSignal): Promise<One> {
    const headers = { "content-type": "application/json", accept: "application/json" };
    let parsed: { image: GeneratedImage | null; text: string; blocked: boolean } | null = null;
    if (!this.legacyOnly) {
      const res = await fetchWithCredential(
        `${this.api}/v1beta/interactions`,
        { method: "POST", headers: { ...headers, "Api-Revision": GEMINI_API_REVISION }, body: JSON.stringify(buildInteractionsBody(req)), signal },
        credential,
        authHeader,
      );
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        this.legacyOnly = true;
      } else if (!res.ok) {
        return httpFailure(res, { vendor: VENDOR, auth: AUTH_COPY });
      } else {
        const j = await readJson(res, VENDOR);
        if (!j.ok) return j;
        parsed = parseInteraction(j.body);
      }
    }
    if (!parsed) {
      const res = await fetchWithCredential(
        `${this.api}/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: req.prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspectRatio, imageSize: geminiImageSize(req.resolution) } },
          }),
          signal,
        },
        credential,
        authHeader,
      );
      if (!res.ok) return httpFailure(res, { vendor: VENDOR, auth: AUTH_COPY });
      const j = await readJson(res, VENDOR);
      if (!j.ok) return j;
      parsed = parseGenerateContent(j.body);
    }
    if (!parsed.image) {
      return parsed.blocked
        ? { ok: false, errorFamily: "content_filtered", message: "Gemini의 안전 정책으로 이미지를 만들 수 없습니다. 프롬프트를 바꿔 보세요.", billed: "unknown" }
        : { ok: false, errorFamily: "invalid_output", message: `Gemini가 이미지를 돌려주지 않았습니다.${parsed.text ? ` 응답: ${parsed.text.slice(0, 200)}` : ""}`, billed: "unknown" };
    }
    return { ok: true, image: parsed.image, text: parsed.text || undefined };
  }

  async generate(req: ImageRequest, opts: { credential: LlmCredential; signal: AbortSignal; timeoutMs: number }): Promise<ImageResult> {
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    const images: GeneratedImage[] = [];
    let text: string | undefined;
    try {
      for (let i = 0; i < req.n; i++) {
        const r = await this.one(req, opts.credential, link.signal);
        if (!r.ok) {
          if (!images.length) return r;
          return { ok: true, images, text, partialFailure: `${req.n}장 중 ${images.length}장만 만들었습니다: ${r.message}` };
        }
        images.push(r.image);
        text ??= r.text;
      }
      return { ok: true, images, text };
    } catch (err) {
      const f = thrownFailure(err, link.timedOut(), opts.signal.aborted, VENDOR);
      return images.length ? { ok: true, images, text, partialFailure: `${req.n}장 중 ${images.length}장만 만들었습니다: ${f.message}` } : f;
    } finally {
      link.dispose();
    }
  }
}
