import { labelKo, type EnumName, type EnumValue } from "@ncs/shared";
import { Badge } from "./Badge.js";
import type { Tone } from "./tone.js";

/**
 * Tone by enum value. Values are shared across many status enums (00 §6), so one table covers
 * most of them; per-enum overrides go in ENUM_TONE_OVERRIDES.
 */
const VALUE_TONE: Record<string, Tone> = {
  // done / good
  done: "ok", approved: "ok", published: "ok", published_locked: "ok", succeeded: "ok", answered: "ok",
  resolved: "ok", confirmed: "ok", completed: "ok", applied: "ok", active: "ok", pass: "ok", ok: "ok",
  paid_off: "ok", sent: "ok", processed: "ok", settled: "ok", adopted: "ok", consumed: "ok", released: "ok",
  // in progress
  running: "info", ready: "info", drafting: "info", outlining: "info", checking: "info", polishing: "info",
  revising: "info", processing: "info", sending: "info", fixing: "info", planted: "info", reinforced: "info",
  serializing: "info", planning: "info", generating: "info", detected: "info", auto_linked: "info",
  // needs a human / attention
  awaiting_approval: "warn", plan_awaiting_approval: "warn", pending: "warn", open: "warn", warn: "warn",
  warning: "warn", soft_warned: "warn", retry: "warn", degraded: "warn", paused: "warn", ambiguous: "warn",
  pending_binding: "warn", needs_followup: "warn", delivery_unknown: "warn", approved_direction: "warn",
  medium: "warn",
  // bad
  blocked: "danger", failed: "danger", fail: "danger", rejected: "danger", hard_stopped: "danger",
  disconnected: "danger", revoked: "danger", missing: "danger", interrupted: "danger", high: "danger",
  unknown: "danger", blocking: "danger",
  // provisional
  candidate: "violet", proposed: "violet", new_entity_candidate: "violet", draft: "violet",
  // inert
  cancelled: "neutral", superseded: "neutral", retired: "neutral", archived: "neutral", abandoned: "neutral",
  waived: "neutral", false_positive: "neutral", merged: "neutral", reverted: "neutral", expired: "neutral",
  ignored: "neutral", discarded: "neutral", planned: "neutral", low: "neutral", informational: "neutral",
  non_blocking: "info",
};

const ENUM_TONE_OVERRIDES: Partial<Record<EnumName, Record<string, Tone>>> = {
  // `approved` canon is still editable; locked is final
  canon_status: { approved: "accent", published_locked: "ok" },
  // reserve counting treats approved as done but not yet published
  episode_status: { approved: "accent", planned: "neutral" },
  autonomy_level: { episode_approval: "accent", arc_approval: "accent", full_auto: "violet", co_writing: "accent" },
};

export function toneForStatus(enumName: EnumName, value: string): Tone {
  return ENUM_TONE_OVERRIDES[enumName]?.[value] ?? VALUE_TONE[value] ?? "neutral";
}

export interface StatusBadgeProps<N extends EnumName> {
  /** Enum name from @ncs/shared (`task_status`, `episode_status`, …). */
  enum: N;
  value: EnumValue<N>;
  /** Force a tone instead of the value-based default. */
  tone?: Tone;
  /** Show the raw enum identifier as a tooltip (default true). */
  showRawTitle?: boolean;
  className?: string;
}

/** Enum value → Korean label pill with tone + glyph (FR-UI-03: labels, not raw identifiers). */
export function StatusBadge<N extends EnumName>({
  enum: enumName,
  value,
  tone,
  showRawTitle = true,
  className,
}: StatusBadgeProps<N>) {
  const v = String(value);
  return (
    <Badge
      tone={tone ?? toneForStatus(enumName, v)}
      glyph
      title={showRawTitle ? v : undefined}
      className={className}
    >
      {labelKo(enumName, v)}
    </Badge>
  );
}
