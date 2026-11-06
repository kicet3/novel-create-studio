import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { TONE_BORDER_LEFT, type Tone } from "./tone.js";

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  actions?: ReactNode;
}

/**
 * `.callout`: banner with a coloured left rule. Danger/warn callouts get role="alert"/"status"
 * unless a role is given explicitly.
 */
export function Callout({ tone = "accent", title, actions, className, children, role, ...rest }: CalloutProps) {
  const implicitRole = tone === "danger" ? "alert" : tone === "warn" ? "status" : undefined;
  return (
    <div
      role={role ?? implicitRole}
      className={cx(
        "rounded-lg border border-l-[3px] border-border bg-surface px-3 py-2.5 text-[13px]",
        TONE_BORDER_LEFT[tone],
        className,
      )}
      {...rest}
    >
      {title && (
        <div className="flex flex-wrap items-center gap-1.5 font-bold">{title}</div>
      )}
      {children && <div className={cx(title ? "mt-0.5" : undefined, "text-[13px]")}>{children}</div>}
      {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
