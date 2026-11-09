import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, WorkspaceSummary } from "@/api/types";
import { atLeast } from "@/lib/roles";
import { collectionOptions, type CollectionOptions } from "./capture";

export interface Collections {
  schemas: ReadonlyMap<string, BaseSchema>;
  found: CollectionOptions;
  /** Folders that were asked for and have not answered. */
  loading: boolean;
}

/**
 * The collections of a workspace a record can be added to. A collection's title type is in its folder's schema, so the folders
 * are fetched: every one when `all`, else only `needed` (the folder in use), which keeps Home from opening a request per folder.
 */
export function useCollections(workspace: WorkspaceSummary, needed: string | undefined, all: boolean): Collections {
  const editable = workspace.bases.filter((b) => atLeast(b.role, "editor") && b.tables.length > 0);
  const queries = useQueries({
    queries: editable.filter((b) => all || b.id === needed).map((b) => ({ queryKey: keys.base(b.id), queryFn: () => api.bases.get(b.id), staleTime: 60_000 })),
  });
  const schemas = useMemo(() => new Map(queries.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : []))), [queries]);
  const found = useMemo(() => collectionOptions(workspace, schemas), [workspace, schemas]);
  return { schemas, found, loading: queries.some((q) => q.isPending) };
}
