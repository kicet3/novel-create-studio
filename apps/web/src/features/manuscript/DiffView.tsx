import { Fragment, useMemo, useState } from "react";
import { labelKo } from "@ncs/shared";
import { Badge, CHOICE_BOX, InlineStatus, QueryError, Select, Tabs } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { actorLabelKo } from "../audit/labels.js";
import { useVersionDetail, type ManuscriptVersionSummaryDto } from "./api.js";
import { diffChars, diffLines, diffStats, toSideBySide, withContext, type CharSegment, type LineDiff, type SideBySideRow } from "./diff.js";

export function versionLabel(v: ManuscriptVersionSummaryDto, me?: { id: string; displayName: string } | null): string {
  const who = v.isHumanEdit ? "사람 수정" : actorLabelKo({ actorType: v.authorActorType, actorId: v.agentRole ?? v.authorActorId }, me);
  return `v${v.versionNo} · ${labelKo("manuscript_version_kind", v.kind)} · ${who}`;
}

/** Two-version comparison (08 §9.4: 기본 parent ↔ 현재, 나란히·통합 보기, 문자 diff). */
export function DiffView({
  novelId,
  versions,
  defaultTargetId,
  me,
}: {
  novelId: string;
  versions: ManuscriptVersionSummaryDto[];
  defaultTargetId: string | null;
  me?: { id: string; displayName: string } | null;
}) {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.versionNo - a.versionNo), [versions]);
  const initialTarget = sorted.find((v) => v.id === defaultTargetId) ?? sorted[0];
  const initialBase =
    sorted.find((v) => v.id === initialTarget?.parentVersionId) ??
    sorted.find((v) => initialTarget && v.versionNo < initialTarget.versionNo) ??
    sorted.find((v) => v.id !== initialTarget?.id);
  const [targetId, setTargetId] = useState(initialTarget?.id ?? "");
  const [baseId, setBaseId] = useState(initialBase?.id ?? "");
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [full, setFull] = useState(false);

  const base = useVersionDetail(novelId, baseId || null, "spans");
  const target = useVersionDetail(novelId, targetId || null, "spans");

  if (sorted.length < 2) return <InlineStatus>비교하려면 버전이 두 개 이상 있어야 합니다.</InlineStatus>;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-muted">
          이전 버전
          <Select value={baseId} onChange={(e) => setBaseId(e.target.value)} className="w-auto min-w-48">
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v, me)}
              </option>
            ))}
          </Select>
        </label>
        <span aria-hidden="true" className="pb-2 text-muted">
          →
        </span>
        <label className="grid gap-1 text-xs text-muted">
          비교 버전
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="w-auto min-w-48">
            {sorted.map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v, me)}
              </option>
            ))}
          </Select>
        </label>
        <label className="ml-auto flex h-9 cursor-pointer items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" className={CHOICE_BOX} checked={full} onChange={(e) => setFull(e.target.checked)} />
          변경 없는 줄도 모두 보기
        </label>
      </div>
      <Tabs
        label="diff 보기 방식"
        value={mode}
        onChange={setMode}
        items={[
          { value: "split", label: "나란히" },
          { value: "unified", label: "통합" },
        ]}
      />
      {base.error || target.error ? (
        <QueryError error={base.error ?? target.error} compact />
      ) : !base.data || !target.data ? (
        <InlineStatus>버전을 불러오는 중…</InlineStatus>
      ) : (
        <DiffBody oldText={base.data.content} newText={target.data.content} mode={mode} full={full} />
      )}
    </div>
  );
}

export function DiffBody({ oldText, newText, mode, full }: { oldText: string; newText: string; mode: "split" | "unified"; full: boolean }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  const stats = diffStats(lines);
  const rows = useMemo(() => toSideBySide(lines), [lines]);
  if (stats.added === 0 && stats.removed === 0) return <InlineStatus>두 버전의 본문이 같습니다.</InlineStatus>;
  return (
    <div className="grid gap-2">
      <div className="flex gap-2 text-xs">
        <Badge tone="ok">+{stats.added}줄</Badge>
        <Badge tone="danger">−{stats.removed}줄</Badge>
        <span className="text-muted">변경 없음 {stats.unchanged}줄</span>
      </div>
      {mode === "split" ? <SplitDiff rows={rows} full={full} /> : <UnifiedDiff lines={lines} full={full} />}
    </div>
  );
}

