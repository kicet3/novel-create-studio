import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  CHARACTER_SHEET_VIEW,
  labelKo,
  type CharacterDto,
  type CharacterSheetView,
  type DesignSheetSpec,
  type DesignSheetView,
  type ImageProviderDto,
  type ImageResolution,
  type LlmProviderId,
} from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Badge, Button, Callout, Field, Input, QueryView, Select, Spinner, StatusBadge, Textarea } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useImageProviders } from "../images/api.js";
import { useDesignSheet, useDesignSheetDraft, useGenerateSheetImage, useSelectPrimaryImage, useSheetPrompt, useUpdateDesignSheet } from "./api.js";

type TextKey = "face" | "hair" | "eyes" | "build" | "height" | "distinguishingMarks" | "artStyle" | "avoid";
const TEXT_FIELDS: Array<{ key: TextKey; label: string; long?: boolean; max: number; placeholder?: string }> = [
  { key: "face", label: "얼굴", long: true, max: 1000, placeholder: "얼굴형, 인상" },
  { key: "hair", label: "머리", long: true, max: 1000, placeholder: "색, 길이, 스타일" },
  { key: "eyes", label: "눈", max: 500 },
  { key: "build", label: "체형", max: 500 },
  { key: "height", label: "키", max: 60, placeholder: "예: 172cm" },
  { key: "distinguishingMarks", label: "특징(흉터·점·장신구)", long: true, max: 1000 },
  { key: "artStyle", label: "그림체", long: true, max: 1000, placeholder: "예: 웹툰풍 셀 셰이딩" },
  { key: "avoid", label: "그리면 안 되는 것", long: true, max: 1000 },
];
const SHORT_LABEL: Record<LlmProviderId, string> = { anthropic: "Claude", openai: "GPT", xai: "Grok", google: "Gemini" };
const VIEW_ASPECT: Record<CharacterSheetView, string> = { front: "2:3", side: "2:3", back: "2:3", expressions: "1:1" };

/** 디자인 시트 탭: 외형 스펙(AI 초안·직접 편집) + 시점별 이미지 생성(정면·측면·후면·표정 시트) + 대표 이미지 지정. */
export function DesignSheetTab({ novelId, character }: { novelId: string; character: CharacterDto }) {
  const sheet = useDesignSheet(novelId, character.id);
  return (
    <QueryView query={sheet} loadingLabel="디자인 시트를 불러오는 중…">
      {(s) => (
        <div className="flex flex-col gap-4">
          <SpecForm key={s.updatedAt ?? "new"} novelId={novelId} character={character} sheet={s} />
          <ImagePanel novelId={novelId} character={character} sheet={s} />
        </div>
      )}
    </QueryView>
  );
}

