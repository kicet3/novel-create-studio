import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ACTIVITY_ACTIONS, ENUMS, labelKo, type ActivityDto } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { Button, Callout, EmptyState, Input, QueryError, InlineStatus, Select, ToggleChip } from "../../components/ui/index.js";
import { CONTROL_FOCUS } from "../../components/ui/control.js";
import { cx } from "../../lib/cx.js";
import { useEpisodes } from "../manuscript/api.js";
import { useMe, useNovel } from "../novels/api.js";
import { ActivityItem, AreaDot } from "./ActivityItem.js";
import { mergeActivity, useActivityPages, useActivitySince, type ActivityFilter } from "./api.js";
import { refTypeKo, safeLabel, shortId } from "./labels.js";
import { areaGroupOf, areaLabelKo, dayLabelKo, groupByDay } from "./timeline.js";

const AREAS = [...new Set(ACTIVITY_ACTIONS.map((a) => a.slice(0, a.indexOf("."))))];
/**
 * Most-used areas get one-tap chips; the rest live in 상세 필터. `episode` (회차) is left to the full list — next to
 * 원고 with the same icon it read as a duplicate.
 */
const QUICK_AREAS = ["novel", "manuscript", "task", "question", "character", "setup", "budget", "settings"].filter((a) => AREAS.includes(a));
const FILTER_KEYS = ["actorType", "actorId", "targetType", "targetId", "actionPrefix"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Patch = Partial<Record<FilterKey, string | undefined>>;
type Me = { id: string; displayName: string } | null;

/** `/novels/:novelId/audit` — activity timeline (08 §9.7, FR-UI-07). Filters live in the query string. */
export function AuditPage() {
  const novelId = useNovelId();
  const me = useMe().data ?? null;
  const episodes = useEpisodes(novelId);
  const epNo = useMemo(() => new Map((episodes.data ?? []).map((e) => [e.id, e.episodeNo])), [episodes.data]);
  const [params, setParams] = useSearchParams();
  const filter: ActivityFilter = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]));
  const filterKey = FILTER_KEYS.map((k) => params.get(k) ?? "").join("|");

  const set = (patch: Patch) =>
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
  const clearAll = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  const active = FILTER_KEYS.some((k) => params.get(k));

  return (
    <>
      <PageHeader title="감사 타임라인" subtitle="누가 · 언제 · 무엇을 바꿨는지 최신순으로 보여 줍니다. 새 활동은 자동으로 맨 위에 추가됩니다." />
      <Filters filter={filter} me={me} epNo={epNo} set={set} clearAll={clearAll} />
      <Timeline
        key={filterKey}
        novelId={novelId}
        filter={filter}
        me={me}
        epNo={epNo}
        filtered={active}
        onClear={clearAll}
        onFilterTarget={(type, id) => {
          set({ targetType: type, targetId: id });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </>
  );
}

// ── filters ─────────────────────────────────────────────────────────────────
function Filters({
  filter,
  me,
  epNo,
  set,
  clearAll,
}: {
  filter: ActivityFilter;
  me: Me;
  epNo: Map<string, number>;
  set: (p: Patch) => void;
  clearAll: () => void;
}) {
  const panelId = useId();
  // removing an applied-filter chip unmounts the focused button; keep focus inside the filter bar
  const toggleRef = useRef<HTMLButtonElement>(null);
  const prefixArea = filter.actionPrefix?.replace(/\.$/, "");
  // active filters are always visible as removable chips, so the panel stays closed until asked for
  const [open, setOpen] = useState(false);

  const actorChips: Array<{
    id: string;
    label: string;
    pressed: boolean;
    patch: Patch;
  }> = [
    {
      id: "all",
      label: "전체",
      pressed: !filter.actorType,
      patch: { actorType: undefined, actorId: undefined },
    },
    {
      id: "me",
      label: "내 활동",
      // `?actorType=user` alone (old links) means every user — only "내 활동" when it is narrowed to me
      pressed: filter.actorType === "user" && !!me && filter.actorId === me.id,
      patch: { actorType: "user", actorId: me?.id },
    },
    {
      id: "agent",
      label: "에이전트",
      pressed: filter.actorType === "agent",
      patch: { actorType: "agent", actorId: undefined },
    },
    {
      id: "system",
      label: "시스템",
      pressed: filter.actorType === "system",
      patch: { actorType: "system", actorId: undefined },
    },
  ];

  const chips = activeChips(filter, me, epNo);

  return (
    <section aria-label="활동 필터" className="mb-4 grid gap-2.5 rounded-lg border border-border bg-surface p-3 shadow-card">
      <div role="group" aria-label="누가" className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className="w-9 text-xs font-semibold text-muted">
          누가
        </span>
        {actorChips.map((c) => (
          <ToggleChip key={c.id} pressed={c.pressed} onClick={() => set(c.pressed && c.id !== "all" ? { actorType: undefined, actorId: undefined } : c.patch)}>
            {c.label}
          </ToggleChip>
        ))}
      </div>

      <div
        role="group"
        aria-label="무엇을 (영역)"
        className="flex items-center gap-1.5 overflow-x-auto pb-0.5 max-[860px]:-mx-3 max-[860px]:px-3 min-[861px]:flex-wrap"
      >
        <span aria-hidden="true" className="w-9 flex-none text-xs font-semibold text-muted">
          영역
        </span>
        <ToggleChip pressed={!filter.actionPrefix} onClick={() => set({ actionPrefix: undefined })}>
          전체
        </ToggleChip>
        {QUICK_AREAS.map((a) => {
          const pressed = prefixArea === a;
          return (
            <ToggleChip key={a} pressed={pressed} onClick={() => set({ actionPrefix: pressed ? undefined : `${a}.` })} className="gap-1.5 pl-1.5">
              <AreaDot area={areaGroupOf(`${a}.x`)} size="sm" />
              {areaLabelKo(a)}
            </ToggleChip>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-text",
            CONTROL_FOCUS,
          )}
        >
          상세 필터
          <span aria-hidden="true" className={cx("inline-block transition-transform motion-reduce:transition-none", open && "rotate-180")}>
            ▾
          </span>
        </button>
        {chips.length > 0 && (
          <>
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
            <span className="text-xs text-muted">적용 중</span>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {chips.map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => {
                      set(c.remove);
                      toggleRef.current?.focus();
                    }}
                    aria-label={`${c.label} 필터 해제`}
                    className={cx(
                      "inline-flex h-7 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft pl-2.5 pr-1.5 text-xs text-accent hover:border-accent",
                      CONTROL_FOCUS,
                    )}
                  >
                    {c.label}
                    <span aria-hidden="true" className="grid size-4 place-items-center rounded-full text-[13px] leading-none">
                      ×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearAll();
                toggleRef.current?.focus();
              }}
              className="h-7"
            >
              모두 지우기
            </Button>
          </>
        )}
      </div>
      <div id={panelId} hidden={!open} className="border-t border-border pt-2.5">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          <label className="grid gap-1 text-xs text-muted">
            {filter.actorType === "system" ? "구성 요소" : "에이전트 역할"}
            {filter.actorType === "system" ? (
              <Select value={filter.actorId ?? ""} onChange={(e) => set({ actorId: e.target.value || undefined })}>
                <option value="">모든 구성 요소</option>
                {ENUMS.system_component.map((r) => (
                  <option key={r} value={r}>
                    {labelKo("system_component", r)}
                  </option>
                ))}
              </Select>
            ) : (
              <Select
                value={filter.actorType === "agent" ? (filter.actorId ?? "") : ""}
                onChange={(e) => set(e.target.value ? { actorType: "agent", actorId: e.target.value } : { actorId: undefined })}
              >
                <option value="">모든 역할</option>
                {ENUMS.agent_role.map((r) => (
                  <option key={r} value={r}>
                    {labelKo("agent_role", r)}
                  </option>
                ))}
              </Select>
            )}
          </label>
          <label className="grid gap-1 text-xs text-muted">
            영역 (전체 목록)
            <Select value={filter.actionPrefix ?? ""} onChange={(e) => set({ actionPrefix: e.target.value || undefined })}>
              <option value="">전체</option>
              {AREAS.map((a) => (
                <option key={a} value={`${a}.`}>
                  {areaLabelKo(a)}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-muted">
            대상 유형
            <Select value={filter.targetType ?? ""} onChange={(e) => set({ targetType: e.target.value || undefined })}>
              <option value="">전체</option>
              {ENUMS.ref_type.map((t) => (
                <option key={t} value={t}>
                  {refTypeKo(t)}
                </option>
              ))}
            </Select>
          </label>
          <TargetIdInput value={filter.targetId ?? ""} onCommit={(v) => set({ targetId: v || undefined })} />
        </div>
      </div>
    </section>
  );
}

function activeChips(filter: ActivityFilter, me: Me, epNo: Map<string, number>): Array<{ key: string; label: string; remove: Patch }> {
  const out: Array<{ key: string; label: string; remove: Patch }> = [];
  if (filter.actorType) {
    const who = filter.actorType === "user" ? (me && filter.actorId === me.id ? "나" : "사용자") : safeLabel("actor_type", filter.actorType);
    out.push({
      key: "actorType",
      label: `누가: ${who}`,
      remove: { actorType: undefined, actorId: undefined },
    });
  }
  if (filter.actorId && filter.actorType !== "user") {
    // `?actorId=` without actorType (old links): pick the vocabulary the id belongs to
    const isSystem =
      filter.actorType === "system" ||
      (!filter.actorType && (ENUMS.system_component as readonly string[]).includes(filter.actorId) && !(ENUMS.agent_role as readonly string[]).includes(filter.actorId));
    const name = isSystem ? safeLabel("system_component", filter.actorId) : safeLabel("agent_role", filter.actorId);
    out.push({
      key: "actorId",
      label: `${isSystem ? "구성 요소" : "역할"}: ${name}`,
      remove: { actorId: undefined },
    });
  }
  if (filter.actionPrefix)
    out.push({
      key: "actionPrefix",
      label: `영역: ${areaLabelKo(filter.actionPrefix.replace(/\.$/, ""))}`,
      remove: { actionPrefix: undefined },
    });
  if (filter.targetType)
    out.push({
      key: "targetType",
      label: `대상 유형: ${refTypeKo(filter.targetType)}`,
      remove: { targetType: undefined },
    });
  if (filter.targetId) {
    const ids = filter.targetId
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const name = ids.length > 1 ? `${ids.length}개` : epNo.has(ids[0]!) ? `${epNo.get(ids[0]!)}화` : shortId(ids[0] ?? "");
    out.push({
      key: "targetId",
      label: `대상: ${name}`,
      remove: { targetId: undefined },
    });
  }
  return out;
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
      <Input
        id="audit-target-id"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== value && onCommit(v.trim())}
        className="font-mono text-xs"
        placeholder="epi_… , ent_…"
      />
    </form>
  );
}

// ── timeline ────────────────────────────────────────────────────────────────
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Timeline({
  novelId,
  filter,
  me,
  epNo,
  filtered,
  onClear,
  onFilterTarget,
}: {
  novelId: string;
  filter: ActivityFilter;
  me: Me;
  epNo: Map<string, number>;
  filtered: boolean;
  onClear: () => void;
  onFilterTarget: (type: string, id: string) => void;
}) {
  const pages = useActivityPages(novelId, filter);
  const novel = useNovel(novelId);
  const now = useNow();
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
  const tz = novel.data?.timezone;
  const groups = useMemo(() => groupByDay(items, tz), [items, tz]);

  if (pages.error && !pages.data)
    return <QueryError error={pages.error} onRetry={() => void pages.refetch()} notReadyDescription="감사 기록 조회가 준비되면 표시됩니다." />;
  if (!pages.data) return <InlineStatus>활동 기록을 불러오는 중…</InlineStatus>;
  if (items.length === 0)
    return filtered ? (
      <EmptyState
        title="조건에 맞는 활동이 없습니다"
        description="필터를 줄이거나 모두 지워서 전체 활동을 확인해 보세요."
        actions={<Button onClick={onClear}>필터 모두 지우기</Button>}
      />
    ) : (
      <EmptyState
        icon="◷"
        title="아직 기록된 활동이 없습니다"
        description="작품 설정을 바꾸거나 에이전트가 작업을 시작하면, 누가 무엇을 했는지 이곳에 시간순으로 쌓입니다."
      />
    );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
        <span>
          {items.length}건 · 최신순{tz ? ` · ${tz} 기준` : ""}
        </span>
        {freshSeqs.size > 0 && (
          <button
            type="button"
            onClick={() => {
              window.scrollTo({ top: 0, behavior: "smooth" });
              setFreshSeqs(new Set());
            }}
            className={cx(
              "inline-flex h-6 items-center gap-1 rounded-full bg-info-soft px-2.5 text-[11.5px] font-semibold text-info hover:brightness-95",
              CONTROL_FOCUS,
            )}
          >
            <span aria-hidden="true">●</span> 새 활동 {freshSeqs.size}건 · 확인
          </button>
        )}
        {since.error ? <span className="text-danger">새 활동을 확인하지 못했습니다. 잠시 후 다시 시도합니다.</span> : null}
      </div>

      {groups.map((g) => {
        const label = dayLabelKo(g.key, now, tz);
        const hid = `audit-day-${g.key || "unknown"}`;
        return (
          <section key={g.key} aria-labelledby={hid}>
            <h2
              id={hid}
              className="sticky top-0 z-10 -mx-1 mb-2 flex items-baseline gap-2 bg-bg/95 px-1 py-1.5 text-[13.5px] font-bold backdrop-blur max-[860px]:top-[53px]"
            >
              {label.title}
              {label.sub && <span className="text-xs font-normal text-muted">{label.sub}</span>}
              <span className="ml-auto text-xs font-normal text-muted">{g.items.length}건</span>
            </h2>
            <ol className="relative m-0 list-none p-0 before:absolute before:top-3 before:bottom-3 before:left-[15.5px] before:w-px before:bg-border">
              {g.items.map((a) => (
                <ActivityItem
                  key={a.seq}
                  a={a}
                  tz={tz}
                  now={now}
                  me={me}
                  fresh={freshSeqs.has(a.seq)}
                  novelId={novelId}
                  epNo={epNo}
                  onFilterTarget={onFilterTarget}
                />
              ))}
            </ol>
          </section>
        );
      })}

      <div className="flex justify-center py-2">
        {pages.hasNextPage ? (
          <Button onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>
            이전 활동 더 보기
          </Button>
        ) : (
          <span className="text-xs text-muted">처음 기록까지 모두 불러왔습니다.</span>
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
