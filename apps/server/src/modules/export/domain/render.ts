/**
 * TXT / Markdown rendering and file naming (07 §3.8 FR-MAN-04a). Pure.
 * Body only — no annotations, attribution, issues, hidden names. UTF-8 NFC, LF.
 */
export interface ExportChapter {
  episodeNo: number;
  title: string | null;
  arc: { id: string; ord: number; title: string } | null;
  content: string;
}

const nfc = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");
const heading = (c: ExportChapter) => (c.title ? `${c.episodeNo}화 ${c.title}` : `${c.episodeNo}화`);

export function renderTxt(chapters: readonly ExportChapter[]): string {
  return nfc(chapters.map((c) => `${heading(c)}\n\n${nfc(c.content).trim()}`).join("\n\n\n")) + "\n";
}

export function renderMarkdown(chapters: readonly ExportChapter[], opts: { arcHeadings: boolean }): string {
  const out: string[] = [];
  let arcId: string | null = null;
  for (const c of chapters) {
    if (opts.arcHeadings && c.arc && c.arc.id !== arcId) {
      out.push(`# ${c.arc.title}`);
      arcId = c.arc.id;
    }
    out.push(`## ${heading(c)}`, nfc(c.content).trim());
  }
  return nfc(out.join("\n\n")) + "\n";
}

/** body text as it appears in the file, minus the heading line (for the "앱 표시와 일치" count test) */
export function stripTxtHeading(chapterText: string): string {
  const i = chapterText.indexOf("\n\n");
  return i < 0 ? "" : chapterText.slice(i + 2);
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

export function exportFileName(input: { novelTitle: string; scope: { kind: "episode" | "arc" | "novel"; episodeNo?: number; arcOrd?: number }; at: Date; timeZone: string; ext: "txt" | "md" }): string {
  const part =
    input.scope.kind === "episode"
      ? `ep${String(input.scope.episodeNo ?? 0).padStart(3, "0")}`
      : input.scope.kind === "arc"
        ? `arc${String(input.scope.arcOrd ?? 0).padStart(2, "0")}`
        : "all";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(input.at).map((x) => [x.type, x.value]));
  const stamp = `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
  const title = (input.novelTitle.normalize("NFC").replace(FORBIDDEN, "_").trim() || "novel").slice(0, 80);
  return `${title}_${part}_${stamp}.${input.ext}`;
}
