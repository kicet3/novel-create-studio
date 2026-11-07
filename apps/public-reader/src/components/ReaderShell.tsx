"use client";
/** App shell: reader theme (stored setting / system dark mode) + typography variables on one wrapper. */
import { useEffect, useRef, type ReactNode } from "react";
import { readerVars, useReaderSettings, useTheme } from "../lib/hooks";

export function ReaderShell({ children }: { children: ReactNode }) {
  const [settings] = useReaderSettings();
  const theme = useTheme(settings);
  const ref = useRef<HTMLDivElement>(null);
  // body background follows the theme so overscroll / safe areas match
  useEffect(() => {
    if (ref.current) document.body.style.backgroundColor = getComputedStyle(ref.current).backgroundColor;
    document.documentElement.style.colorScheme = theme === "black" ? "dark" : "light";
  }, [theme]);
  return (
    <div ref={ref} className="reader pr-app" data-reader-theme={theme} style={readerVars(settings)}>
      {children}
    </div>
  );
}
