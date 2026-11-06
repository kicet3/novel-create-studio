import { useEffect, useState } from "react";
import { stableOffset } from "./model.js";

/**
 * Ticking clock (ms, shifted by the server clock offset) for live elapsed times. Text-only, so no reduced-motion gate.
 * The offset is re-estimated on every poll; small changes are ignored so the 1s timer is not restarted each poll.
 */
export function useNow(rawOffsetMs = 0, intervalMs = 1000): number {
  const [offsetMs, setOffsetMs] = useState(() => Math.round(rawOffsetMs));
  const nextOffset = stableOffset(offsetMs, rawOffsetMs);
  if (nextOffset !== offsetMs) setOffsetMs(nextOffset); // adjust-on-prop-change during render (no extra effect pass)
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const id = window.setInterval(() => setNow(Date.now() + offsetMs), intervalMs);
    return () => window.clearInterval(id);
  }, [offsetMs, intervalMs]);
  return now;
}
