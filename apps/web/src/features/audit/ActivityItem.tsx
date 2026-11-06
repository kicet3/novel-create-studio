import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ActivityDto } from "@ncs/shared";
import { NavIcon } from "../../components/layout/icons.js";
import { Badge, TONE_SOFT } from "../../components/ui/index.js";
import { CONTROL_FOCUS } from "../../components/ui/control.js";
import { cx } from "../../lib/cx.js";
import { bulkInfo, summarizeChange } from "./api.js";
import { actionLabelKo, displayChanges, refTypeKo } from "./labels.js";
import { actorView, areaGroupOf, buildSentence, exactTimeKo, sentenceText, relativeTimeKo, targetNameOf, targetTextKo, type AreaGroup } from "./timeline.js";

export function targetHref(novelId: string, type: string, id: string, epNo: Map<string, number>): string | null {
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

const LINK_BTN = cx("inline-flex min-h-6 items-center rounded px-1 text-xs underline-offset-2 hover:underline", CONTROL_FOCUS);

export function AreaDot({ area, size = "md" }: { area: AreaGroup; size?: "md" | "sm" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid flex-none place-items-center rounded-full font-bold",
        size === "md" ? "size-8 text-[13px] ring-4 ring-bg" : "size-4 text-[9px]",
        TONE_SOFT[area.tone],
      )}
    >
      {area.icon ? (
        <NavIcon name={area.icon} width={size === "md" ? 16 : 10} height={size === "md" ? 16 : 10} strokeWidth={size === "md" ? 1.9 : 2.4} />
      ) : (
        area.glyph
      )}
    </span>
  );
}

export interface ActivityItemProps {
  a: ActivityDto;
  tz?: string;
  now: number;
  me: { id: string; displayName: string } | null;
  fresh: boolean;
  novelId: string;
  epNo: Map<string, number>;
  onFilterTarget: (type: string, id: string) => void;
}

