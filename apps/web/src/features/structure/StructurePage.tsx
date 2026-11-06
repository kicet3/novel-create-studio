import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import type { StructureView } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, ButtonLink, Callout, Card, Dialog, EmptyState, Field, QueryView, Select, Textarea, type Tone } from "../../components/ui/index.js";
import { useCast } from "../cast/api.js";
import { useGenerateStructure, useStructure, useStructureDecision } from "./api.js";
import { EndingCard } from "./EndingCard.js";
import { PartTree } from "./PartTree.js";
import { buildTree, DISPLAY_STATUS_LABEL, displayStatus, pendingChangeLines, rangeLabel, type StructureDisplayStatus } from "./tree.js";

/**
 * /novels/:novelId/structure(/plots/:arcId) — 전체 구성.
 * 결말과 1~4부를 정하고 작가가 승인하면(자율 단계와 상관없이 항상 사용자 승인) 부마다 플롯이 만들어지고,
 * 플롯마다 화 계획이 이어집니다. 캐릭터 필수 항목이 비어 있으면 구성을 만들 수 없습니다(게이트).
 */
export function StructurePage() {
  const novelId = useNovelId();
  const { arcId } = useParams();
  const q = useStructure(novelId);
  return (
    <>
      <PageHeader title="전체 구성" subtitle="결말과 1~4부를 정하고 승인하면 부마다 플롯과 화를 계획합니다." />
      <QueryView query={q} loadingLabel="전체 구성을 불러오는 중…">
        {(view) => <StructureScreen novelId={novelId} view={view} selectedArcId={arcId ?? null} />}
      </QueryView>
    </>
  );
}

