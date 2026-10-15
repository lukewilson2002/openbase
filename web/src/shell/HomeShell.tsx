/**
 * The shell with the home menu: the person's workspaces (the open one with its Bases, Members and
 * settings pages), Trash and Settings. Used by the workspace pages and by account and admin.
 */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings, Trash2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconButton } from "@/components/ui/icon-button";
import { atLeast } from "@/lib/roles";
import { AppShell } from "./AppShell";
import { SidebarLink, SidebarSection } from "./Sidebar";

export type WorkspaceSection = "bases" | "members" | "settings";

export interface HomeShellProps {
  /** The workspace the page belongs to: it is expanded in the menu. */
  workspaceId?: string;
  section?: WorkspaceSection;
  topBar?: ReactNode;
  children: ReactNode;
}

export function HomeShell({ workspaceId, section, topBar, children }: HomeShellProps) {
  return (
    <AppShell
      topBar={topBar}
      sidebar={<WorkspaceMenu workspaceId={workspaceId} section={section} />}
      sidebarFooter={
        <>
          <SidebarLink to="/trash" icon={<Trash2 />}>
            Trash
          </SidebarLink>
          <SidebarLink to="/account" icon={<Settings />}>
            Settings
          </SidebarLink>
        </>
      }
    >
      {children}
    </AppShell>
  );
}

/** Creates a workspace and opens it. */
export function useCreateWorkspace() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (v: { name: string; icon?: string | null }) => api.workspaces.create(v.name, v.icon),
    onSuccess: async (ws) => {
      // Seed the list so the new page finds its workspace without a round trip.
      qc.setQueryData<WorkspaceSummary[]>(keys.workspaces, (cur) => (cur && !cur.some((w) => w.id === ws.id) ? [...cur, ws] : cur));
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      await navigate(`/workspace/${ws.id}`);
    },
  });
}

function WorkspaceMenu({ workspaceId, section }: { workspaceId?: string; section?: WorkspaceSection }) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const [creating, setCreating] = useState(false);
  const create = useCreateWorkspace();

  return (
    <SidebarSection
      title="Workspaces"
      action={
        <IconButton label="New workspace" size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="size-4" />
        </IconButton>
      }
    >
      {(workspaces.data ?? []).map((ws) => {
        const open = ws.id === workspaceId;
        return (
          <div key={ws.id} className="flex flex-col gap-0.5">
            {/* The open workspace is expanded instead of highlighted: its sub-item says where you are. */}
            <SidebarLink to={`/workspace/${ws.id}`} active={false} className={open ? "font-semibold" : undefined} icon={<EntityTile name={ws.name} icon={ws.icon} size="sm" />}>
              {ws.name}
            </SidebarLink>
            {open && (
              <>
                <SidebarLink to={`/workspace/${ws.id}`} indent active={(section ?? "bases") === "bases"}>
                  Bases
                </SidebarLink>
                <SidebarLink to={`/workspace/${ws.id}/members`} indent active={section === "members"}>
                  Members
                </SidebarLink>
                {atLeast(ws.role, "owner") && (
                  <SidebarLink to={`/workspace/${ws.id}/settings`} indent active={section === "settings"}>
                    Workspace settings
                  </SidebarLink>
                )}
              </>
            )}
          </div>
        );
      })}
      {workspaces.isSuccess && workspaces.data.length === 0 && <p className="px-2 py-1 text-xs text-muted">No workspaces yet.</p>}
      <NameDialog open={creating} onOpenChange={setCreating} title="New workspace" submitLabel="Create workspace" withIcon onSubmit={(name, icon) => create.mutateAsync({ name, icon })} />
    </SidebarSection>
  );
}
