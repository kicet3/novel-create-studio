import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { formatUsd, type ImageGenerationDto, type ImageModelDto, type ImageProviderDto, type ImageQuality, type ImageResolution, type LlmProviderId } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import {
  Badge,
  Button,
  buttonClass,
  Callout,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  formatDateTime,
  Input,
  QueryView,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
  CHOICE_BOX,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { isOpenGeneration, useCancelImageGeneration, useCreateImageGeneration, useDeleteImageGeneration, useImageGenerations, useImageProviders } from "./api.js";

const TIER_LABEL: Record<ImageModelDto["tier"], string> = { default: "기본", quality: "고품질", budget: "저가", legacy: "이전 세대" };
const QUALITY_LABEL: Record<ImageQuality, string> = { low: "낮음(빠름)", medium: "보통", high: "높음" };
const METHOD_LABEL: Record<string, string> = { api_key: "API 키", chatgpt_oauth: "ChatGPT 로그인", xai_oauth: "xAI 로그인" };
const SHORT_LABEL: Record<LlmProviderId, string> = { anthropic: "Claude", openai: "GPT", xai: "Grok", google: "Gemini" };
const PAGE = 24;
const PROMPT_MAX = 4_000;

/** OpenAI price scales with quality (historical gpt-image-2 table low/medium/high = 6 / 53 / 211 ¢-tenths) */
function estimate(provider: LlmProviderId, model: ImageModelDto, resolution: ImageResolution, quality: ImageQuality | "", count: number): number | null {
  const per = model.estimatedMicrosPerImage[resolution];
  if (per === null || per === undefined) return null;
  const q = provider === "openai" && quality ? { low: 6 / 53, medium: 1, high: 211 / 53 }[quality] : 1;
  return Math.round(per * q) * count;
}

/**
 * 이미지 생성 탭. `novelId` 있으면 작품 소속(작품 예산·원장에 기록), 없으면 설치 공용.
 * Provider/model picker (disabled with reason), prompt + style / avoid notes, aspect, resolution, quality, count,
 * async generation (polling), gallery with download / delete, history paging.
 */
export function ImageStudio({ novelId }: { novelId?: string }) {
  const providers = useImageProviders();
  return (
    <div className="grid gap-4 min-[1100px]:grid-cols-[minmax(320px,400px)_1fr]">
      <QueryView query={providers} loadingLabel="이미지 공급자를 불러오는 중…">
        {(items) => <GenerateForm providers={items} novelId={novelId} />}
      </QueryView>
      <Gallery novelId={novelId} providers={providers.data ?? []} />
    </div>
  );
}

function GenerateForm({ providers, novelId }: { providers: ImageProviderDto[]; novelId?: string }) {
  const usable = providers.filter((p) => p.available && !p.unavailableReason);
  const [provider, setProvider] = useState<LlmProviderId>(usable[0]?.provider ?? providers.find((p) => p.available)?.provider ?? "openai");
  const current = providers.find((p) => p.provider === provider);
  const [modelId, setModelId] = useState<string>(current?.defaultModelId ?? "");
  const model = current?.models.find((m) => m.id === modelId) ?? current?.models[0];
  const [prompt, setPrompt] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [resolution, setResolution] = useState<ImageResolution>("1k");
  const [quality, setQuality] = useState<ImageQuality | "">("medium");
  const [count, setCount] = useState(1);
  const create = useCreateImageGeneration();

  // keep the selection valid when the provider / model changes
  useEffect(() => {
    if (!current) return;
    if (!current.models.some((m) => m.id === modelId)) setModelId(current.defaultModelId ?? current.models[0]?.id ?? "");
  }, [current, modelId]);
  useEffect(() => {
    if (!model) return;
    if (!model.aspectRatios.includes(aspectRatio)) setAspectRatio(model.aspectRatios[0]!);
    if (!model.resolutions.includes(resolution)) setResolution(model.resolutions[0]!);
    if (model.qualities.length && quality && !model.qualities.includes(quality)) setQuality(model.qualities.includes("medium") ? "medium" : model.qualities[0]!);
    if (count > model.maxImages) setCount(model.maxImages);
  }, [model, aspectRatio, resolution, quality, count]);

  const disabledReason = !current
    ? "공급자를 고르세요."
    : !current.available || current.unavailableReason
      ? current.unavailableReason
      : !model
        ? "모델을 고르세요."
        : !prompt.trim()
          ? "프롬프트를 입력하세요."
          : prompt.length > PROMPT_MAX
            ? "프롬프트가 너무 깁니다."
            : null;
  const plan = current?.activeMethod === "chatgpt_oauth";
  const cost = current && model ? estimate(current.provider, model, resolution, model.qualities.length ? quality : "", count) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabledReason || !model || !current) return;
    create.mutate(
      {
        novelId,
        provider: current.provider,
        modelId: model.id,
        prompt: prompt.trim(),
        styleNotes: styleNotes.trim() || undefined,
        negativePrompt: negativePrompt.trim() || undefined,
        aspectRatio,
        resolution,
        quality: model.qualities.length && quality ? quality : undefined,
        count,
      });
  };

  return (
    <Card title="새 이미지" className="self-start">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1.5 text-[12.5px] font-semibold text-muted">공급자</legend>
          <div className="grid grid-cols-2 gap-2">
            {providers.map((p) => {
              const off = !p.available || !!p.unavailableReason;
              const checked = p.provider === provider;
              return (
                <label
                  key={p.provider}
                  title={p.unavailableReason ?? undefined}
                  className={cx(
                    "flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
                    !p.available && "cursor-not-allowed opacity-55",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="image-provider"
                      value={p.provider}
                      checked={checked}
                      disabled={!p.available}
                      onChange={() => setProvider(p.provider)}
                      className={CHOICE_BOX}
                    />
                    <b>{SHORT_LABEL[p.provider]}</b>
                    {p.available ? (
                      off ? (
                        <Badge tone="neutral">연결 필요</Badge>
                      ) : (
                        <Badge tone="ok">{METHOD_LABEL[p.activeMethod ?? "api_key"]}</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">미지원</Badge>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {current?.unavailableReason && (
          <Callout tone={current.available ? "warn" : "info"}>
            {current.unavailableReason}
            {current.available && !current.connected && (
              <>
                {" "}
                <Link to="/settings" className="font-semibold">
                  AI 계정 연결로 이동
                </Link>
              </>
            )}
          </Callout>
        )}

        {current?.available && current.models.length > 0 && model && (
          <>
            <Field label="모델" hint={model.note}>
              <Select value={model.id} onChange={(e) => setModelId(e.target.value)} disabled={!!current.unavailableReason}>
                {current.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {TIER_LABEL[m.tier]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="프롬프트" required hint={`${prompt.length.toLocaleString("ko-KR")} / ${PROMPT_MAX.toLocaleString("ko-KR")}자`} error={prompt.length > PROMPT_MAX ? "4,000자 이하로 입력하세요." : undefined}>
              <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="예: 비 내리는 밤, 네온이 번지는 골목에 선 검은 코트의 탐정, 영화 포스터 구도" />
            </Field>
            <Field label="스타일 메모" hint="선택. 프롬프트 뒤에 '스타일 지시'로 덧붙입니다.">
              <Input value={styleNotes} maxLength={1000} onChange={(e) => setStyleNotes(e.target.value)} placeholder="예: 수채화, 부드러운 파스텔 톤" />
            </Field>
            <Field label="넣지 말 것" hint="선택. 공식 부정 프롬프트 파라미터가 없어 프롬프트 뒤에 덧붙입니다.">
              <Input value={negativePrompt} maxLength={1000} onChange={(e) => setNegativePrompt(e.target.value)} placeholder="예: 글자, 워터마크, 흐릿한 얼굴" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="화면비">
                <Select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  {model.aspectRatios.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="해상도">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value as ImageResolution)}>
                  {model.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              {model.qualities.length > 0 && (
                <Field label="품질">
                  <Select value={quality} onChange={(e) => setQuality(e.target.value as ImageQuality)}>
                    {model.qualities.map((q) => (
                      <option key={q} value={q}>
                        {QUALITY_LABEL[q]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="장 수" hint={`최대 ${model.maxImages}장`}>
                <Select value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
                  {Array.from({ length: model.maxImages }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}장
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <p className="m-0 text-[12.5px] text-muted">
              {plan
                ? "ChatGPT 요금제 한도에서 차감됩니다(API 요금·작품 예산에는 기록하지 않습니다)."
                : cost === null
                  ? "공개 단가가 없어 예상 비용을 계산할 수 없습니다."
                  : `예상 비용 약 ${formatUsd(cost, cost < 10_000 ? 3 : 2)} (추정, 실제 청구액은 공급자 기준)`}
              {novelId && !plan && " · 작품 이미지 예산에서 확인하고 기록합니다."}
            </p>
          </>
        )}

        {current?.available && current.notes.length > 0 && (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-xs text-faint">
            {current.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>{current.termsNote} 해당 공급자와 맺은 내 약정이 적용됩니다.</li>
          </ul>
        )}

        {create.error && <Callout tone="danger">{errorMessage(create.error)}</Callout>}
        {create.isSuccess && !create.isPending && <Callout tone="ok" role="status">요청을 보냈습니다. 오른쪽 목록에서 진행 상황을 확인하세요.</Callout>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!!disabledReason} aria-describedby={disabledReason ? "image-submit-reason" : undefined}>
            이미지 만들기
          </Button>
          {disabledReason && (
            <span id="image-submit-reason" className="text-xs text-faint">
              {disabledReason}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function Gallery({ novelId, providers }: { novelId?: string; providers: ImageProviderDto[] }) {
  const [limit, setLimit] = useState(PAGE);
  const q = useImageGenerations(novelId, limit);
  const labelOf = useMemo(() => new Map(providers.map((p) => [p.provider as string, SHORT_LABEL[p.provider]])), [providers]);
  return (
    <Card title={novelId ? "이 작품의 이미지" : "생성 기록"} actions={q.isFetching ? <Spinner label="갱신 중" /> : undefined}>
      <QueryView query={q} loadingLabel="생성 기록을 불러오는 중…">
        {(page) =>
          page.items.length === 0 ? (
            <EmptyState title="아직 만든 이미지가 없습니다" description="왼쪽에서 공급자와 프롬프트를 정하고 이미지 만들기를 누르세요." icon="◇" />
          ) : (
            <div className="flex flex-col gap-3">
              {page.items.map((g) => (
                <GenerationItem key={g.id} g={g} providerLabel={labelOf.get(g.provider) ?? g.provider} />
              ))}
              {page.nextCursor && (
                <Button className="self-center" onClick={() => setLimit((l) => Math.min(100, l + PAGE))} disabled={limit >= 100}>
                  {limit >= 100 ? "최근 100건까지 표시합니다" : "더 보기"}
                </Button>
              )}
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}

function GenerationItem({ g, providerLabel }: { g: ImageGenerationDto; providerLabel: string }) {
  const cancel = useCancelImageGeneration();
  const del = useDeleteImageGeneration();
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<ImageGenerationDto["assets"][number] | null>(null);
  const open = isOpenGeneration(g);
  const params = g.params as { aspectRatio?: string; resolution?: string; quality?: string; styleNotes?: string; negativePrompt?: string };
  const cost =
    g.costBasis === "plan"
      ? "ChatGPT 요금제"
      : g.costMicros !== null
        ? `${formatUsd(g.costMicros, g.costMicros < 10_000 ? 3 : 2)}${g.costBasis === "estimated" ? " (추정)" : ""}`
        : g.estimatedMicros !== null
          ? `예상 ${formatUsd(g.estimatedMicros, g.estimatedMicros < 10_000 ? 3 : 2)}`
          : "—";

  return (
    <article className="rounded-lg border border-border bg-surface-2/40 p-3" aria-busy={open || undefined}>
      <header className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <StatusBadge enum="image_generation_status" value={g.status} />
        <b>{providerLabel}</b>
        <span className="text-muted">{g.modelId}</span>
        <span className="text-faint">
          {[params.aspectRatio, params.resolution?.toUpperCase(), params.quality, `${g.imageCount}장`].filter(Boolean).join(" · ")}
        </span>
        <span className="ml-auto text-faint">
          <time dateTime={g.createdAt}>{formatDateTime(g.createdAt)}</time> · {cost}
        </span>
      </header>
      <p className="mt-1.5 mb-0 line-clamp-3 whitespace-pre-wrap text-[13px]" title={g.prompt}>
        {g.prompt}
      </p>
      {(params.styleNotes || params.negativePrompt) && (
        <p className="mt-1 mb-0 text-xs text-faint">
          {params.styleNotes && <>스타일: {params.styleNotes} </>}
          {params.negativePrompt && <>· 넣지 말 것: {params.negativePrompt}</>}
        </p>
      )}

      {open && (
        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-muted" role="status">
          <Spinner />
          {g.status === "queued" ? "대기 중입니다…" : "생성 중입니다. 모델에 따라 1~2분 걸릴 수 있습니다."}
        </div>
      )}
      {g.status === "failed" && g.errorMessage && (
        <Callout tone="danger" className="mt-2">
          {g.errorMessage}
        </Callout>
      )}
      {g.status === "succeeded" && g.errorMessage && (
        <Callout tone="warn" className="mt-2">
          {g.errorMessage}
        </Callout>
      )}

      {g.assets.length > 0 && (
        <ul className="m-0 mt-2.5 grid list-none grid-cols-2 gap-2 p-0 min-[700px]:grid-cols-3 min-[1400px]:grid-cols-4">
          {g.assets.map((a) => (
            <li key={a.id} className="group relative overflow-hidden rounded-md border border-border bg-surface">
              <button type="button" onClick={() => setPreview(a)} className="block w-full" aria-label={`${a.ord + 1}번째 이미지 크게 보기`}>
                <img src={a.url} alt={`생성된 이미지 ${a.ord + 1}: ${g.prompt.slice(0, 80)}`} loading="lazy" className="aspect-square w-full object-cover" />
              </button>
              <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-[11px] text-faint">
                <span>{a.width && a.height ? `${a.width}×${a.height}` : a.mimeType}</span>
                <a href={`${a.url}?download=1`} download className="font-semibold text-accent">
                  내려받기
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {g.revisedPrompt && <p className="mt-1.5 mb-0 text-xs text-faint">공급자가 고친 프롬프트: {g.revisedPrompt}</p>}

      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {open && (
          <Button size="sm" onClick={() => cancel.mutate(g.id)} loading={cancel.isPending}>
            취소
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
          삭제
        </Button>
      </div>
      {(cancel.error || del.error) && (
        <Callout tone="danger" className="mt-2">
          {errorMessage(cancel.error ?? del.error)}
        </Callout>
      )}

      <ConfirmDialog
        open={confirm}
        title="이미지 기록을 삭제할까요?"
        description={open ? "진행 중인 생성을 멈추고 기록과 파일을 지웁니다. 공급자에서 이미 청구된 비용은 되돌릴 수 없습니다." : "기록과 이미지 파일을 모두 지웁니다. 되돌릴 수 없습니다."}
        confirmLabel="삭제"
        danger
        busy={del.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => del.mutate(g.id, { onSettled: () => setConfirm(false) })}
      />
      <Dialog
        open={!!preview}
        onClose={() => setPreview(null)}
        size="lg"
        title={`${providerLabel} · ${g.modelId}`}
        description={preview?.width && preview.height ? `${preview.width}×${preview.height}` : undefined}
        footer={
          preview ? (
            <>
              <a href={`${preview.url}?download=1`} download className={buttonClass("primary")}>
                내려받기
              </a>
              <Button onClick={() => setPreview(null)}>닫기</Button>
            </>
          ) : undefined
        }
      >
        {preview && (
          <figure className="m-0 flex flex-col gap-2">
            <img src={preview.url} alt={`생성된 이미지: ${g.prompt.slice(0, 120)}`} className="max-h-[70vh] w-full rounded-md object-contain" />
            <figcaption className="whitespace-pre-wrap text-xs text-muted">{preview.revisedPrompt ?? g.prompt}</figcaption>
          </figure>
        )}
      </Dialog>
    </article>
  );
}
