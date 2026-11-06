import { useState } from "react";
import { Link } from "react-router";
import { WORLD_RELATION_PREDICATES, labelKo, type WorldItemDto, type WorldOntologyView } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, ButtonLink, Callout, Card, ConfirmDialog, Dialog, Field, InlineStatus, Input, QueryView, Select, Textarea, ToggleChip, WebSources, formatRelative, type Tone } from "../../components/ui/index.js";
import { useOntologySchema } from "./api.js";
import { useApproveAllWorld, useApproveWorldItem, useEditWorldItem, useGenerateWorld, useRejectWorldItem, useWorldOntology } from "./world-api.js";
import { generationLine, isGenerating, statusTone, statementLabel } from "./world-view.js";

/**
 * 세계관 온톨로지 후보 (설계 추가): 컨셉 승인 뒤 AI가 만든 세력·장소·체계·물건·역사·관계·규칙 후보를 분류별로 검토합니다.
 * 승인하면 캐논(온톨로지 확정 사실)이 되고, [다시 생성]은 승인했거나 직접 고친 항목을 바꾸지 않습니다.
 */
export function WorldOntologyPanel({ novelId }: { novelId: string }) {
  const q = useWorldOntology(novelId);
  return (
    <QueryView query={q} compact notReadyDescription="세계관 온톨로지 생성 기능이 준비되면 후보가 표시됩니다.">
      {(v) => <WorldPanel novelId={novelId} view={v} />}
    </QueryView>
  );
}

