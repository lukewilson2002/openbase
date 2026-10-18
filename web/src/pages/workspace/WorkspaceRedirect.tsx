/**
 * `/workspace/:workspaceId`: the workspace has no page of its own any more. It opens the project
 * last opened in it (else its first), where the person left off. A workspace without projects shows
 * what to do about that: make one, or import a spreadsheet.
 */
import { Navigate, useParams } from "react-router";
import { FileDown, FolderPlus, Plus } from "lucide-react";
import type { WorkspaceSummary } from "@/api/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { projectPath, projectToOpen } from "@/lib/lastPlace";
import { atLeast } from "@/lib/roles";
import { HomeShell } from "@/shell/HomeShell";
import { useNavDialog } from "@/shell/NavDialogs";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceRedirect() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  const project = ws ? projectToOpen(ws) : undefined;
  if (project) return <Navigate to={projectPath(project)} replace />;
  return <HomeShell workspaceId={workspaceId}>{ws ? <NoProjects ws={ws} /> : fallback}</HomeShell>;
}

function NoProjects({ ws }: { ws: WorkspaceSummary }) {
  const openDialog = useNavDialog();
  const canCreate = atLeast(ws.role, "creator");
  return (
    <EmptyState
      icon={<FolderPlus />}
      title={`No projects in ${ws.name} yet`}
      description={canCreate ? "A project holds your tables. Start empty, or bring in a spreadsheet you already have." : "When someone adds a project you can open, it shows up in the menu."}
      action={
        canCreate && (
          <div className="flex flex-wrap justify-center gap-2.5">
            <Button variant="primary" size="lg" className="h-11 rounded-[10px] px-[18px] font-semibold" onClick={() => openDialog({ kind: "create-project", workspaceId: ws.id })}>
              <Plus aria-hidden className="size-4" strokeWidth={2.2} /> New project
            </Button>
            <Button size="lg" className="h-11 rounded-[10px] px-[18px] font-semibold" onClick={() => openDialog({ kind: "import-project", workspaceId: ws.id })}>
              <FileDown aria-hidden className="size-4" /> Import a spreadsheet
            </Button>
          </div>
        )
      }
      className="py-20"
    />
  );
}
