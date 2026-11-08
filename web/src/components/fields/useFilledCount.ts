/**
 * How many records have a value in a property: what a type change would put at risk. It asks the server for
 * the "filled" summary over the whole collection, through the default view with its (empty) filter spelled out,
 * so nothing is counted from the records the page happens to have.
 */
import { useQuery } from "@tanstack/react-query";
import { recordsApi } from "@/api/records";
import type { Field, Table } from "@/api/types";
import { defaultViewOf } from "@/lib/views";

/** The count, or null while it is being asked for, when it is not wanted (`enabled` false) or when it could not be read. */
export function useFilledCount(table: Pick<Table, "id" | "views">, field: Field | undefined, enabled: boolean): number | null {
  const view = defaultViewOf(table);
  const id = field?.id ?? "";
  const { data } = useQuery({
    // Under the collection's record keys, so a change to its records makes the next count fresh.
    queryKey: ["records", table.id, "filled", id],
    enabled: enabled && !!view && !!field,
    queryFn: ({ signal }) => recordsApi.aggregations(view!.id, { transient: { filter: { conjunction: "and", items: [] }, summaries: { [id]: "filled" } }, signal }),
    select: (r) => {
      const n = r.values[id];
      return typeof n === "number" ? n : null;
    },
  });
  return data ?? null;
}
