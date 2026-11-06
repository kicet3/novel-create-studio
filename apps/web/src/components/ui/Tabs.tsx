import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Optional count/badge after the label. */
  adornment?: ReactNode;
  panel?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string> {
  items: readonly TabItem<V>[];
  /** Controlled value; omit for uncontrolled (starts at `defaultValue` or the first item). */
  value?: V;
  defaultValue?: V;
  onChange?: (value: V) => void;
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
}

/**
 * `.tabs`: WAI-ARIA tabs with roving tabindex. ←/→/Home/End move focus and select (automatic activation).
 * Panels render from `items[].panel`; when no panel is given, use `onChange` to drive your own content.
 */
export function Tabs<V extends string>({ items, value, defaultValue, onChange, label, className }: TabsProps<V>) {
  const baseId = useId();
  const [inner, setInner] = useState<V | undefined>(defaultValue ?? items[0]?.value);
  const current = value ?? inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (v: V) => {
    if (value === undefined) setInner(v);
    onChange?.(v);
  };

  const enabled = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const pos = enabled.findIndex(({ it }) => it.value === current);
    let next: number | undefined;
    if (e.key === "ArrowRight") next = (pos + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (pos - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    const target = enabled[next];
    if (!target) return;
    select(target.it.value);
    refs.current[target.i]?.focus();
  };

  const active = items.find((it) => it.value === current);

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="mb-3 flex gap-0.5 overflow-x-auto border-b border-border"
      >
        {items.map((it, i) => {
          const selected = it.value === current;
          return (
            <button
              key={it.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${it.value}`}
              aria-selected={selected}
              aria-controls={it.panel !== undefined ? `${baseId}-panel-${it.value}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={it.disabled}
              onClick={() => select(it.value)}
              className={cx(
                "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-[7px] text-[13px] disabled:opacity-50",
                selected ? "border-accent font-semibold text-accent" : "border-transparent text-muted hover:text-text",
              )}
            >
              {it.label}
              {it.adornment}
            </button>
          );
        })}
      </div>
      {active?.panel !== undefined && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.value}`}
          aria-labelledby={`${baseId}-tab-${active.value}`}
          tabIndex={0}
        >
          {active.panel}
        </div>
      )}
    </div>
  );
}
