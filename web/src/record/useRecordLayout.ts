/**
 * Hide from pages and Show on pages (REC-3): they change the collection's default view, whose order and hidden
 * properties lay out every record. That is an explicit edit of the record layout, so it is saved at once and is
 * not a draft (decision 4). The change shows straight away and goes out one request at a time, in the order made.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View, ViewConfig } from "@/api/types";
import { useToast } from "@/components/ui/toast";
import { setHiddenField } from "@/components/viewbar/config";
import { replaceViewConfig } from "@/views/grid/useViewConfig";
import { SAVED_VISIBLE_MS, type SaveState } from "./useRecordSave";

export interface RecordLayout {
  /** Hides the property from every record's page, or brings it back. */
  setHidden(fieldId: string, hidden: boolean): void;
  state: SaveState;
}

export function useRecordLayout({ schema, table, view }: { schema: BaseSchema; table: Table; view: View | null }): RecordLayout {
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(0);
  const [outcome, setOutcome] = useState<"saved" | "error" | null>(null);
  const viewId = view?.id ?? "";
  const mutationKey = ["record-layout", viewId];

  const save = useMutation({
    scope: { id: `record-layout:${viewId}` },
    mutationKey,
    mutationFn: (config: ViewConfig) => api.views.update(viewId, { config }),
    onMutate: () => {
      setPending((n) => n + 1);
      setOutcome(null);
    },
    onSuccess: (saved) => {
      // With another change still on its way, that one's answer is the newer.
      if (saved?.config && qc.isMutating({ mutationKey }) <= 1) qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, viewId, saved.config) : old));
      setOutcome("saved");
    },
    onError: (e) => {
      toast.error(e, "Could not change which properties pages show");
      setOutcome("error");
      void qc.invalidateQueries({ queryKey: keys.base(schema.id) });
    },
    onSettled: () => setPending((n) => Math.max(0, n - 1)),
  });

  // "Saved" fades after a few seconds, as the values' does.
  useEffect(() => {
    if (outcome !== "saved" || pending > 0) return;
    const t = setTimeout(() => setOutcome(null), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [outcome, pending]);

  const { mutate } = save;
  const viewRef = useRef(view);
  viewRef.current = view;
  const setHidden = useCallback(
    (fieldId: string, hidden: boolean) => {
      const v = viewRef.current;
      if (!v) return;
      // The latest layout, which holds the changes still on their way, rather than the one this render was given.
      const cached = qc.getQueryData<BaseSchema>(keys.base(schema.id))?.tables.find((t) => t.id === table.id)?.views.find((x) => x.id === v.id);
      const next = setHiddenField((cached ?? v).config, table, fieldId, hidden);
      qc.setQueryData<BaseSchema>(keys.base(schema.id), (old) => (old ? replaceViewConfig(old, table.id, v.id, next) : old));
      mutate(next);
    },
    [qc, schema.id, table, mutate],
  );

  const state: SaveState = pending > 0 ? "saving" : outcome === "error" ? "error" : outcome === "saved" ? "saved" : "idle";
  return { setHidden, state };
}
