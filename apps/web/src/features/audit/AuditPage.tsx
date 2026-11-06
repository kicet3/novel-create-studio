import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ACTIVITY_ACTIONS, ENUMS, labelKo, type ActivityDto } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { Badge, Button, Callout, Input, QueryError, InlineStatus, Select, formatDateTime } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useEpisodes } from "../manuscript/api.js";
import { useMe, useNovel } from "../novels/api.js";
import { bulkInfo, mergeActivity, summarizeChange, useActivityPages, useActivitySince, type ActivityFilter } from "./api.js";
import { actionAreaKo, actionLabelKo, actorLabelKo, displayChanges, refTypeKo } from "./labels.js";

const AREAS = [...new Set(ACTIVITY_ACTIONS.map((a) => a.slice(0, a.indexOf("."))))];
const FILTER_KEYS = ["actorType", "actorId", "targetType", "targetId", "actionPrefix"] as const;

/** `/novels/:novelId/audit` — activity timeline (08 §9.7, FR-UI-07). Filters live in the query string. */
export function AuditPage() {
  const novelId = useNovelId();
  const [params, setParams] = useSearchParams();
  const filter: ActivityFilter = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]));
  const filterKey = FILTER_KEYS.map((k) => params.get(k) ?? "").join("|");

  const set = (patch: Partial<Record<(typeof FILTER_KEYS)[number], string | undefined>>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );

  const active = FILTER_KEYS.some((k) => params.get(k));

  return (
    <>
      <PageHeader title="감사 타임라인" subtitle="누가 언제 무엇을 바꿨는지 최신순으로 봅니다. 새 활동은 자동으로 맨 위에 추가됩니다." />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-muted">
          주체
          <Select value={filter.actorType ?? ""} onChange={(e) => set({ actorType: e.target.value || undefined, actorId: undefined })} className="w-auto">
            <option value="">전체</option>
            {ENUMS.actor_type.map((t) => (
              <option key={t} value={t}>
                {labelKo("actor_type", t)}
              </option>
            ))}
          </Select>
        </label>
        {filter.actorType === "agent" && (
          <label className="grid gap-1 text-xs text-muted">
            역할
            <Select value={filter.actorId ?? ""} onChange={(e) => set({ actorId: e.target.value || undefined })} className="w-auto">
              <option value="">모든 역할</option>
              {ENUMS.agent_role.map((r) => (
                <option key={r} value={r}>
                  {labelKo("agent_role", r)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {filter.actorType === "system" && (
          <label className="grid gap-1 text-xs text-muted">
            구성 요소
            <Select value={filter.actorId ?? ""} onChange={(e) => set({ actorId: e.target.value || undefined })} className="w-auto">
              <option value="">전체</option>
              {ENUMS.system_component.map((r) => (
                <option key={r} value={r}>
                  {labelKo("system_component", r)}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="grid gap-1 text-xs text-muted">
          동작
          <Select value={filter.actionPrefix ?? ""} onChange={(e) => set({ actionPrefix: e.target.value || undefined })} className="w-auto">
            <option value="">전체</option>
            {AREAS.map((a) => (
              <option key={a} value={`${a}.`}>
                {actionAreaKo(a)}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          대상 유형
          <Select value={filter.targetType ?? ""} onChange={(e) => set({ targetType: e.target.value || undefined })} className="w-auto">
            <option value="">전체</option>
            {ENUMS.ref_type.map((t) => (
              <option key={t} value={t}>
                {refTypeKo(t)}
              </option>
            ))}
          </Select>
        </label>
        <TargetIdInput value={filter.targetId ?? ""} onCommit={(v) => set({ targetId: v || undefined })} />
        {active && (
          <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            필터 지우기
          </Button>
        )}
      </div>
      <Timeline key={filterKey} novelId={novelId} filter={filter} onFilterTarget={(type, id) => set({ targetType: type, targetId: id })} />
    </>
  );
}

function TargetIdInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <form
      className="grid gap-1 text-xs text-muted"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(v.trim());
      }}
    >
      <label htmlFor="audit-target-id">대상 ID (쉼표로 여러 개)</label>
      <Input id="audit-target-id" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && onCommit(v.trim())} className="w-56 font-mono text-xs" placeholder="epi_… , ent_…" />
    </form>
  );
}

function Timeline({ novelId, filter, onFilterTarget }: { novelId: string; filter: ActivityFilter; onFilterTarget: (type: string, id: string) => void }) {
  const pages = useActivityPages(novelId, filter);
  const novel = useNovel(novelId);
  const me = useMe().data ?? null;
  const episodes = useEpisodes(novelId);
  const epNo = useMemo(() => new Map((episodes.data ?? []).map((e) => [e.id, e.episodeNo])), [episodes.data]);
  const [head, setHead] = useState<ActivityDto[]>([]);
  const [freshSeqs, setFreshSeqs] = useState<Set<number>>(new Set());

  const firstPage = pages.data?.pages[0];
  const afterSeq = Math.max(head[0]?.seq ?? 0, firstPage?.latestSeq ?? 0, firstPage?.items[0]?.seq ?? 0);
  const since = useActivitySince(novelId, filter, firstPage ? afterSeq : undefined, !!firstPage);

  useEffect(() => {
    const items = since.data?.items;
    if (!items || items.length === 0) return;
    setHead((h) => mergeActivity(items, h));
    setFreshSeqs((s) => new Set([...s, ...items.map((i) => i.seq)]));
  }, [since.data]);

  const items = useMemo(() => mergeActivity(head, pages.data?.pages.flatMap((p) => p.items) ?? []), [head, pages.data]);

  if (pages.error && !pages.data) return <QueryError error={pages.error} onRetry={() => void pages.refetch()} notReadyDescription="감사 기록 조회가 준비되면 표시됩니다." />;
  if (!pages.data) return <InlineStatus>불러오는 중…</InlineStatus>;
  if (items.length === 0) return <InlineStatus>조건에 맞는 활동이 없습니다.</InlineStatus>;

  const tz = novel.data?.timezone;
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
        {items.length}건 표시
        {freshSeqs.size > 0 && <Badge tone="info">새 활동 {freshSeqs.size}건</Badge>}
        {since.error ? <span className="text-danger">새 활동을 확인하지 못했습니다.</span> : null}
      </div>
      <ol className="m-0 list-none rounded-lg border border-border bg-surface p-0">
        {items.map((a) => (
          <Row key={a.seq} a={a} tz={tz} me={me} fresh={freshSeqs.has(a.seq)} novelId={novelId} epNo={epNo} onFilterTarget={onFilterTarget} />
        ))}
      </ol>
      <div className="flex justify-center py-2">
        {pages.hasNextPage ? (
          <Button onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>
            이전 활동 더 보기
          </Button>
        ) : (
          <span className="text-xs text-faint">처음 기록까지 모두 불러왔습니다.</span>
        )}
      </div>
      {pages.error && pages.data && (
        <Callout tone="danger" title="더 불러오지 못했습니다">
          잠시 후 다시 시도하세요.
        </Callout>
      )}
    </div>
  );
}

function targetHref(novelId: string, type: string, id: string, epNo: Map<string, number>): string | null {
  const base = `/novels/${novelId}`;
  switch (type) {
    case "episode": {
      const no = epNo.get(id);
      return no !== undefined ? `${base}/episodes/${no}` : null;
    }
    case "entity":
      return `${base}/entities/${id}`;
    case "setup":
      return `${base}/setups/${id}`;
    case "question":
      return `${base}/inbox/${id}`;
    case "task":
    case "run":
      return `${base}/board`;
    case "novel":
      return base;
    case "goal":
    case "budget_policy":
      return `${base}/settings`;
    default:
      return null;
  }
}

function Row({
  a,
  tz,
  me,
  fresh,
  novelId,
  epNo,
  onFilterTarget,
}: {
  a: ActivityDto;
  tz?: string;
  me: { id: string; displayName: string } | null;
  fresh: boolean;
  novelId: string;
  epNo: Map<string, number>;
  onFilterTarget: (type: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const changes = displayChanges(summarizeChange(a.before, a.after));
  const bulk = bulkInfo(a.details);
  const href = targetHref(novelId, a.targetType, a.targetId, epNo);
  const targetText = a.targetType === "episode" && epNo.has(a.targetId) ? `${epNo.get(a.targetId)}화` : refTypeKo(a.targetType);
  return (
    <li className={cx("grid gap-1 border-t border-border px-3 py-2 first:border-t-0 min-[861px]:grid-cols-[120px_150px_minmax(0,1fr)]", fresh && "bg-info-soft/40")}>
      <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted min-[861px]:block">
        <div className="flex items-baseline gap-1.5 min-[861px]:block">
          <time dateTime={a.occurredAt} className="whitespace-nowrap">
            {formatDateTime(a.occurredAt, tz)}
          </time>
          <div className="text-faint">#{a.seq}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[12.5px] min-[861px]:hidden">
          <Badge tone={a.actorType === "user" ? "warn" : a.actorType === "agent" ? "info" : "neutral"}>{labelKo("actor_type", a.actorType)}</Badge>
          <span>{actorLabelKo(a, me)}</span>
        </div>
      </div>
      <div className="text-[12.5px] max-[860px]:hidden">
        <Badge tone={a.actorType === "user" ? "warn" : a.actorType === "agent" ? "info" : "neutral"}>{labelKo("actor_type", a.actorType)}</Badge>
        <div className="mt-0.5 text-muted">{actorLabelKo(a, me)}</div>
      </div>
      <div className="min-w-0 text-[13px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <b title={a.action}>{actionLabelKo(a.action)}</b>
          <span className="text-muted">·</span>
          {href ? (
            <Link to={href} className="inline-flex min-h-6 items-center underline">
              {targetText}
            </Link>
          ) : (
            <span>{targetText}</span>
          )}
          <button type="button" className="inline-flex min-h-6 items-center px-1 text-xs text-accent underline" onClick={() => onFilterTarget(a.targetType, a.targetId)}>
            이 대상 이력
          </button>
          {a.questionId && (
            <Link className="inline-flex min-h-6 items-center px-1 text-xs underline" to={`/novels/${novelId}/inbox/${a.questionId}`}>
              질문
            </Link>
          )}
        </div>
        {a.reason && <div className="text-muted">사유: {a.reason}</div>}
        {changes.length > 0 && (
          <ul className="m-0 mt-0.5 list-none p-0 text-xs text-muted">
            {changes.map((c, i) => (
              <li key={i}>
                {c.label && (
                  <span className="mr-1 font-semibold" title={c.key}>
                    {c.label}
                  </span>
                )}
                <span className="line-through decoration-faint" title={c.fromRaw}>
                  {c.from}
                </span>{" "}
                → <span className="text-text" title={c.toRaw}>{c.to}</span>
              </li>
            ))}
          </ul>
        )}
        {bulk && (
          <div className="mt-0.5 text-xs text-muted">
            {bulk.count}건
            {bulk.ids.length > 0 && (
              <>
                {" "}
                <button type="button" className="inline-flex min-h-6 items-center px-1 text-accent underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                  {open ? "ID 접기" : "ID 펼치기"}
                </button>
                {open && <div className="mt-1 break-all font-mono text-[11px]">{bulk.ids.join(", ")}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
