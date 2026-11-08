import type { ViewConfig } from "@/api/types";

/** Whether the view's filter or the search text narrows what it shows: why a view with no records is "filtered to nothing" (COL-9). */
export function isFiltered(config: Pick<ViewConfig, "filter">, search: string): boolean {
  return (config.filter?.items.length ?? 0) > 0 || search.trim() !== "";
}
