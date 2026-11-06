import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** Small muted note under the value. */
  hint?: ReactNode;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  /** Label column width, default 9rem. Stacks under 520px. */
  labelWidth?: string;
  className?: string;
}

/** Definition list (<dl>) for settings/detail panels. */
export function KeyValueList({ items, labelWidth = "9rem", className }: KeyValueListProps) {
  return (
    <dl
      className={cx("m-0 grid grid-cols-1 gap-x-4 text-[13px] min-[521px]:grid-cols-[var(--kv-label)_minmax(0,1fr)]", className)}
      style={{ ["--kv-label" as string]: labelWidth }}
    >
      {items.map((it, i) => {
        const rule = i > 0 ? "min-[521px]:border-t min-[521px]:border-border" : "";
        return (
          <div key={it.key} className="contents">
            <dt className={cx("pt-2 font-semibold text-muted min-[521px]:py-2", rule)}>{it.label}</dt>
            <dd className={cx("m-0 pb-2 min-[521px]:py-2", rule, i < items.length - 1 && "max-[520px]:border-b max-[520px]:border-border")}>
              {it.value}
              {it.hint && <div className="text-xs text-faint">{it.hint}</div>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
