/** browser hooks of the 읽기 viewer (client only; SSR-safe snapshots). */
import { useEffect, useState, useSyncExternalStore } from "react";
import { headerVisible } from "@ncs/reader-core/model";

/** sticky header that slides away on scroll down (목차 page) */
export function useHideOnScroll(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let last = window.scrollY;
    let vis = true;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = window.scrollY;
        const nearBottom = top + window.innerHeight >= document.documentElement.scrollHeight - 24;
        const next = nearBottom || headerVisible(last, top, vis);
        if (Math.abs(top - last) >= 6 || top <= 64) last = top;
        if (next !== vis) {
          vis = next;
          setVisible(next);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return visible;
}

export const wakeLockSupported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

/** 화면 꺼짐 방지: hold a screen wake lock while enabled and visible (re-acquired when the tab comes back) */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !wakeLockSupported()) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* denied (battery saver, not focused): reading continues normally */
      }
    };
    void acquire();
    const onVisible = () => void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (lock && !lock.released) void lock.release().catch(() => {});
    };
  }, [enabled]);
}

/** prefers-reduced-motion (page turns jump instead of sliding) */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** window size, updated once per frame on resize */
export function useWindowSize(): { w: number; h: number } {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setSize((s) => {
          const n = read();
          return n.w === s.w && n.h === s.h ? s : n;
        }),
      );
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return size;
}
