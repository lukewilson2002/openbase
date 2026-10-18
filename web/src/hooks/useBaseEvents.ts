import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectBaseEvents, queryKeysForEvent, type ConnectOptions } from "@/api/events";
import { keys } from "@/api/keys";

/**
 * Subscribe to a base's live events and turn them into query invalidations. Who is viewing the base
 * (the `presence_changed` frames) goes into the cache for `usePresence`, and is dropped again when
 * the base is left.
 */
export function useBaseEvents(baseId: string | undefined, overrides?: Pick<ConnectOptions, "createEventSource">): void {
  const qc = useQueryClient();
  const createRef = useRef(overrides?.createEventSource);
  createRef.current = overrides?.createEventSource;
  useEffect(() => {
    if (!baseId) return;
    const close = connectBaseEvents({
      baseId,
      createEventSource: createRef.current,
      onEvent: (env) => {
        if (env.event.kind === "presence_changed") qc.setQueryData(keys.presence(baseId), env.event.viewers);
        for (const key of queryKeysForEvent(env)) void qc.invalidateQueries({ queryKey: key });
      },
      // Events may have been missed while disconnected: refetch what is on screen. (The new stream
      // starts with who is viewing, so presence needs nothing.)
      onReconnect: () => {
        void qc.invalidateQueries({ queryKey: keys.base(baseId) });
        void qc.invalidateQueries({ queryKey: ["records"] });
      },
    });
    return () => {
      close();
      // Emptied, not removed: a component still showing the base keeps its observer on the query.
      qc.setQueryData(keys.presence(baseId), []);
    };
  }, [baseId, qc]);
}
