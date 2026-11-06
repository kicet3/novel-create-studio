import { createContext, useCallback, useContext, useEffect, useState } from "react";

/** Below this width the sidebar becomes an off-canvas drawer from the left. */
export const DESKTOP_QUERY = "(min-width: 861px)";
const COLLAPSE_KEY = "ncs.sidebar.collapsed";

export interface SidebarState {
  /** Desktop only: icon rail instead of full sidebar. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Mobile only: drawer visibility. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  isDesktop: boolean;
}

export const SidebarStateContext = createContext<SidebarState>({
  collapsed: false,
  toggleCollapsed: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
  isDesktop: true,
});

export function useSidebarState(): SidebarState {
  return useContext(SidebarStateContext);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function useSidebarController(): SidebarState {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable: keep in memory only */
      }
      return next;
    });
  }, []);

  // Leaving mobile width closes the drawer.
  useEffect(() => {
    if (isDesktop) setMobileOpen(false);
  }, [isDesktop]);

  return { collapsed: isDesktop && collapsed, toggleCollapsed, mobileOpen, setMobileOpen, isDesktop };
}
