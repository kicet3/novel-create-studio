/**
 * 읽기(reader) — pure model. The framework-agnostic part (settings, resume, history, reading blocks, labels)
 * lives in @ncs/reader-core (shared with apps/public-reader); the studio-only TOC grouping (부 → 플롯 → 화,
 * approved / draft modes over ReaderTocDto) stays here.
 */
import type { ReaderMode, ReaderTocDto, ReaderTocEpisodeDto } from "@ncs/shared";

export * from "@ncs/reader-core/model";

// ── TOC ─────────────────────────────────────────────────────────────────
export type TocRowKind = "published" | "approved" | "draft";

export interface TocRow {
  episodeNo: number;
  title: string | null;
  status: ReaderTocEpisodeDto["status"];
  /** what the reader opens in the current mode */
  kind: TocRowKind;
  charCount: number;
}

/** an episode as listed in a mode (null = hidden: nothing readable in that mode) */
export function tocRow(e: ReaderTocEpisodeDto, mode: ReaderMode): TocRow | null {
  if (mode === "draft" && e.draft) return { episodeNo: e.episodeNo, title: e.title, status: e.status, kind: "draft", charCount: e.draft.charCount };
  if (e.approved) return { episodeNo: e.episodeNo, title: e.title, status: e.status, kind: e.approved.source, charCount: e.approved.charCount };
  return null;
}

export interface TocPlotGroup {
  plot: { id: string; ord: number; title: string } | null;
  rows: TocRow[];
}
export interface TocPartGroup {
  part: { id: string; ord: number; title: string } | null;
  plots: TocPlotGroup[];
}

/**
 * 부 → 플롯 → 화. Without parts the plots are the top level (one part group with `part: null`);
 * with ≤ 1 plot and no parts the list is flat (one group, `plot: null`). Empty groups are dropped.
 */
export function groupToc(toc: Pick<ReaderTocDto, "parts" | "plots" | "episodes">, mode: ReaderMode): TocPartGroup[] {
  const rowsByArc = new Map<string, TocRow[]>();
  const rows: Array<{ arcId: string; row: TocRow }> = [];
  for (const e of [...toc.episodes].sort((a, b) => a.episodeNo - b.episodeNo)) {
    const row = tocRow(e, mode);
    if (!row) continue;
    rows.push({ arcId: e.arcId, row });
    rowsByArc.set(e.arcId, [...(rowsByArc.get(e.arcId) ?? []), row]);
  }
  if (!rows.length) return [];
  const plots = [...toc.plots].sort((a, b) => a.ord - b.ord);
  if (!toc.parts.length && plots.length <= 1) return [{ part: null, plots: [{ plot: null, rows: rows.map((r) => r.row) }] }];

  const plotIds = new Set(plots.map((p) => p.id));
  const orphanRows = rows.filter((r) => !plotIds.has(r.arcId)).map((r) => r.row);
  const plotGroup = (p: (typeof plots)[number]): TocPlotGroup => ({ plot: { id: p.id, ord: p.ord, title: p.title }, rows: rowsByArc.get(p.id) ?? [] });
  const nonEmpty = (gs: TocPlotGroup[]) => gs.filter((g) => g.rows.length);
  const out: TocPartGroup[] = [];
  const partIds = new Set(toc.parts.map((p) => p.id));
  for (const part of [...toc.parts].sort((a, b) => a.ord - b.ord)) {
    const gs = nonEmpty(plots.filter((p) => p.partId === part.id).map(plotGroup));
    if (gs.length) out.push({ part: { id: part.id, ord: part.ord, title: part.title }, plots: gs });
  }
  const rest = nonEmpty(plots.filter((p) => !p.partId || !partIds.has(p.partId)).map(plotGroup));
  if (orphanRows.length) rest.push({ plot: null, rows: orphanRows });
  if (rest.length) out.push({ part: null, plots: rest });
  return out;
}

/** readable episode numbers in order (jump select, first episode) */
export function readableEpisodes(toc: Pick<ReaderTocDto, "episodes">, mode: ReaderMode): TocRow[] {
  return toc.episodes
    .map((e) => tocRow(e, mode))
    .filter((r): r is TocRow => !!r)
    .sort((a, b) => a.episodeNo - b.episodeNo);
}

