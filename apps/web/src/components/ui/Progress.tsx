import { cx } from "../../lib/cx.js";
import { TONE_FILL, type Tone } from "./tone.js";

export interface ProgressProps {
  /** 0..max */
  value: number;
  max?: number;
  tone?: Tone;
  /** Accessible name, e.g. "목표 진척". */
  label: string;
  /** Human readable value text, e.g. "11 / 120화". */
  valueText?: string;
  className?: string;
}

/** `.progress` bar with role="progressbar". */
export function Progress({ value, max = 100, tone = "accent", label, valueText, className }: ProgressProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={cx("h-[7px] overflow-hidden rounded-full bg-surface-2", className)}
    >
      <span className={cx("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}
