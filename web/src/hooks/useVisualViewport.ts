import { useEffect, useState } from "react";

/** The part of the page the user can see, in the coordinates of `position: fixed`. */
export interface VisibleArea {
  top: number;
  height: number;
}

function readVisibleArea(): VisibleArea {
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: window.innerHeight };
}

/**
 * Tracks `window.visualViewport`: the area left visible by the on-screen keyboard and pinch zoom.
 * iOS Safari keeps the layout viewport (what `100dvh`, `bottom: 0` and `interactive-widget` go by)
 * at full height while the keyboard is up, so only this tells where the keyboard begins.
 */
export function useVisualViewport(enabled = true): VisibleArea {
  const [area, setArea] = useState(readVisibleArea);
  useEffect(() => {
    if (!enabled) return;
    const update = () =>
      setArea((prev) => {
        const next = readVisibleArea();
        return prev.top === next.top && prev.height === next.height ? prev : next;
      });
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);
  return area;
}
