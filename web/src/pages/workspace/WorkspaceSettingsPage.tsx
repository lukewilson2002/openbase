import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { WorkspaceSummary } from "@/api/types";
import { Notice, Section, SettingsRow } from "@/components/layouts";
import { daysText, useTrashDays } from "@/components/trash/retention";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { useToast } from "@/components/ui/toast";
import { colorLabel } from "@/lib/colors";
import { atLeast } from "@/lib/roles";
import { topLevelOf } from "@/lib/topLevel";
import { workspaceColor } from "@/lib/workspaceColor";
import { AppPage } from "@/shell/AppPage";
import { WorkspaceDialogs, type WorkspaceDialog } from "./WorkspaceDialogs";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceSettingsPage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <AppPage workspaceId={workspaceId} title="Workspace settings">
      {ws ? <Settings key={ws.id} ws={ws} /> : fallback}
    </AppPage>
  );
}

function Settings({ ws }: { ws: WorkspaceSummary }) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const trashDays = useTrashDays();
  if (!atLeast(ws.role, "owner")) return <Notice>Only owners can rename, change or delete a workspace.</Notice>;
  const color = workspaceColor(ws);
  return (
    <div className="flex flex-col gap-6">
      <Section title="Workspace" flush>
        <ul className="divide-y divide-line">
          <SettingsRow
            title="Name"
            description={ws.name}
            action={<Button onClick={() => setDialog("rename")}>Rename</Button>}
          />
          <SettingsRow
            title="Color"
            leading={<ColorMark hue={ws.color} name={ws.name} size={24} />}
            description={colorLabel(color)}
            action={<Button onClick={() => setDialog("color")}>Change color…</Button>}
          />
        </ul>
      </Section>

      <TopLevel ws={ws} />

      <Section title="Delete workspace" danger>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 basis-48 text-label text-muted">
            The workspace and all of its folders move to the trash for {daysText(trashDays)}. Restore them from Trash until then.
          </p>
          <Button variant="danger" onClick={() => setDialog("delete")}>
            Delete workspace
          </Button>
        </div>
      </Section>
      <WorkspaceDialogs ws={ws} open={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

/**
 * Which folder is the top level (APP-12): the one whose collections show directly under the workspace. Owners see
 * every folder, so each can be made the top level; only the pointer moves, nothing is copied.
 */
function TopLevel({ ws }: { ws: WorkspaceSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const top = topLevelOf(ws);
  const choose = useMutation({
    mutationFn: (baseId: string) => api.workspaces.setTopLevel(ws.id, baseId),
    onSuccess: (_, baseId) => {
      void qc.invalidateQueries({ queryKey: keys.workspaces });
      const name = ws.bases.find((b) => b.id === baseId)?.name ?? "The folder";
      toast.toast({ title: `${name} is now the top level`, variant: "success" });
    },
    onError: (e) => toast.error(e, "Could not change the top level"),
  });
  return (
    <Section flush title="Top level" description="The collections of the top level show directly under the workspace. Every other folder is listed as a folder.">
      <ul className="divide-y divide-line">
        {ws.bases.map((b) => {
          const current = b.id === top?.id;
          return (
            <SettingsRow
              key={b.id}
              leading={<ColorMark hue={b.color} name={b.name} size={14} />}
              title={b.name}
              description={current ? "Top level now" : undefined}
              action={
                current ? undefined : (
                  <Button aria-label={`Use as top level: ${b.name}`} loading={choose.isPending && choose.variables === b.id} disabled={choose.isPending} onClick={() => choose.mutate(b.id)}>
                    Use as top level
                  </Button>
                )
              }
            />
          );
        })}
      </ul>
    </Section>
  );
}
