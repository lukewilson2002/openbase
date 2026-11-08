import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onRecordCountChange } from "@/api/records";
import { keys } from "@/api/keys";

/** The sidebar's record counts follow other people's adds and deletes at most this often. */
export const COUNT_REFRESH_MS = 3_000;

/** A person's own adds and deletes show sooner: they are looking at the number they just changed. */
export const OWN_COUNT_REFRESH_MS = 800;

/**
 * Refreshes the workspaces list, which holds the record counts the sidebar and the Collections tab show, once
 * per `delay` however many times the returned function is called (a paste of a thousand rows is many writes).
 * A refresh still waiting when the component goes is dropped.
 */
export function useCountRefresh(delay = COUNT_REFRESH_MS): () => void {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(() => {
    timer.current ??= setTimeout(() => {
      timer.current = undefined;
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    }, delay);
  }, [qc, delay]);
}

/**
 * Keeps the counts right after this tab's own record changes. The live streams skip them (the change already
 * updated the cache it came from), but the counts are on another list, which only the streams and the
 * minute-by-minute refresh would otherwise bring up to date.
 */
export function useOwnRecordCounts(): void {
  const refresh = useCountRefresh(OWN_COUNT_REFRESH_MS);
  useEffect(() => onRecordCountChange(refresh), [refresh]);
}
