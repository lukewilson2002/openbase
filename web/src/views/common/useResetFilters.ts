/**
 * "Reset" of the filtered-empty state (COL-9): goes back to what the view shows as saved. A draft
 * filter or a search that narrowed it to nothing is dropped, and the saved view's own filter stays. Only
 * when the saved filter alone leaves nothing is it lifted, as a draft, so the button always shows records.
 */
import { useCallback } from "react";
import type { View } from "@/api/types";
import { setFilter } from "@/components/viewbar/config";
import type { ViewConfigApi } from "../grid/useViewConfig";

export function useResetFilters(cfg: ViewConfigApi, view: View, search: string, setSearch: (s: string) => void): () => void {
  const { update } = cfg;
  const draftFilters = cfg.draft !== null && "filter" in cfg.draft.changes;
  const savedFilter = view.config.filter;
  const typed = search.trim() !== "";
  return useCallback(() => {
    if (draftFilters || typed) update((c) => setFilter(c, savedFilter));
    else update((c) => setFilter(c, null));
    setSearch("");
  }, [update, draftFilters, typed, savedFilter, setSearch]);
}
