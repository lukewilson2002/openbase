/**
 * `/workspace/:workspaceId/collections`: the phone's Collections tab, a screen holding what the desktop
 * menu holds (NAV-7). A desktop has the menu beside every screen, so it goes to Home instead.
 */
import { Navigate, useParams } from "react-router";
import { useMediaQuery, DESKTOP_QUERY } from "@/hooks/useMediaQuery";
import { HomeShell } from "@/shell/HomeShell";
import { NavGlobalLinks, NavTree } from "@/shell/NavTree";
import { useWorkspace } from "./useWorkspace";

export function CollectionsPage() {
  const { workspaceId = "" } = useParams();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { ws, fallback } = useWorkspace(workspaceId);
  if (desktop) return <Navigate to={`/workspace/${workspaceId}`} replace />;
  return (
    <HomeShell workspaceId={workspaceId} title="Collections">
      {ws ? (
        <div className="flex flex-col gap-4 px-3 py-3">
          <NavTree workspaceId={ws.id} />
          <nav aria-label="History and trash" className="flex flex-col gap-0.5 border-t border-line pt-2">
            <NavGlobalLinks page={null} />
          </nav>
        </div>
      ) : (
        fallback
      )}
    </HomeShell>
  );
}
