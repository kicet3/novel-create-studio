import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { labelKo, type CastView, type CharacterDto, type CharacterRole, CHARACTER_ROLE } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Callout, Card, ConfirmDialog, Dialog, EmptyState, Field, Input, QueryView, Select, StatusBadge, Tabs, Textarea, Checkbox } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useCast, useConfirmCast, useCreateCharacter, useImportBrief, useReorderCast, useRequestCastDraft } from "./api.js";
import { CastCompleteness } from "./CastCompleteness.js";
import { CharacterProfileForm } from "./CharacterProfileForm.js";
import { DesignSheetTab } from "./DesignSheetTab.js";

/**
 * /novels/:novelId/cast(/:characterId) — 캐릭터 설정 단계 (설계 추가).
 * 컨셉(스토리라인) 승인 뒤, 연재 목표 전에 주인공 1명·서브 주인공 0..N명·기타 인물을 정하고 확정합니다.
 * 넓은 화면은 목록 + 상세 2단, 좁은 화면은 목록 → 상세(뒤로) 1단입니다.
 */
export function CastPage() {
  const novelId = useNovelId();
  const { characterId } = useParams();
  const cast = useCast(novelId);
  return (
    <>
      <PageHeader
        title="캐릭터"
        subtitle="스토리라인을 바탕으로 주인공과 서브 주인공, 그 밖의 인물을 정합니다. 확정한 캐스트는 기획서·아웃라인·본문 작성에 그대로 쓰입니다."
      />
      <QueryView query={cast} loadingLabel="캐릭터를 불러오는 중…">
        {(view) => <CastScreen novelId={novelId} view={view} selectedId={characterId ?? null} />}
      </QueryView>
    </>
  );
}

const GROUPS: Array<{ key: string; roles: CharacterRole[]; title: (n: number) => string }> = [
  { key: "protagonist", roles: ["protagonist"], title: () => "주인공" },
  { key: "sub", roles: ["sub_protagonist"], title: (n) => `서브 주인공 (${n}명)` },
  { key: "other", roles: ["antagonist", "supporting"], title: (n) => `기타 (${n}명)` },
];

