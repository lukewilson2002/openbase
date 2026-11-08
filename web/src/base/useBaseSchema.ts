import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";

/**
 * A folder with its collections, views and people, for the screens under `/base/:baseId` (a collection, a record
 * page). A folder that is gone or closed to the person is not asked for again. The menu tree is built from the
 * workspaces list, which is fetched beside it rather than after it.
 */
export function useBaseSchema(baseId: string) {
  const base = useQuery({
    queryKey: keys.base(baseId),
    queryFn: () => api.bases.get(baseId),
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 2,
  });
  useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  return base;
}
