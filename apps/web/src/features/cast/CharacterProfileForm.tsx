import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { CHARACTER_ROLE, labelKo, type CharacterDto, type CharacterPatchRequest, type CharacterRelationship, type CharacterRole } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Callout, ConfirmDialog, Field, Input, Select, Textarea } from "../../components/ui/index.js";
import { useAcceptCharacter, useDeleteCharacter, useUpdateCharacter } from "./api.js";

type TextField = "name" | "age" | "gender" | "personality" | "background" | "desire" | "weakness" | "notes";

interface FormState {
  role: CharacterRole;
  name: string;
  aliases: string;
  age: string;
  gender: string;
  personality: string;
  background: string;
  desire: string;
  weakness: string;
  notes: string;
  relationships: CharacterRelationship[];
}

const fromCharacter = (c: CharacterDto): FormState => ({
  role: c.role,
  name: c.name,
  aliases: c.aliases.join(", "),
  age: c.age,
  gender: c.gender,
  personality: c.personality,
  background: c.background,
  desire: c.desire,
  weakness: c.weakness,
  notes: c.notes,
  relationships: c.relationships,
});

const splitAliases = (s: string) =>
  s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const TEXT_FIELDS: Array<{ key: TextField; label: string; long?: boolean; placeholder?: string; max: number }> = [
  { key: "age", label: "나이", placeholder: "예: 17세, 30대 초반", max: 40 },
  { key: "gender", label: "성별", max: 40 },
  { key: "personality", label: "성격", long: true, max: 2000 },
  { key: "background", label: "배경", long: true, max: 4000 },
  { key: "desire", label: "욕망·목표", long: true, max: 2000 },
  { key: "weakness", label: "약점", long: true, max: 2000 },
  { key: "notes", label: "메모", long: true, max: 4000 },
];

