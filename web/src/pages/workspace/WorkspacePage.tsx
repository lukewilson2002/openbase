/**
 * A workspace: its bases as cards (with who can open each), and the ways to add one (empty or from
 * a spreadsheet) and to invite people. On a phone the header shrinks into the top bar and the two
 * "add" buttons float at the bottom corners, within thumb reach.
 */
import { useState, type ComponentProps } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, Pencil, Plus, Shapes, Trash2, Upload, UserPlus } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { NewTableFromCsvDialog } from "@/components/csv/LazyCsvDialogs";
import { EntityTile } from "@/components/icons/EntityIcon";
import { IconPicker, IconPickerDialog } from "@/components/icons/IconPicker";
import { iconPatch } from "@/components/icons/iconPatch";
import { Button } from "@/components/ui/button";
import { ColorSwatchPicker } from "@/components/ui/color-swatch-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { DESKTOP_QUERY } from "@/shell/AppShell";
import { BaseAvatars, PendingFace } from "@/shell/BaseAvatars";
import { HomeShell } from "@/shell/HomeShell";
import { WorkspaceDialogs, useUpdateWorkspace, type WorkspaceDialog } from "./WorkspaceDialogs";
import { membersLine, useWorkspace } from "./useWorkspace";

const BASE_COLOR_DEFAULT = "blue_dark";

type BaseDialog = { kind: "create" } | { kind: "edit"; base: BaseSummary } | { kind: "icon"; base: BaseSummary } | { kind: "delete"; base: BaseSummary } | { kind: "import" } | { kind: "invite" };

export function WorkspacePage() {
  const { workspaceId } = useParams();
  const { ws, fallback } = useWorkspace(workspaceId);
  return (
    <HomeShell workspaceId={workspaceId} section="bases" topBar={ws && <PhoneTitle ws={ws} />}>
      {ws ? <Workspace key={ws.id} ws={ws} /> : fallback}
    </HomeShell>
  );
}

/** On a phone the workspace's name lives in the top bar; the page header is reduced to its actions. */
function PhoneTitle({ ws }: { ws: WorkspaceSummary }) {
  return (
    <span aria-hidden className="flex min-w-0 items-center gap-2 md:hidden">
      <EntityTile name={ws.name} icon={ws.icon} size="sm" />
      <span className="truncate text-[0.9375rem] font-semibold">{ws.name}</span>
    </span>
  );
}

