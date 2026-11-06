import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ENUMS, labelKo, type EntityStatus, type EntityType } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Button,
  Callout,
  DataTable,
  Dialog,
  Field,
  Input,
  QueryView,
  Select,
  StatusBadge,
  Textarea,
  type Column,
  ToggleChip,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useCreateEntity, useEntities, useOntologySchema, type EntityListItemDto } from "./api.js";
import { EntityDetail } from "./EntityDetail.js";

/** `/novels/:novelId/ontology` and `/novels/:novelId/entities/:entityId` (08 §9.5, FR-UI-05a). */
export function OntologyPage() {
  const novelId = useNovelId();
  const { entityId } = useParams();
  if (entityId) return <EntityDetail key={entityId} novelId={novelId} entityId={entityId} />;
  return <EntityList novelId={novelId} />;
}

const DEFAULT_STATUSES: EntityStatus[] = ["active", "candidate"];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function EntityList({ novelId }: { novelId: string }) {
  const navigate = useNavigate();
  const [type, setType] = useState<string>("");
  const [statuses, setStatuses] = useState<EntityStatus[]>(DEFAULT_STATUSES);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useDebounced(q, 250);
  const schema = useOntologySchema(novelId);
  const entities = useEntities(novelId, { type: type ? [type] : undefined, status: statuses, q: query, limit: 500 });

  const typeOptions: Array<{ key: string; label: string }> = schema.data
    ? schema.data.entityTypes.filter((t) => t.enabled).map((t) => ({ key: t.key, label: t.labelKo }))
    : ENUMS.entity_type.map((t) => ({ key: t, label: labelKo("entity_type", t) }));
  const typeLabel = (t: string) => typeOptions.find((o) => o.key === t)?.label ?? labelKo("entity_type", t);

  const columns: Column<EntityListItemDto>[] = [
    {
      key: "name",
      header: "대표명",
      rowHeader: true,
      cell: (r) => (
        <span>
          {/* keyboard / screen-reader path to the detail (the row click is a mouse shortcut) */}
          <Link to={`/novels/${novelId}/entities/${r.entity.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold">
            {r.preferredName}
          </Link>
          {r.entity.disambiguator && <span className="ml-1 text-muted">({r.entity.disambiguator})</span>}
          {r.entity.isRealPerson && <span className="ml-1 text-xs text-warn">실존 인물</span>}
        </span>
      ),
    },
    { key: "type", header: "유형", cell: (r) => typeLabel(r.entity.entityType) },
    { key: "status", header: "상태", cell: (r) => <StatusBadge enum="entity_status" value={r.entity.status} /> },
    { key: "app", header: "등장 화", className: "tabular", cell: (r) => `${r.appearanceEpisodeCount}화` },
    {
      key: "unresolved",
      header: "미확정 언급",
      className: "tabular",
      cell: (r) => (r.unresolvedMentionCount > 0 ? <span className="font-semibold text-warn">{r.unresolvedMentionCount}건</span> : <span className="text-faint">0</span>),
    },
    { key: "summary", header: "요약", cell: (r) => <span className="line-clamp-2 text-muted">{r.entity.summary ?? "—"}</span> },
  ];

  return (
    <>
      <PageHeader
        title="세계관 온톨로지"
        subtitle="인물·장소·조직 등 엔티티와 이름 사전, 시점별 사실을 봅니다. 이름·별칭·호칭으로 검색할 수 있습니다."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            엔티티 추가
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="grid min-w-56 flex-1 gap-1 text-xs text-muted">
          검색
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="대표명·별칭·호칭" maxLength={100} />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          유형
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
            <option value="">전체</option>
            {typeOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">상태</legend>
          {ENUMS.entity_status.map((s) => {
            const on = statuses.includes(s);
            return (
              <ToggleChip
                key={s}
                pressed={on}
                onClick={() => setStatuses((cur) => (on ? cur.filter((x) => x !== s) : [...cur, s]))}
              >
                {labelKo("entity_status", s)}
              </ToggleChip>
            );
          })}
        </fieldset>
      </div>
      <QueryView query={entities} notReadyDescription="온톨로지 모듈이 준비되면 엔티티 목록이 표시됩니다.">
        {(items) => (
          <DataTable
            label="엔티티 목록"
            caption={`${items.length}개${entities.isFetching ? " · 갱신 중…" : ""}`}
            columns={columns}
            rows={items}
            rowKey={(r) => r.entity.id}
            onRowClick={(r) => navigate(`/novels/${novelId}/entities/${r.entity.id}`)}
            empty={query || type ? "조건에 맞는 엔티티가 없습니다." : "아직 엔티티가 없습니다. 기획서가 승인되면 초기 온톨로지가 만들어집니다."}
          />
        )}
      </QueryView>
      {creating && <CreateEntityDialog novelId={novelId} typeOptions={typeOptions} onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateEntityDialog({ novelId, typeOptions, onClose }: { novelId: string; typeOptions: Array<{ key: string; label: string }>; onClose: () => void }) {
  const navigate = useNavigate();
  const [entityType, setEntityType] = useState<string>(typeOptions[0]?.key ?? "character");
  const [name, setName] = useState("");
  const [disambiguator, setDisambiguator] = useState("");
  const [summary, setSummary] = useState("");
  const m = useCreateEntity(novelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="엔티티 추가"
      description="같은 이름의 엔티티가 있으면 추가 후 중복 후보로 안내합니다."
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={m.isPending}
            onClick={() =>
              m.mutate(
                {
                  entityType: entityType as EntityType,
                  preferredName: name.trim(),
                  disambiguator: disambiguator.trim() || null,
                  summary: summary.trim() || null,
                },
                { onSuccess: (r) => navigate(`/novels/${novelId}/entities/${r.entity.id}`, { state: { similar: r.similar?.length ?? 0 } }) },
              )
            }
          >
            추가
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="유형" required>
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {typeOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="대표명" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="구분자" hint="동명이인을 구분하는 짧은 설명 (예: 1회차, 길드장)">
          <Input value={disambiguator} onChange={(e) => setDisambiguator(e.target.value)} maxLength={50} />
        </Field>
        <Field label="요약">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}
