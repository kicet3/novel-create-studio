import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Card heading (`.card h4`). Rendered as h2 by default; adjust with `headingLevel`. */
  title?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Right side of the heading row (badges, small buttons). */
  actions?: ReactNode;
  /** Render as <section> (default when titled) for landmark-ish grouping. */
  as?: "section" | "div" | "article";
}

/** `.card`: surface panel with optional heading + actions. */
export function Card({ title, headingLevel = 2, actions, as, className, children, ...rest }: CardProps) {
  const Tag = as ?? (title ? "section" : "div");
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <Tag
      className={cx("min-w-0 rounded-[10px] border border-border bg-surface px-3 py-3 shadow-card min-[521px]:px-4 min-[521px]:py-3.5", className)}
      {...rest}
    >
      {(title || actions) && (
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          {title && <H className="min-w-0 text-[13.5px] font-bold">{title}</H>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

export interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Secondary value shown small after the main value, e.g. "/ 120화". */
  of?: ReactNode;
  delta?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** `.card.kpi`: metric tile. */
export function KpiCard({ label, value, of, delta, children, className }: KpiCardProps) {
  return (
    <div className={cx("min-w-0 rounded-[10px] border border-border bg-surface px-3 py-3 shadow-card min-[521px]:px-4 min-[521px]:py-3.5", className)}>
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular text-[22px] font-bold leading-[1.3]">
        {value}
        {of && <span className="ml-1 text-[13px] font-semibold text-muted">{of}</span>}
      </div>
      {children}
      {delta && <div className="mt-1 text-xs text-muted">{delta}</div>}
    </div>
  );
}

/** Responsive grid (`.grid.g2/.g3/.g4`): collapses at 860px / 520px like the mockups. */
export function Grid({ cols = 2, className, children }: { cols?: 2 | 3 | 4; className?: string; children: ReactNode }) {
  const colClass = {
    2: "grid-cols-1 min-[861px]:grid-cols-2",
    3: "grid-cols-1 min-[521px]:grid-cols-2 min-[861px]:grid-cols-3",
    4: "grid-cols-2 min-[861px]:grid-cols-4",
  }[cols];
  return <div className={cx("grid gap-3", colClass, className)}>{children}</div>;
}

/** `.split`: main + side column (1.6fr / 1fr), stacked under 860px. */
export function Split({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("grid grid-cols-1 gap-3 min-[861px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]", className)}>
      {children}
    </div>
  );
}
