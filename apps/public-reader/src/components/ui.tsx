/** Small UI pieces (server- and client-safe): icons, buttons, messages. Mobile-first (44px tap targets). */
import type { ButtonHTMLAttributes, ReactNode } from "react";

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

export function Message({ tone = "muted", children }: { tone?: "muted" | "danger" | "ok"; children: ReactNode }) {
  return (
    <p className={`pr-msg pr-msg-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {children}
    </p>
  );
}
