import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./keys";
import type { BaseSchema, Table, TableSummary, WorkspaceSummary } from "./types";

/** What the workspace list says about a table, taken from the table as the base schema has it. */
export function summaryOfTable(t: Table): TableSummary {
  return {
    id: t.id,
    name: t.name,
    icon: t.icon ?? null,
    color: t.color,
    record_count: t.record_count,
    body_field_id: t.body_field_id ?? null,
    home_date_field_id: t.home_date_field_id ?? null,
    done_field_id: t.done_field_id ?? null,
    record_noun: t.record_noun,
  };
}

function sameTables(a: readonly TableSummary[], b: readonly TableSummary[]): boolean {
  return a.length === b.length && a.every((t, i) => JSON.stringify(t) === JSON.stringify(b[i]));
}

/**
 * Copies each freshly loaded base schema's tables into that base's entry in the workspace list.
 * The workspace page names a base's tables from the list, but adding, renaming, reordering,
 * duplicating, importing and deleting tables (here or, through live events, by someone else) only
 * refetch the base's schema; without this the cards would show the old tables until the list is
 * next fetched. Returns the unsubscribe function.
 */
export function syncBaseTablesIntoWorkspaces(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const key = event.query.queryKey;
    if (key.length !== 2 || key[0] !== keys.allBases[0]) return;
    const schema = event.query.state.data as BaseSchema | undefined;
    if (!schema?.tables) return;
    const tables = schema.tables.map(summaryOfTable);
    const list = client.getQueryData<WorkspaceSummary[]>(keys.workspaces);
    const base = list?.find((w) => w.id === schema.workspace_id)?.bases.find((b) => b.id === schema.id);
    if (!list || !base || sameTables(base.tables ?? [], tables)) return;
    client.setQueryData<WorkspaceSummary[]>(
      keys.workspaces,
      list.map((w) => (w.id !== schema.workspace_id ? w : { ...w, bases: w.bases.map((b) => (b.id === schema.id ? { ...b, tables } : b)) })),
    );
  });
}
