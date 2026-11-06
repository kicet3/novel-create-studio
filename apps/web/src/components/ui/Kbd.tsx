import type { ReactNode } from "react";
import { cx } from "../../lib/cx.js";

/** Keyboard key cap for shortcut hints. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-block min-w-[1.5em] rounded border border-border bg-surface-2 px-1 text-center font-mono text-[11px] leading-[1.6] text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