function SpecForm({ novelId, character, sheet }: { novelId: string; character: CharacterDto; sheet: DesignSheetView }) {
  const [spec, setSpec] = useState<DesignSheetSpec>(sheet.spec);
  const update = useUpdateDesignSheet(novelId, character.id);
  const draft = useDesignSheetDraft(novelId, character.id);
  const dirtyKeys = (Object.keys(spec) as Array<keyof DesignSheetSpec>).filter((k) => JSON.stringify(spec[k]) !== JSON.stringify(sheet.spec[k]));
  const set = <K extends keyof DesignSheetSpec>(k: K, v: DesignSheetSpec[K]) => setSpec((s) => ({ ...s, [k]: v }));
  const aiTag = (k: string) => (sheet.fieldOrigins[k] === "agent" ? <Badge tone="violet" className="ml-1">AI 제안</Badge> : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirtyKeys.length) return;
    update.mutate(Object.fromEntries(dirtyKeys.map((k) => [k, spec[k]])));
  };
  const drafting = !!sheet.draftTask || draft.isPending;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`${character.name} 디자인 시트`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-xs text-muted">이 스펙은 이 캐릭터의 모든 이미지 프롬프트에 참조 문구로 들어갑니다. 직접 고친 칸은 AI 초안이 바꾸지 않습니다.</p>
        <Button onClick={() => draft.mutate(undefined)} loading={drafting} disabled={drafting}>
          {drafting ? "AI 초안 작성 중…" : "AI 초안 받기"}
        </Button>
      </div>
      {draft.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(draft.error)}</p>}
      <div className="grid gap-3 min-[640px]:grid-cols-2">
        {TEXT_FIELDS.map((f) => (
          <Field key={f.key} label={<>{f.label}{aiTag(f.key)}</>} className={f.long ? "min-[640px]:col-span-2" : undefined}>
            {f.long ? (
              <Textarea rows={2} maxLength={f.max} placeholder={f.placeholder} value={spec[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <Input maxLength={f.max} placeholder={f.placeholder} value={spec[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        ))}
      </div>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">의상{aiTag("outfits")}</legend>
        {spec.outfits.map((o, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-semibold text-muted">의상 {i + 1}</span>
              <Button size="sm" variant="ghost" aria-label={`의상 ${i + 1} 삭제`} onClick={() => set("outfits", spec.outfits.filter((_, j) => j !== i))}>
                삭제
              </Button>
            </div>
            <div className="grid gap-2 min-[640px]:grid-cols-[1fr_3fr]">
              <Field label="이름">
                <Input maxLength={60} value={o.name} onChange={(e) => set("outfits", spec.outfits.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              </Field>
              <Field label="설명">
                <Input maxLength={1000} value={o.description} onChange={(e) => set("outfits", spec.outfits.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              </Field>
            </div>
          </div>
        ))}
        {spec.outfits.length < 8 && (
          <div>
            <Button size="sm" onClick={() => set("outfits", [...spec.outfits, { name: `의상 ${spec.outfits.length + 1}`, description: "" }])}>
              의상 추가
            </Button>
          </div>
        )}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">색상 팔레트{aiTag("colorPalette")}</legend>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {spec.colorPalette.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-lg border border-border p-1">
              <input
                type="color"
                aria-label={`${c.name || `색 ${i + 1}`} 색상`}
                value={c.hex}
                onChange={(e) => set("colorPalette", spec.colorPalette.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))}
                className="size-8 flex-none cursor-pointer rounded-md border-0 bg-transparent p-0 ring-1 ring-faint/60"
              />
              <Input
                aria-label={`색 ${i + 1} 이름`}
                controlSize="sm"
                className="w-28"
                maxLength={40}
                value={c.name}
                onChange={(e) => set("colorPalette", spec.colorPalette.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <Button size="sm" variant="ghost" className="w-8 px-0" aria-label={`색 ${i + 1} 삭제`} onClick={() => set("colorPalette", spec.colorPalette.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
        {spec.colorPalette.length < 12 && (
          <div>
            <Button size="sm" onClick={() => set("colorPalette", [...spec.colorPalette, { name: `색 ${spec.colorPalette.length + 1}`, hex: "#888888" }])}>
              색 추가
            </Button>
          </div>
        )}
      </fieldset>

      {update.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(update.error)}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => setSpec(sheet.spec)} disabled={!dirtyKeys.length}>
          되돌리기
        </Button>
        <Button type="submit" variant="primary" disabled={!dirtyKeys.length || spec.colorPalette.some((c) => !c.name.trim()) || spec.outfits.some((o) => !o.name.trim())} loading={update.isPending}>
          디자인 시트 저장
        </Button>
      </div>
      {sheet.referenceText && (
        <details className="rounded-lg border border-border p-2.5 text-[12.5px]">
          <summary className="cursor-pointer font-semibold">이미지 프롬프트에 들어가는 참조 문구</summary>
          <pre className="m-0 mt-2 whitespace-pre-wrap font-sans text-muted">{sheet.referenceText}</pre>
        </details>
      )}
    </form>
  );
}

function ImagePanel({ novelId, character, sheet }: { novelId: string; character: CharacterDto; sheet: DesignSheetView }) {
  const providers = useImageProviders();
  return (
    <section aria-labelledby={`sheet-images-${character.id}`} className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 id={`sheet-images-${character.id}`} className="text-[13.5px] font-bold">
        시트 이미지
      </h3>
      <QueryView query={providers} loadingLabel="이미지 공급자를 불러오는 중…" compact>
        {(items) => <GenerateForm novelId={novelId} character={character} sheet={sheet} providers={items} />}
      </QueryView>
      <Gallery novelId={novelId} character={character} sheet={sheet} />
    </section>
  );
}

function GenerateForm({ novelId, character, sheet, providers }: { novelId: string; character: CharacterDto; sheet: DesignSheetView; providers: ImageProviderDto[] }) {
  const usable = providers.filter((p) => p.available && !p.unavailableReason);
  const [view, setView] = useState<CharacterSheetView>("front");
  const [provider, setProvider] = useState<LlmProviderId | "">(usable[0]?.provider ?? "");
  const current = usable.find((p) => p.provider === provider);
  const [modelId, setModelId] = useState(current?.defaultModelId ?? "");
  const model = current?.models.find((m) => m.id === modelId) ?? current?.models[0];
  const [resolution, setResolution] = useState<ImageResolution>("1k");
  const [count, setCount] = useState(1);
  const [outfitIndex, setOutfitIndex] = useState(0);
  const [showPrompt, setShowPrompt] = useState(false);
  const generate = useGenerateSheetImage(novelId, character.id);
  const prompt = useSheetPrompt(novelId, character.id, view, outfitIndex, showPrompt);

  useEffect(() => {
    if (current && !current.models.some((m) => m.id === modelId)) setModelId(current.defaultModelId ?? current.models[0]?.id ?? "");
  }, [current, modelId]);
  useEffect(() => {
    if (model && !model.resolutions.includes(resolution)) setResolution(model.resolutions[0]!);
    if (model && count > Math.min(4, model.maxImages)) setCount(Math.min(4, model.maxImages));
  }, [model, resolution, count]);

  const aspect = model ? (model.aspectRatios.includes(VIEW_ASPECT[view]) ? VIEW_ASPECT[view] : model.aspectRatios[0]!) : VIEW_ASPECT[view];
  const specEmpty = Object.values(sheet.spec).every((v) => (Array.isArray(v) ? v.length === 0 : !String(v).trim()));
  const reason = usable.length === 0 ? "연결된 이미지 공급자가 없습니다." : !current || !model ? "공급자와 모델을 고르세요." : specEmpty ? "디자인 시트를 먼저 채우세요." : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason || !current || !model) return;
    generate.mutate({ view, provider: current.provider, modelId: model.id, aspectRatio: aspect, resolution, count, outfitIndex });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="시트 이미지 생성">
      {usable.length === 0 && (
        <Callout tone="warn">
          이미지를 만들 수 있는 공급자(GPT·Grok·Gemini)가 연결되어 있지 않습니다. <Link to="/settings">설치 설정</Link>에서 연결하세요.
        </Callout>
      )}
      <div className="grid grid-cols-2 items-start gap-3 min-[640px]:grid-cols-3">
        <Field label="시점">
          <Select value={view} onChange={(e) => setView(e.target.value as CharacterSheetView)}>
            {CHARACTER_SHEET_VIEW.map((v) => (
              <option key={v} value={v}>
                {labelKo("character_sheet_view", v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="공급자">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as LlmProviderId)} disabled={usable.length === 0}>
            {usable.length === 0 && <option value="">연결 필요</option>}
            {usable.map((p) => (
              <option key={p.provider} value={p.provider}>
                {SHORT_LABEL[p.provider]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="모델" hint={model?.note} className="col-span-2 min-[640px]:col-span-1">
          <Select value={model?.id ?? ""} onChange={(e) => setModelId(e.target.value)} disabled={!current}>
            {(current?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        {model && (
          <Field label="해상도">
            <Select value={resolution} onChange={(e) => setResolution(e.target.value as ImageResolution)}>
              {model.resolutions.map((r) => (
                <option key={r} value={r}>
                  {r.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {model && (
          <Field label="장 수">
            <Select value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: Math.min(4, model.maxImages) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}장
                </option>
              ))}
            </Select>
          </Field>
        )}
        {sheet.spec.outfits.length > 1 && (
          <Field label="의상">
            <Select value={String(outfitIndex)} onChange={(e) => setOutfitIndex(Number(e.target.value))}>
              {sheet.spec.outfits.map((o, i) => (
                <option key={i} value={i}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!!reason} loading={generate.isPending}>
          {labelKo("character_sheet_view", view)} 이미지 생성
        </Button>
        <Button variant="ghost" aria-expanded={showPrompt} onClick={() => setShowPrompt((v) => !v)}>
          {showPrompt ? "프롬프트 숨기기" : "프롬프트 보기"}
        </Button>
        <span className="text-xs text-faint">화면비 {aspect}</span>
        {reason && <span className="text-xs text-muted">{reason}</span>}
      </div>
      {generate.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(generate.error)}</p>}
      {showPrompt && (
        <div className="rounded-lg border border-border p-2.5 text-[12.5px]">
          {prompt.data ? (
            <pre className="m-0 whitespace-pre-wrap font-sans text-muted">
              {prompt.data.prompt}
              {prompt.data.styleNotes && `\n\n스타일 지시: ${prompt.data.styleNotes}`}
              {prompt.data.negativePrompt && `\n\n넣지 말 것: ${prompt.data.negativePrompt}`}
            </pre>
          ) : (
            <Spinner label="프롬프트를 만드는 중" />
          )}
        </div>
      )}
    </form>
  );
}

function Gallery({ novelId, character, sheet }: { novelId: string; character: CharacterDto; sheet: DesignSheetView }) {
  const select = useSelectPrimaryImage(novelId, character.id);
  if (!sheet.images.length) return <p className="m-0 text-xs text-faint">아직 만든 시트 이미지가 없습니다.</p>;
  return (
    <div className="flex flex-col gap-3">
      {select.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(select.error)}</p>}
      {CHARACTER_SHEET_VIEW.map((v) => {
        const items = sheet.images.filter((i) => i.view === v);
        if (!items.length) return null;
        const primary = sheet.primaryImages[v];
        return (
          <section key={v} aria-label={`${labelKo("character_sheet_view", v)} 이미지`}>
            <h4 className="mb-1.5 text-[12.5px] font-semibold text-muted">
              {labelKo("character_sheet_view", v)}
              {primary && <Badge tone="ok" className="ml-1.5">대표 지정됨</Badge>}
            </h4>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 min-[640px]:grid-cols-3 min-[1300px]:grid-cols-4">
              {items.map((it) => {
                const g = it.generation;
                if (g.status !== "succeeded") {
                  return (
                    <li key={it.id} className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border p-2 text-xs text-muted">
                      <StatusBadge enum="image_generation_status" value={g.status} />
                      {(g.status === "queued" || g.status === "running") && <Spinner label="생성 중" />}
                      {g.errorMessage && <span className="text-center text-danger">{g.errorMessage}</span>}
                    </li>
                  );
                }
                return g.assets.map((a) => {
                  const isPrimary = primary === a.id;
                  return (
                    <li key={a.id} className={cx("flex flex-col gap-1 rounded-lg border p-1.5", isPrimary ? "border-accent" : "border-border")}>
                      <a href={a.url} target="_blank" rel="noreferrer" className="block">
                        <img src={a.url} alt={`${character.name} ${labelKo("character_sheet_view", v)} 시안`} loading="lazy" className="aspect-[2/3] w-full rounded-md bg-surface-2 object-contain" />
                      </a>
                      <Button
                        size="sm"
                        variant={isPrimary ? "primary" : "default"}
                        aria-pressed={isPrimary}
                        loading={select.isPending && select.variables?.assetId === a.id}
                        onClick={() => select.mutate({ view: v, assetId: isPrimary ? null : a.id })}
                      >
                        {isPrimary ? "대표 해제" : "대표로 지정"}
                      </Button>
                    </li>
                  );
                });
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