function WorldPanel({ novelId, view }: { novelId: string; view: WorldOntologyView }) {
  const [regen, setRegen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const generate = useGenerateWorld(novelId);
  const approveAll = useApproveAllWorld(novelId);
  const g = view.generation;
  const busy = isGenerating(g.state);
  const hasItems = view.groups.length > 0;
  return (
    <div className="flex flex-col gap-3">
      <Card
        title="세계관 온톨로지 후보"
        actions={
          <div className="flex flex-wrap gap-2">
            {view.counts.pending > 0 && (
              <Button variant="primary" size="sm" onClick={() => setConfirmAll(true)} disabled={busy} loading={approveAll.isPending}>
                모두 승인 ({view.counts.pending})
              </Button>
            )}
            {view.briefApproved && (
              <Button size="sm" onClick={() => (hasItems ? setRegen(true) : generate.mutate({}))} disabled={busy} loading={generate.isPending}>
                {hasItems || g.state === "failed" ? "다시 생성" : "세계관 생성"}
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="m-0" role="status">
            {busy && <span className="mr-1.5 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-1px]" aria-hidden />}
            {generationLine(view)}
            {g.finishedAt && !busy && <span className="text-muted"> · {formatRelative(g.finishedAt)}</span>}
          </p>
          {hasItems && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="warn" glyph>검토 대기 {view.counts.pending}</Badge>
              <Badge tone="ok" glyph>승인 {view.counts.approved}</Badge>
              {view.counts.rejected > 0 && (
                <ToggleChip pressed={showRejected} onClick={() => setShowRejected((x) => !x)}>
                  기각 {view.counts.rejected} {showRejected ? "숨기기" : "보기"}
                </ToggleChip>
              )}
            </div>
          )}
          {g.webSearch && (
            <p className="m-0 text-xs text-muted">
              인터넷 검색: {g.webSearch.status === "used" ? `${g.webSearch.requests}회 검색` : g.webSearch.status === "not_used" ? "검색하지 않음" : g.webSearch.status === "disabled" ? "꺼짐(설정)" : "이 모델에서는 지원하지 않음"}
              {g.webSearch.note ? ` — ${g.webSearch.note}` : ""}
            </p>
          )}
          {g.sources.length > 0 && <WebSources sources={g.sources} title="생성에 쓴 출처" />}
          {g.state === "failed" && g.error && <Callout tone="danger" title="세계관 생성에 실패했습니다">{g.error}</Callout>}
          {(generate.error || approveAll.error) && <InlineStatus tone="danger">{errorMessage(generate.error ?? approveAll.error)}</InlineStatus>}
          {approveAll.data && approveAll.data.held.length > 0 && (
            <Callout tone="warn" title={`${approveAll.data.approved}개 승인, ${approveAll.data.held.length}개는 남았습니다`}>
              {approveAll.data.held.slice(0, 3).map((h) => h.reason).join(" ")}
            </Callout>
          )}
          {hasItems && <p className="m-0 text-xs text-muted">승인한 항목은 확정 설정(캐논)이 되어 캐릭터 초안·기획서·전체 구성에 그대로 쓰입니다. 검토 전 후보는 “미확정”으로 표시되어 참고로만 들어갑니다.</p>}
        </div>
      </Card>

      {view.groups.map((grp) => {
        const list = grp.items.filter((i) => showRejected || i.status !== "rejected");
        if (!list.length) return null;
        return (
          <Card key={grp.kind} title={`${labelKo("world_item_kind", grp.kind)} (${list.length})`} headingLevel={3}>
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {list.map((it) => (
                <WorldItemRow key={it.id} novelId={novelId} item={it} />
              ))}
            </ul>
          </Card>
        );
      })}

      <ConfirmDialog
        open={confirmAll}
        title={`검토 대기 ${view.counts.pending}개를 모두 승인할까요?`}
        description="엔티티를 먼저 승인하고 관계를 승인합니다. 기존 캐논과 충돌하는 항목은 승인하지 않고 남겨 둡니다."
        confirmLabel="모두 승인"
        busy={approveAll.isPending}
        onConfirm={() => approveAll.mutate(undefined, { onSettled: () => setConfirmAll(false) })}
        onCancel={() => setConfirmAll(false)}
      />
      {regen && <RegenerateDialog novelId={novelId} onClose={() => setRegen(false)} />}
    </div>
  );
}

function RegenerateDialog({ novelId, onClose }: { novelId: string; onClose: () => void }) {
  const [instructions, setInstructions] = useState("");
  const m = useGenerateWorld(novelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="세계관을 다시 생성할까요?"
      description="승인했거나 직접 고친 항목은 그대로 둡니다. 검토하지 않은 AI 후보는 새 결과로 바뀌고, 새 결과에 없는 후보는 정리됩니다."
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            취소
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate({ instructions: instructions.trim() || undefined }, { onSuccess: onClose })}>
            다시 생성
          </Button>
        </>
      }
    >
      <Field label="추가 요청 (선택)" hint="예: 마법 체계를 더 자세히, 지명은 한국식으로">
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={2000} />
      </Field>
      {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
    </Dialog>
  );
}

function WorldItemRow({ novelId, item }: { novelId: string; item: WorldItemDto }) {
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const approve = useApproveWorldItem(novelId);
  const pending = item.status === "pending";
  const held = approve.data?.held[0]?.reason ?? item.heldReason;
  return (
    <li className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.entityId ? (
          <Link to={novelPath(novelId, `entities/${item.entityId}`)} className="font-semibold">
            {item.name}
          </Link>
        ) : (
          <span className="font-semibold">{item.name}</span>
        )}
        {item.aliases.length > 0 && <span className="text-xs text-muted">({item.aliases.join(", ")})</span>}
        <Badge tone={statusTone(item.status) as Tone} glyph>
          {labelKo("world_item_status", item.status)}
        </Badge>
        {item.userEdited ? <Badge tone="info">직접 고침</Badge> : item.origin === "agent" && pending ? <Badge tone="violet">AI 제안</Badge> : null}
        {item.fromBrief && <Badge tone="accent">브리프 규칙</Badge>}
        {pending && (
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="primary" onClick={() => approve.mutate(item.id)} loading={approve.isPending}>
              승인
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              수정
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>
              기각
            </Button>
          </span>
        )}
      </div>
      {item.summary && <p className="m-0 text-[13px]">{item.summary}</p>}
      {item.statement && (
        <p className="m-0 text-[13px]">
          <span className="font-semibold text-muted">{statementLabel(item)}: </span>
          {item.statement}
        </p>
      )}
      {item.details.length > 0 && (
        <ul className="m-0 pl-4 text-[12.5px] text-muted">
          {item.details.map((d) => (
            <li key={d}>한계: {d}</li>
          ))}
        </ul>
      )}
      {item.note && <p className="m-0 text-xs text-muted">{item.note}</p>}
      {pending && held && <p className="m-0 text-xs text-warn">{held}</p>}
      {approve.error && <InlineStatus tone="danger">{errorMessage(approve.error)}</InlineStatus>}
      <WebSources sources={item.sources} />
      {editing && <EditItemDialog novelId={novelId} item={item} onClose={() => setEditing(false)} />}
      {rejecting && <RejectDialog novelId={novelId} item={item} onClose={() => setRejecting(false)} />}
    </li>
  );
}

function RejectDialog({ novelId, item, onClose }: { novelId: string; item: WorldItemDto; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const m = useRejectWorldItem(novelId);
  return (
    <ConfirmDialog
      open
      danger
      title={`'${item.name}' 후보를 기각할까요?`}
      description={item.entityId ? "이 항목과 연결된 검토 대기 관계도 함께 기각합니다." : undefined}
      confirmLabel="기각"
      busy={m.isPending}
      onConfirm={() => m.mutate({ itemId: item.id, reason: reason.trim() || undefined }, { onSuccess: onClose })}
      onCancel={onClose}
    >
      <Field label="이유 (선택)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
    </ConfirmDialog>
  );
}

function EditItemDialog({ novelId, item, onClose }: { novelId: string; item: WorldItemDto; onClose: () => void }) {
  const m = useEditWorldItem(novelId);
  const schema = useOntologySchema(novelId);
  const [name, setName] = useState(item.name);
  const [summary, setSummary] = useState(item.summary ?? "");
  const [statement, setStatement] = useState(item.statement ?? "");
  const [predicate, setPredicate] = useState(item.relation?.predicate ?? "");
  const hasStatement = item.statement !== null || item.entityType === "ability" || item.entityType === "rule";
  const relLabel = (k: string) => schema.data?.relationTypes.find((r) => r.key === k)?.labelKo ?? k;
  const submit = () => {
    const patch = item.relation
      ? { predicate }
      : {
          ...(name.trim() !== item.name ? { name: name.trim() } : {}),
          ...(summary.trim() !== (item.summary ?? "") ? { summary: summary.trim() || null } : {}),
          ...(hasStatement && statement.trim() && statement.trim() !== (item.statement ?? "") ? { statement: statement.trim() } : {}),
        };
    if (!Object.keys(patch).length || (item.relation && predicate === item.relation.predicate)) return onClose();
    m.mutate({ itemId: item.id, patch }, { onSuccess: onClose });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="세계관 후보 수정"
      description="고친 항목은 '직접 고침'으로 표시되고, 다시 생성해도 바뀌지 않습니다."
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            취소
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={submit} disabled={!item.relation && !name.trim()}>
            저장
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {item.relation ? (
          <Field label={`${item.relation.subjectName} → ${item.relation.objectName}`} hint="두 항목의 유형에 맞는 관계만 저장됩니다.">
            <Select value={predicate} onChange={(e) => setPredicate(e.target.value)}>
              {WORLD_RELATION_PREDICATES.map((p) => (
                <option key={p} value={p}>
                  {relLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="이름" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label="요약">
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={2000} />
            </Field>
            {hasStatement && (
              <Field label={statementLabel(item)}>
                <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={2} maxLength={1000} />
              </Field>
            )}
          </>
        )}
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}

/** 컨셉 승인 직후의 안내 카드: 생성 상태 + 세계관 화면으로 가는 링크. */
export function WorldStepCard({ novelId, title = "세계관 온톨로지" }: { novelId: string; title?: string }) {
  const q = useWorldOntology(novelId);
  const v = q.data;
  return (
    <Card title={title} actions={v ? v.counts.pending > 0 ? <Badge tone="warn" glyph>검토 {v.counts.pending}개</Badge> : v.counts.approved > 0 ? <Badge tone="ok" glyph>승인됨</Badge> : undefined : undefined}>
      {!v ? (
        q.error ? <InlineStatus tone="danger">{errorMessage(q.error)}</InlineStatus> : <InlineStatus>불러오는 중…</InlineStatus>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="m-0">{generationLine(v)}</p>
          <p className="m-0 text-muted">세력·장소·능력 체계·역사·지켜야 할 규칙을 검토해 승인하면, 캐릭터 초안과 기획서·전체 구성이 그 설정을 따릅니다.</p>
          <div>
            <ButtonLink to={novelPath(novelId, "ontology")} size="sm" variant={v.counts.pending > 0 ? "primary" : "default"}>
              {v.counts.pending > 0 ? "세계관 검토하기" : "세계관 보기"}
            </ButtonLink>
          </div>
        </div>
      )}
    </Card>
  );
}