function StructureScreen({ novelId, view, selectedArcId }: { novelId: string; view: StructureView; selectedArcId: string | null }) {
  const cast = useCast(novelId);
  const names = useMemo(() => new Map((cast.data?.items ?? []).map((c) => [c.id, c.name] as const)), [cast.data]);
  const mainCharacters = useMemo(
    () => (cast.data?.items ?? []).filter((c) => c.role === "protagonist" || c.role === "sub_protagonist").map((c) => ({ id: c.id, name: c.name })),
    [cast.data],
  );
  const allCharacters = useMemo(() => (cast.data?.items ?? []).map((c) => ({ id: c.id, name: c.name })), [cast.data]);
  const tree = useMemo(() => buildTree(view), [view]);
  const s = view.structure;

  return (
    <div className="flex flex-col gap-4">
      <Gate novelId={novelId} view={view} />
      {s && (
        <>
          <StatusBar novelId={novelId} view={view} />
          <EndingCard novelId={novelId} structure={s} names={names} characters={allCharacters} />
          <PartTree
            novelId={novelId}
            structure={s}
            tree={tree}
            names={names}
            mainCharacters={mainCharacters}
            allCharacters={allCharacters}
            selectedArcId={selectedArcId}
            totalEpisodes={view.goal?.totalEpisodesMax ?? view.goal?.totalEpisodesMin ?? null}
          />
        </>
      )}
      {!s && tree.unassigned.length > 0 && (
        <Card title="기존 아크">
          <p className="m-0 mb-2 text-[13px] text-muted">이 작품은 전체 구성 기능 이전에 만든 아크로 연재 중입니다. 기존 아크는 그대로 진행됩니다.</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {tree.unassigned.map((n) => (
              <li key={n.plot.id}>
                {n.plot.ord}. {n.plot.title} ({rangeLabel(n.plot.plannedEpisodeFrom, n.plot.plannedEpisodeTo)})
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ── 게이트(캐릭터 완성도·기획서 승인) + 첫 생성 ──
function Gate({ novelId, view }: { novelId: string; view: StructureView }) {
  const s = view.structure;
  const cast = view.gate.cast;
  // the cast reason has its own callout (with a link to the cast screen); before the concept is approved the cast
  // cannot be edited yet, so only the concept step is shown
  const conceptPending = view.gate.codes.includes("concept_not_approved");
  const otherReasons = view.gate.reasons.filter((r) => r !== cast.message);
  const castMissing = cast.items.some((i) => i.missing.length > 0) || cast.items.length === 0;
  return (
    <>
      {view.task && (
        <Callout tone="info" title="AI가 전체 구성을 만드는 중입니다">
          결말과 1~4부를 설계하고 있습니다. 끝나면 이 화면과 인박스에 승인 요청이 나타납니다.
        </Callout>
      )}
      {view.lastError && !view.task && (
        <Callout tone="danger" title="전체 구성을 만들지 못했습니다">
          {view.lastError}
        </Callout>
      )}
      {!s && !view.gate.canGenerate && otherReasons.length > 0 && (
        <Callout tone="warn" title="아직 전체 구성을 만들 수 없습니다">
          <ol className="m-0 mt-1 pl-5">
            {otherReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </Callout>
      )}
      {!cast.complete && !conceptPending && (
        <Callout
          tone="warn"
          title={
            castMissing
              ? s
                ? "캐릭터 설정이 비어 있어 구성을 승인할 수 없습니다"
                : "전체 구성을 만들기 전에 캐릭터 설정을 보완하세요"
              : "캐릭터 화면에서 캐스트를 확정해야 합니다"
          }
          actions={
            <ButtonLink to={novelPath(novelId, "cast")} size="sm" variant="primary">
              캐릭터 보완하기
            </ButtonLink>
          }
        >
          {cast.items.length === 0 && <p className="m-0">{cast.message.replace(/^전체 구성을 만들기 전에 [^.]*\.\s*/, "")}</p>}
          <ul className="m-0 mt-1 list-disc pl-5 empty:hidden">
            {cast.items.map((i) => (
              <li key={i.characterId}>
                <b>{i.name}</b>: {[...i.missing.map((m) => `${m.label} 비어 있음`), ...(i.unconfirmed ? ["확정 전"] : [])].join(", ")}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {!s && !view.task && <FirstGenerate novelId={novelId} view={view} />}
    </>
  );
}

function FirstGenerate({ novelId, view }: { novelId: string; view: StructureView }) {
  const [instructions, setInstructions] = useState("");
  const gen = useGenerateStructure(novelId);
  const can = view.gate.canGenerate;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    gen.mutate({ scope: "all", instructions: instructions.trim() || undefined });
  };
  const g = view.goal;
  return (
    <Card>
      <EmptyState
        className="border-0 py-6"
        title="아직 전체 구성이 없습니다"
        description={
          <>
            AI가 결말을 먼저 정하고, 1~4부를 결말로 가는 단계로 나눠 제안합니다. 승인한 뒤에야 플롯과 화 계획이 시작됩니다.
            {g && (
              <>
                {" "}
                연재 목표: {g.totalEpisodesMax && g.totalEpisodesMax !== g.totalEpisodesMin ? `${g.totalEpisodesMin}~${g.totalEpisodesMax}화` : `${g.totalEpisodesMin}화`}
                {g.endingDirection ? ` · 결말 방향 “${g.endingDirection}”` : ""}
              </>
            )}
          </>
        }
      />
      <form onSubmit={submit} className="mx-auto flex w-full max-w-lg flex-col gap-3">
          <Field label="추가 요청 (선택)">
            <Textarea
              rows={3}
              maxLength={1000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="예: 2부 끝에서 주인공이 크게 패배하게"
              disabled={!can}
            />
          </Field>
          {gen.error && (
            <p className="m-0 text-xs text-danger" role="alert">
              {errorMessage(gen.error)}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={gen.isPending} disabled={!can}>
              전체 구성 만들기
            </Button>
          </div>
      </form>
    </Card>
  );
}

// ── 상태·승인 ──
const STATUS_TONE: Record<StructureDisplayStatus, Tone> = {
  none: "neutral",
  draft: "violet",
  awaiting_approval: "warn",
  approved: "ok",
  reapproval: "warn",
};

function StatusBar({ novelId, view }: { novelId: string; view: StructureView }) {
  const s = view.structure!;
  const [dialog, setDialog] = useState<"reject" | "regen" | null>(null);
  const decide = useStructureDecision(novelId);
  const d = displayStatus(s);
  const changes = pendingChangeLines(s);
  const needsDecision = s.status !== "approved";
  const busy = !!view.task;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          구성 상태
          <Badge tone={STATUS_TONE[d]} glyph>
            {DISPLAY_STATUS_LABEL[d]}
          </Badge>
          <span className="text-xs font-normal text-muted">개정 {s.revision}{s.approvedRevision ? ` · 마지막 승인 개정 ${s.approvedRevision}` : ""}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {d === "approved" && <p className="m-0 text-muted">승인된 구성대로 플롯과 화를 계획하고 있습니다. 결말이나 부를 고치면 다시 승인해야 합니다.</p>}
        {d === "awaiting_approval" && <p className="m-0">결말과 1~4부를 검토하고 승인하세요. 승인하면 1부부터 플롯 계획을 시작합니다. 자동 진행 단계에서도 구성은 작가가 직접 승인합니다.</p>}
        {d === "draft" && <p className="m-0">초안입니다. 고친 뒤 승인하면 플롯이 만들어집니다.</p>}
        {d === "reapproval" && <p className="m-0">승인 뒤 바뀐 내용이 있습니다. 다시 승인하기 전까지 새 플롯 계획은 멈춥니다.</p>}
        {changes.length > 0 && (
          <ul className="m-0 list-disc pl-5 text-warn">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        {decide.error && (
          <p className="m-0 text-xs text-danger" role="alert">
            {errorMessage(decide.error)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {needsDecision && (
            <>
              <Button
                variant="primary"
                loading={decide.isPending && decide.variables?.decision === "approved"}
                disabled={busy || decide.isPending}
                onClick={() => decide.mutate({ decision: "approved", expectedRevision: s.revision })}
              >
                구성 승인
              </Button>
              <Button disabled={busy || decide.isPending} onClick={() => setDialog("reject")}>
                반려
              </Button>
            </>
          )}
          <Button disabled={busy} loading={busy} onClick={() => setDialog("regen")}>
            {busy ? "AI가 만드는 중…" : "AI로 다시 만들기"}
          </Button>
        </div>
      </div>
      <RejectDialog
        open={dialog === "reject"}
        onClose={() => setDialog(null)}
        busy={decide.isPending}
        error={decide.error && decide.variables?.decision === "rejected" ? errorMessage(decide.error) : null}
        onSubmit={(note) => decide.mutate({ decision: "rejected", note, expectedRevision: s.revision }, { onSuccess: () => setDialog(null) })}
      />
      <RegenerateDialog novelId={novelId} open={dialog === "regen"} approved={s.status === "approved"} onClose={() => setDialog(null)} />
    </Card>
  );
}

function RejectDialog({ open, onClose, onSubmit, busy, error }: { open: boolean; onClose: () => void; onSubmit: (note: string) => void; busy: boolean; error: string | null }) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="구성 반려" description="반려 사유를 반영해 AI가 구성을 다시 만듭니다. 직접 고친 항목은 그대로 둡니다." footer={false}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) onSubmit(note.trim());
        }}
      >
        <Field label="반려 사유" required error={error ?? undefined}>
          <Textarea rows={4} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 3부가 너무 늘어집니다. 결말을 더 씁쓸하게." autoFocus />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!note.trim()}>
            반려
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RegenerateDialog({ novelId, open, approved, onClose }: { novelId: string; open: boolean; approved: boolean; onClose: () => void }) {
  const [scope, setScope] = useState<"all" | "ending" | "parts">("all");
  const [instructions, setInstructions] = useState("");
  const gen = useGenerateStructure(novelId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="AI로 다시 만들기"
      description="직접 고친 항목은 바꾸지 않고 나머지를 다시 제안합니다."
      footer={false}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          gen.mutate({ scope, instructions: instructions.trim() || undefined }, { onSuccess: () => onClose() });
        }}
      >
        <Field label="범위">
          <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">전체(결말과 1~4부)</option>
            <option value="ending">결말만</option>
            <option value="parts">부만</option>
          </Select>
        </Field>
        <Field label="추가 요청 (선택)">
          <Textarea rows={3} maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        {approved && <Callout tone="warn">승인된 구성을 다시 만들면 다시 승인해야 하며, 그동안 새 플롯 계획이 멈춥니다.</Callout>}
        {gen.error && (
          <p className="m-0 text-xs text-danger" role="alert">
            {errorMessage(gen.error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" loading={gen.isPending}>
            다시 만들기
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
