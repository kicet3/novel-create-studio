import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ENUMS, labelKo, type EpisodeStatus } from "@ncs/shared";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  formatDateTime,
  QueryView,
  Select,
  StatusBadge,
  Table,
  TableWrap,
  Td,
  Th,
  ToggleChip,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useNovel } from "../novels/api.js";
import { useArcs, useEpisodes, type ArcDto, type EpisodeDto } from "./api.js";
import { ExportDialog, type ExportTarget } from "./ExportDialog.js";

/** `/novels/:novelId/manuscript` — episodes grouped by arc, filterable by status (08 §9.4). */
export function EpisodeList({ novelId }: { novelId: string }) {
  const episodes = useEpisodes(novelId);
  const arcs = useArcs(novelId);
  const novel = useNovel(novelId);
  const tz = novel.data?.timezone;
  const [statuses, setStatuses] = useState<EpisodeStatus[]>([]);
  const [arcId, setArcId] = useState<string>("");
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const toggle = (s: EpisodeStatus) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <>
      <PageHeader
        title="원고"
        subtitle="플롯별 화 목록 · 상태 필터 · 화를 고르면 버전·diff·직접 수정 화면으로 이동합니다."
        actions={
          <Button onClick={() => setExportTarget({ scopeKind: "novel", label: "작품 전체" })}>TXT · Markdown 내보내기</Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="화 상태 필터">
        {ENUMS.episode_status.map((s) => {
          const on = statuses.includes(s);
          return (
            <ToggleChip
              key={s}
              pressed={on}
              onClick={() => toggle(s)}
            >
              {labelKo("episode_status", s)}
            </ToggleChip>
          );
        })}
        {statuses.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setStatuses([])}>
            필터 지우기
          </Button>
        )}
        <label className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-muted">
          플롯
          <Select controlSize="sm" value={arcId} onChange={(e) => setArcId(e.target.value)} className="w-auto max-w-56">
            <option value="">전체</option>
            {(arcs.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                플롯 {a.ord} · {a.title}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <QueryView query={episodes} notReadyDescription="원고 모듈이 준비되면 화 목록이 표시됩니다.">
        {(items) => (
          <Grouped
            novelId={novelId}
            arcs={arcs.data ?? []}
            episodes={items.filter((e) => (statuses.length === 0 || statuses.includes(e.status)) && (!arcId || e.arcId === arcId))}
            total={items.length}
            tz={tz}
            onExportArc={(a) => setExportTarget({ scopeKind: "arc", targetId: a.id, label: `플롯 ${a.ord} · ${a.title}` })}
          />
        )}
      </QueryView>
      {exportTarget && <ExportDialog novelId={novelId} target={exportTarget} open onClose={() => setExportTarget(null)} />}
    </>
  );
}

function Grouped({
  novelId,
  arcs,
  episodes,
  total,
  tz,
  onExportArc,
}: {
  novelId: string;
  arcs: ArcDto[];
  episodes: EpisodeDto[];
  total: number;
  tz?: string;
  onExportArc: (a: ArcDto) => void;
}) {
  const navigate = useNavigate();
  const groups = useMemo(() => {
    const byArc = new Map<string, EpisodeDto[]>();
    for (const e of [...episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
      const list = byArc.get(e.arcId) ?? [];
      list.push(e);
      byArc.set(e.arcId, list);
    }
    const ordered = [...arcs].sort((a, b) => a.ord - b.ord).filter((a) => byArc.has(a.id));
    const known = new Set(ordered.map((a) => a.id));
    const orphan = [...byArc.keys()].filter((k) => !known.has(k));
    return [
      ...ordered.map((a) => ({ arc: a as ArcDto | null, key: a.id, items: byArc.get(a.id) ?? [] })),
      ...orphan.map((k) => ({ arc: null, key: k, items: byArc.get(k) ?? [] })),
    ];
  }, [arcs, episodes]);

  if (total === 0) {
    return <EmptyState title="아직 화가 없습니다" description="기획서와 플롯 계획이 승인되면 화가 예약되고 아웃라인부터 작성됩니다." />;
  }
  if (groups.length === 0) return <EmptyState title="조건에 맞는 화가 없습니다" description="필터를 바꿔 보세요." />;

  return (
    <div className="grid gap-3">
      {groups.map((g) => (
        <Card
          key={g.key}
          title={g.arc ? `플롯 ${g.arc.ord} · ${g.arc.title} (${g.arc.plannedEpisodeFrom}~${g.arc.plannedEpisodeTo}화)` : "플롯 미상"}
          actions={
            g.arc && (
              <>
                <StatusBadge enum="arc_status" value={g.arc.status} />
                <Button size="sm" onClick={() => onExportArc(g.arc as ArcDto)}>
                  플롯 내보내기
                </Button>
              </>
            )
          }
        >
          <TableWrap label={`화 목록${g.arc ? ` · 플롯 ${g.arc.ord}` : ""}`}>
            <Table>
              <thead>
                <tr>
                  <Th className="w-16">화</Th>
                  <Th>제목</Th>
                  <Th>상태</Th>
                  <Th>차단·메모</Th>
                  <Th>반려</Th>
                  <Th>승인</Th>
                  <Th>공개</Th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer hover:bg-surface-2"
                    onClick={() => navigate(`/novels/${novelId}/episodes/${e.episodeNo}`)}
                  >
                    <Th scope="row" className="tabular whitespace-nowrap border-b-border bg-transparent text-text">
                      <Link to={`/novels/${novelId}/episodes/${e.episodeNo}`} onClick={(ev) => ev.stopPropagation()} className="font-semibold">
                        {e.episodeNo}화
                      </Link>
                    </Th>
                    <Td className="min-w-28">{e.title ?? <span className="text-faint">제목 없음</span>}</Td>
                    <Td>
                      <StatusBadge enum="episode_status" value={e.status} />
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {e.pausedAt && <Badge tone="warn">일시정지</Badge>}
                        {e.lengthBelowFloor && (
                          <Badge tone="danger" glyph>
                            분량 미달
                          </Badge>
                        )}
                        {e.blockReasons.map((r) => (
                          <Badge key={r} tone="danger" glyph>
                            {labelKo("episode_block_reason", r)}
                          </Badge>
                        ))}
                        {!e.pausedAt && !e.lengthBelowFloor && e.blockReasons.length === 0 && <span className="text-faint">—</span>}
                      </div>
                    </Td>
                    <Td className="tabular">{e.rejectionCount > 0 ? `${e.rejectionCount}회` : "—"}</Td>
                    <Td className="tabular whitespace-nowrap text-muted">{formatDateTime(e.approvedAt, tz)}</Td>
                    <Td className="tabular whitespace-nowrap text-muted">{formatDateTime(e.publishedAt, tz)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      ))}
    </div>
  );
}