/** One timeline event: area dot on the rail + card with "누가 무엇을" sentence, reason, changes and a details drawer. */
export function ActivityItem({ a, tz, now, me, fresh, novelId, epNo, onFilterTarget }: ActivityItemProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const area = areaGroupOf(a.action);
  const actor = actorView(a, me);
  const bulk = bulkInfo(a.details);
  const targetName = a.targetType === "episode" ? undefined : targetNameOf(a.before, a.after);
  const changes = useMemo(
    () =>
      displayChanges(summarizeChange(a.before, a.after), a.targetType)
        // a newly set title/name is already in the sentence
        .filter((c) => !(c.from === "—" && (c.key === "title" || c.key === "name") && targetName)),
    [a.before, a.after, a.targetType, targetName],
  );
  const target = targetTextKo(a.action, {
    type: a.targetType,
    episodeNo: a.targetType === "episode" ? epNo.get(a.targetId) : undefined,
    name: targetName,
    count: bulk?.count,
  });
  const parts = buildSentence(a.action, actor.name, target);
  const sentence = sentenceText(parts);
  const href = targetHref(novelId, a.targetType, a.targetId, epNo);
  const exact = exactTimeKo(a.occurredAt, tz);

  return (
    <li className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 pb-3 last:pb-0">
      <div className="relative z-[1] flex justify-center pt-2.5">
        <AreaDot area={area} />
      </div>
      <article
        aria-label={`${area.label} · ${sentence}`}
        className={cx(
          "min-w-0 rounded-lg border bg-surface px-3.5 py-2.5 shadow-card max-[480px]:px-3",
          fresh ? "border-info ring-1 ring-info/30" : "border-border",
        )}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {/* who is said once — in the sentence below; the header only carries 영역 and 언제 */}
          <span className="font-semibold text-muted">{area.label}</span>
          {fresh && (
            <Badge tone="info" className="ml-0.5">
              새 활동
            </Badge>
          )}
          <time dateTime={a.occurredAt} title={exact} className="tabular ml-auto whitespace-nowrap text-muted">
            {relativeTimeKo(a.occurredAt, now, tz)}
            <span className="sr-only"> ({exact})</span>
          </time>
        </header>

        <p className="m-0 mt-1 flex items-start gap-2 text-[14px] leading-6">
          <span
            title={`${actor.kind} · ${actor.label}`}
            aria-hidden="true"
            className={cx("mt-0.5 grid size-5 flex-none place-items-center rounded-full text-[10px] font-bold", TONE_SOFT[actor.tone])}
          >
            {actor.initials}
          </span>
          <span className="min-w-0">
            {parts.map((p, i) =>
              p.kind === "actor" ? (
                <strong key={i} className="font-semibold">
                  {p.text}
                </strong>
              ) : p.kind === "target" ? (
                href ? (
                  <Link
                    key={i}
                    to={href}
                    className={cx("rounded font-semibold underline decoration-accent/40 underline-offset-[3px] hover:decoration-accent", CONTROL_FOCUS)}
                  >
                    {p.text}
                  </Link>
                ) : (
                  <strong key={i} className="font-semibold">
                    {p.text}
                  </strong>
                )
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </span>
        </p>

        {a.reason && (
          <blockquote className="m-0 mt-1.5 border-l-2 border-border pl-2.5 text-[13px] text-muted">
            <span className="sr-only">사유: </span>
            {a.reason}
          </blockquote>
        )}

        {changes.length > 0 && (
          <dl aria-label="바뀐 내용" className="m-0 mt-2 grid gap-1 rounded-md bg-surface-2 px-2.5 py-1.5 text-[12.5px]">
            {changes.map((c, i) => {
              const fromEmpty = c.from === "—";
              return (
                <div key={i} className="grid grid-cols-[minmax(3.5rem,auto)_minmax(0,1fr)] items-baseline gap-x-3">
                  <dt className="font-semibold text-muted" title={c.key || undefined}>
                    {c.label || "값"}
                  </dt>
                  <dd className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 break-words">
                    {!fromEmpty && (
                      <>
                        <del className="text-muted decoration-muted/70" title={c.fromRaw}>
                          <span className="sr-only">이전 값 </span>
                          {c.from}
                        </del>
                        <span aria-hidden="true" className="text-faint">
                          →
                        </span>
                      </>
                    )}
                    <ins className={cx("no-underline", c.to === "—" ? "text-muted" : "font-semibold text-text")} title={c.toRaw}>
                      <span className="sr-only">{fromEmpty ? "값 " : "새 값 "}</span>
                      {c.to === "—" ? "없음" : c.to}
                    </ins>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}

        <footer className="-mr-1 -mb-1 mt-1 flex flex-wrap items-center justify-end gap-x-1">
          <button
            type="button"
            className={cx(LINK_BTN, "text-muted hover:text-accent")}
            onClick={() => onFilterTarget(a.targetType, a.targetId)}
            aria-label={`${target} 이력만 보기`}
          >
            이 대상 이력
          </button>
          {a.questionId && (
            <Link className={cx(LINK_BTN, "text-accent")} to={`/novels/${novelId}/inbox/${a.questionId}`}>
              관련 질문 열기
            </Link>
          )}
          <button
            type="button"
            className={cx(LINK_BTN, "text-muted hover:text-text")}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`자세히: ${sentence}`}
            onClick={() => setOpen((o) => !o)}
          >
            자세히
            <span aria-hidden="true" className={cx("ml-0.5 inline-block transition-transform motion-reduce:transition-none", open && "rotate-180")}>
              ▾
            </span>
          </button>
        </footer>

        <div id={detailsId} hidden={!open} className="mt-1 border-t border-border pt-2 text-xs">
          {open && <Details a={a} exact={exact} bulkIds={bulk?.ids ?? []} />}
        </div>
      </article>
    </li>
  );
}

function Details({ a, exact, bulkIds }: { a: ActivityDto; exact: string; bulkIds: string[] }) {
  const raw = a.before !== null || a.after !== null ? JSON.stringify({ before: a.before, after: a.after }, null, 2) : null;
  const rows: Array<[string, ReactNode]> = [
    ["정확한 시각", exact],
    [
      "동작",
      <>
        <span>{actionLabelKo(a.action)}</span> <code className="ml-1">{a.action}</code>
      </>,
    ],
    ["기록 번호", <span className="tabular">#{a.seq}</span>],
    [
      "대상",
      <>
        <span>{refTypeKo(a.targetType)}</span> <code className="ml-1 break-all">{a.targetId}</code>
      </>,
    ],
    ["주체 ID", <code className="break-all">{a.actorId}</code>],
  ];
  if (a.runId) rows.push(["실행 ID", <code className="break-all">{a.runId}</code>]);
  if (a.approvalId) rows.push(["승인 ID", <code className="break-all">{a.approvalId}</code>]);
  return (
    <div className="grid gap-2">
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="m-0 min-w-0 text-muted">{v}</dd>
          </div>
        ))}
      </dl>
      {bulkIds.length > 0 && (
        <div>
          <div className="mb-0.5 text-muted">포함된 ID {bulkIds.length}개</div>
          <div className="max-h-32 overflow-auto break-all rounded bg-code-bg p-2 font-mono text-[11px] text-muted">{bulkIds.join(", ")}</div>
        </div>
      )}
      {raw && (
        <div>
          <div className="mb-0.5 text-muted">원본 변경 데이터</div>
          <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 font-mono text-[11px] text-muted">{raw}</pre>
        </div>
      )}
    </div>
  );
}
