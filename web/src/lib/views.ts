/**
 * A table's default grid and its other views. Every table has one default grid (`View.is_default`):
 * a plain grid of all its records whose field order and hidden fields are the layout of every record
 * (the record panel, cards and previews follow it). It is not one of the table's views: menus and
 * lists of views leave it out, and the toolbar has an icon for it before them. Its filter, sort and
 * grouping are each person's own, kept on their device; it cannot be renamed, locked or deleted.
 */
import type { Table, View } from "@/api/types";

/** The table's default grid; for a table from before it existed, its first shared grid. */
export function defaultViewOf(table: Pick<Table, "views">): View | undefined {
  return table.views.find((v) => v.is_default) ?? table.views.find((v) => v.type === "grid" && !v.personal);
}

/** The table's views people make and pick from: all but its default grid. */
export function namedViews(table: Pick<Table, "views">): View[] {
  return table.views.filter((v) => !v.is_default);
}

/** The address of a table's default grid ("Edit schema"). */
export function defaultViewPath(baseId: string, table: Pick<Table, "id" | "views">): string {
  const view = defaultViewOf(table);
  return `/base/${baseId}/${table.id}${view ? `/${view.id}` : ""}`;
}
