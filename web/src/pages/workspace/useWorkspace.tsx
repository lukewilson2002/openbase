import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { Notice } from "@/components/layouts";
import { ErrorState } from "@/components/ErrorState";
import { PageSpinner } from "@/components/ui/spinner";
import { readLastWorkspace, rememberWorkspace } from "./lastWorkspace";

/**
 * The workspace of a `/workspace/:id` page, from the workspaces list (which also feeds the menu),
 * or the element to show instead while it loads, fails, or is not one of the person's.
 */
export function useWorkspace(workspaceId: string | undefined): { ws: WorkspaceSummary | null; fallback: ReactNode } {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const ws = workspaces.data?.find((w) => w.id === workspaceId) ?? null;
  const missing = workspaces.isSuccess && !ws;

  useEffect(() => {
    if (ws) rememberWorkspace(ws.id);
    // A deleted or left workspace must not keep sending `/` to a "not found" page.
    else if (missing && readLastWorkspace() === workspaceId) rememberWorkspace(null);
  }, [ws, missing, workspaceId]);

  if (ws) return { ws, fallback: null };
  if (workspaces.isPending) return { ws: null, fallback: <PageSpinner label="Loading workspace" /> };
  if (workspaces.isError)
    return {
      ws: null,
      fallback: (
        <div className="p-6">
          <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
        </div>
      ),
    };
  return {
    ws: null,
    fallback: (
      <ErrorState title="Workspace not found" happened="It was deleted, or you are no longer a member." todo="Go to Home to open one of your workspaces." className="py-20" />
    ),
  };
}
