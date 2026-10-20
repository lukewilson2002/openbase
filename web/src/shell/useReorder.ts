/**
 * Putting the menu's rows in a new order: workspaces (each person's own order), a workspace's projects,
 * a project's tables, a table's shared views or its personal views. The server takes the ids of one
 * group in their new order: those ids take the places the group held, in that order, and siblings left
 * out keep theirs ("the full visible list of the group" is what the menu sends).
 *
 * The caches change first, in the same turn as the drop, so the rows do not jump back while the
 * request is on its way (`applyOrder` and the `reorder…In` functions are the pure part); a failed request
 * puts every cache back and says so, and a settled one asks for the affected queries again, once no
 * other reorder is still in flight (an earlier answer must not undo a later drop).
 */
import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, WorkspaceSummary } from "@/api/types";
import { useToast } from "@/components/ui/toast";

/**
 * `items` with the ones named in `ids` in that order, each at a place a listed item held; items not
 * named stay where they are, and ids that match no item are ignored.
 */
export function applyOrder<T>(items: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const queue: T[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined || seen.has(id)) continue;
    seen.add(id);
    queue.push(item);
  }
  let next = 0;
  return items.map((item) => (seen.has(idOf(item)) ? queue[next++]! : item));
}

/** `ids` with `id` moved one place (`-1` up, `1` down); `null` when it is not there or already at that end. */
export function moveId(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const out = [...ids];
  out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}

const idOf = (x: { id: string }) => x.id;

export function reorderWorkspacesIn(list: WorkspaceSummary[] | undefined, ids: readonly string[]): WorkspaceSummary[] | undefined {
  return list && applyOrder(list, ids, idOf);
}

export function reorderProjectsIn(list: WorkspaceSummary[] | undefined, workspaceId: string, ids: readonly string[]): WorkspaceSummary[] | undefined {
  return list?.map((ws) => (ws.id === workspaceId ? { ...ws, bases: applyOrder(ws.bases, ids, idOf) } : ws));
}

/** The project's table summaries in the workspaces list (what the home pages name its tables from). */
export function reorderTablesInWorkspaces(list: WorkspaceSummary[] | undefined, baseId: string, ids: readonly string[]): WorkspaceSummary[] | undefined {
  return list?.map((ws) => (ws.bases.some((b) => b.id === baseId) ? { ...ws, bases: ws.bases.map((b) => (b.id === baseId ? { ...b, tables: applyOrder(b.tables, ids, idOf) } : b)) } : ws));
}

export function reorderTablesIn(schema: BaseSchema | undefined, ids: readonly string[]): BaseSchema | undefined {
  return schema && { ...schema, tables: applyOrder(schema.tables, ids, idOf) };
}

/** A table's views: `ids` are all shared or all personal ones, and the default grid is never among them. */
export function reorderViewsIn(schema: BaseSchema | undefined, tableId: string, ids: readonly string[]): BaseSchema | undefined {
  return schema && { ...schema, tables: schema.tables.map((t) => (t.id === tableId ? { ...t, views: applyOrder(t.views, ids, idOf) } : t)) };
}

export type ReorderRequest =
  { kind: "workspaces"; ids: string[] } | { kind: "projects"; workspaceId: string; ids: string[] } | { kind: "tables"; baseId: string; ids: string[] } | { kind: "views"; baseId: string; tableId: string; ids: string[] };

const REORDER_KEY = ["reorder"] as const;
const FAILURE: Record<ReorderRequest["kind"], string> = {
  workspaces: "Could not reorder the workspaces",
  projects: "Could not reorder the projects",
  tables: "Could not reorder the tables",
  views: "Could not reorder the views",
};

/** The cached queries a reorder changes. */
function affected(req: ReorderRequest): QueryKey[] {
  switch (req.kind) {
    case "workspaces":
    case "projects":
      return [keys.workspaces];
    case "tables":
      return [keys.workspaces, keys.base(req.baseId)];
    case "views":
      return [keys.base(req.baseId)];
  }
}

/** Changes the caches as the request will once the server has answered. */
function applyOptimistic(qc: QueryClient, req: ReorderRequest): void {
  switch (req.kind) {
    case "workspaces":
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (d) => reorderWorkspacesIn(d, req.ids));
      break;
    case "projects":
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (d) => reorderProjectsIn(d, req.workspaceId, req.ids));
      break;
    case "tables":
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (d) => reorderTablesInWorkspaces(d, req.baseId, req.ids));
      qc.setQueryData<BaseSchema>(keys.base(req.baseId), (d) => reorderTablesIn(d, req.ids));
      break;
    case "views":
      qc.setQueryData<BaseSchema>(keys.base(req.baseId), (d) => reorderViewsIn(d, req.tableId, req.ids));
      break;
  }
}

function send(req: ReorderRequest) {
  switch (req.kind) {
    case "workspaces":
      return api.workspaces.reorder(req.ids);
    case "projects":
      return api.workspaces.reorderBases(req.workspaceId, req.ids);
    case "tables":
      return api.bases.reorderTables(req.baseId, req.ids);
    case "views":
      return api.tables.reorderViews(req.tableId, req.ids);
  }
}

/** Queries to ask for again once the last reorder in flight settles, per client. */
const stale = new WeakMap<QueryClient, Map<string, QueryKey>>();

/**
 * Returns a function that reorders one group of the menu: the caches change at once, the request goes
 * out, and the promise settles (never rejects) when it has been answered, after a failure was put back
 * and toasted.
 */
export function useReorder(): (req: ReorderRequest) => Promise<void> {
  const qc = useQueryClient();
  const toast = useToast();
  const { mutateAsync } = useMutation({
    mutationKey: REORDER_KEY,
    mutationFn: ({ req }: { req: ReorderRequest; before: [QueryKey, unknown][] }) => send(req),
    onError: (e, { req, before }) => {
      for (const [key, data] of before) qc.setQueryData(key, data);
      toast.error(e, FAILURE[req.kind]);
    },
    onSettled: (_data, _error, { req }) => {
      let pending = stale.get(qc);
      if (!pending) stale.set(qc, (pending = new Map()));
      for (const key of affected(req)) pending.set(JSON.stringify(key), key);
      // This one still counts as in flight here.
      if (qc.isMutating({ mutationKey: REORDER_KEY }) > 1) return;
      const keysToAsk = [...pending.values()];
      pending.clear();
      for (const queryKey of keysToAsk) void qc.invalidateQueries({ queryKey, exact: true });
    },
  });
  return useCallback(
    async (req: ReorderRequest) => {
      const touched = affected(req);
      // Changed in this turn, not after the mutation starts: the rows must not see the old order in between.
      for (const key of touched) void qc.cancelQueries({ queryKey: key, exact: true });
      const before = touched.map((key): [QueryKey, unknown] => [key, qc.getQueryData(key)]);
      applyOptimistic(qc, req);
      try {
        await mutateAsync({ req, before });
      } catch {
        /* reported and put back by onError */
      }
    },
    [qc, mutateAsync],
  );
}
