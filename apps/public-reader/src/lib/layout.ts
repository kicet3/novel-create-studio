/**
 * Screen classes of snowpage (pure; shared by the reader switch, tests and the CSS breakpoints in app/globals.css):
 *   ≤ 767px      phones, Flip / Fold cover screens, Fold inner screen (mobile reader, two-page spread on near-square screens)
 *   768–1023px   tablets (mobile reader + spread logic; wider list / home layouts)
 *   ≥ 1024px     PC: the studio's 읽기 viewer (same page geometry, bars, 목차 drawer, 보기 설정) — unless the screen is
 *                split by a fold (Viewport Segments), which keeps the foldable layout.
 */
import { pageGeometry, type PageGeometry } from "@ncs/reader-core/layout";
import { READER_MARGIN_PX, READER_MAX_EM, fontPxOf, type ReaderSettings } from "@ncs/reader-core/model";

export const TABLET_MIN_WIDTH = 768;
export const DESKTOP_MIN_WIDTH = 1024;

export type ScreenClass = "mobile" | "tablet" | "desktop";

export function screenClass(width: number): ScreenClass {
  if (width >= DESKTOP_MIN_WIDTH) return "desktop";
  if (width >= TABLET_MIN_WIDTH) return "tablet";
  return "mobile";
}

/** the PC reader (studio viewer) is used on wide flat screens; folded / dual-segment screens keep the foldable reader */
export function usesDesktopReader(width: number, segments: readonly unknown[] | null | undefined): boolean {
  return screenClass(width) === "desktop" && !(segments && segments.length > 1);
}

/** the studio viewer's page box for this screen (apps/web ReaderEpisodePage: same pads, width and margins) */
export function desktopPageGeometry(viewportWidth: number, viewportHeight: number, s: Pick<ReaderSettings, "fontStep" | "margin">): PageGeometry {
  const pad = viewportHeight >= 720 ? 52 : 40;
  return pageGeometry({
    viewportWidth,
    viewportHeight,
    fontPx: fontPxOf(s.fontStep),
    maxEm: READER_MAX_EM[s.margin],
    sidePad: READER_MARGIN_PX[s.margin],
    topPad: pad,
    bottomPad: pad,
  });
}
