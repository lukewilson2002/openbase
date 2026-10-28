import { useEffect, useState } from "react";
import { wallNow } from "../common/wallTime";

/** How often the clock is read; a day boundary is crossed at most this late. */
const TICK_MS = 30_000;
const MINUTE_MS = 60_000;

/** Wall time to the minute: the view only redraws when the marker could have moved (a minute is under a pixel at the widest scale). */
const wallMinute = (zone: string) => Math.floor(wallNow(zone) / MINUTE_MS) * MINUTE_MS;

/**
 * Wall time "now" in `zone`, kept current: the timeline's today marker follows midnight on a page
 * left open (and catches up when the tab wakes, as timers pause while it is hidden or asleep).
 */
export function useWallNow(zone: string): number {
  const [now, setNow] = useState(() => wallMinute(zone));
  useEffect(() => {
    const tick = () => setNow(wallMinute(zone));
    tick();
    const id = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, [zone]);
  return now;
}
