import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative mark; aria-hidden. Defaults to a simple glyph. */
  icon?: ReactNode;
  actions?: ReactNode;
  /** Extra detail below actions (e.g. related FR ids). */
  children?: ReactNode;
  className?: string;
}

/** Empty / not-yet-available state for lists and screens. */
export function EmptyState({ title, description, icon, actions, children, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-2 rounded-[10px] border border-dashed border-border bg-surface px-6 py-10 text-center",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="mb-1 grid size-10 place-items-center rounded-full bg-accent-soft text-lg font-bold text-accent"
      >
        {icon ?? "∅"}
      </div>
      <p className="m-0 text-[15px] font-bold">{title}</p>
      {description && <p className="m-0 max-w-prose text-[13px] text-muted">{description}</p>}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
      {children && <div className="mt-2 text-xs text-faint">{children}</div>}
    </div>
  );
}
