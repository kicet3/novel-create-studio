import { useEffect, useMemo } from "react";
import { labelKo } from "@ncs/shared";
import { cx } from "../../lib/cx.js";
import { actorLabelKo } from "../audit/labels.js";
import { buildLines, type LineAuthor, type MarkerLike, type RenderLine } from "./annotate.js";
import type { BeatAnnotation, IssueAnnotation, VersionDetail } from "./api.js";

export interface ViewerToggles {
  attribution: boolean;
  scenes: boolean;
  issues: boolean;
  beats: boolean;
}

export const DEFAULT_TOGGLES: ViewerToggles = { attribution: true, scenes: true, issues: true, beats: true };

const AUTHOR_BORDER: Record<LineAuthor, string> = {
  human: "border-l-warn",
  agent: "border-l-info",
  system: "border-l-faint",
  mixed: "border-l-violet",
  none: "border-l-transparent",
};
const AUTHOR_GLYPH: Record<LineAuthor, string> = { human: "사", agent: "AI", system: "시", mixed: "혼", none: "" };
const AUTHOR_LABEL: Record<LineAuthor, string> = { human: "사람", agent: "에이전트", system: "시스템", mixed: "혼합", none: "" };

export function markerDomId(id: string): string {
  return `mk-${id}`;
}

/** Issue + beat + focus markers in the version's own coordinates (annotators only return markers of this version). */
export function collectMarkers(
  detail: VersionDetail,
  setupLabel: (setupId: string) => string,
  focus?: { start: number; end: number } | null,
): MarkerLike[] {
  const out: MarkerLike[] = [];
  for (const i of detail.issues ?? []) {
    if (i.charStart == null || i.charEnd == null) continue;
    if (i.status === "resolved" || i.status === "waived" || i.status === "false_positive" || i.status === "superseded") continue;
    out.push({ id: i.id, kind: "issue", start: i.charStart, end: Math.max(i.charEnd, i.charStart + 1), tone: i.severity, label: i.displayLabel });
  }
  for (const b of detail.beats ?? []) {
    if (b.charStart == null || b.charEnd == null) continue;
    out.push({
      id: b.id,
      kind: "beat",
      start: b.charStart,
      end: Math.max(b.charEnd, b.charStart + 1),
      tone: b.kind,
      label: `${setupLabel(b.setupId)} ${labelKo("setup_beat_kind", b.kind)}`,
    });
  }
  if (focus) out.push({ id: "focus", kind: "focus", start: focus.start, end: Math.max(focus.end, focus.start + 1), label: "선택 위치" });
  return out;
}

export function VersionViewer({
  detail,
  toggles,
  setupLabel,
  focus,
  me,
  className,
}: {
  detail: VersionDetail;
  toggles: ViewerToggles;
  setupLabel: (setupId: string) => string;
  /** char range to highlight + scroll into view (mention / beat / issue link) */
  focus?: { start: number; end: number } | null;
  me?: { id: string; displayName: string } | null;
  className?: string;
}) {
  const markers = useMemo(() => {
    const all = collectMarkers(detail, setupLabel, focus);
    return all.filter((m) => (m.kind === "issue" ? toggles.issues : m.kind === "beat" ? toggles.beats : true));
  }, [detail, setupLabel, focus, toggles.issues, toggles.beats]);
  const lines = useMemo(
    () => buildLines(detail.content, toggles.attribution ? (detail.attributionSpans ?? []) : [], toggles.scenes ? (detail.scenes ?? []).filter((s) => s.status === "active") : [], markers),
    [detail, toggles.attribution, toggles.scenes, markers],
  );

  useEffect(() => {
    if (focus) document.getElementById(markerDomId("focus"))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, detail.id]);

  const sceneById = new Map((detail.scenes ?? []).map((s) => [s.id, s]));

  return (
    <div className={cx("manuscript-body rounded-lg border border-border bg-surface py-2 text-[14.5px] leading-[1.9]", className)} lang="ko">
      {lines.map((ln) => (
        <Line key={ln.no} line={ln} showAuthor={toggles.attribution} sceneById={sceneById} me={me} />
      ))}
    </div>
  );
}

