import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectWorkspaceEvents, queryKeysForEvent, type ConnectOptions } from "@/api/events";
import { keys } from "@/api/keys";
import { useCountRefresh } from "./useCountRefresh";

/** A burst of record events is one refetch of Home. */
const HOME_REFRESH_MS = 400;

/**
 * Subscribe to the live events of every folder of a workspace (BE-9) for a screen that shows more than one
 * folder: the Collections tab and Home. Collections, names, colors and order refresh from schema events
 * at once, and record counts (other people's adds and deletes) once per few seconds. Home's lists (HOME-10) are refetched
 * when records or collections change, a burst of events costing one request. Presence is not read from
 * this stream: screens that show who is viewing use the folder's own.
 */
export function useWorkspaceEvents(workspaceId: string | undefined, overrides?: Pick<ConnectOptions, "createEventSource">): void {
  const qc = useQueryClient();
  const createRef = useRef(overrides?.createEventSource);
  createRef.current = overrides?.createEventSource;
  const refreshCounts = useCountRefresh();
  useEffect(() => {
    if (!workspaceId) return;
    let homeTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshHome = () => {
      if (homeTimer) clearTimeout(homeTimer);
      homeTimer = setTimeout(() => void qc.invalidateQueries({ queryKey: keys.home(workspaceId) }), HOME_REFRESH_MS);
    };
    const close = connectWorkspaceEvents({
      workspaceId,
      createEventSource: createRef.current,
      onEvent: (env) => {
        for (const key of queryKeysForEvent(env)) void qc.invalidateQueries({ queryKey: key });
        if (env.event.kind === "records_changed" && (env.event.created.length > 0 || env.event.deleted.length > 0)) refreshCounts();
        if (env.event.kind === "records_changed" || env.event.kind === "schema_changed" || env.event.kind === "base_changed") refreshHome();
      },
      // Events may have been missed while disconnected.
      onReconnect: () => {
        void qc.invalidateQueries({ queryKey: keys.workspaces });
        void qc.invalidateQueries({ queryKey: ["records"] });
        void qc.invalidateQueries({ queryKey: keys.home(workspaceId) });
      },
    });
    return () => {
      if (homeTimer) clearTimeout(homeTimer);
      close();
    };
  }, [workspaceId, qc, refreshCounts]);
}