function CastScreen({ novelId, view, selectedId }: { novelId: string; view: CastView; selectedId: string | null }) {
  const selected = view.items.find((c) => c.id === selectedId) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <StepCallout novelId={novelId} view={view} />
      <CastCompleteness novelId={novelId} view={view} />
      <Toolbar novelId={novelId} view={view} />
      <div className="grid gap-4 min-[1000px]:grid-cols-[minmax(280px,360px)_1fr]">
        <div className={cx(selected && "max-[999px]:hidden")}>
          <CastList novelId={novelId} view={view} selectedId={selected?.id ?? null} />
        </div>
        <div className={cx(!selected && "max-[999px]:hidden")}>
          {selected ? (
            <CharacterDetail key={selected.id} novelId={novelId} character={selected} cast={view.items} completeness={{ ...view.completeness, items: [...view.completeness.items, ...view.plotCompleteness.items] }} />
          ) : (
            <Card>
              <EmptyState title="캐릭터를 고르세요" description="왼쪽 목록에서 캐릭터를 고르면 프로필과 디자인 시트를 편집할 수 있습니다." />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function StepCallout({ novelId, view }: { novelId: string; view: CastView }) {
  if (view.confirmed) {
    return (
      <Callout tone="ok" title="캐스트가 확정됐습니다">
        주인공 {view.counts.protagonist}명, 서브 주인공 {view.counts.subProtagonist}명, 기타 {view.counts.other}명입니다. 고치면 다시 확정해야 합니다.
        {!view.goalSet && (
          <>
            {" "}
            <Link to={novelPath(novelId)}>작품 홈에서 연재 목표 정하기</Link>
          </>
        )}
      </Callout>
    );
  }
  return (
    <Callout tone={view.stepRequired ? "accent" : "warn"} title={view.stepRequired ? "캐릭터 설정 단계" : `확정하지 않은 변경이 있습니다${view.pendingChanges ? ` (${view.pendingChanges}명)` : ""}`}>
      주인공 1명을 정하고 [캐스트 확정]을 누르세요. 서브 주인공은 원하는 만큼(0명도 가능) 둘 수 있습니다.
      {view.stepRequired && " 캐스트를 확정해야 연재 목표를 저장하고 기획서 작성을 시작할 수 있습니다."}
      {view.goalSet && " 다시 확정하기 전까지 기획서·아웃라인·본문 작성에는 마지막으로 확정한 내용이 쓰입니다."}
      {view.blockers.length > 0 && (
        <ul className="m-0 mt-1 list-disc pl-5">
          {view.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

function Toolbar({ novelId, view }: { novelId: string; view: CastView }) {
  const [adding, setAdding] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const importBrief = useImportBrief(novelId);
  const confirm = useConfirmCast(novelId);
  const busyDraft = !!view.draftTask;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setConfirming(true)} disabled={view.blockers.length > 0 || view.confirmed} title={view.blockers[0]}>
          캐스트 확정
        </Button>
        <Button onClick={() => setAdding(true)}>캐릭터 추가</Button>
        <Button onClick={() => setDrafting(true)} loading={busyDraft} disabled={busyDraft}>
          {busyDraft ? "AI 초안 작성 중…" : "AI 초안 받기"}
        </Button>
        {view.canImportBrief && (
          <Button onClick={() => importBrief.mutate()} loading={importBrief.isPending}>
            컨셉 브리프에서 가져오기
          </Button>
        )}
      </div>
      {view.lastDraftError && <p className="m-0 text-xs text-danger" role="alert">{view.lastDraftError}</p>}
      {importBrief.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(importBrief.error)}</p>}
      {confirm.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(confirm.error)}</p>}
      <AddCharacterDialog novelId={novelId} open={adding} onClose={() => setAdding(false)} hasProtagonist={view.counts.protagonist > 0} />
      <DraftDialog novelId={novelId} open={drafting} onClose={() => setDrafting(false)} subCount={view.counts.subProtagonist} />
      <ConfirmDialog
        open={confirming}
        title="캐스트를 확정할까요?"
        description="확정하면 캐릭터가 세계관 온톨로지의 인물로 등록되고, 기획서·아웃라인·본문 작성에 쓰입니다. 나중에 고칠 수 있지만 다시 확정해야 합니다."
        confirmLabel="확정"
        busy={confirm.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => confirm.mutate(undefined, { onSettled: () => setConfirming(false) })}
      />
    </div>
  );
}

function AddCharacterDialog({ novelId, open, onClose, hasProtagonist }: { novelId: string; open: boolean; onClose: () => void; hasProtagonist: boolean }) {
  const [role, setRole] = useState<CharacterRole>(hasProtagonist ? "sub_protagonist" : "protagonist");
  const [name, setName] = useState("");
  const create = useCreateCharacter(novelId);
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { role, name: name.trim() },
      {
        onSuccess: (c) => {
          setName("");
          onClose();
          navigate(novelPath(novelId, `cast/${c.id}`));
        },
      },
    );
  };
  return (
    <Dialog open={open} onClose={onClose} title="캐릭터 추가" size="sm" footer={false}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="역할" hint={role === "protagonist" && hasProtagonist ? "지금 주인공은 서브 주인공으로 바뀝니다." : undefined}>
          <Select value={role} onChange={(e) => setRole(e.target.value as CharacterRole)}>
            {CHARACTER_ROLE.map((r) => (
              <option key={r} value={r}>
                {labelKo("character_role", r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="이름" required error={create.error ? errorMessage(create.error) : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            추가
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DraftDialog({ novelId, open, onClose, subCount }: { novelId: string; open: boolean; onClose: () => void; subCount: number }) {
  const [count, setCount] = useState("");
  const [includeAntagonist, setIncludeAntagonist] = useState(true);
  const [instructions, setInstructions] = useState("");
  const draft = useRequestCastDraft(novelId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = count.trim() === "" ? undefined : Number(count);
    draft.mutate(
      { subProtagonistCount: n, includeAntagonist, instructions: instructions.trim() || undefined },
      { onSuccess: () => onClose() },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="AI 초안 받기"
      description="승인된 컨셉 브리프를 바탕으로 AI가 캐릭터를 제안합니다. 직접 정한 항목은 바꾸지 않고, 새 캐릭터는 'AI 제안'으로 추가됩니다."
      footer={false}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="서브 주인공 수" hint={`비워 두면 AI가 이야기에 맞게 정합니다. 지금 ${subCount}명이 있습니다.`}>
          <Input type="number" inputMode="numeric" min={0} max={10} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Checkbox label="적대자도 제안받기" checked={includeAntagonist} onChange={(e) => setIncludeAntagonist(e.target.checked)} />
        <Field label="추가 요청 (선택)">
          <Textarea rows={3} maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="예: 서브 주인공 중 한 명은 주인공의 라이벌로" />
        </Field>
        {draft.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(draft.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" loading={draft.isPending}>
            초안 요청
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CastList({ novelId, view, selectedId }: { novelId: string; view: CastView; selectedId: string | null }) {
  const reorder = useReorderCast(novelId);
  const ids = view.items.map((c) => c.id);
  const move = (c: CharacterDto, dir: -1 | 1) => {
    // reorder within the role group shown on screen
    const group = view.items.filter((x) => x.role === c.role);
    const i = group.findIndex((x) => x.id === c.id);
    const swap = group[i + dir];
    if (!swap) return;
    const next = [...ids];
    const a = next.indexOf(c.id);
    const b = next.indexOf(swap.id);
    [next[a], next[b]] = [next[b]!, next[a]!];
    reorder.mutate(next);
  };
  if (view.items.length === 0) {
    return (
      <Card>
        <EmptyState
          title="아직 캐릭터가 없습니다"
          description="[캐릭터 추가]로 주인공을 직접 만들거나 [AI 초안 받기]로 제안을 받으세요."
        />
      </Card>
    );
  }
  return (
    <nav aria-label="캐릭터 목록" className="flex flex-col gap-3">
      {GROUPS.map((g) => {
        const members = view.items.filter((c) => g.roles.includes(c.role));
        return (
          <section key={g.key} aria-labelledby={`cast-group-${g.key}`} className="rounded-xl border border-border bg-surface p-2">
            <h2 id={`cast-group-${g.key}`} className="px-1 pb-1 text-[13px] font-bold">
              {g.title(members.length)}
            </h2>
            {members.length === 0 ? (
              <p className="m-0 px-1 pb-1 text-xs text-faint">{g.key === "protagonist" ? "주인공을 1명 정하세요." : "없음"}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {members.map((c, i) => (
                  <li key={c.id} className={cx("flex items-center gap-2 rounded-lg px-1 py-1", c.id === selectedId && "bg-accent-soft")}>
                    <Link
                      to={novelPath(novelId, `cast/${c.id}`)}
                      aria-current={c.id === selectedId ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md no-underline text-text"
                    >
                      <Thumb character={c} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{c.name}</span>
                        <span className="flex flex-wrap gap-1">
                          {g.key === "other" && <Badge tone="neutral">{labelKo("character_role", c.role)}</Badge>}
                          <StatusBadge enum="character_status" value={c.status} tone={c.status === "confirmed" ? "ok" : "neutral"} />
                          {c.proposed && <Badge tone="violet">AI 제안</Badge>}
                          {c.introducedArcId && <Badge tone="info">{c.firstAppearanceArcTitle ? `${c.firstAppearanceArcTitle} 플롯에서 등장` : "플롯에서 등장"}</Badge>}
                        </span>
                      </span>
                    </Link>
                    {members.length > 1 && (
                      <span className="flex flex-none items-center gap-0.5">
                        <Button size="sm" variant="ghost" className="w-8 px-0" aria-label={`${c.name} 위로`} disabled={i === 0 || reorder.isPending} onClick={() => move(c, -1)}>
                          ▲
                        </Button>
                        <Button size="sm" variant="ghost" className="w-8 px-0" aria-label={`${c.name} 아래로`} disabled={i === members.length - 1 || reorder.isPending} onClick={() => move(c, 1)}>
                          ▼
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {reorder.error && <p className="m-0 text-xs text-danger" role="alert">{errorMessage(reorder.error)}</p>}
    </nav>
  );
}

function Thumb({ character }: { character: CharacterDto }) {
  if (character.thumbnailUrl) return <img src={character.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md border border-border object-cover" loading="lazy" />;
  return (
    <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-2 text-sm font-bold text-muted">
      {character.name.slice(0, 1)}
    </span>
  );
}

function CharacterDetail({ novelId, character, cast, completeness }: { novelId: string; character: CharacterDto; cast: CharacterDto[]; completeness: CastView["completeness"] }) {
  const [tab, setTab] = useState<"profile" | "sheet">("profile");
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {character.name}
          <Badge tone={character.role === "protagonist" ? "accent" : "neutral"}>{labelKo("character_role", character.role)}</Badge>
          <StatusBadge enum="character_status" value={character.status} tone={character.status === "confirmed" ? "ok" : "neutral"} />
          {character.introducedArcId && <Badge tone="info">{character.firstAppearanceArcTitle ? `${character.firstAppearanceArcTitle} 플롯에서 등장` : "플롯에서 등장"}</Badge>}
        </span>
      }
      actions={
        <Link to={novelPath(novelId, "cast")} className="text-xs min-[1000px]:hidden">
          ← 목록
        </Link>
      }
    >
      <Tabs
        label="캐릭터 상세"
        value={tab}
        onChange={setTab}
        items={[
          { value: "profile", label: "프로필", panel: <CharacterProfileForm key={character.updatedAt} novelId={novelId} character={character} cast={cast} completeness={completeness} /> },
          { value: "sheet", label: "디자인 시트", adornment: character.hasDesignSheet ? <span className="sr-only">(작성됨)</span> : undefined, panel: <DesignSheetTab novelId={novelId} character={character} /> },
        ]}
      />
    </Card>
  );
}

