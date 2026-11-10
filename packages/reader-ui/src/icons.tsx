/** 읽기 viewer icons and the 44px icon-button styling (Tailwind classes over the reader tokens). */
const ICONS = {
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />,
  home: <path d="M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9" />,
  book: <path d="M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2ZM12 6.5v14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  scroll: <path d="M7 3h10v18H7zM10 8h4M10 12h4M10 16h4" />,
  pages: <path d="M3 5h8v15H3zM13 5h8v15h-8z" />,
  sun: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  comment: <path d="M4 5h16v11H9l-5 4z" />,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
} as const;
export type ReaderIconName = keyof typeof ICONS;

export function ReaderIcon({ name, size = 20, filled = false }: { name: ReaderIconName; size?: number; filled?: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/** 44px tap target icon button / link styling */
export const ICON_BTN =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted no-underline transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent";

/** "가가" glyph of the 보기 설정 buttons */
export const SettingsGlyph = () => (
  <span aria-hidden="true" className="text-[15px] font-semibold">
    가<span className="text-[11px]">가</span>
  </span>
);
