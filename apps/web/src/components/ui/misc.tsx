import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";

/** `.avatar`: initials disc for agents / users. Decorative unless `label` is given. */
export function Avatar({ initials, label, className }: { initials: string; label?: string; className?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx(
        "inline-grid size-[26px] flex-none place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-text",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/** `.list`: divided vertical list. */
export function List({ className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cx("m-0 list-none p-0", className)} {...rest} />;
}

export function ListItem({ className, ...rest }: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={cx(
        "flex items-start gap-2.5 border-t border-border py-[9px] first:border-t-0 first:pt-0.5",
        className,
      )}
      {...rest}
    />
  );
}

/** `.fr`: requirement id tag (FR-UI-01) used in placeholders/annotations. */
export function ReqTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded bg-violet-soft px-[5px] font-mono text-[10.5px] font-semibold leading-normal text-violet">
      {children}
    </span>
  );
}

/** Loading / error inline row for query states. */
export function InlineStatus({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={cx("m-0 text-[13px]", tone === "danger" ? "text-danger" : "text-muted")}>
      {children}
    </p>
  );
}
