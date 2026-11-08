/**
 * `/workspace/:workspaceId/collections`: the phone's Collections tab, a screen holding what the desktop
 * sidebar holds (NAV-7). A desktop has the sidebar beside every screen, so it goes to Home instead.
 */
import { Navigate, useParams } from "react-router";
import { useMediaQuery, DESKTOP_QUERY } from "@/hooks/useMediaQuery";
import { HomeShell } from "@/shell/HomeShell";
import { SidebarContent } from "@/shell/SidebarContent";
import { useWorkspace } from "./useWorkspace";

export function CollectionsPage() {
  const { workspaceId = "" } = useParams();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { ws, fallback } = useWorkspace(workspaceId);
  if (desktop) return <Navigate to={`/workspace/${workspaceId}`} replace />;
  return (
    <HomeShell workspaceId={workspaceId} title="Collections">
      {ws ? (
        <nav aria-label="Workspace menu">
          <SidebarContent mode="page" workspaceId={ws.id} />
        </nav>
      ) : (
        fallback
      )}
    </HomeShell>
  );
}
