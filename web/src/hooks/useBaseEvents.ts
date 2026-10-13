import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectBaseEvents, queryKeysForEvent, type ConnectOptions } from "@/api/events";
import { keys } from "@/api/keys";

/** Subscribe to a base's live events and turn them into query invalidations. */
export function useBaseEvents(baseId: string | undefined, overrides?: Pick<ConnectOptions, "createEventSource">): void {
  const qc = useQueryClient();
  const createRef = useRef(overrides?.createEventSource);
  createRef.current = overrides?.createEventSource;
  useEffect(() => {
    if (!baseId) return;
    return connectBaseEvents({
      baseId,
      createEventSource: createRef.current,
      onEvent: (env) => {
        for (const key of queryKeysForEvent(env)) void qc.invalidateQueries({ queryKey: key });
      },
      // Events may have been missed while disconnected: refetch what is on screen.
      onReconnect: () => {
        void qc.invalidateQueries({ queryKey: keys.base(baseId) });
        void qc.invalidateQueries({ queryKey: ["records"] });
      },
    });
  }, [baseId, qc]);
}
