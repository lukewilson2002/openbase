/**
 * Whether a grid view keeps its primary field pinned at the left on this device. Pinned by default:
 * on a phone the name column is what tells you which row you are reading once you scroll sideways.
 * The choice is per device and per view (localStorage), never saved to the view.
 */
import { useCallback, useEffect, useState } from "react";

function storageKey(viewId: string): string {
  return `ob-primary-pinned:${viewId}`;
}

export function readPrimaryPinned(viewId: string): boolean {
  try {
    return localStorage.getItem(storageKey(viewId)) !== "false";
  } catch {
    return true;
  }
}

function writePrimaryPinned(viewId: string, pinned: boolean): void {
  try {
    if (pinned) localStorage.removeItem(storageKey(viewId));
    else localStorage.setItem(storageKey(viewId), "false");
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
}

/** Columns Glide keeps in place: the primary field plus `frozen` more, or none once it is unpinned. */
export function frozenColumnCount(pinned: boolean, frozen: number, columnCount: number): number {
  if (!pinned) return 0;
  return 1 + Math.min(frozen, Math.max(0, columnCount - 1));
}

export function usePrimaryPinned(viewId: string): [boolean, () => void] {
  const [pinned, setPinned] = useState(() => readPrimaryPinned(viewId));
  useEffect(() => setPinned(readPrimaryPinned(viewId)), [viewId]);
  const toggle = useCallback(() => {
    setPinned((p) => {
      writePrimaryPinned(viewId, !p);
      return !p;
    });
  }, [viewId]);
  return [pinned, toggle];
}
