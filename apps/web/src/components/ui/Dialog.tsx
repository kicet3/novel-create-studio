import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { Button } from "./Button.js";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons; a 닫기 button is shown when omitted. `false` = no footer (the body has its own form buttons). */
  footer?: ReactNode | false;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl" } as const;

/**
 * Modal built on native <dialog>.showModal(): the browser traps focus and makes the page inert;
 * Esc closes. On close focus returns to the element that opened it (08 §9.9).
 * Put `autoFocus` on the element that should receive initial focus.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // Restore focus whenever the dialog actually closes (Esc, button, or prop change).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onNativeClose = () => {
      opener.current?.focus();
      opener.current = null;
    };
    el.addEventListener("close", onNativeClose);
    return () => el.removeEventListener("close", onNativeClose);
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        // Esc: let the parent own the state.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // click on the backdrop (the dialog element itself, outside the panel)
        if (e.target === e.currentTarget) onClose();
      }}
      className={cx(
        "m-auto w-[calc(100%-24px)] rounded-xl border border-border bg-surface p-0 text-text shadow-card",
        SIZE[size],
        className,
      )}
    >
      {open && (
        <div className="flex flex-col gap-3 p-5">
          <div>
            <h2 id={titleId} className="text-base font-bold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="m-0 mt-1 text-[13px] text-muted">
                {description}
              </p>
            )}
          </div>
          {children}
          {footer !== false && (
            <div className="flex flex-wrap justify-end gap-2">
              {footer ?? (
                <Button onClick={onClose} autoFocus>
                  닫기
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger variant for destructive or irreversible actions. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation step for approve / reject / submit (08 §9.9: "확인 단계를 한 번 거칩니다"). */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "확인",
  cancelLabel = "취소",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} autoFocus disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
