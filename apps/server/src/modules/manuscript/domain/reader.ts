/**
 * 읽기(reader) — pure helpers: which version an episode is read from, and the reading text with scene breaks.
 * No I/O (CONVENTIONS §3).
 */
import { READER_SCENE_BREAK, type ReaderMode, type ReaderSource } from "@ncs/shared";
import { normalizeText } from "./text.js";

export interface ReaderEpisodeRefs {
  status: string;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  publishedVersionId: string | null;
}

/** approved / published text of an episode (null = never approved) */
export function approvedRef(ep: ReaderEpisodeRefs): { versionId: string; source: "published" | "approved" } | null {
  const id = ep.approvedVersionId ?? ep.publishedVersionId;
  if (!id) return null;
  return { versionId: id, source: ep.status === "published" && ep.publishedVersionId === id ? "published" : "approved" };
}

/**
 * current draft distinct from the approved text. `kindOf` = kind of a version id (outlines are not readable text).
 */
export function draftRef(ep: ReaderEpisodeRefs, kindOf: (versionId: string) => string | undefined): { versionId: string } | null {
  const id = ep.currentVersionId;
  if (!id || id === ep.approvedVersionId || id === ep.publishedVersionId) return null;
  const kind = kindOf(id);
  if (!kind || kind === "outline") return null;
  return { versionId: id };
}

/** version read in a mode: draft mode prefers the draft, then the approved text */
export function readRef(ep: ReaderEpisodeRefs, mode: ReaderMode, kindOf: (versionId: string) => string | undefined): { versionId: string; source: ReaderSource } | null {
  const approved = approvedRef(ep);
  if (mode === "draft") {
    const draft = draftRef(ep, kindOf);
    if (draft) return { versionId: draft.versionId, source: "draft" };
  }
  return approved;
}

const SEPARATOR = /^[ \t]*(\*[ \t]*\*[ \t]*\*|-{3,}|◇+|◆+|#{3,}|＊[ \t]*＊[ \t]*＊)[ \t]*$/u;
/** a leading markdown heading line like "# 3화 제목" (the reader shows the title itself) */
const HEADING = /^[ \t]*#{1,2}[ \t]+\S/u;

/**
 * Reading text: normalized body, a break line at every scene start offset (> 0) and at each separator line,
 * consecutive breaks merged, blank lines collapsed, no break at the very start or end, no leading heading.
 * Never drops body text (scene offsets only add breaks).
 */
export function buildReadingText(content: string, sceneStarts: readonly number[] = []): string {
  let text = content;
  const cuts = [...new Set(sceneStarts)].filter((o) => o > 0 && o < text.length).sort((a, b) => b - a);
  for (const o of cuts) text = `${text.slice(0, o)}\n${READER_SCENE_BREAK}\n${text.slice(o)}`;
  text = normalizeText(text);
  const out: string[] = [];
  let lastBreak = true; // suppress a break before any text
  let pendingBlank = false;
  let first = true;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t　]+$/u, "");
    if (!line.trim()) {
      pendingBlank = out.length > 0;
      continue;
    }
    if (SEPARATOR.test(line)) {
      if (!lastBreak) {
        out.push("", READER_SCENE_BREAK, "");
        lastBreak = true;
      }
      pendingBlank = false;
      continue;
    }
    if (first && HEADING.test(line)) {
      first = false;
      continue;
    }
    first = false;
    if (pendingBlank && !lastBreak) out.push("");
    out.push(line);
    pendingBlank = false;
    lastBreak = false;
  }
  while (out.length && (out[out.length - 1] === "" || out[out.length - 1] === READER_SCENE_BREAK)) out.pop();
  return out.join("\n");
}
