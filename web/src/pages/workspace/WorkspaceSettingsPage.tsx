import { useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { Pencil, Shapes, Trash2 } from "lucide-react";
import type { WorkspaceSummary } from "@/api/types";
import { EntityTile } from "@/components/icons/EntityIcon";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { atLeast } from "@/lib/roles";
import { HomeShell } from "@/shell/HomeShell";
import { WorkspaceDialogs, type WorkspaceDialog } from "./WorkspaceDialogs";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceSettingsPage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} section="settings">
      {ws ? <Settings key={ws.id} ws={ws} /> : fallback}
    </HomeShell>
  );
}

function Row({ title, description, action }: { title: string; description: ReactNode; action: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[0.8125rem] font-medium">{title}</p>
        <div className="text-[0.8125rem] text-muted">{description}</div>
      </div>
      {action}
    </li>
  );
}

function Settings({ ws }: { ws: WorkspaceSummary }) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const isOwner = atLeast(ws.role, "owner");
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 md:py-8">
      <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{ws.name}</p>
      <h1 className="mt-1 text-2xl">Workspace settings</h1>
      {!isOwner ? (
        <div className="mt-6">
          <Notice>Only owners can rename, change or delete a workspace.</Notice>
        </div>
      ) : (
        <>
          <ul className="mt-6 divide-y divide-line rounded-lg border border-line bg-surface">
            <Row
              title="Name"
              description={ws.name}
              action={
                <Button onClick={() => setDialog("rename")}>
                  <Pencil aria-hidden className="size-4" /> Rename
                </Button>
              }
            />
            <Row
              title="Icon"
              description={
                <span className="mt-1 inline-flex">
                  <EntityTile name={ws.name} icon={ws.icon} size="sm" />
                </span>
              }
              action={
                <Button onClick={() => setDialog("icon")}>
                  <Shapes aria-hidden className="size-4" /> Change icon…
                </Button>
              }
            />
          </ul>
          <ul className="mt-6 rounded-lg border border-danger/40 bg-surface">
            <Row
              title="Delete workspace"
              description="The workspace and all of its bases move to the trash for 30 days."
              action={
                <Button variant="danger" onClick={() => setDialog("delete")}>
                  <Trash2 aria-hidden className="size-4" /> Delete workspace
                </Button>
              }
            />
          </ul>
          <WorkspaceDialogs ws={ws} open={dialog} onClose={() => setDialog(null)} />
        </>
      )}
    </div>
  );
}
