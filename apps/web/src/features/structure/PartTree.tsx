import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { labelKo, type StoryPartDto, type StoryStructureDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Card, Chip, Dialog, Field, StatusBadge, Textarea } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useAcknowledgeArcFlags, usePlotDecision, useReplanArc } from "./api.js";
import { PartEditorDialog } from "./PartEditorDialog.js";
import { nameOf, partTitle, rangeLabel, type PartNode, type PlotNode, type StructureTree } from "./tree.js";

type Character = { id: string; name: string };

const REPLANNABLE = new Set(["planned", "plan_awaiting_approval", "active", "awaiting_approval"]);

/** 1~4부 카드 → 플롯 행 → 화 행. 부·플롯은 접고 펼칠 수 있습니다. */
export function PartTree({
  novelId,
  structure,
  tree,
  names,
  mainCharacters,
  allCharacters,
  selectedArcId,
  totalEpisodes,
}: {
  novelId: string;
  structure: StoryStructureDto;
  tree: StructureTree;
  names: ReadonlyMap<string, string>;
  mainCharacters: Character[];
  allCharacters: Character[];
  selectedArcId: string | null;
  totalEpisodes: number | null;
}) {
  const [editing, setEditing] = useState<StoryPartDto | null>(null);
  return (
    <section aria-labelledby="parts-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="parts-title" className="m-0 text-[15px] font-bold">
          1~4부 · 플롯 · 화
        </h2>
        {totalEpisodes && <span className="text-xs text-muted">연재 목표 {totalEpisodes}화</span>}
      </div>
      {structure.status !== "approved" && structure.approvedRevision == null && (
        <p className="m-0 text-xs text-muted">구성을 승인하면 각 부의 플롯 개요가 실제 플롯이 되고, 1부 첫 플롯부터 화 계획을 시작합니다.</p>
      )}
      {tree.parts.map((n) => (
        <PartCard
          key={n.part.id}
          novelId={novelId}
          node={n}
          changed={!!structure.pendingChanges.partIds?.includes(n.part.id)}
          names={names}
          selectedArcId={selectedArcId}
          onEdit={() => setEditing(n.part)}
        />
      ))}
      {tree.unassigned.length > 0 && (
        <Card title="부에 연결되지 않은 플롯">
          <PlotList novelId={novelId} plots={tree.unassigned} names={names} selectedArcId={selectedArcId} />
        </Card>
      )}
      {editing && (
        <PartEditorDialog
          key={editing.id + structure.revision}
          novelId={novelId}
          structure={structure}
          part={editing}
          mainCharacters={mainCharacters}
          allCharacters={allCharacters}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function PartCard({
  novelId,
  node,
  changed,
  names,
  selectedArcId,
  onEdit,
}: {
  novelId: string;
  node: PartNode;
  changed: boolean;
  names: ReadonlyMap<string, string>;
  selectedArcId: string | null;
  onEdit: () => void;
}) {
  const p = node.part;
  const hasSelected = node.plots.some((x) => x.plot.id === selectedArcId);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (hasSelected) setOpen(true);
  }, [hasSelected]);
  const ai = (k: string) => (p.fieldOrigins[k] === "agent" ? <Badge tone="violet">AI 제안</Badge> : null);
  const bodyId = `part-body-${p.id}`;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Chip>{p.ord}부</Chip>
          <span className="min-w-0 break-words">{partTitle(p.title) || <span className="text-faint">제목 없음</span>}</span>
          <span className="text-xs font-normal text-muted">{rangeLabel(p.plannedEpisodeFrom, p.plannedEpisodeTo)}</span>
          {ai("title")}
          {changed && <Badge tone="warn" glyph>승인 뒤 바뀜</Badge>}
          {node.flaggedPlots > 0 && <Badge tone="warn" glyph>확인 필요 플롯 {node.flaggedPlots}개</Badge>}
        </span>
      }
      actions={
        <span className="flex flex-wrap gap-1">
          <Button size="sm" onClick={onEdit}>
            부 편집
          </Button>
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            {open ? "접기" : "펼치기"}
          </Button>
        </span>
      }
    >
      <div id={bodyId} hidden={!open} className="flex flex-col gap-3 text-[13px]">
        <dl className="m-0 grid grid-cols-1 gap-3 min-[700px]:grid-cols-2">
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">부 목표 {ai("goalText")}</dt>
            <dd className="m-0 mt-0.5 whitespace-pre-wrap">{p.goalText || <span className="text-faint">비어 있음</span>}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">전환점 {ai("turningPoints")}</dt>
            <dd className="m-0 mt-0.5">
              {p.turningPoints.length === 0 ? (
                <span className="text-faint">비어 있음</span>
              ) : (
                <ol className="m-0 pl-5">
                  {p.turningPoints.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ol>
              )}
            </dd>
          </div>
          <div className="min-[700px]:col-span-2">
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">부 끝 인물 상태 {ai("characterStates")}</dt>
            <dd className="m-0 mt-0.5">
              {p.characterStates.length === 0 ? (
                <span className="text-faint">비어 있음</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {p.characterStates.map((c) => (
                    <li key={c.characterId}>
                      <b>{nameOf(names, c.characterId)}</b>: {c.state}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        <div>
          <h3 className="m-0 mb-1.5 text-[13px] font-bold">플롯</h3>
          {node.plots.length > 0 ? (
            <PlotList novelId={novelId} plots={node.plots} names={names} selectedArcId={selectedArcId} />
          ) : p.plotOutline.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {p.plotOutline.map((o, i) => (
                <li key={i} className="rounded-lg border border-dashed border-border px-2.5 py-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <b>{o.title}</b>
                    <Badge tone="neutral">{o.episodeCount}화 예정</Badge>
                    <Badge tone="neutral">개요</Badge>
                  </span>
                  {o.coreEvent && <p className="m-0 mt-0.5 text-muted">{o.coreEvent}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-faint">플롯 개요가 없습니다.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function PlotList({ novelId, plots, names, selectedArcId }: { novelId: string; plots: PlotNode[]; names: ReadonlyMap<string, string>; selectedArcId: string | null }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {plots.map((n) => (
        <PlotRow key={n.plot.id} novelId={novelId} node={n} names={names} selected={n.plot.id === selectedArcId} />
      ))}
    </ul>
  );
}

function PlotRow({ novelId, node, names, selected }: { novelId: string; node: PlotNode; names: ReadonlyMap<string, string>; selected: boolean }) {
  const p = node.plot;
  const [open, setOpen] = useState(selected);
  const [replanning, setReplanning] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const ack = useAcknowledgeArcFlags(novelId);
  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "center" });
  }, [selected]);
  const bodyId = `plot-body-${p.id}`;
  const canReplan = REPLANNABLE.has(p.status) && p.planningStage === "episodes_planned";
  return (
    <li ref={ref} className={cx("rounded-lg border border-border px-2.5 py-2", selected && "border-accent bg-accent-soft/40", node.flagged && "border-l-[3px] border-l-warn")}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Link to={novelPath(novelId, `structure/plots/${p.id}`)} className="font-semibold">
              {p.title}
            </Link>
            <span className="text-xs text-muted">{rangeLabel(p.plannedEpisodeFrom, p.plannedEpisodeTo)}</span>
            <StatusBadge enum="arc_status" value={p.status} />
            <Badge tone={p.planningStage === "outline" ? "neutral" : "info"}>{p.planningStage === "outline" ? "화 계획 전" : `${p.episodeCount}화 계획됨`}</Badge>
            {p.planFlags.map((f) => (
              <Badge key={f} tone="warn" glyph>
                {labelKo("arc_plan_flag", f)}
              </Badge>
            ))}
            {node.belowFloorCount > 0 && (
              <Badge tone="danger" glyph>
                분량 미달 {node.belowFloorCount}화
              </Badge>
            )}
          </span>
          {p.coreEvent && <p className="m-0 mt-0.5 text-[13px] text-muted">{p.coreEvent}</p>}
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          {open ? "접기" : "자세히"}
        </Button>
      </div>
      {p.castGaps && (
        <div className="mt-2 flex flex-col gap-1 rounded-md border border-warn/40 bg-warn-soft/40 px-2.5 py-2 text-[13px]" role="note">
          <p className="m-0 font-semibold">이 플롯에 새로 등장하는 인물을 먼저 확인해야 승인할 수 있습니다.</p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {p.castGaps.items.map((i) => (
              <li key={i.characterId} className="flex flex-wrap items-center gap-1.5">
                <b>{i.name}</b>
                {i.missing.map((m) => (
                  <Badge key={m.field} tone="warn">
                    {m.label} 비어 있음
                  </Badge>
                ))}
                {i.unconfirmed && <Badge tone="violet">AI 제안 수락 전</Badge>}
                <Link to={novelPath(novelId, `cast/${i.characterId}`)} className="text-xs">
                  캐릭터 화면에서 확인
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.status === "plan_awaiting_approval" && p.planApprovalId && <PlanDecision novelId={novelId} approvalId={p.planApprovalId} title="플롯 계획" blocked={!!p.castGaps} />}
      {p.replanApprovalId && <PlanDecision novelId={novelId} approvalId={p.replanApprovalId} title="재계획안" blocked={false} />}
      {node.flagged && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md bg-surface-2 px-2.5 py-2 text-[13px]">
          <p className="m-0">전체 구성이 바뀌었습니다. 이 플롯을 새 구성에 맞게 다시 계획할지, 지금 계획을 유지할지 정하세요. 정하기 전까지 이 플롯의 새 아웃라인을 만들지 않습니다(이미 시작한 작업은 끝까지 진행됩니다).</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => setReplanning(true)}>
              재계획
            </Button>
            <Button size="sm" loading={ack.isPending} onClick={() => ack.mutate(p.id)}>
              유지
            </Button>
          </div>
          {ack.error && (
            <p className="m-0 text-xs text-danger" role="alert">
              {errorMessage(ack.error)}
            </p>
          )}
        </div>
      )}
      <div id={bodyId} hidden={!open} className="mt-2 flex flex-col gap-2 text-[13px]">
        <dl className="m-0 grid grid-cols-1 gap-2 min-[700px]:grid-cols-2">
          <Detail label="만들어 낼 변화" text={p.changeText} />
          <Detail label="등장 인물" text={p.involvedCharacterIds.map((id) => nameOf(names, id)).join(", ")} />
          <DetailList label="심을 떡밥" items={p.setupPlan.plant} />
          <DetailList label="회수할 떡밥" items={p.setupPlan.payoff} />
        </dl>
        {node.episodes.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">
            {node.episodes.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
                <Link to={novelPath(novelId, `episodes/${e.episodeNo}`)} className="tabular font-semibold">
                  {e.episodeNo}화
                </Link>
                <span className="min-w-0 flex-1 break-words">{e.title ?? e.planSummary ?? ""}</span>
                <span className="text-xs text-muted">
                  {e.plannedSceneCount ? `씬 ${e.plannedSceneCount}개` : "씬 미정"} · {e.targetChars ? `목표 ${e.targetChars.toLocaleString("ko-KR")}자` : "목표 미정"}
                </span>
                <StatusBadge enum="episode_status" value={e.status} />
                {e.lengthBelowFloor && (
                  <Badge tone="danger" glyph>
                    분량 미달
                  </Badge>
                )}
                {e.title && e.planSummary && <p className="m-0 w-full text-xs text-muted">{e.planSummary}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-faint">아직 화 계획이 없습니다. 차례가 되면 AI가 이 플롯의 화 목록을 계획합니다.</p>
        )}
        {canReplan && !node.flagged && (
          <div>
            <Button size="sm" onClick={() => setReplanning(true)}>
              화 계획 다시 짜기
            </Button>
          </div>
        )}
      </div>
      {replanning && <ReplanDialog novelId={novelId} arcId={p.id} title={p.title} onClose={() => setReplanning(false)} />}
    </li>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 whitespace-pre-wrap">{text || <span className="text-faint">비어 있음</span>}</dd>
    </div>
  );
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="m-0 mt-0.5">
        {items.length === 0 ? (
          <span className="text-faint">비어 있음</span>
        ) : (
          <ul className="m-0 flex flex-col gap-0.5 pl-5">
            {items.map((t, i) => (
              <li key={i} className="break-words">
                {t}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

/** 플롯 계획(또는 진행 중 플롯의 재계획안) 승인·반려 — 인박스와 같은 승인 요청을 이 자리에서 결정합니다. */
function PlanDecision({ novelId, approvalId, title, blocked }: { novelId: string; approvalId: string; title: string; blocked: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const decide = usePlotDecision(novelId);
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-accent/40 bg-accent-soft/30 px-2.5 py-2 text-[13px]">
      <p className="m-0">
        {title} 승인을 기다립니다. 아래 화 계획을 확인하고 승인하면 이 플롯의 아웃라인과 초고를 시작합니다.
        {blocked && " 새 인물을 먼저 확인하세요."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={blocked} loading={decide.isPending && !rejecting} onClick={() => decide.mutate({ approvalId, body: { decision: "approved" } })}>
          승인
        </Button>
        <Button size="sm" onClick={() => setRejecting((r) => !r)} aria-expanded={rejecting}>
          반려
        </Button>
        <Link to={novelPath(novelId, "inbox")} className="self-center text-xs">
          인박스에서 보기
        </Link>
      </div>
      {rejecting && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            decide.mutate({ approvalId, body: { decision: "rejected", decisionNote: note.trim() } }, { onSuccess: () => setRejecting(false) });
          }}
        >
          <Field label="반려 사유" required>
            <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 3화에서 서린의 배신을 더 일찍 드러내 주세요." autoFocus />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="danger" disabled={!note.trim()} loading={decide.isPending}>
              반려하고 다시 계획
            </Button>
          </div>
        </form>
      )}
      {decide.error && (
        <p className="m-0 text-xs text-danger" role="alert">
          {errorMessage(decide.error)}
        </p>
      )}
    </div>
  );
}

function ReplanDialog({ novelId, arcId, title, onClose }: { novelId: string; arcId: string; title: string; onClose: () => void }) {
  const [note, setNote] = useState("");
  const replan = useReplanArc(novelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`「${title}」 다시 계획하기`}
      description="아직 아웃라인을 쓰지 않은 화의 계획만 새 구성에 맞게 고칩니다. 이미 쓴 원고는 바꾸지 않습니다."
      footer={false}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          replan.mutate({ arcId, body: { note: note.trim() || undefined } }, { onSuccess: onClose });
        }}
      >
        <Field label="요청 (선택)">
          <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 바뀐 결말에 맞춰 이 플롯 끝에서 복선을 하나 더 심어 주세요." autoFocus />
        </Field>
        {replan.error && (
          <p className="m-0 text-xs text-danger" role="alert">
            {errorMessage(replan.error)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>취소</Button>
          <Button type="submit" variant="primary" loading={replan.isPending}>
            재계획 요청
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
