import { useState, type ReactNode } from "react";
import type { StoryEnding, StoryStructureDto, UpdateStructureEndingRequest } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Badge, Button, Card, ConfirmDialog, Field, Select, Textarea } from "../../components/ui/index.js";
import { useUpdateEnding } from "./api.js";
import { nameOf } from "./tree.js";

type Character = { id: string; name: string };
type EndingPatch = UpdateStructureEndingRequest["ending"];

/** 결말 카드: 세계·갈등의 최종 상태, 갈등의 끝, 주인공의 변화, 인물별 최종 상태, 떡밥 회수. 보기 ↔ 편집. */
export function EndingCard({
  novelId,
  structure,
  names,
  characters,
}: {
  novelId: string;
  structure: StoryStructureDto;
  names: ReadonlyMap<string, string>;
  characters: Character[];
}) {
  const [editing, setEditing] = useState(false);
  const e = structure.ending;
  const ai = (k: string) => (structure.endingFieldOrigins[k] === "agent" ? <Badge tone="violet">AI 제안</Badge> : null);
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          결말
          {structure.pendingChanges.ending && <Badge tone="warn" glyph>승인 뒤 바뀜</Badge>}
        </span>
      }
      actions={
        !editing && (
          <Button size="sm" onClick={() => setEditing(true)}>
            결말 편집
          </Button>
        )
      }
    >
      {editing ? (
        <EndingEditor key={structure.revision} novelId={novelId} structure={structure} characters={characters} onDone={() => setEditing(false)} />
      ) : (
        <dl className="m-0 grid grid-cols-1 gap-3 text-[13px] min-[700px]:grid-cols-2">
          <Item label="세계·갈등의 최종 상태" badge={ai("worldState")} text={e.worldState} />
          <Item label="갈등의 끝" badge={ai("conflictResolution")} text={e.conflictResolution} />
          <div className="min-[700px]:col-span-2">
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">주인공의 변화 {ai("protagonistChange")}</dt>
            <dd className="m-0 mt-0.5">
              {e.protagonistChange.from || e.protagonistChange.to ? (
                <span className="flex flex-col gap-1 min-[700px]:flex-row min-[700px]:items-start">
                  <span className="whitespace-pre-wrap">{e.protagonistChange.from || <Empty />}</span>
                  <span aria-label="에서" className="text-muted">→</span>
                  <span className="whitespace-pre-wrap">{e.protagonistChange.to || <Empty />}</span>
                </span>
              ) : (
                <Empty />
              )}
            </dd>
          </div>
          <div className="min-[700px]:col-span-2">
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">인물별 최종 상태 {ai("characterFinalStates")}</dt>
            <dd className="m-0 mt-0.5">
              {e.characterFinalStates.length === 0 ? (
                <Empty />
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {e.characterFinalStates.map((c) => (
                    <li key={c.characterId}>
                      <b>{nameOf(names, c.characterId)}</b>: {c.finalState || <Empty />}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div className="min-[700px]:col-span-2">
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">회수할 떡밥 {ai("foreshadowPayoffs")}</dt>
            <dd className="m-0 mt-0.5">
              {e.foreshadowPayoffs.length === 0 ? (
                <Empty />
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {e.foreshadowPayoffs.map((f, i) => (
                    <li key={i}>
                      {f.setup} <span className="text-muted">→</span> {f.payoff || <Empty />}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function Item({ label, badge, text }: { label: string; badge: ReactNode; text: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">
        {label} {badge}
      </dt>
      <dd className="m-0 mt-0.5 whitespace-pre-wrap">{text || <Empty />}</dd>
    </div>
  );
}

function Empty() {
  return <span className="text-faint">비어 있음</span>;
}

/** changed keys only (a missing key is not changed) */
export function endingPatch(original: StoryEnding, next: StoryEnding): EndingPatch {
  const p: EndingPatch = {};
  if (next.worldState.trim() !== original.worldState) p.worldState = next.worldState.trim();
  if (next.conflictResolution.trim() !== original.conflictResolution) p.conflictResolution = next.conflictResolution.trim();
  const pc = { from: next.protagonistChange.from.trim(), to: next.protagonistChange.to.trim() };
  if (pc.from !== original.protagonistChange.from || pc.to !== original.protagonistChange.to) p.protagonistChange = pc;
  const finals = next.characterFinalStates.filter((c) => c.characterId).map((c) => ({ characterId: c.characterId, finalState: c.finalState.trim() }));
  if (JSON.stringify(finals) !== JSON.stringify(original.characterFinalStates)) p.characterFinalStates = finals;
  const pays = next.foreshadowPayoffs.filter((f) => f.setup.trim()).map((f) => ({ setup: f.setup.trim(), payoff: f.payoff.trim(), setupId: f.setupId ?? null }));
  if (JSON.stringify(pays) !== JSON.stringify(original.foreshadowPayoffs.map((f) => ({ ...f, setupId: f.setupId ?? null })))) p.foreshadowPayoffs = pays;
  return p;
}

function EndingEditor({ novelId, structure, characters, onDone }: { novelId: string; structure: StoryStructureDto; characters: Character[]; onDone: () => void }) {
  const original = structure.ending;
  const [form, setForm] = useState<StoryEnding>(() => structuredClone(original));
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateEnding(novelId);
  const patch = endingPatch(original, form);
  const dirty = Object.keys(patch).length > 0;
  const approved = structure.status === "approved";
  const save = () =>
    update.mutate(
      { expectedRevision: structure.revision, ending: patch },
      {
        onSuccess: () => onDone(),
        onSettled: () => setConfirming(false),
      },
    );
  const set = <K extends keyof StoryEnding>(k: K, v: StoryEnding[K]) => setForm((f) => ({ ...f, [k]: v }));
  const usedIds = new Set(form.characterFinalStates.map((c) => c.characterId));

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!dirty) return;
        if (approved) setConfirming(true);
        else save();
      }}
    >
      <div className="grid grid-cols-1 gap-3 min-[700px]:grid-cols-2">
        <Field label="세계·갈등의 최종 상태">
          <Textarea rows={4} maxLength={2000} value={form.worldState} onChange={(e) => set("worldState", e.target.value)} />
        </Field>
        <Field label="갈등의 끝">
          <Textarea rows={4} maxLength={2000} value={form.conflictResolution} onChange={(e) => set("conflictResolution", e.target.value)} />
        </Field>
        <Field label="주인공의 변화 — 시작">
          <Textarea rows={3} maxLength={1000} value={form.protagonistChange.from} onChange={(e) => set("protagonistChange", { ...form.protagonistChange, from: e.target.value })} />
        </Field>
        <Field label="주인공의 변화 — 끝">
          <Textarea rows={3} maxLength={1000} value={form.protagonistChange.to} onChange={(e) => set("protagonistChange", { ...form.protagonistChange, to: e.target.value })} />
        </Field>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">인물별 최종 상태</legend>
        {form.characterFinalStates.map((c, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 min-[700px]:grid-cols-[180px_1fr_auto]">
            <Field label="인물">
              <Select
                value={c.characterId}
                onChange={(e) => set("characterFinalStates", form.characterFinalStates.map((x, j) => (j === i ? { ...x, characterId: e.target.value } : x)))}
              >
                <option value="">고르세요</option>
                {characters
                  .filter((o) => o.id === c.characterId || !usedIds.has(o.id))
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="최종 상태">
              <Textarea
                rows={2}
                maxLength={1000}
                value={c.finalState}
                onChange={(e) => set("characterFinalStates", form.characterFinalStates.map((x, j) => (j === i ? { ...x, finalState: e.target.value } : x)))}
              />
            </Field>
            <Button variant="ghost" className="justify-self-start" aria-label={`인물 최종 상태 ${i + 1} 삭제`} onClick={() => set("characterFinalStates", form.characterFinalStates.filter((_, j) => j !== i))}>
              삭제
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" disabled={usedIds.size >= characters.length} onClick={() => set("characterFinalStates", [...form.characterFinalStates, { characterId: "", finalState: "" }])}>
            인물 추가
          </Button>
        </div>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">회수할 떡밥</legend>
        {form.foreshadowPayoffs.map((f, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 min-[700px]:grid-cols-[1fr_1fr_auto]">
            <Field label="떡밥">
              <Textarea rows={2} maxLength={500} value={f.setup} onChange={(e) => set("foreshadowPayoffs", form.foreshadowPayoffs.map((x, j) => (j === i ? { ...x, setup: e.target.value } : x)))} />
            </Field>
            <Field label="회수 방식">
              <Textarea rows={2} maxLength={1000} value={f.payoff} onChange={(e) => set("foreshadowPayoffs", form.foreshadowPayoffs.map((x, j) => (j === i ? { ...x, payoff: e.target.value } : x)))} />
            </Field>
            <Button variant="ghost" className="justify-self-start" aria-label={`떡밥 ${i + 1} 삭제`} onClick={() => set("foreshadowPayoffs", form.foreshadowPayoffs.filter((_, j) => j !== i))}>
              삭제
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => set("foreshadowPayoffs", [...form.foreshadowPayoffs, { setup: "", payoff: "", setupId: null }])}>
            떡밥 추가
          </Button>
        </div>
      </fieldset>

      {update.error && (
        <p className="m-0 text-xs text-danger" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>취소</Button>
        <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
          저장
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="승인된 결말을 바꿀까요?"
        description="승인된 결말을 바꾸면 다시 승인할 때까지 새 아웃라인·초고를 만들지 않습니다. 다시 승인하면 진행 중인 플롯에 확인 표시가 붙습니다."
        confirmLabel="바꾸기"
        busy={update.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={save}
      />
    </form>
  );
}
