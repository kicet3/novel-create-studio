import { THEME_MODES, THEME_MODE_LABELS, useThemeMode } from "../../app/theme-mode.js";
import { cx } from "../../lib/cx.js";

/** Segmented 시스템 / 라이트 / 다크 switch (radio group semantics via aria-pressed buttons). */
export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useThemeMode();
  return (
    <div role="group" aria-label="화면 테마" className={cx("inline-flex h-8 items-stretch rounded-[7px] border border-border bg-surface-2 p-0.5", className)}>
      {THEME_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => setMode(m)}
          className={cx(
            "inline-flex flex-1 items-center justify-center rounded-[5px] px-2.5 text-xs leading-none font-semibold whitespace-nowrap",
            mode === m ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
          )}
        >
          {THEME_MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}
