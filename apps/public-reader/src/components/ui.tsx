/** Small UI pieces: icons, bottom sheet, buttons. Mobile-first (44px tap targets, safe-area aware). */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

const PATHS = {
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  comment: <path d="M4 5h16v11H9l-5 4z" />,
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  list: <path d="M5 7h14M5 12h14M5 17h14" />,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5" />
    </>
  ),
} as const;

export function Icon({ name, filled, size = 22 }: { name: keyof typeof PATHS; filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function IconButton({ label, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={`pr-icon-btn ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Button({ variant = "default", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return <button type="button" className={`pr-btn pr-btn-${variant} ${className}`} {...rest} />;
}

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

export const formatCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString("ko-KR"));

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return formatDate(iso);
}

export function Message({ tone = "muted", children }: { tone?: "muted" | "danger" | "ok"; children: ReactNode }) {
  return (
    <p className={`pr-msg pr-msg-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {children}
    </p>
  );
}