/** 프로필 탭: 역할·이름·별칭·나이·성별·성격·배경·욕망·약점·관계·메모. AI가 채운 칸은 'AI 제안'으로 표시합니다. */
export function CharacterProfileForm({ novelId, character, cast }: { novelId: string; character: CharacterDto; cast: CharacterDto[] }) {
  const [form, setForm] = useState<FormState>(() => fromCharacter(character));
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateCharacter(novelId, character.id);
  const accept = useAcceptCharacter(novelId);
  const remove = useDeleteCharacter(novelId);
  const navigate = useNavigate();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const original = fromCharacter(character);
  const others = cast.filter((c) => c.id !== character.id);

  const patch = (): CharacterPatchRequest => {
    const p: Record<string, unknown> = {};
    if (form.role !== original.role) p.role = form.role;
    for (const k of ["name", "age", "gender", "personality", "background", "desire", "weakness", "notes"] as const) if (form[k].trim() !== original[k].trim()) p[k] = form[k].trim();
    if (form.aliases !== original.aliases) p.aliases = splitAliases(form.aliases);
    const rels = form.relationships.filter((r) => r.targetCharacterId && r.kind.trim());
    if (JSON.stringify(rels) !== JSON.stringify(original.relationships)) p.relationships = rels.map((r) => ({ ...r, kind: r.kind.trim(), description: r.description.trim() }));
    return p as CharacterPatchRequest;
  };
  const dirty = Object.keys(patch()).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !form.name.trim()) return;
    update.mutate(patch());
  };

  const aiTag = (k: string) => (character.fieldOrigins[k] === "agent" ? <Badge tone="violet" className="ml-1">AI 제안</Badge> : null);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`${character.name} 프로필`}>
      {character.proposed && (
        <Callout
          tone="info"
          title="AI가 제안한 캐릭터입니다"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => accept.mutate(character.id)} loading={accept.isPending}>
                제안 수락
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                빼기
              </Button>
            </>
          }
        >
          수락하면 지금 내용이 사용자가 정한 값이 되어 AI 초안이 더는 바꾸지 않습니다. 고쳐서 저장해도 됩니다.
        </Callout>
      )}
      <div className="grid gap-3 min-[640px]:grid-cols-2">
        <Field label="역할" hint={form.role === "protagonist" && original.role !== "protagonist" ? "저장하면 지금 주인공은 서브 주인공으로 바뀝니다." : undefined}>
          <Select value={form.role} onChange={(e) => set("role", e.target.value as CharacterRole)}>
            {CHARACTER_ROLE.map((r) => (
              <option key={r} value={r}>
                {labelKo("character_role", r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={<>이름{aiTag("name")}</>} required>
          <Input value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={<>별칭{aiTag("aliases")}</>} hint="쉼표로 구분합니다." className="min-[640px]:col-span-2">
          <Input value={form.aliases} onChange={(e) => set("aliases", e.target.value)} />
        </Field>
        {TEXT_FIELDS.map((f) => (
          <Field key={f.key} label={<>{f.label}{aiTag(f.key)}</>} className={f.long ? "min-[640px]:col-span-2" : undefined}>
            {f.long ? (
              <Textarea rows={3} maxLength={f.max} value={form[f.key]} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <Input maxLength={f.max} value={form[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        ))}
      </div>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">관계{aiTag("relationships")}</legend>
        {form.relationships.length === 0 && <p className="m-0 text-xs text-faint">다른 캐릭터와의 관계를 적으면 확정할 때 온톨로지 관계(동료·적대·형제 등)로도 기록합니다.</p>}
        {form.relationships.map((r, i) => (
          <div key={i} className="grid gap-2 min-[640px]:grid-cols-[1fr_1fr_2fr_auto] items-end">
            <Field label="상대">
              <Select
                value={r.targetCharacterId}
                onChange={(e) => set("relationships", form.relationships.map((x, j) => (j === i ? { ...x, targetCharacterId: e.target.value } : x)))}
              >
                <option value="">고르세요</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="관계 이름">
              <Input
                maxLength={40}
                placeholder="예: 소꿉친구, 숙적"
                value={r.kind}
                onChange={(e) => set("relationships", form.relationships.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}
              />
            </Field>
            <Field label="설명">
              <Input
                maxLength={500}
                value={r.description}
                onChange={(e) => set("relationships", form.relationships.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
              />
            </Field>
            <Button variant="ghost" className="justify-self-start" aria-label={`관계 ${i + 1} 삭제`} onClick={() => set("relationships", form.relationships.filter((_, j) => j !== i))}>
              삭제
            </Button>
          </div>
        ))}
        {others.length > 0 && (
          <div>
            <Button size="sm" onClick={() => set("relationships", [...form.relationships, { targetCharacterId: "", kind: "", description: "" }])}>
              관계 추가
            </Button>
          </div>
        )}
      </fieldset>

      {update.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(update.error)}</p>}
      {accept.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(accept.error)}</p>}
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="danger" onClick={() => setDeleting(true)}>
          캐릭터 삭제
        </Button>
        <div className="flex gap-2">
          <Button onClick={() => setForm(original)} disabled={!dirty}>
            되돌리기
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || !form.name.trim()} loading={update.isPending}>
            저장
          </Button>
        </div>
      </div>
      {character.status === "confirmed" && dirty && <p className="m-0 text-xs text-warn">저장하면 이 캐릭터는 초안으로 돌아가고 캐스트를 다시 확정해야 합니다.</p>}
      <ConfirmDialog
        open={deleting}
        danger
        title={`${character.name}을(를) 삭제할까요?`}
        description="다른 캐릭터의 이 캐릭터와의 관계도 함께 지워집니다. 이미 온톨로지에 등록된 인물은 그대로 남습니다."
        confirmLabel="삭제"
        busy={remove.isPending}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          remove.mutate(character.id, {
            onSuccess: () => navigate(novelPath(novelId, "cast")),
            onSettled: () => setDeleting(false),
          })
        }
      />
    </form>
  );
}
