/** Tiny history router (4 routes; no dependency). Paths are relative to Vite's BASE_URL. */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Route =
  | { name: "list" }
  | { name: "novel"; slug: string }
  | { name: "episode"; slug: string; episodeNo: number }
  | { name: "admin" }
  | { name: "notFound" };

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");

export function parseRoute(pathname: string): Route {
  let p = pathname;
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length);
  p = p.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "list" };
  if (p === "/admin") return { name: "admin" };
  const m = /^\/novels\/([a-z0-9-]{1,64})(?:\/(\d{1,6}))?$/.exec(p);
  if (m) return m[2] ? { name: "episode", slug: m[1]!, episodeNo: Number(m[2]) } : { name: "novel", slug: m[1]! };
  return { name: "notFound" };
}

export const href = {
  list: () => `${BASE}/`,
  novel: (slug: string) => `${BASE}/novels/${slug}`,
  episode: (slug: string, no: number, at?: "end") => `${BASE}/novels/${slug}/${no}${at ? `?at=${at}` : ""}`,
  admin: () => `${BASE}/admin`,
};

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === snapshot()) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const fn of listeners) fn();
}

/** current path + search (re-renders on navigation) */
export function useLocation(): { pathname: string; search: URLSearchParams } {
  const s = useSyncExternalStore(subscribe, snapshot, () => "/");
  const i = s.indexOf("?");
  return { pathname: i < 0 ? s : s.slice(0, i), search: new URLSearchParams(i < 0 ? "" : s.slice(i)) };
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
    window.scrollTo(0, 0);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
