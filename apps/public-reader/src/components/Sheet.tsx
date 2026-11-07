"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon, IconButton } from "./ui";

/** bottom sheet (phones) / centered panel (wide screens); Esc and backdrop close it; focus moves inside */
export function Sheet({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>("input, textarea, button:not([data-sheet-close])")?.focus({ preventScroll: true }), 30);
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      document.body.style.overflow = bodyOverflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="pr-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="pr-sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="pr-sheet-grip" aria-hidden="true" />
        <div className="pr-sheet-head">
          <h2 id={id}>{title}</h2>
          <IconButton label="닫기" data-sheet-close onClick={onClose}>
            <Icon name="close" />
          </IconButton>
        </div>
        <div className="pr-sheet-body">{children}</div>
        {footer && <div className="pr-sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

