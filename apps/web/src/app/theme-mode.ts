import { useCallback, useEffect, useState } from "react";

/**
 * Manual theme override on top of `prefers-color-scheme`.
 * `system` removes `data-theme` from <html> so the OS preference applies (see theme.css).
 * index.html applies the stored value before first paint to avoid a flash.
 */
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = "ncs.theme";

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: "시스템",
  light: "라이트",
  dark: "다크",
};

function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === "string" && (THEME_MODES as readonly string[]).includes(v);
}

export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setModeState] = useState<ThemeMode>(readThemeMode);

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  // keep tabs in sync
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setModeState(isThemeMode(e.newValue) ? e.newValue : "system");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable: still apply for this session */
    }
    setModeState(next);
  }, []);

  return [mode, setMode];
}
