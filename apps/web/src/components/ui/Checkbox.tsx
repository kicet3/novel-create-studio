import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { CHOICE_INPUT } from "./control.js";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  hint?: ReactNode;
}

/** Native checkbox with label + optional hint (keyboard: Space toggles). */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, hint, className, id, ...rest }, ref) {
  const auto = useId();
  const inputId = id ?? auto;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={cx("flex items-start gap-2 text-[13px]", className)}>
      <input ref={ref} id={inputId} type="checkbox" aria-describedby={hintId} className={CHOICE_INPUT} {...rest} />
      <div className="min-w-0">
        <label htmlFor={inputId} className="cursor-pointer font-semibold">
          {label}
        </label>
        {hint && (
          <div id={hintId} className="text-xs text-faint">
            {hint}
          </div>
        )}
      </div>
    </div>
  );
});

export interface ChoiceOption<V extends string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  adornment?: ReactNode;
  disabled?: boolean;
}

/**
 * Radio card group (fieldset + native radios): arrow keys move between options, Space selects.
 * Used for autonomy level, entry mode, rework_from, question options.
 */
export function ChoiceGroup<V extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  columns = 1,
  className,
  legendHidden = false,
}: {
  legend: ReactNode;
  name: string;
  value: V | null | undefined;
  onChange: (value: V) => void;
  options: readonly ChoiceOption<V>[];
  columns?: 1 | 2 | 3;
  className?: string;
  legendHidden?: boolean;
}) {
  const grid = { 1: "grid-cols-1", 2: "grid-cols-1 min-[521px]:grid-cols-2", 3: "grid-cols-1 min-[521px]:grid-cols-3" }[columns];
  return (
    <fieldset className={cx("m-0 min-w-0 border-0 p-0", className)}>
      <legend className={cx("mb-1.5 text-[12.5px] font-semibold text-muted", legendHidden && "sr-only")}>{legend}</legend>
      <div className={cx("grid gap-2", grid)}>
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              className={cx(
                "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
                o.disabled && "cursor-not-allowed opacity-55",
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                className={CHOICE_INPUT}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 font-semibold">
                  {o.label}
                  {o.adornment}
                </span>
                {o.description && <span className="block text-xs text-muted">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
