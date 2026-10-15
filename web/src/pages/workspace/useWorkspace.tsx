import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
      <EmptyState
        title="Workspace not found"
        description="It may have been deleted, or you are no longer a member."
        action={
          <Button asChild variant="primary">
            <Link to="/">Go home</Link>
          </Button>
        }
        className="py-20"
      />
    ),
  };
}

/** "3 members · 1 invite waiting", or "Only you". */
export function membersLine(ws: Pick<WorkspaceSummary, "member_count" | "pending_invite_count">): string {
  if (ws.member_count <= 1 && ws.pending_invite_count === 0) return "Only you";
  const members = `${ws.member_count} member${ws.member_count === 1 ? "" : "s"}`;
  if (ws.pending_invite_count === 0) return members;
  return `${members} · ${ws.pending_invite_count} invite${ws.pending_invite_count === 1 ? "" : "s"} waiting`;
}
