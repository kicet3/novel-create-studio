/**
 * Shared sizing tokens for form controls and buttons, so Input / Select / Textarea / Button / ButtonLink line up in
 * the same row: fixed heights (md 36px, sm 32px), one radius, one border, one focus ring.
 */
export type ControlSize = "md" | "sm";

/** fixed height + horizontal padding + type size per size (single-line controls and buttons) */
export const CONTROL_SIZE: Record<ControlSize, string> = {
  md: "h-9 px-3 text-[13px] leading-5",
  sm: "h-8 px-2.5 text-[12.5px] leading-5",
};

/** radius shared by every control and button */
export const CONTROL_SHAPE = "rounded-[7px]";

/** focus ring: same 2px accent ring as the global :focus-visible, drawn just outside the border */
export const CONTROL_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** native checkbox / radio: one size everywhere (use in `items-center` rows) */
export const CHOICE_BOX = "size-4 flex-none cursor-pointer accent-accent disabled:cursor-not-allowed";

/** CHOICE_BOX aligned with the first line of 13px text (line-height 1.65) in `items-start` rows */
export const CHOICE_INPUT = `${CHOICE_BOX} mt-[3px]`;
