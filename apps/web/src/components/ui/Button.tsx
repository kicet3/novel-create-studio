import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { cx } from "../../lib/cx.js";
import { CONTROL_FOCUS, CONTROL_SHAPE, type ControlSize } from "./control.js";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = ControlSize;

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border font-semibold no-underline " +
  `transition-colors disabled:opacity-55 aria-disabled:opacity-55 ${CONTROL_SHAPE} ${CONTROL_FOCUS}`;

const VARIANT: Record<ButtonVariant, string> = {
  default: "border-border bg-surface text-text hover:bg-surface-2",
  primary: "border-accent bg-accent text-accent-text hover:brightness-110",
  danger: "border-danger bg-surface text-danger hover:bg-danger-soft",
  ghost: "border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-text",
};

/** same heights as Input / Select (control.ts): md 36px, sm 32px */
const SIZE: Record<ButtonSize, string> = {
  md: "h-9 px-3.5 text-[13px] leading-5",
  sm: "h-8 px-2.5 text-xs leading-5",
};

export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", className?: string) {
  return cx(BASE, VARIANT[variant], SIZE[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a busy state and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
}

/** `.btn` with variants primary / danger / ghost and size sm. Defaults to type="button". */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", loading = false, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A router link styled as a button (navigation must stay a link for a11y). */
export function ButtonLink({ variant = "default", size = "md", className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, size, typeof className === "string" ? className : undefined)} {...rest} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}
