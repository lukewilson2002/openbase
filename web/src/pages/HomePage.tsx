import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, FolderOpen, Pencil, Plus, Shapes, Trash2, Users } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconPicker, IconPickerDialog } from "@/components/icons/IconPicker";
import { iconPatch } from "@/components/icons/iconPatch";
import { SharingDialog } from "@/components/LazySharingDialog";
import { DeletedWorkspaces } from "@/components/trash/DeletedWorkspaces";
import { AppPage, Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PageSpinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/api/client";
import { ROLE_LABELS, atLeast, isRole } from "@/lib/roles";

type HomeDialog =
  | { kind: "create-workspace" }
  | { kind: "rename-workspace"; ws: WorkspaceSummary }
  | { kind: "icon-workspace"; ws: WorkspaceSummary }
  | { kind: "icon-base"; base: BaseSummary }
  | { kind: "delete-workspace"; ws: WorkspaceSummary }
  | { kind: "members"; ws: WorkspaceSummary }
  | { kind: "create-base"; ws: WorkspaceSummary }
  | { kind: "edit-base"; base: BaseSummary }
  | { kind: "delete-base"; base: BaseSummary };

const BASE_COLORS_DEFAULT = "blue_dark";

export function HomePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const [dialog, setDialog] = useState<HomeDialog | null>(null);
  const [baseColor, setBaseColor] = useState<string>(BASE_COLORS_DEFAULT);
  const close = () => setDialog(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.workspaces });

  const createWorkspace = useMutation({ mutationFn: (v: { name: string; icon: string | null }) => api.workspaces.create(v.name, v.icon), onSuccess: refresh });
  const updateWorkspace = useMutation({
    mutationFn: (v: { id: string; name?: string; icon?: string | null }) => api.workspaces.update(v.id, { name: v.name, icon: v.icon }),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not update workspace"),
  });
  const deleteWorkspace = useMutation({ mutationFn: (id: string) => api.workspaces.remove(id), onSuccess: refresh });
  const createBase = useMutation({
    mutationFn: (v: { wsId: string; name: string; color: string; icon: string | null }) => api.bases.create(v.wsId, { name: v.name, color: v.color, icon: v.icon ?? undefined }),
    onSuccess: (base) => {
      void refresh();
      if (base?.id) navigate(`/base/${base.id}`);
    },
  });
  const updateBase = useMutation({
    mutationFn: (v: { id: string; name?: string; color?: string; icon?: string | null }) => api.bases.update(v.id, { name: v.name, color: v.color, icon: v.icon }),
    onSuccess: refresh,
    onError: (e) => toast.error(e, "Could not update base"),
  });
  const deleteBase = useMutation({ mutationFn: (id: string) => api.bases.remove(id), onSuccess: refresh });
  const duplicateBase = useMutation({
    mutationFn: (b: BaseSummary) => api.bases.duplicate(b.id, { name: `${b.name} copy`, include_records: true }),
    onSuccess: () => {
      toast.toast({ title: "Base duplicated", variant: "success" });
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not duplicate base"),
  });

  return (
    <AppPage
      wide
      title="Your workspaces"
      actions={
        <Button variant="primary" onClick={() => setDialog({ kind: "create-workspace" })}>
          <Plus aria-hidden className="size-4" /> New workspace
        </Button>
      }
    >
      {workspaces.isPending ? (
        <PageSpinner label="Loading workspaces" />
      ) : workspaces.isError ? (
        <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
      ) : workspaces.data.length === 0 ? (
        <EmptyState
          icon={<FolderOpen />}
          title="No workspaces yet"
          description="A workspace holds your bases and the people who can work in them. Create one to get started."
          action={
            <Button variant="primary" onClick={() => setDialog({ kind: "create-workspace" })}>
              <Plus aria-hidden className="size-4" /> Create a workspace
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {workspaces.data.map((ws) => (
            <WorkspaceSection
              key={ws.id}
              ws={ws}
              onAction={(d) => {
                if (d.kind === "edit-base") setBaseColor(d.base.color);
                else if (d.kind === "create-base") setBaseColor(BASE_COLORS_DEFAULT);
                setDialog(d);
              }}
              onDuplicate={(b) => duplicateBase.mutate(b)}
              onWorkspaceIcon={(ws, icon) => updateWorkspace.mutate({ id: ws.id, icon })}
            />
          ))}
        </div>
      )}
      {!workspaces.isPending && <DeletedWorkspaces />}

      <NameDialog
        open={dialog?.kind === "create-workspace"}
        onOpenChange={(o) => !o && close()}
        title="New workspace"
        submitLabel="Create workspace"
        withIcon
        onSubmit={(name, icon) => createWorkspace.mutateAsync({ name, icon })}
      />
      <NameDialog
        open={dialog?.kind === "rename-workspace"}
        onOpenChange={(o) => !o && close()}
        title="Rename workspace"
        initialValue={dialog?.kind === "rename-workspace" ? dialog.ws.name : ""}
        withIcon
        initialIcon={dialog?.kind === "rename-workspace" ? (dialog.ws.icon ?? null) : null}
        onSubmit={(name, icon) => (dialog?.kind === "rename-workspace" ? updateWorkspace.mutateAsync({ id: dialog.ws.id, name, ...iconPatch(dialog.ws.icon, icon) }) : undefined)}
      />
      <IconPickerDialog
        open={dialog?.kind === "icon-workspace"}
        onOpenChange={(o) => !o && close()}
        title="Workspace icon"
        value={dialog?.kind === "icon-workspace" ? dialog.ws.icon : null}
        onChange={(icon) => dialog?.kind === "icon-workspace" && updateWorkspace.mutate({ id: dialog.ws.id, icon })}
      />
      <IconPickerDialog
        open={dialog?.kind === "icon-base"}
        onOpenChange={(o) => !o && close()}
        title="Base icon"
        value={dialog?.kind === "icon-base" ? dialog.base.icon : null}
        onChange={(icon) => dialog?.kind === "icon-base" && updateBase.mutate({ id: dialog.base.id, icon })}
      />
      <NameDialog
        open={dialog?.kind === "create-base" || dialog?.kind === "edit-base"}
        onOpenChange={(o) => !o && close()}
        title={dialog?.kind === "edit-base" ? "Edit base" : "New base"}
        submitLabel={dialog?.kind === "edit-base" ? "Save" : "Create base"}
        initialValue={dialog?.kind === "edit-base" ? dialog.base.name : ""}
        withIcon
        initialIcon={dialog?.kind === "edit-base" ? (dialog.base.icon ?? null) : null}
        extra={
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">Colour</span>
            <ColorSwatchPicker value={baseColor} onChange={setBaseColor} />
          </div>
        }
        onSubmit={(name, icon) => {
          if (dialog?.kind === "edit-base") return updateBase.mutateAsync({ id: dialog.base.id, name, color: baseColor, ...iconPatch(dialog.base.icon, icon) });
          if (dialog?.kind === "create-base") return createBase.mutateAsync({ wsId: dialog.ws.id, name, color: baseColor, icon });
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-workspace"}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${dialog?.kind === "delete-workspace" ? dialog.ws.name : "workspace"}?`}
        description="The workspace and all of its bases move to the trash. Restore it from “Recently deleted workspaces” on this page for 30 days."
        confirmLabel="Delete workspace"
        destructive
        onConfirm={() => (dialog?.kind === "delete-workspace" ? deleteWorkspace.mutateAsync(dialog.ws.id) : undefined)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-base"}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${dialog?.kind === "delete-base" ? dialog.base.name : "base"}?`}
        description="The base moves to the trash and can be restored for 30 days."
        confirmLabel="Delete base"
        destructive
        onConfirm={() => (dialog?.kind === "delete-base" ? deleteBase.mutateAsync(dialog.base.id) : undefined)}
      />
      {dialog?.kind === "members" && (
        <SharingDialog open onOpenChange={(o) => !o && close()} scope={{ kind: "workspace", id: dialog.ws.id, name: dialog.ws.name, icon: dialog.ws.icon }} myRole={dialog.ws.role} />
      )}
    </AppPage>
  );
}

function WorkspaceSection({
  ws,
  onAction,
  onDuplicate,
  onWorkspaceIcon,
}: {
  ws: WorkspaceSummary;
  onAction: (d: HomeDialog) => void;
  onDuplicate: (b: BaseSummary) => void;
  onWorkspaceIcon: (ws: WorkspaceSummary, icon: string | null) => void;
}) {
  const isOwner = atLeast(ws.role, "owner");
  const canCreateBase = atLeast(ws.role, "creator");
  const wsRole = isRole(ws.role) ? ws.role : null;

  return (
    <section aria-labelledby={`ws-${ws.id}`}>
      <div className="mb-3 flex items-center gap-2">
        {isOwner ? (
          <IconPicker value={ws.icon} onChange={(icon) => onWorkspaceIcon(ws, icon)}>
            <button type="button" aria-label={`Change icon of ${ws.name}`} title="Change icon" className="shrink-0 rounded-md hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring">
              <EntityTile name={ws.name} icon={ws.icon} size="md" />
            </button>
          </IconPicker>
        ) : (
          <EntityTile name={ws.name} icon={ws.icon} size="md" />
        )}
        <h2 id={`ws-${ws.id}`} className="min-w-0 truncate text-[0.9375rem]">
          {ws.name}
        </h2>
        {wsRole && <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">{ROLE_LABELS[wsRole]}</span>}
        <div className="flex-1" />
        {canCreateBase && (
          <Button size="sm" onClick={() => onAction({ kind: "create-base", ws })}>
            <Plus aria-hidden className="size-3.5" /> New base
          </Button>
        )}
        {wsRole && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Workspace actions for ${ws.name}`} size="sm" noTooltip>
                <Ellipsis aria-hidden className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => onAction({ kind: "members", ws })}>
                <Users aria-hidden className="size-4" /> {isOwner ? "Members and invites" : "Members"}
              </DropdownMenuItem>
              {isOwner && (
                <>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "rename-workspace", ws })}>
                    <Pencil aria-hidden className="size-4" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction({ kind: "icon-workspace", ws })}>
                    <Shapes aria-hidden className="size-4" /> Change icon…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => onAction({ kind: "delete-workspace", ws })}>
                    <Trash2 aria-hidden className="size-4" /> Delete workspace
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {ws.bases.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[0.8125rem] text-muted">
          {canCreateBase ? "No bases yet. Create one to start organising your data." : "No bases in this workspace yet."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ws.bases.map((b) => (
            <BaseCard key={b.id} base={b} onAction={onAction} onDuplicate={onDuplicate} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BaseCard({ base, onAction, onDuplicate }: { base: BaseSummary; onAction: (d: HomeDialog) => void; onDuplicate: (b: BaseSummary) => void }) {
  const canEdit = atLeast(base.role, "creator");
  const canDelete = atLeast(base.role, "owner");
  return (
    <li className="group relative flex items-center gap-3 rounded-lg border border-line bg-surface p-3 transition-shadow focus-within:shadow-pop hover:shadow-pop">
      <EntityTile name={base.name} icon={base.icon} color={base.color} size="lg" />
      <div className="min-w-0 flex-1">
        <Link to={`/base/${base.id}`} className="block truncate font-medium text-fg no-underline after:absolute after:inset-0 after:content-['']">
          {base.name}
        </Link>
        <p className="text-xs text-muted">{isRole(base.role) ? ROLE_LABELS[base.role] : base.role}</p>
      </div>
      {(canEdit || canDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`Actions for ${base.name}`} size="sm" noTooltip className="relative z-10">
              <Ellipsis aria-hidden className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {canEdit && (
              <>
                <DropdownMenuItem onSelect={() => onAction({ kind: "edit-base", base })}>
                  <Pencil aria-hidden className="size-4" /> Rename or recolour
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction({ kind: "icon-base", base })}>
                  <Shapes aria-hidden className="size-4" /> Change icon…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDuplicate(base)}>
                  <Copy aria-hidden className="size-4" /> Duplicate
                </DropdownMenuItem>
              </>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger onSelect={() => onAction({ kind: "delete-base", base })}>
                  <Trash2 aria-hidden className="size-4" /> Delete base
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}
