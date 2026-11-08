/**
 * The saved views of every folder of a workspace the person can open (REC-6: a View embed shows "any saved view
 * in this workspace"). The folder at hand is already loaded; the others are asked for one by one (the same
 * `GET /api/bases/{id}` the app uses, so what comes back is what this person may see, personal views of others
 * left out) and only once `enabled`, so a page without a View block costs nothing.
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, Table, View } from "@/api/types";

export interface FoundView {
  view: View;
  table: Table;
  /** The folder it is in, whole: its other collections give the formats of linked values. */
  schema: BaseSchema;
}

export interface WorkspaceViews {
  /** Every view found so far, the current folder's first. */
  views: FoundView[];
  /** Folders are still being asked for. */
  loading: boolean;
}

/** Every view of a folder, with the collection and the folder it is in. */
export function viewsOf(schema: BaseSchema): FoundView[] {
  return schema.tables.flatMap((table) => table.views.map((view) => ({ view, table, schema })));
}

export function useWorkspaceViews(current: BaseSchema, enabled: boolean): WorkspaceViews {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled });
  const others = useMemo(
    () => (workspaces.data?.find((w) => w.id === current.workspace_id)?.bases ?? []).filter((b) => b.id !== current.id),
    [workspaces.data, current.workspace_id, current.id],
  );
  const loaded = useQueries({
    queries: others.map((b) => ({
      queryKey: keys.base(b.id),
      queryFn: () => api.bases.get(b.id),
      enabled,
      // A folder that closed meanwhile is not asked for again.
      retry: (count: number, err: unknown) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 2,
      staleTime: 30_000,
    })),
    combine: (results) => ({ schemas: results.flatMap((r) => (r.data ? [r.data] : [])), pending: results.some((r) => r.isPending && r.fetchStatus !== "idle") }),
  });
  const views = useMemo(() => [...viewsOf(current), ...loaded.schemas.flatMap(viewsOf)], [current, loaded.schemas]);
  return { views, loading: enabled && (workspaces.isPending || loaded.pending) };
}