function Skipped({ n, cols }: { n: number; cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="bg-surface-2 px-3 py-0.5 text-center font-sans text-[11px] text-faint">
        … 변경 없는 {n}줄 …
      </td>
    </tr>
  );
}

function Segs({ segs, side }: { segs: CharSegment[]; side: "old" | "new" }) {
  return (
    <>
      {segs.map((s, i) =>
        s.op === "equal" ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : side === "old" ? (
          <del key={i} className="rounded-sm bg-danger/25 no-underline">
            {s.text}
          </del>
        ) : (
          <ins key={i} className="rounded-sm bg-ok/25 no-underline">
            {s.text}
          </ins>
        ),
      )}
    </>
  );
}

const CELL = "whitespace-pre-wrap break-words px-2 py-0.5 align-top";
const NO = "w-10 select-none px-1.5 py-0.5 text-right align-top font-sans text-[10.5px] text-faint tabular";

function SplitDiff({ rows, full }: { rows: SideBySideRow[]; full: boolean }) {
  const items = full ? rows : withContext(rows, 2);
  return (
    <div role="region" aria-label="나란히 비교" tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full table-fixed border-collapse font-serif text-[13.5px] leading-[1.8]">
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-10" />
          <col />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th>이전 줄</th>
            <th>이전</th>
            <th>새 줄</th>
            <th>새 버전</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) =>
            "skipped" in r ? (
              <Skipped key={i} n={r.skipped} cols={4} />
            ) : (
              <tr key={i}>
                <td className={cx(NO, r.left && r.kind !== "equal" && "bg-danger-soft")}>{r.left?.no}</td>
                <td className={cx(CELL, r.left && r.kind !== "equal" && "bg-danger-soft", !r.left && "bg-surface-2")}>
                  {r.left && (r.left.segments ? <Segs segs={r.left.segments} side="old" /> : r.left.text || " ")}
                </td>
                <td className={cx(NO, "border-l border-border", r.right && r.kind !== "equal" && "bg-ok-soft")}>{r.right?.no}</td>
                <td className={cx(CELL, r.right && r.kind !== "equal" && "bg-ok-soft", !r.right && "bg-surface-2")}>
                  {r.right && (r.right.segments ? <Segs segs={r.right.segments} side="new" /> : r.right.text || " ")}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedDiff({ lines, full }: { lines: LineDiff[]; full: boolean }) {
  // pair adjacent delete/insert runs for intra-line highlights
  const charSegs = useMemo(() => {
    const map = new Map<number, CharSegment[]>();
    let i = 0;
    while (i < lines.length) {
      if ((lines[i] as LineDiff).op === "equal") {
        i++;
        continue;
      }
      const ds: number[] = [];
      const is: number[] = [];
      while (i < lines.length && (lines[i] as LineDiff).op === "delete") ds.push(i++);
      while (i < lines.length && (lines[i] as LineDiff).op === "insert") is.push(i++);
      for (let k = 0; k < Math.min(ds.length, is.length); k++) {
        const segs = diffChars((lines[ds[k] as number] as LineDiff).text, (lines[is[k] as number] as LineDiff).text);
        map.set(ds[k] as number, segs.filter((s) => s.op !== "insert"));
        map.set(is[k] as number, segs.filter((s) => s.op !== "delete"));
      }
    }
    return map;
  }, [lines]);
  const indexed = lines.map((l, idx) => ({ ...l, idx }));
  const items = full ? indexed : withContext(indexed, 2);
  return (
    <div role="region" aria-label="통합 비교" tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse font-serif text-[13.5px] leading-[1.8]">
        <thead className="sr-only">
          <tr>
            <th>이전 줄</th>
            <th>새 줄</th>
            <th>변경</th>
            <th>본문</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => {
            if ("skipped" in r) return <Skipped key={i} n={r.skipped} cols={4} />;
            const tone = r.op === "delete" ? "bg-danger-soft" : r.op === "insert" ? "bg-ok-soft" : undefined;
            const segs = charSegs.get(r.idx);
            return (
              <tr key={i} className={tone}>
                <td className={NO}>{r.oldNo}</td>
                <td className={NO}>{r.newNo}</td>
                <td className="w-5 select-none text-center font-mono text-xs text-muted" aria-label={r.op === "delete" ? "삭제" : r.op === "insert" ? "추가" : undefined}>
                  {r.op === "delete" ? "−" : r.op === "insert" ? "+" : ""}
                </td>
                <td className={CELL}>{segs ? <Segs segs={segs} side={r.op === "delete" ? "old" : "new"} /> : r.text || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