function Workspace({ ws }: { ws: WorkspaceSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [dialog, setDialog] = useState<BaseDialog | null>(null);
  const [wsDialog, setWsDialog] = useState<WorkspaceDialog>(null);
  const [color, setColor] = useState(BASE_COLOR_DEFAULT);
  const isOwner = atLeast(ws.role, "owner");
  const canCreate = atLeast(ws.role, "creator");
  const refresh = () => qc.invalidateQueries({ queryKey: keys.workspaces });
  const close = () => setDialog(null);
  const updateWorkspace = useUpdateWorkspace();

  const createBase = useMutation({
    mutationFn: (v: { name: string; color?: string; icon?: string | null; empty: boolean }) =>
      api.bases.create(ws.id, { name: v.name, ...(v.color ? { color: v.color } : {}), ...(v.icon ? { icon: v.icon } : {}), empty: v.empty }),
    onSuccess: () => void refresh(),
  });
  const updateBase = useMutation({
    mutationFn: (v: { id: string; name?: string; color?: string; icon?: string | null }) => api.bases.update(v.id, { name: v.name, color: v.color, icon: v.icon }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e, "Could not update base"),
  });
  const deleteBase = useMutation({ mutationFn: (id: string) => api.bases.remove(id), onSuccess: () => void refresh() });
  const duplicateBase = useMutation({
    mutationFn: (b: BaseSummary) => api.bases.duplicate(b.id, { name: `${b.name} copy`, include_records: true }),
    onSuccess: () => {
      toast.toast({ title: "Base duplicated", variant: "success" });
      void refresh();
    },
    onError: (e) => toast.error(e, "Could not duplicate base"),
  });

  const newBase = () => {
    setColor(BASE_COLOR_DEFAULT);
    setDialog({ kind: "create" });
  };
  const importSheet = () => setDialog({ kind: "import" });
  const pending = ws.bases.some((b) => b.people.some((p) => p.pending));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-32 pt-4 sm:px-6 md:pb-10 md:pt-8">
      <header className="mb-5 flex items-center gap-3 md:mb-6">
        <span className="hidden md:block">
          {isOwner ? (
            <IconPicker value={ws.icon} onChange={(icon) => updateWorkspace.mutate({ id: ws.id, icon })}>
              <button type="button" aria-label={`Change icon of ${ws.name}`} title="Change icon" className="block rounded-lg hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring">
                <EntityTile name={ws.name} icon={ws.icon} size="lg" />
              </button>
            </IconPicker>
          ) : (
            <EntityTile name={ws.name} icon={ws.icon} size="lg" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl max-md:sr-only">{ws.name}</h1>
          <Link to={`/workspace/${ws.id}/members`} className="text-[0.8125rem] text-muted no-underline hover:text-fg hover:underline">
            {membersLine(ws)}
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isOwner && (
            <Button onClick={() => setDialog({ kind: "invite" })}>
              <UserPlus aria-hidden className="size-4" /> Invite
            </Button>
          )}
          {canCreate && desktop && (
            <>
              <Button onClick={importSheet}>
                <Upload aria-hidden className="size-4" /> Import a spreadsheet
              </Button>
              <Button variant="primary" onClick={newBase}>
                <Plus aria-hidden className="size-4" /> New base
              </Button>
            </>
          )}
          {isOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={`Workspace actions for ${ws.name}`} noTooltip>
                  <Ellipsis aria-hidden className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setWsDialog("rename")}>
                  <Pencil aria-hidden className="size-4" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setWsDialog("icon")}>
                  <Shapes aria-hidden className="size-4" /> Change icon…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger onSelect={() => setWsDialog("delete")}>
                  <Trash2 aria-hidden className="size-4" /> Delete workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {ws.bases.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-line-strong px-6 py-12 text-center">
          <h2 className="text-base">{canCreate ? "Make your first base" : "No bases here yet"}</h2>
          <p className="mx-auto mt-1 max-w-md text-[0.8125rem] text-muted">
            {canCreate ? "A base holds one project. Start empty, or bring in a spreadsheet you already have." : "When someone adds a base you can open, it shows up here."}
          </p>
          {canCreate && desktop && (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={newBase}>
                <Plus aria-hidden className="size-4" /> New base
              </Button>
              <Button onClick={importSheet}>
                <Upload aria-hidden className="size-4" /> Import a spreadsheet
              </Button>
            </div>
          )}
        </div>
      ) : (
        <ul aria-label="Bases" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ws.bases.map((b) => (
            <BaseCard key={b.id} base={b} onAction={(d) => {
                if (d.kind === "edit") setColor(d.base.color);
                setDialog(d);
              }} onDuplicate={(b) => duplicateBase.mutate(b)} />
          ))}
        </ul>
      )}
      {pending && (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted">
          <PendingFace /> A grey, dashed face is someone invited who has not joined yet.
        </p>
      )}

      {canCreate && !desktop && (
        <>
          <FloatingButton side="left" onClick={importSheet} aria-label="Import a spreadsheet">
            <Upload aria-hidden className="size-5" /> Import
          </FloatingButton>
          <FloatingButton side="right" primary onClick={newBase}>
            <Plus aria-hidden className="size-5" /> New base
          </FloatingButton>
        </>
      )}

      <NameDialog
        open={dialog?.kind === "create" || dialog?.kind === "edit"}
        onOpenChange={(o) => !o && close()}
        title={dialog?.kind === "edit" ? "Edit base" : "New base"}
        submitLabel={dialog?.kind === "edit" ? "Save" : "Create base"}
        initialValue={dialog?.kind === "edit" ? dialog.base.name : ""}
        withIcon
        initialIcon={dialog?.kind === "edit" ? (dialog.base.icon ?? null) : null}
        extra={
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">Colour</span>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>
        }
        onSubmit={async (name, icon) => {
          if (dialog?.kind === "edit") return updateBase.mutateAsync({ id: dialog.base.id, name, color, ...iconPatch(dialog.base.icon, icon) });
          const base = await createBase.mutateAsync({ name, color, icon, empty: true });
          await navigate(`/base/${base.id}`);
        }}
      />
      <IconPickerDialog
        open={dialog?.kind === "icon"}
        onOpenChange={(o) => !o && close()}
        title="Base icon"
        value={dialog?.kind === "icon" ? dialog.base.icon : null}
        onChange={(icon) => dialog?.kind === "icon" && updateBase.mutate({ id: dialog.base.id, icon })}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && close()}
        title={`Delete ${dialog?.kind === "delete" ? dialog.base.name : "base"}?`}
        description="The base moves to the trash and can be restored for 30 days."
        confirmLabel="Delete base"
        destructive
        onConfirm={() => (dialog?.kind === "delete" ? deleteBase.mutateAsync(dialog.base.id) : undefined)}
      />
      {dialog?.kind === "import" && (
        <NewTableFromCsvDialog
          open
          onOpenChange={(o) => !o && close()}
          createBase={async (name) => (await createBase.mutateAsync({ name, empty: true })).id}
        />
      )}
      {dialog?.kind === "invite" && <ShareDialog open onOpenChange={(o) => !o && close()} scope="workspace" workspace={ws} />}
      {isOwner && <WorkspaceDialogs ws={ws} open={wsDialog} onClose={() => setWsDialog(null)} />}
    </div>
  );
}

