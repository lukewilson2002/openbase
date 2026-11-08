/**
 * `/workspace/:workspaceId/collections`: the phone's Collections tab, a screen holding what the desktop
 * sidebar holds (NAV-7), kept live by the workspace's event stream (BE-9). A desktop has the sidebar beside every
 * screen, so it goes to Home instead.
 */
import { Navigate, useParams } from "react-router";
import { useMediaQuery, DESKTOP_QUERY } from "@/hooks/useMediaQuery";
import { useWorkspaceEvents } from "@/hooks/useWorkspaceEvents";
import { HomeShell } from "@/shell/HomeShell";
import { SidebarContent } from "@/shell/SidebarContent";
import { useWorkspace } from "./useWorkspace";

export function CollectionsPage() {
  const { workspaceId = "" } = useParams();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { ws, fallback } = useWorkspace(workspaceId);
  // Not on a desktop, which redirects: its sidebar is live through the open folder's stream.
  useWorkspaceEvents(desktop ? undefined : workspaceId);
  if (desktop) return <Navigate to={`/workspace/${workspaceId}`} replace />;
  return (
    <HomeShell workspaceId={workspaceId} title="Collections" variant="tab">
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