function Line({
  line,
  showAuthor,
  sceneById,
  me,
}: {
  line: RenderLine;
  showAuthor: boolean;
  sceneById: Map<string, NonNullable<VersionDetail["scenes"]>[number]>;
  me?: { id: string; displayName: string } | null;
}) {
  const authorTitle = line.actors.map((a) => actorLabelKo(a, me)).join(", ");
  return (
    <>
      {line.sceneStarts.map((s) => {
        const scene = sceneById.get(s.id);
        return (
          <div key={s.id} id={`scene-${s.ord}`} className="mx-3 mb-1 mt-3 flex flex-wrap items-baseline gap-2 border-t border-dashed border-border pt-2 font-sans text-xs text-muted first:mt-0">
            <span className="rounded bg-surface-2 px-1.5 font-semibold text-text">씬 {s.ord}</span>
            {scene?.summary && <span>{scene.summary}</span>}
            {scene && <span className="text-faint">· 시점 {scene.storyPoint}</span>}
            {scene?.narrationMode && <span className="text-faint">· {labelKo("narration_mode", scene.narrationMode)}</span>}
          </div>
        );
      })}
      <div
        className={cx("group flex border-l-[3px] pl-0 pr-3", showAuthor ? AUTHOR_BORDER[line.author] : "border-l-transparent")}
        data-line={line.no}
      >
        <span className="w-10 flex-none select-none pr-2 text-right font-sans text-[10.5px] leading-[2.6] text-faint tabular" aria-hidden="true">
          {line.no}
        </span>
        {showAuthor && (
          <span
            className="w-6 flex-none select-none font-sans text-[10px] font-bold leading-[2.6] text-muted"
            title={authorTitle || undefined}
            aria-label={line.author !== "none" ? `작성: ${AUTHOR_LABEL[line.author]}${authorTitle ? ` (${authorTitle})` : ""}` : undefined}
          >
            {AUTHOR_GLYPH[line.author]}
          </span>
        )}
        <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words">
          {line.markerStarts.map((m) => (
            <span key={m.id} id={markerDomId(m.id)} className="scroll-mt-24" />
          ))}
          {line.text.length === 0 ? (
            " "
          ) : (
            line.segments.map((seg, k) => <SegmentView key={k} text={seg.text} actorType={showAuthor ? seg.actorType : undefined} markers={seg.markers} />)
          )}
          {line.markerStarts
            .filter((m) => m.kind !== "focus")
            .map((m) => (
              <a
                key={`tag-${m.id}`}
                href={`#side-${m.id}`}
                className={cx(
                  "ml-1 rounded px-1 align-super font-sans text-[10px] font-semibold no-underline",
                  m.kind === "issue" ? (m.tone === "high" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn") : "bg-violet-soft text-violet",
                )}
              >
                {m.label}
              </a>
            ))}
        </p>
      </div>
    </>
  );
}

function SegmentView({ text, actorType, markers }: { text: string; actorType?: string; markers: MarkerLike[] }) {
  const issue = markers.find((m) => m.kind === "issue");
  const beat = markers.find((m) => m.kind === "beat");
  const focus = markers.find((m) => m.kind === "focus");
  const cls = cx(
    actorType === "user" && "bg-warn-soft/60",
    issue && (issue.tone === "high" ? "underline decoration-danger decoration-wavy decoration-2 underline-offset-4" : "underline decoration-warn decoration-wavy underline-offset-4"),
    beat && !issue && "underline decoration-violet decoration-dotted decoration-2 underline-offset-4",
    focus && "rounded-sm bg-accent-soft outline outline-1 outline-accent",
  );
  const title = markers
    .filter((m) => m.kind !== "focus")
    .map((m) => m.label)
    .join(", ");
  if (!cls) return <>{text}</>;
  return (
    <span className={cls} title={title || undefined} id={focus ? markerDomId("focus") : undefined}>
      {text}
    </span>
  );
}

export function AttributionLegend({ glyphs = true }: { glyphs?: boolean }) {
  const items: Array<[LineAuthor, string]> = [
    ["agent", "에이전트 작성"],
    ["human", "사람 수정"],
    ["mixed", "혼합"],
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-3 p-0 text-xs text-muted">
      {items.map(([a, label]) => (
        <li key={a} className={cx("border-l-[3px] pl-1.5", AUTHOR_BORDER[a])}>
          {glyphs && <b className="mr-1 text-text">{AUTHOR_GLYPH[a]}</b>}
          {label}
        </li>
      ))}
      <li>
        <span className="underline decoration-danger decoration-wavy underline-offset-4">이슈 위치</span>
      </li>
      <li>
        <span className="underline decoration-violet decoration-dotted underline-offset-4">떡밥 근거</span>
      </li>
    </ul>
  );
}

export function issueSort(a: IssueAnnotation, b: IssueAnnotation): number {
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.displayNo - b.displayNo;
}

export function beatSort(a: BeatAnnotation, b: BeatAnnotation): number {
  return (a.charStart ?? Number.MAX_SAFE_INTEGER) - (b.charStart ?? Number.MAX_SAFE_INTEGER);
}

