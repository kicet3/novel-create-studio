import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ENUMS, labelKo, type NameKind } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Badge,
  Button,

  Callout,
  Card,
  Chip,
  DataTable,
  Dialog,
  Field,
  formatDateTime,
  InlineStatus,
  Input,
  KeyValueList,
  QueryError,
  QueryView,
  Select,
  StatusBadge,
  Tabs,
  type Column,
  ToggleChip,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useNovel } from "../novels/api.js";
import {
  formatRange,
  formatRangeLiteral,
  useAddEntityName,
  useEntityDetail,
  useEntityFacts,
  useEntityMentions,
  useEntityNames,
  useIdentityDecisions,
  useIdentityImpact,
  useRevertIdentityDecision,
  useTimelines,
  type EntityDetailDto,
  type FactAtAnchorDto,
  type IdentityDecisionDto,
  type MentionDto,
} from "./api.js";

type Section = "names" | "facts" | "mentions" | "identity";

export function EntityDetail({ novelId, entityId }: { novelId: string; entityId: string }) {
  const q = useEntityDetail(novelId, entityId);
  const navigate = useNavigate();
  const location = useLocation();
  const redirectedFrom = (location.state as { redirectedFrom?: string } | null)?.redirectedFrom;
  const similar = (location.state as { similar?: number } | null)?.similar;

  useEffect(() => {
    if (q.data?.kind === "redirect") {
      navigate(`/novels/${novelId}/entities/${q.data.redirectTo}`, { replace: true, state: { redirectedFrom: q.data.redirectedFrom } });
    }
  }, [q.data, navigate, novelId]);

  return (
    <QueryView query={q} notReadyDescription="온톨로지 모듈이 준비되면 엔티티 상세가 표시됩니다.">
      {(r) =>
        r.kind === "redirect" ? (
          <InlineStatus>병합된 엔티티입니다. 생존 엔티티로 이동합니다…</InlineStatus>
        ) : (
          <DetailBody novelId={novelId} detail={r.detail} redirectedFrom={redirectedFrom ?? r.detail.redirectedFrom ?? undefined} similar={similar} />
        )
      }
    </QueryView>
  );
}

