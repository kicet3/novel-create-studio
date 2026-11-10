/** reader panels (보기 설정, 목차, 댓글): focus handling and the "a panel is open" marker the viewer shortcuts respect. */
import { useEffect, useRef, type RefObject } from "react";

/** set while a reader panel/drawer is open, so viewer shortcuts (←/→, Space) stand aside */
export const READER_PANEL_ATTR = "data-reader-panel";
export const isReaderPanelOpen = () => typeof document !== "undefined" && !!document.querySelector(`[${READER_PANEL_ATTR}]`);
export const panelAttr = { [READER_PANEL_ATTR]: "" } as Record<string, string>;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// last input kind: a panel opened by touch / mouse must not show a focus ring on its first control
let lastPointerAt = -Infinity;
let lastKeyAt = -Infinity;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => void (lastPointerAt = performance.now()), { capture: true, passive: true });
  window.addEventListener("keydown", () => void (lastKeyAt = performance.now()), { capture: true, passive: true });
}
/** the latest interaction was a pointer (touch / mouse), not the keyboard */
export const lastInputWasPointer = () => lastPointerAt > lastKeyAt;
/** the latest interaction was the keyboard (false before any interaction) */
export const lastInputWasKeyboard = () => lastKeyAt > lastPointerAt;

/**
 * focus moves into the panel, Tab stays inside, Esc closes; focus returns to the opener on close.
 * Opened by keyboard: the selected / first control gets focus; opened by touch or mouse: the panel itself
 * (give it tabIndex={-1} and `rv-panel-focus`), so no focus ring appears on a control nobody chose.
 */
export function useDialogFocus(panel: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, initial?: string) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = (initial && panel.current?.querySelector<HTMLElement>(initial)) || panel.current?.querySelector<HTMLElement>('[aria-pressed="true"]') || panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    if (lastInputWasPointer() && panel.current?.tabIndex === -1) panel.current.focus({ preventScroll: true });
    else first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const [head, tail] = [items[0]!, items[items.length - 1]!];
        const inside = panel.current.contains(document.activeElement) && document.activeElement !== panel.current;
        if (e.shiftKey && (document.activeElement === head || !inside)) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && (document.activeElement === tail || !inside)) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, panel, initial]);
}
