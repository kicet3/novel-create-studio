import { useState, type FormEvent } from "react";
import type { PlotOutlineItem, StoryPartDto, StoryStructureDto, StructureCharacterState, UpdateStoryPartRequest } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Button, Callout, Dialog, Field, Input, Select, Textarea } from "../../components/ui/index.js";
import { useUpdatePart } from "./api.js";
import { outlineSumMismatch } from "./tree.js";

type Character = { id: string; name: string };

interface PartForm {
  title: string;
  goalText: string;
  turningPoints: string;
  from: string;
  to: string;
  characterStates: StructureCharacterState[];
  plotOutline: Array<{ title: string; coreEvent: string; episodeCount: string }>;
}

const fromPart = (p: StoryPartDto): PartForm => ({
  title: p.title,
  goalText: p.goalText,
  turningPoints: p.turningPoints.join("\n"),
  from: String(p.plannedEpisodeFrom),
  to: String(p.plannedEpisodeTo),
  characterStates: p.characterStates.map((c) => ({ ...c })),
  plotOutline: p.plotOutline.map((o) => ({ title: o.title, coreEvent: o.coreEvent, episodeCount: String(o.episodeCount) })),
});

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

/** changed keys only; returns an error string when the input is invalid */
export function partPatch(p: StoryPartDto, f: PartForm): { body: Omit<UpdateStoryPartRequest, "expectedRevision">; error: string | null } {
  const body: Omit<UpdateStoryPartRequest, "expectedRevision"> = {};
  if (f.title.trim() !== p.title) body.title = f.title.trim();
  if (f.goalText.trim() !== p.goalText) body.goalText = f.goalText.trim();
  const tps = lines(f.turningPoints);
  if (JSON.stringify(tps) !== JSON.stringify(p.turningPoints)) body.turningPoints = tps;
  const from = Number(f.from);
  const to = Number(f.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return { body, error: "화 범위는 1 이상, 시작 ≤ 끝인 정수로 입력하세요." };
  if (from !== p.plannedEpisodeFrom) body.plannedEpisodeFrom = from;
  if (to !== p.plannedEpisodeTo) body.plannedEpisodeTo = to;
  const states = f.characterStates.filter((c) => c.characterId).map((c) => ({ characterId: c.characterId, state: c.state.trim() }));
  if (JSON.stringify(states) !== JSON.stringify(p.characterStates)) body.characterStates = states;
  const outline: PlotOutlineItem[] = [];
  for (const o of f.plotOutline) {
    if (!o.title.trim()) continue;
    const n = Number(o.episodeCount);
    if (!Number.isInteger(n) || n < 1) return { body, error: `플롯 「${o.title.trim()}」의 화 수는 1 이상의 정수여야 합니다.` };
    outline.push({ title: o.title.trim(), coreEvent: o.coreEvent.trim(), episodeCount: n });
  }
  if (JSON.stringify(outline) !== JSON.stringify(p.plotOutline)) body.plotOutline = outline;
  return { body, error: null };
}

/** 부 편집: 제목·목표·전환점·화 범위·부 끝 인물 상태·플롯 개요(행 추가·삭제). */
export function PartEditorDialog({
  novelId,
  structure,
  part,
  mainCharacters,
  allCharacters,
  onClose,
}: {
  novelId: string;
  structure: StoryStructureDto;
  part: StoryPartDto;
  mainCharacters: Character[];
  allCharacters: Character[];
  onClose: () => void;
}) {
  const [form, setForm] = useState<PartForm>(() => fromPart(part));
  const update = useUpdatePart(novelId);
  const set = <K extends keyof PartForm>(k: K, v: PartForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { body, error } = partPatch(part, form);
  const dirty = Object.keys(body).length > 0;
  const mismatch = outlineSumMismatch(
    Number(form.from),
    Number(form.to),
    form.plotOutline.filter((o) => o.title.trim()).map((o) => ({ episodeCount: Number(o.episodeCount) })),
  );
  const usedIds = new Set(form.characterStates.map((c) => c.characterId));
  const missingMain = mainCharacters.filter((c) => !usedIds.has(c.id));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (error || !dirty) return;
    update.mutate({ partId: part.id, body: { expectedRevision: structure.revision, ...body } }, { onSuccess: onClose });
  };
  const outlineSet = (i: number, k: "title" | "coreEvent" | "episodeCount", v: string) =>
    set(
      "plotOutline",
      form.plotOutline.map((x, j) => (j === i ? { ...x, [k]: v } : x)),
    );

  return (
    <Dialog open onClose={onClose} title={`${part.ord}부 편집`} size="lg" footer={false}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {structure.status === "approved" && <Callout tone="warn">승인된 구성의 부를 바꾸면 다시 승인할 때까지 새 아웃라인·초고를 만들지 않습니다. 다시 승인하면 이 부의 진행 중인 플롯에 확인 표시가 붙습니다.</Callout>}
        <div className="grid grid-cols-1 gap-3 min-[700px]:grid-cols-[1fr_120px_120px]">
          <Field label="제목">
            <Input maxLength={200} value={form.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="시작 화">
            <Input type="number" inputMode="numeric" min={1} value={form.from} onChange={(e) => set("from", e.target.value)} />
          </Field>
          <Field label="끝 화">
            <Input type="number" inputMode="numeric" min={1} value={form.to} onChange={(e) => set("to", e.target.value)} />
          </Field>
        </div>
        <p className="m-0 -mt-1 text-xs text-muted">범위를 바꾸면 이웃 부의 경계도 함께 움직입니다. 이미 진행 중인 화가 있는 범위는 줄일 수 없습니다.</p>
        <Field label="부 목표">
          <Textarea rows={3} maxLength={2000} value={form.goalText} onChange={(e) => set("goalText", e.target.value)} />
        </Field>
        <Field label="전환점" hint="한 줄에 하나씩, 최대 10개">
          <Textarea rows={3} value={form.turningPoints} onChange={(e) => set("turningPoints", e.target.value)} />
        </Field>

        <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <legend className="px-1 text-[12.5px] font-semibold text-muted">부 끝 인물 상태</legend>
          {missingMain.length > 0 && <p className="m-0 text-xs text-warn">아직 적지 않은 주인공·서브 주인공: {missingMain.map((c) => c.name).join(", ")}</p>}
          {form.characterStates.map((c, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-2 min-[700px]:grid-cols-[180px_1fr_auto]">
              <Field label="인물">
                <Select value={c.characterId} onChange={(e) => set("characterStates", form.characterStates.map((x, j) => (j === i ? { ...x, characterId: e.target.value } : x)))}>
                  <option value="">고르세요</option>
                  {allCharacters
                    .filter((o) => o.id === c.characterId || !usedIds.has(o.id))
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="부 끝 상태">
                <Textarea rows={2} maxLength={1000} value={c.state} onChange={(e) => set("characterStates", form.characterStates.map((x, j) => (j === i ? { ...x, state: e.target.value } : x)))} />
              </Field>
              <Button variant="ghost" className="justify-self-start" aria-label={`인물 상태 ${i + 1} 삭제`} onClick={() => set("characterStates", form.characterStates.filter((_, j) => j !== i))}>
                삭제
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" disabled={usedIds.size >= allCharacters.length} onClick={() => set("characterStates", [...form.characterStates, { characterId: missingMain[0]?.id ?? "", state: "" }])}>
              인물 추가
            </Button>
          </div>
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <legend className="px-1 text-[12.5px] font-semibold text-muted">플롯 개요 (큰 사건)</legend>
          {form.plotOutline.map((o, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-2 min-[700px]:grid-cols-[1fr_2fr_90px_auto]">
              <Field label="플롯 제목">
                <Input maxLength={200} value={o.title} onChange={(e) => outlineSet(i, "title", e.target.value)} />
              </Field>
              <Field label="핵심 사건">
                <Textarea rows={2} maxLength={1000} value={o.coreEvent} onChange={(e) => outlineSet(i, "coreEvent", e.target.value)} />
              </Field>
              <Field label="화 수">
                <Input type="number" inputMode="numeric" min={1} value={o.episodeCount} onChange={(e) => outlineSet(i, "episodeCount", e.target.value)} />
              </Field>
              <Button variant="ghost" className="justify-self-start" aria-label={`플롯 ${i + 1} 삭제`} onClick={() => set("plotOutline", form.plotOutline.filter((_, j) => j !== i))}>
                삭제
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" disabled={form.plotOutline.length >= 20} onClick={() => set("plotOutline", [...form.plotOutline, { title: "", coreEvent: "", episodeCount: "2" }])}>
              플롯 추가
            </Button>
          </div>
          {mismatch && <p className="m-0 text-xs text-warn">{mismatch}</p>}
        </fieldset>

        {(error || update.error) && (
          <p className="m-0 text-xs text-danger" role="alert">
            {error ?? errorMessage(update.error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" disabled={!dirty || !!error} loading={update.isPending}>
            저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
