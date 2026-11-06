import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { cx } from "../../lib/cx.js";
import { NavIcon } from "./icons.js";
import { SidebarStateContext, useSidebarController } from "./sidebar-state.js";
import { StatusBanner } from "./StatusBanner.js";

/**
 * Left sidebar + main. Desktop: sidebar column (full or icon rail). Mobile: top bar with a menu button that opens
 * the sidebar as a left drawer. Landmarks: skip link → <main id="main">, sidebar <aside><nav>.
 * Each page renders its own <PageHeader> (h1) inside main.
 */
export function AppShell({ sidebar, children, title }: { sidebar: ReactNode; children: ReactNode; title?: ReactNode }) {
  const state = useSidebarController();
  const { pathname } = useLocation();
  const { setMobileOpen } = state;

  // Navigating closes the mobile drawer.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  return (
    <SidebarStateContext.Provider value={state}>
      <div className={cx("min-h-dvh bg-bg", state.isDesktop && "flex")}>
        <a href="#main" className="sr-only-focusable">
          본문으로 건너뛰기
        </a>
        {sidebar}
        <div className="flex min-w-0 flex-1 flex-col">
          {!state.isDesktop && (
            <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-surface/95 px-2 py-2 backdrop-blur">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="메뉴 열기"
                aria-expanded={state.mobileOpen}
                aria-controls="app-sidebar"
                className="grid size-9 place-items-center rounded-md text-text hover:bg-surface-2"
              >
                <NavIcon name="menu" />
              </button>
              <Link to="/novels" className="flex min-w-0 items-center gap-2 text-[13.5px] font-bold text-text no-underline">
                <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-md bg-accent text-xs text-accent-text">
                  N
                </span>
                <span className="truncate">{title ?? "Novel Studio"}</span>
              </Link>
            </header>
          )}
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-5 pt-[18px] pb-6 max-[860px]:px-3 max-[860px]:pt-3.5 focus:outline-none">
            <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
              <StatusBanner />
              <div>{children}</div>
            </div>
          </main>
        </div>
      </div>
    </SidebarStateContext.Provider>
  );
}
