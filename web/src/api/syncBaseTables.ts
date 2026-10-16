import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./keys";
import type { BaseSchema, TableSummary, WorkspaceSummary } from "./types";

function sameTables(a: readonly TableSummary[], b: readonly TableSummary[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i]!.id && t.name === b[i]!.name && (t.icon ?? null) === (b[i]!.icon ?? null));
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
    const tables: TableSummary[] = schema.tables.map((t) => ({ id: t.id, name: t.name, icon: t.icon ?? null }));
    const list = client.getQueryData<WorkspaceSummary[]>(keys.workspaces);
    const base = list?.find((w) => w.id === schema.workspace_id)?.bases.find((b) => b.id === schema.id);
    if (!list || !base || sameTables(base.tables ?? [], tables)) return;
    client.setQueryData<WorkspaceSummary[]>(
      keys.workspaces,
      list.map((w) => (w.id !== schema.workspace_id ? w : { ...w, bases: w.bases.map((b) => (b.id === schema.id ? { ...b, tables } : b)) })),
    );
  });
}
