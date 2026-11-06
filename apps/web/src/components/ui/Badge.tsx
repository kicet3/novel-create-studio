import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_GLYPH, TONE_SOFT, type Tone } from "./tone.js";
import { CONTROL_FOCUS } from "./control.js";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Prefix a tone glyph (✓ ! ✕ ●) so status is not conveyed by colour alone. */
  glyph?: boolean;
  children: ReactNode;
}

/** Status pill (`.badge`). */
export function Badge({ tone = "neutral", glyph = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold leading-[1.6]",
        TONE_SOFT[tone],
        className,
      )}
      {...rest}
    >
      {glyph && <span aria-hidden="true">{TONE_GLYPH[tone]}</span>}
      {children}
    </span>
  );
}

/** Outlined chip (`.chip`) for tags, filters, references like `S-01`. */
export function Chip({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-surface px-[9px] py-0.5 text-xs",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** Small red counter used in nav items (`.app-nav .count`). */
export function CountBadge({ count, label }: { count: number; label?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="rounded-full bg-danger px-1.5 text-[11px] font-semibold leading-[17px] text-white"
      aria-label={label ? `${label} ${count}건` : `${count}건`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Toggle filter pill (aria-pressed): status filters above lists. 28px tall, centres with sm (32px) controls. */
export function ToggleChip({
  pressed,
  className,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & { pressed: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cx(
        "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-xs leading-none transition-colors",
        CONTROL_FOCUS,
        pressed ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-text",
        className,
      )}
      {...rest}
    />
  );
}
