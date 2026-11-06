import { useEffect, useRef, type ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { cx } from "../../lib/cx.js";
import { CountBadge } from "../ui/Badge.js";
import { NavIcon, type NavIconName } from "./icons.js";
import { useSidebarState } from "./sidebar-state.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * Sidebar nav item. NavLink sets aria-current="page" on the active item.
 * In the collapsed icon rail the label stays in the accessible name (sr-only) and appears as a tooltip.
 */
export function SidebarNavItem({
  to,
  end,
  children,
  icon,
  count,
  countLabel,
  adornment,
}: {
  to: string;
  end?: boolean;
  children: ReactNode;
  icon?: NavIconName;
  count?: number;
  countLabel?: string;
  adornment?: ReactNode;
}) {
  const { collapsed, setMobileOpen } = useSidebarState();
  const label = typeof children === "string" ? children : undefined;
  const hasCount = count !== undefined && count > 0;
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      onClick={() => setMobileOpen(false)}
      className={({ isActive }) =>
        cx(
          "group relative flex items-center gap-2.5 whitespace-nowrap rounded-lg py-[7px] no-underline transition-colors",
          collapsed ? "justify-center px-0" : "px-2.5",
          isActive
            ? "bg-accent-soft font-semibold text-accent before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
            : "text-muted hover:bg-surface-2 hover:text-text",
        )
      }
    >
      {icon && <NavIcon name={icon} className="shrink-0" />}
      <span className={cx("min-w-0 flex-1 truncate", collapsed && "sr-only")}>{children}</span>
      {count !== undefined &&
        (collapsed ? (
          hasCount && (
            <span className="absolute top-1 right-1.5 size-2 rounded-full bg-danger" aria-label={`${countLabel ?? label ?? ""} ${count}건`} />
          )
        ) : (
          <CountBadge count={count} label={countLabel ?? label} />
        ))}
      {!collapsed && adornment}
    </NavLink>
  );
}

/** Small uppercase-style group heading inside the nav ("작품", "설치"). Hidden in the icon rail. */
export function SidebarSection({ title, children }: { title?: string; children: ReactNode }) {
  const { collapsed } = useSidebarState();
  return (
    <div className="flex flex-col gap-0.5">
      {title &&
        (collapsed ? (
          <hr className="mx-2 my-1.5 border-border" />
        ) : (
          <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint">{title}</div>
        ))}
      {children}
    </div>
  );
}

export interface SidebarProps {
  /** Context box under the brand: current novel title + genre, or a section label. */
  context?: ReactNode;
  /** Main navigation items (SidebarNavItem / SidebarSection). */
  children: ReactNode;
  navLabel: string;
  /** Secondary links at the bottom (작품 목록, 설치 설정, …). */
  footer?: ReactNode;
}

/**
 * Left sidebar at every width.
 * - Desktop (≥861px): sticky full-height column, collapsible to a 64px icon rail.
 * - Mobile: off-canvas drawer sliding in from the left (opened from the top bar), with backdrop, Esc to close,
 *   and `inert` while closed so hidden links are out of the tab order.
 */
export function Sidebar({ context, children, navLabel, footer }: SidebarProps) {
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen, isDesktop } = useSidebarState();
  const asideRef = useRef<HTMLElement>(null);
  const drawerHidden = !isDesktop && !mobileOpen;

  useEffect(() => {
    if (isDesktop || !mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    asideRef.current?.querySelector<HTMLElement>("a[aria-current='page'], a, button")?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isDesktop, mobileOpen, setMobileOpen]);

  return (
    <>
      {!isDesktop && (
        <div
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
          className={cx(
            "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none",
            mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}
      <aside
        ref={asideRef}
        id="app-sidebar"
        inert={drawerHidden}
        aria-label="사이드바"
        className={cx(
          "flex flex-col border-r border-border bg-surface text-[13px]",
          isDesktop
            ? "sticky top-0 h-dvh overflow-y-auto overflow-x-hidden transition-[width] duration-200 motion-reduce:transition-none"
            : "fixed inset-y-0 left-0 z-50 w-[272px] max-w-[85vw] overflow-y-auto transition-[transform,box-shadow] duration-200 motion-reduce:transition-none",
          isDesktop && (collapsed ? "w-16 px-2 py-3.5" : "w-[232px] px-3 py-3.5"),
          !isDesktop && "px-3 py-3.5",
          !isDesktop && (mobileOpen ? "translate-x-0 shadow-xl" : "-translate-x-full shadow-none"),
        )}
      >
        <div className={cx("flex items-center pb-3", collapsed ? "justify-center" : "justify-between gap-2 pl-1")}>
          <Link
            to="/novels"
            onClick={() => setMobileOpen(false)}
            title={collapsed ? "Novel Studio" : undefined}
            className="flex min-w-0 items-center gap-2 text-[13.5px] font-bold text-text no-underline"
          >
            <span aria-hidden="true" className="grid size-[26px] shrink-0 place-items-center rounded-md bg-accent text-xs text-accent-text">
              N
            </span>
            <span className={cx("truncate", collapsed && "sr-only")}>Novel Studio</span>
          </Link>
          {!isDesktop && (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="메뉴 닫기"
              className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
            >
              <NavIcon name="close" />
            </button>
          )}
        </div>

        {context && !collapsed && (
          <div className="mb-3 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-[12.5px]">{context}</div>
        )}

        <nav aria-label={navLabel} className="flex flex-col gap-0.5">
          {children}
        </nav>

        <div className="mt-auto flex flex-col gap-2 pt-4">
          {footer && (
            <nav aria-label="보조 메뉴" className="flex flex-col gap-0.5 border-t border-border pt-3">
              {footer}
            </nav>
          )}
          {!collapsed && <ThemeToggle className="self-start" />}
          {isDesktop && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
              className={cx(
                "flex items-center gap-2.5 rounded-lg py-[7px] text-muted hover:bg-surface-2 hover:text-text",
                collapsed ? "justify-center px-0" : "px-2.5",
              )}
            >
              <NavIcon name={collapsed ? "expand" : "collapse"} />
              <span className={cx(collapsed && "sr-only")}>{collapsed ? "사이드바 펼치기" : "사이드바 접기"}</span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
