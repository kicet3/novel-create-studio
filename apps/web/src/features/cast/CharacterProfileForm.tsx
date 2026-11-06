import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  CHARACTER_ROLE,
  labelKo,
  type CastCompleteness,
  type CharacterDto,
  type CharacterPatchRequest,
  type CharacterRelationship,
  type CharacterRequirementField,
  type CharacterRole,
} from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Callout, ConfirmDialog, Field, Input, Select, Textarea } from "../../components/ui/index.js";
import { useAcceptCharacter, useDeleteCharacter, useUpdateCharacter } from "./api.js";
import { isRequiredField, missingFieldsOf } from "./completeness.js";

const TEXT_KEYS = [
  "name", "age", "gender", "appearance", "personality", "desire", "motivation", "weakness", "background",
  "speechSample", "arcStart", "arcEnd", "storyRole", "notes",
] as const;
type TextField = Exclude<(typeof TEXT_KEYS)[number], "name">;

type FormState = Record<(typeof TEXT_KEYS)[number], string> & {
  role: CharacterRole;
  aliases: string;
  firstAppearanceEpisodeNo: string;
  relationships: CharacterRelationship[];
};

const fromCharacter = (c: CharacterDto): FormState => ({
  role: c.role,
  name: c.name,
  aliases: c.aliases.join(", "),
  age: c.age,
  gender: c.gender,
  appearance: c.appearance,
  personality: c.personality,
  desire: c.desire,
  motivation: c.motivation,
  weakness: c.weakness,
  background: c.background,
  speechSample: c.speechSample,
  arcStart: c.arcStart,
  arcEnd: c.arcEnd,
  storyRole: c.storyRole,
  notes: c.notes,
  firstAppearanceEpisodeNo: c.firstAppearanceEpisodeNo == null ? "" : String(c.firstAppearanceEpisodeNo),
  relationships: c.relationships,
});

const splitAliases = (s: string) =>
  s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const SUPPORT_ROLES: readonly CharacterRole[] = ["supporting", "antagonist"];

interface TextFieldSpec {
  key: TextField;
  label: string;
  rows?: number;
  placeholder?: string;
  hint?: string;
  max: number;
  /** only shown for these roles */
  roles?: readonly CharacterRole[];
}

const TEXT_FIELDS: TextFieldSpec[] = [
  { key: "storyRole", label: "이야기 속 역할", placeholder: "예: 주인공을 막는 조직의 2인자", max: 200, roles: SUPPORT_ROLES },
  { key: "age", label: "나이", placeholder: "예: 17세, 30대 초반", max: 40 },
  { key: "gender", label: "성별", max: 40 },
  { key: "appearance", label: "외형 요약", rows: 2, placeholder: "키·체격·인상·눈에 띄는 특징", max: 1000 },
  { key: "personality", label: "성격(장점·결점)", rows: 3, max: 2000 },
  { key: "desire", label: "목표·욕망", rows: 2, max: 2000 },
  { key: "motivation", label: "동기", rows: 2, hint: "왜 그 목표를 원하는가", max: 2000 },
  { key: "weakness", label: "두려움·약점", rows: 2, max: 2000 },
  { key: "background", label: "핵심 과거사", rows: 3, hint: "2~3줄", max: 4000 },
  { key: "speechSample", label: "말투 예시", rows: 2, hint: "1~2줄, 대사 그대로", placeholder: "“그래서, 네가 책임질 거야?”", max: 500 },
  { key: "arcStart", label: "변화 아크 — 시작", rows: 2, max: 1000 },
  { key: "arcEnd", label: "변화 아크 — 끝", rows: 2, max: 1000 },
  { key: "notes", label: "메모", rows: 3, max: 4000 },
];

const REQUIREMENT_OF: Partial<Record<TextField, CharacterRequirementField>> = {
  age: "age", appearance: "appearance", personality: "personality", desire: "desire", motivation: "motivation", weakness: "weakness",
  background: "background", speechSample: "speechSample", arcStart: "arcStart", arcEnd: "arcEnd", storyRole: "storyRole",
};

/**
 * 프로필 탭: 역할·이름·별칭과 구성 전 필수 항목(외형·성격·목표·동기·약점·과거사·말투 예시·변화 아크, 조연·적대자는 역할·목표·주인공과의 관계),
 * 첫 등장 화, 관계, 메모. 역할별 필수 항목에 * 표시, 비어 있는 필수 항목은 강조합니다. AI가 채운 칸은 'AI 제안'으로 표시합니다.
 */