function FloatingButton({ side, primary, className, ...props }: { side: "left" | "right"; primary?: boolean } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 inline-flex h-[52px] items-center gap-2 rounded-full px-5 text-[0.9375rem] font-semibold shadow-pop transition-colors",
        side === "left" ? "left-[max(1rem,env(safe-area-inset-left))]" : "right-[max(1rem,env(safe-area-inset-right))]",
        primary ? "bg-primary text-primary-fg hover:bg-primary-hover" : "border border-line-strong bg-surface text-fg hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

function BaseCard({ base, onAction, onDuplicate }: { base: BaseSummary; onAction: (d: BaseDialog) => void; onDuplicate: (b: BaseSummary) => void }) {
  // Below 400 px the faces would squeeze the name into a sliver; fewer faces, more "+N".
  const roomy = useMediaQuery("(min-width: 400px)");
  const canEdit = atLeast(base.role, "creator");
  const canDelete = atLeast(base.role, "owner");
  return (
    <li className="relative grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 rounded-xl border border-line bg-surface p-3 transition-shadow focus-within:shadow-pop hover:shadow-pop md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-x-3 md:gap-y-4 md:p-4">
      <EntityTile name={base.name} icon={base.icon} color={base.color} size="lg" className="max-md:size-10" />
      <Link to={`/base/${base.id}`} className="block text-[0.9375rem] font-semibold text-fg no-underline after:absolute after:inset-0 after:rounded-xl after:content-[''] max-md:line-clamp-2 max-md:break-words md:truncate">
        {base.name}
      </Link>
      <BaseAvatars people={base.people} max={roomy ? 4 : 3} summary summaryClassName="hidden md:inline" className="justify-self-end md:col-span-3 md:row-start-2 md:justify-self-start" />
      {(canEdit || canDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`Actions for ${base.name}`} size="sm" noTooltip className="relative z-10 md:col-start-3 md:row-start-1">
              <Ellipsis aria-hidden className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {canEdit && (
              <>
                <DropdownMenuItem onSelect={() => onAction({ kind: "edit", base })}>
                  <Pencil aria-hidden className="size-4" /> Rename or recolour
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction({ kind: "icon", base })}>
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
                <DropdownMenuItem danger onSelect={() => onAction({ kind: "delete", base })}>
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