function DetailBody({ novelId, detail, redirectedFrom, similar }: { novelId: string; detail: EntityDetailDto; redirectedFrom?: string; similar?: number }) {
  const [section, setSection] = useState<Section>("names");
  const names = useEntityNames(novelId);
  const e = detail.entity;
  const preferred = detail.names.find((n) => n.isPreferred) ?? detail.names.find((n) => n.id === e.preferredNameId);
  const title = preferred?.surface ?? names.get(e.id) ?? "엔티티";
  const sceneToEpisode = useMemo(() => new Map(detail.appearances.map((a) => [a.sceneId, a.episodeNo])), [detail.appearances]);
  const episodes = [...new Set(detail.appearances.map((a) => a.episodeNo))].sort((a, b) => a - b);

  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          <span>
            <Link to={`/novels/${novelId}/ontology`} className="underline">
              온톨로지
            </Link>{" "}
            › {labelKo("entity_type", e.entityType)}
            {e.disambiguator && ` · ${e.disambiguator}`}
          </span>
        }
        actions={
          <>
            <StatusBadge enum="entity_status" value={e.status} />
            {e.isRealPerson && <Badge tone="warn">실존 인물</Badge>}
          </>
        }
      />
      {redirectedFrom && (
        <Callout tone="info" className="mb-3" title="병합된 엔티티의 옛 주소로 들어왔습니다">
          이 엔티티로 병합되어 새 주소로 안내했습니다.
        </Callout>
      )}
      {!!similar && (
        <Callout tone="warn" className="mb-3" title={`비슷한 이름의 엔티티가 ${similar}개 있습니다`}>
          같은 대상이면 동일성 결정(병합)으로 정리하세요.
        </Callout>
      )}

      <div className="mb-3 grid grid-cols-1 gap-3 min-[861px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="요약">
          <p className="m-0 text-[13px]">{e.summary ?? <span className="text-faint">요약이 없습니다.</span>}</p>
          {e.confusableWithIds.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              혼동 주의:
              {e.confusableWithIds.map((id) => (
                <Link key={id} to={`/novels/${novelId}/entities/${id}`}>
                  <Chip>{names.get(id) ?? "다른 엔티티"}</Chip>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title="등장">
          {episodes.length === 0 ? (
            <InlineStatus>아직 등장한 화가 없습니다.</InlineStatus>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {episodes.map((no) => (
                <Link key={no} to={`/novels/${novelId}/episodes/${no}`}>
                  <Chip>{no}화</Chip>
                </Link>
              ))}
            </div>
          )}
          {detail.titleHolders.length > 0 && (
            <div className="mt-2 text-xs text-muted">
              <div className="mb-1 font-semibold text-text">시점별 보유자</div>
              {detail.titleHolders.map((h, i) => (
                <div key={i}>
                  <Link className="underline" to={`/novels/${novelId}/entities/${h.entityId}`}>
                    {names.get(h.entityId) ?? "엔티티"}
                  </Link>{" "}
                  · {formatRange(h.storyRange)}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Tabs
        label="엔티티 상세"
        value={section}
        onChange={setSection}
        items={[
          { value: "names", label: "이름 사전", adornment: <span className="text-faint">{detail.names.length}</span> },
          { value: "facts", label: "사실" },
          { value: "mentions", label: "언급" },
          { value: "identity", label: "동일성 이력", adornment: <span className="text-faint">{detail.identityDecisions.length}</span> },
        ]}
      />
      <div className="mt-3">
        {section === "names" && <NamesSection novelId={novelId} detail={detail} />}
        {section === "facts" && <FactsSection novelId={novelId} detail={detail} names={names} />}
        {section === "mentions" && <MentionsSection novelId={novelId} entityId={e.id} sceneToEpisode={sceneToEpisode} />}
        {section === "identity" && <IdentitySection novelId={novelId} entityId={e.id} fallback={detail.identityDecisions} names={names} />}
      </div>
    </>
  );
}

// ── names ────────────────────────────────────────────────────────────────

function NamesSection({ novelId, detail }: { novelId: string; detail: EntityDetailDto }) {
  const timelines = useTimelines(novelId);
  const tl = (id: string | null) => (id ? (timelines.data?.find((t) => t.id === id)?.label ?? "다른 시간선") : "모든 시간선");
  const [adding, setAdding] = useState(false);
  type Row = EntityDetailDto["names"][number];
  const columns: Column<Row>[] = [
    {
      key: "surface",
      header: "표기",
      rowHeader: true,
      cell: (n) => (
        <span className={cx(n.status !== "active" && "text-faint line-through")}>
          <b>{n.surface}</b>
          {n.isPreferred && (
            <Badge tone="accent" className="ml-1">
              대표명
            </Badge>
          )}
        </span>
      ),
    },
    { key: "kind", header: "종류", cell: (n) => labelKo("name_kind", n.nameKind) },
    { key: "range", header: "사용 범위", cell: (n) => formatRangeLiteral(n.storyRange) },
    { key: "timeline", header: "시간선", cell: (n) => tl(n.timelineId) },
    { key: "sv", header: "표기 인지", cell: (n) => labelKo("name_visibility", n.surfaceVisibility) },
    { key: "iv", header: "정체 인지", cell: (n) => labelKo("name_visibility", n.identityVisibility) },
    { key: "reveal", header: "독자 공개", className: "tabular", cell: (n) => (n.readerRevealPoint == null ? "—" : `시점 ${n.readerRevealPoint}`) },
    { key: "status", header: "상태", cell: (n) => <StatusBadge enum="entity_name_status" value={n.status} /> },
  ];
  return (
    <div className="grid gap-2">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          이름 추가
        </Button>
      </div>
      <DataTable label="이름 사전" columns={columns} rows={detail.names} rowKey={(n) => n.id} empty="등록된 이름이 없습니다." />
      {adding && <AddNameDialog novelId={novelId} entityId={detail.entity.id} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddNameDialog({ novelId, entityId, onClose }: { novelId: string; entityId: string; onClose: () => void }) {
  const [surface, setSurface] = useState("");
  const [nameKind, setNameKind] = useState<NameKind>("alias");
  const [from, setFrom] = useState("");
  const m = useAddEntityName(novelId, entityId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="이름 추가"
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!surface.trim()}
            loading={m.isPending}
            onClick={() =>
              m.mutate(
                { surface: surface.trim(), nameKind, storyRange: from ? { from: Number(from), to: null } : undefined },
                { onSuccess: onClose },
              )
            }
          >
            추가
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="표기" required>
          <Input value={surface} onChange={(e) => setSurface(e.target.value)} maxLength={100} />
        </Field>
        <Field label="종류">
          <Select value={nameKind} onChange={(e) => setNameKind(e.target.value as NameKind)}>
            {ENUMS.name_kind.map((k) => (
              <option key={k} value={k}>
                {labelKo("name_kind", k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="사용 시작 시점" hint="비우면 처음부터 사용합니다.">
          <Input type="number" min={0} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}

// ── facts ────────────────────────────────────────────────────────────────

function FactsSection({ novelId, detail, names }: { novelId: string; detail: EntityDetailDto; names: Map<string, string> }) {
  const timelines = useTimelines(novelId);
  const [pointText, setPointText] = useState("");
  const [timelineId, setTimelineId] = useState("");
  const [include, setInclude] = useState<"canon" | "canon_and_safe_candidates">("canon");
  const point = pointText.trim() === "" ? undefined : Number(pointText);
  const asOf = point !== undefined && Number.isFinite(point);
  const facts = useEntityFacts(novelId, detail.entity.id, { storyPoint: asOf ? point : undefined, timelineId: timelineId || undefined, include }, asOf);
  const rows: FactAtAnchorDto[] | undefined = asOf ? facts.data : detail.factsSummary;
  const tl = (id: string) => timelines.data?.find((t) => t.id === id)?.label ?? "시간선";

  const columns: Column<FactAtAnchorDto>[] = [
    {
      key: "text",
      header: "사실",
      rowHeader: true,
      cell: (f) => (
        <span className={cx(f.canonStatus === "candidate" && "italic text-muted")}>
          {f.text}
          {f.objectEntityId && (
            <Link className="ml-1 text-xs underline" to={`/novels/${novelId}/entities/${f.objectEntityId}`}>
              → {names.get(f.objectEntityId) ?? "대상"}
            </Link>
          )}
        </span>
      ),
    },
    { key: "kind", header: "종류", cell: (f) => labelKo("fact_kind", f.factKind) },
    { key: "pred", header: "술어", cell: (f) => <code className="text-xs">{f.predicate}</code> },
    { key: "range", header: "시점", className: "tabular", cell: (f) => formatRange(f.storyRange) },
    { key: "tl", header: "시간선", cell: (f) => tl(f.timelineId) },
    { key: "canon", header: "캐논", cell: (f) => <StatusBadge enum="canon_status" value={f.canonStatus} /> },
  ];

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-muted">
          시점(story point)
          <Input type="number" min={0} value={pointText} onChange={(e) => setPointText(e.target.value)} placeholder="비우면 전체" className="w-36" />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          시간선
          <Select value={timelineId} onChange={(e) => setTimelineId(e.target.value)} className="w-auto" disabled={!asOf}>
            <option value="">기본 시간선</option>
            {(timelines.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.isDefault ? " (기본)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          포함
          <Select value={include} onChange={(e) => setInclude(e.target.value as typeof include)} className="w-auto" disabled={!asOf}>
            <option value="canon">캐논만</option>
            <option value="canon_and_safe_candidates">캐논 + 안전한 후보</option>
          </Select>
        </label>
        <span className="pb-2 text-xs text-muted">{asOf ? `시점 ${point} 기준 사실` : "모든 시점의 현재 사실"}</span>
      </div>
      {asOf && facts.error ? (
        <QueryError error={facts.error} compact />
      ) : !rows ? (
        <InlineStatus>불러오는 중…</InlineStatus>
      ) : (
        <DataTable label="사실" columns={columns} rows={rows} rowKey={(f) => f.factVersionId} empty="이 조건의 사실이 없습니다." caption="후보(candidate) 사실은 기울임으로 구분합니다." />
      )}
    </div>
  );
}

// ── mentions ─────────────────────────────────────────────────────────────

const LINK_PRIORITY: Record<string, number> = { ambiguous: 0, new_entity_candidate: 1, auto_linked: 2, confirmed: 3, rejected: 4 };

function MentionsSection({ novelId, entityId, sceneToEpisode }: { novelId: string; entityId: string; sceneToEpisode: Map<string, number> }) {
  const [filter, setFilter] = useState<string[]>([]);
  const q = useEntityMentions(novelId, entityId, filter);
  const columns: Column<MentionDto>[] = [
    { key: "surface", header: "표기", rowHeader: true, cell: (m) => <b>{m.surface}</b> },
    { key: "kind", header: "언급 종류", cell: (m) => labelKo("mention_kind", m.mentionKind) },
    { key: "status", header: "연결 상태", cell: (m) => <StatusBadge enum="link_status" value={m.linkStatus} /> },
    { key: "conf", header: "신뢰도", className: "tabular", cell: (m) => (m.confidence == null ? "—" : `${Math.round(m.confidence * 100)}%`) },
    { key: "point", header: "시점", className: "tabular", cell: (m) => m.storyPoint },
    {
      key: "where",
      header: "위치",
      cell: (m) => {
        const no = m.sceneId ? sceneToEpisode.get(m.sceneId) : undefined;
        if (m.sourceKind === "answer") return <span className="text-muted">답변</span>;
        if (no === undefined) return <span className="text-faint">—</span>;
        const qs = new URLSearchParams();
        if (m.manuscriptVersionId) qs.set("v", m.manuscriptVersionId);
        if (m.charStart != null) qs.set("at", String(m.charStart));
        if (m.charEnd != null) qs.set("end", String(m.charEnd));
        return (
          <Link className="underline" to={`/novels/${novelId}/episodes/${no}?${qs.toString()}`}>
            {no}화 원고 위치
          </Link>
        );
      },
    },
    {
      key: "q",
      header: "판별",
      cell: (m) =>
        m.questionId ? (
          <Link className="font-semibold text-accent underline" to={`/novels/${novelId}/inbox/${m.questionId}`}>
            인박스 질문
          </Link>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
  ];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="연결 상태 필터">
        {ENUMS.link_status.map((s) => {
          const on = filter.includes(s);
          return (
            <ToggleChip
              key={s}
              pressed={on}
              onClick={() => setFilter((cur) => (on ? cur.filter((x) => x !== s) : [...cur, s]))}
            >
              {labelKo("link_status", s)}
            </ToggleChip>
          );
        })}
      </div>
      <QueryView query={q} compact>
        {(items) => (
          <DataTable
            label="언급"
            columns={columns}
            rows={[...items].sort((a, b) => (LINK_PRIORITY[a.linkStatus] ?? 9) - (LINK_PRIORITY[b.linkStatus] ?? 9) || a.storyPoint - b.storyPoint)}
            rowKey={(m) => m.id}
            empty="언급이 없습니다."
            caption="판별이 필요한 언급(모호·새 엔티티 후보)을 먼저 보여 줍니다."
          />
        )}
      </QueryView>
    </div>
  );
}

// ── identity decisions ───────────────────────────────────────────────────

function IdentitySection({ novelId, entityId, fallback, names }: { novelId: string; entityId: string; fallback: IdentityDecisionDto[]; names: Map<string, string> }) {
  const q = useIdentityDecisions(novelId, entityId);
  const novel = useNovel(novelId);
  const [selected, setSelected] = useState<IdentityDecisionDto | null>(null);
  const items = q.data ?? fallback;
  const name = (id: string) => (
    <Link key={id} to={`/novels/${novelId}/entities/${id}`} className="underline">
      {names.get(id) ?? "엔티티"}
    </Link>
  );
  if (items.length === 0) return <InlineStatus>동일성 결정 이력이 없습니다.</InlineStatus>;
  return (
    <div className="grid gap-2">
      {[...items]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((d) => (
          <Card
            key={d.id}
            title={
              <span className="flex flex-wrap items-center gap-1.5">
                {labelKo("identity_decision_kind", d.kind)}
                <StatusBadge enum="identity_decision_status" value={d.status} />
              </span>
            }
            headingLevel={3}
            actions={
              <>
                <Button size="sm" onClick={() => setSelected(d)}>
                  {d.status === "applied" ? "영향 보기 · 되돌리기" : "영향 보기"}
                </Button>
              </>
            }
          >
            <div className="grid gap-1 text-[13px]">
              {d.sourceEntityIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  대상: {d.sourceEntityIds.map((id, i) => <span key={id}>{i > 0 && ", "}{name(id)}</span>)}
                  {d.survivorEntityId && <span>→ 생존: {name(d.survivorEntityId)}</span>}
                  {d.newEntityId && <span>→ 새 엔티티: {name(d.newEntityId)}</span>}
                </div>
              )}
              {d.kind === "relink" && (
                <div>
                  언급 {d.relinkMentionIds.length}건: {d.relinkFromEntityId ? name(d.relinkFromEntityId) : "—"} → {d.relinkToEntityId ? name(d.relinkToEntityId) : "—"}
                </div>
              )}
              {d.rationale && <div className="text-muted">근거: {d.rationale}</div>}
              <div className="text-xs text-faint">
                제안 {formatDateTime(d.createdAt, novel.data?.timezone)}
                {d.appliedAt && ` · 적용 ${formatDateTime(d.appliedAt, novel.data?.timezone)}`}
                {d.revertedAt && ` · 되돌림 ${formatDateTime(d.revertedAt, novel.data?.timezone)}`}
                {d.questionId && (
                  <>
                    {" · "}
                    <Link className="underline" to={`/novels/${novelId}/inbox/${d.questionId}`}>
                      관련 질문
                    </Link>
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
      {selected && <ImpactDialog novelId={novelId} decision={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ImpactDialog({ novelId, decision, onClose }: { novelId: string; decision: IdentityDecisionDto; onClose: () => void }) {
  const impact = useIdentityImpact(novelId, decision.id);
  const revert = useRevertIdentityDecision(novelId);
  const [reason, setReason] = useState("");
  const canRevert = decision.status === "applied";
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${labelKo("identity_decision_kind", decision.kind)} · 영향 범위`}
      description={canRevert ? "되돌리면 옮겨진 언급·사실·이름 참조가 원래 엔티티로 돌아갑니다. 영향 범위를 먼저 확인하세요." : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={revert.isPending}>
            닫기
          </Button>
          {canRevert && (
            <Button
              variant="danger"
              disabled={!impact.data || revert.isSuccess}
              loading={revert.isPending}
              onClick={() => revert.mutate({ id: decision.id, reason: reason.trim() || undefined }, { onSuccess: onClose })}
            >
              되돌리기
            </Button>
          )}
        </>
      }
    >
      <QueryView query={impact} compact>
        {(i) => (
          <div className="grid gap-3">
            <KeyValueList
              items={[
                { key: "m", label: "언급", value: `${i.mentions}건` },
                {
                  key: "f",
                  label: "사실",
                  value: (
                    <span>
                      {i.facts}건
                      {i.factsByStatus &&
                        Object.entries(i.factsByStatus).map(([k, v]) => (
                          <span key={k} className="ml-1 text-xs text-muted">
                            {labelKo("canon_status", k)} {v}
                          </span>
                        ))}
                    </span>
                  ),
                },
                { key: "n", label: "이름", value: i.names == null ? "—" : `${i.names}건` },
                { key: "s", label: "떡밥 연결", value: `${i.setupLinks}건` },
                { key: "p", label: "씬 참여", value: `${i.sceneParticipants}건` },
                { key: "c", label: "슬롯 충돌", value: i.slotConflicts.length === 0 ? "없음" : `${i.slotConflicts.length}건 (${i.slotConflicts.map((c) => c.slotKey).join(", ")})` },
              ]}
            />
            {i.requiresApproval && (
              <Callout tone="warn" title="공개 확정 사실이 포함됩니다">
                되돌리면 동일성 변경 승인 요청이 만들어지고, 승인 후 반영됩니다.
              </Callout>
            )}
            {canRevert && (
              <Field label="사유" hint="감사 기록에 남습니다.">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
            )}
            {revert.error && <Callout tone="danger">{errorMessage(revert.error)}</Callout>}
          </div>
        )}
      </QueryView>
    </Dialog>
  );
}