export function CharacterProfileForm({
  novelId,
  character,
  cast,
  completeness,
}: {
  novelId: string;
  character: CharacterDto;
  cast: CharacterDto[];
  completeness?: CastCompleteness;
}) {
  const [form, setForm] = useState<FormState>(() => fromCharacter(character));
  const [deleting, setDeleting] = useState(false);
  // empty required fields turn red only after the author touched them or tried to save (a neutral hint before)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const touch = (k: string) => setTouched((t) => (t.has(k) ? t : new Set([...t, k])));
  const update = useUpdateCharacter(novelId, character.id);
  const accept = useAcceptCharacter(novelId);
  const remove = useDeleteCharacter(novelId);
  const navigate = useNavigate();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const original = fromCharacter(character);
  const others = cast.filter((c) => c.id !== character.id);
  const missing = missingFieldsOf(completeness, character.id);
  const firstNo = form.firstAppearanceEpisodeNo.trim();
  const firstNoInvalid = firstNo !== "" && !(Number.isInteger(Number(firstNo)) && Number(firstNo) >= 1);

  const patch = (): CharacterPatchRequest => {
    const p: Record<string, unknown> = {};
    if (form.role !== original.role) p.role = form.role;
    for (const k of TEXT_KEYS) if (form[k].trim() !== original[k].trim()) p[k] = form[k].trim();
    if (form.aliases !== original.aliases) p.aliases = splitAliases(form.aliases);
    if (firstNo !== original.firstAppearanceEpisodeNo && !firstNoInvalid) p.firstAppearanceEpisodeNo = firstNo === "" ? null : Number(firstNo);
    const rels = form.relationships.filter((r) => r.targetCharacterId && r.kind.trim());
    if (JSON.stringify(rels) !== JSON.stringify(original.relationships)) p.relationships = rels.map((r) => ({ ...r, kind: r.kind.trim(), description: r.description.trim() }));
    return p as CharacterPatchRequest;
  };
  const dirty = Object.keys(patch()).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!dirty || !form.name.trim() || firstNoInvalid) return;
    update.mutate(patch());
  };

  /** 비어 있는 필수 항목(입력하면 사라짐) */
  const isGap = (k: TextField) => {
    const req = REQUIREMENT_OF[k];
    return !!req && missing.has(req) && !form[k].trim();
  };
  const gap = (k: TextField) => (isGap(k) && (submitted || touched.has(k)) ? "구성 전에 채워야 하는 항목입니다." : undefined);
  const gapHint = (k: TextField, hint?: string) => (isGap(k) && !gap(k) ? [hint, "구성 전에 채워야 합니다."].filter(Boolean).join(" · ") : hint);
  const required = (k: TextField) => {
    const req = REQUIREMENT_OF[k];
    return !!req && isRequiredField(form.role, req);
  };
  const relationGap = missing.has("relationships") || missing.has("relationToProtagonist");
  const protagonist = cast.find((c) => c.role === "protagonist" && c.id !== character.id);

  // an AI-proposed character (drafted or introduced by a plot) vs. the author's character whose empty fields AI filled
  const aiCharacter = character.proposed && (character.fieldOrigins.name === "agent" || !!character.introducedArcId);
  const agentFilled = Object.values(character.fieldOrigins).some((o) => o === "agent");
  const aiTag = (k: string) => (character.fieldOrigins[k] === "agent" ? <Badge tone="violet" className="ml-1">AI 제안</Badge> : null);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`${character.name} 프로필`}>
      {!aiCharacter && agentFilled && (
        <Callout
          tone="info"
          title="AI가 빈 항목을 채웠습니다"
          actions={
            <Button size="sm" variant="primary" onClick={() => accept.mutate(character.id)} loading={accept.isPending}>
              AI 값 수락
            </Button>
          }
        >
          ‘AI 제안’ 표시가 붙은 칸을 확인하세요. 고쳐서 저장하거나 수락하면 사용자가 정한 값이 됩니다. 반영하려면 캐스트를 다시 확정하세요.
        </Callout>
      )}
      {aiCharacter && (
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
        {TEXT_FIELDS.filter((f) => !f.roles || f.roles.includes(form.role)).map((f) => (
          <Field
            key={f.key}
            label={<>{f.label}{aiTag(f.key)}</>}
            required={required(f.key)}
            hint={gapHint(f.key, f.hint)}
            error={gap(f.key)}
            className={f.rows ? "min-[640px]:col-span-2" : undefined}
          >
            {f.rows ? (
              <Textarea rows={f.rows} maxLength={f.max} value={form[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} onBlur={() => touch(f.key)} />
            ) : (
              <Input maxLength={f.max} value={form[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} onBlur={() => touch(f.key)} />
            )}
          </Field>
        ))}
        <Field
          label={<>첫 등장 화{aiTag("firstAppearanceEpisodeNo")}</>}
          hint={character.firstAppearanceArcTitle ? `「${character.firstAppearanceArcTitle}」 플롯에서 등장합니다. 비워 두면 구성·플롯 계획에서 정합니다.` : "비워 두면 구성·플롯 계획에서 정합니다."}
          error={firstNoInvalid ? "1 이상의 정수를 입력하세요." : undefined}
        >
          <Input type="number" inputMode="numeric" min={1} value={form.firstAppearanceEpisodeNo} onChange={(e) => set("firstAppearanceEpisodeNo", e.target.value)} placeholder="예: 1" />
        </Field>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <legend className="px-1 text-[12.5px] font-semibold text-muted">
          관계{aiTag("relationships")}
          {(form.role === "protagonist" ? isRequiredField(form.role, "relationships") && others.length > 0 : true) && (
            <span className="text-danger" aria-hidden="true">
              {" "}
              *
            </span>
          )}
        </legend>
        {relationGap && (
          <p className={submitted ? "m-0 text-xs text-danger" : "m-0 text-xs text-muted"}>
            {form.role === "protagonist" ? "주요 인물과의 관계를 1개 이상 적으세요." : `주인공${protagonist ? `(${protagonist.name})` : ""}과의 관계를 적으세요. 주인공 쪽에 적어도 됩니다.`}
          </p>
        )}
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
          <Button type="submit" variant="primary" disabled={!dirty || !form.name.trim() || firstNoInvalid} loading={update.isPending}>
            저장
          </Button>
        </div>
      </div>
      {firstNoInvalid && <p className="m-0 text-xs text-danger">첫 등장 화를 고쳐야 저장할 수 있습니다.</p>}
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
