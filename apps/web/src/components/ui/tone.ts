/** Semantic colour tones shared by Badge, Callout, Progress, StatusBadge (base.css `.badge.<tone>`). */
export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "violet";

export const TONE_SOFT: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
  violet: "bg-violet-soft text-violet",
};

export const TONE_BORDER_LEFT: Record<Tone, string> = {
  neutral: "border-l-border",
  ok: "border-l-ok",
  warn: "border-l-warn",
  danger: "border-l-danger",
  info: "border-l-info",
  accent: "border-l-accent",
  violet: "border-l-violet",
};

export const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-faint",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
  violet: "bg-violet",
};

/**
 * Non-colour cue per tone (WCAG 1.4.1, 08 §9.9): status is never conveyed by colour alone.
 * Glyphs are aria-hidden; the label text carries the meaning.
 */
export const TONE_GLYPH: Record<Tone, string> = {
  neutral: "○",
  ok: "✓",
  warn: "!",
  danger: "✕",
  info: "●",
  accent: "●",
  violet: "◆",
};
