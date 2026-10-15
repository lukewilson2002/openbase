/**
 * The base's parts of the app's top bar. On a desktop: `Household ⌄ / Chores ⌄` (switch workspace;
 * switch base, back to the workspace home, and the base's own name and icon) at the start, then who
 * can open the base and Share. On a phone: the base's tile with the workspace's name over its own,
 * opening one picker for both, then the faces and a Share icon; the drawer repeats the two pickers.
 * Share is for creators and owners: inviting and sharing a view both need that role, so below it
 * the dialog would hold nothing to do.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Home, Pencil, Plus, Shapes, Share2 } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSchema, WorkspaceSummary } from "@/api/types";
import { NameDialog } from "@/components/NameDialog";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SplitMenu } from "@/components/ui/split-menu";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { BaseAvatars } from "@/shell/BaseAvatars";
import { useCreateWorkspace } from "@/shell/useCreateWorkspace";
import { WorkspacePicker, placeItemClass } from "@/shell/WorkspacePicker";
import type { BaseDialog } from "./BaseDialogs";
import { basePermissions } from "./permissions";

/** The base's workspace from the workspaces list (for its colour and its other bases), if loaded. */
function useBaseWorkspace(schema: BaseSchema): { ws: WorkspaceSummary | undefined; all: WorkspaceSummary[] } {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const all = workspaces.data ?? [];
  return { ws: all.find((w) => w.id === schema.workspace_id), all };
}

/** The workspace as a tile can draw it, before and after the workspaces list arrives. */
function workspaceLike(schema: BaseSchema, ws: WorkspaceSummary | undefined) {
  return ws ?? { name: schema.workspace_name };
}

/** `Household ⌄ / Chores ⌄`: the desktop top bar's start, in place of the logo. */
export function BasePlaces({ schema, onDialog, compact = false }: { schema: BaseSchema; onDialog: (d: BaseDialog) => void; compact?: boolean }) {
  const { ws } = useBaseWorkspace(schema);
  const wsTile = workspaceLike(schema, ws);
  return (
    <div className={cn("flex min-w-0 items-center", compact ? "flex-1 gap-0.5" : "-ml-1.5 gap-2")}>
      <WorkspacePicker
        currentId={schema.workspace_id}
        trigger={
          <button
            type="button"
            aria-label={`Workspace: ${schema.workspace_name}. Switch workspace`}
            className={cn(
              "flex min-w-0 shrink items-center gap-1 rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover",
              compact ? "min-h-11 px-1 text-[0.9375rem]" : "h-9 px-2 text-[0.875rem] font-medium",
            )}
          >
            <WorkspaceTile ws={wsTile} size="xs" className="mr-1" />
            <span className="min-w-0 truncate">{schema.workspace_name}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
          </button>
        }
      />
      <span aria-hidden className="shrink-0 text-lg text-line-strong">
        /
      </span>
      <BaseMenu
        schema={schema}
        onDialog={onDialog}
        trigger={
          // Named by the base's name alone: on a desktop it is the page's heading.
          <button
            type="button"
            title="Switch base"
            className={cn(
              "flex min-w-0 items-center rounded-lg text-left font-bold text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover",
              compact ? "min-h-11 flex-1 gap-1.5 px-1 text-[0.9375rem]" : "h-10 gap-2 pl-1.5 pr-2 text-base",
            )}
          >
            <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size={compact ? "xs" : "md"} className={compact ? undefined : "size-7 rounded-[7px]"} />
            <span className="min-w-0 truncate">{schema.name}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
          </button>
        }
        heading={!compact}
      />
    </div>
  );
}

/**
 * The base picker: back to the workspace home, the workspace's bases (this one checked), a new
 * base, and the base's own name and icon for those who may change them.
 */
function BaseMenu({ schema, onDialog, trigger, heading }: { schema: BaseSchema; onDialog: (d: BaseDialog) => void; trigger: React.ReactNode; heading: boolean }) {
  const { ws } = useBaseWorkspace(schema);
  const bases = ws?.bases ?? [{ id: schema.id, name: schema.name, icon: schema.icon, color: schema.color }];
  const canEdit = basePermissions.editBase(schema.role);
  const canCreate = atLeast(ws?.role ?? schema.role, "creator");
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} aria-label={`Bases in ${schema.workspace_name}`} aria-labelledby={undefined} className="w-60 rounded-xl p-1.5">
        <DropdownMenuItem asChild className={placeItemClass}>
          <Link to={`/workspace/${schema.workspace_id}`}>
            <Home aria-hidden className="size-4 text-muted" /> Workspace home
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-1 my-1.5" />
        {bases.map((b) => {
          const on = b.id === schema.id;
          return (
            <DropdownMenuItem key={b.id} asChild role="menuitemradio" aria-checked={on} className={cn(placeItemClass, on && "font-semibold")}>
              <Link to={`/base/${b.id}`}>
                <EntityTile name={b.name} icon={b.icon} color={b.color} size="sm" />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {on && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {(canCreate || canEdit) && <DropdownMenuSeparator className="mx-1 my-1.5" />}
        {canCreate && (
          <DropdownMenuItem onSelect={() => onDialog({ kind: "create-base", workspaceId: schema.workspace_id })} className={cn(placeItemClass, "text-muted")}>
            <Plus aria-hidden className="size-4" /> New base
          </DropdownMenuItem>
        )}
        {canEdit && (
          <>
            <DropdownMenuItem onSelect={() => onDialog({ kind: "rename-base" })} className={cn(placeItemClass, "text-muted")}>
              <Pencil aria-hidden className="size-4" /> Rename base
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDialog({ kind: "base-icon" })} className={cn(placeItemClass, "text-muted")}>
              <Shapes aria-hidden className="size-4" /> Change icon
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // The base's name is the page's heading; the drawer repeats the picker without a second one.
  return heading ? <h1 className="min-w-0 text-base">{menu}</h1> : menu;
}

/** The rest of the top bar: on a phone the base's title (and picker), then faces and Share. */
export function BaseTopBar({ schema, onShare, onDialog, desktop }: { schema: BaseSchema; onShare: () => void; onDialog: (d: BaseDialog) => void; desktop: boolean }) {
  const canShare = basePermissions.manageSharing(schema.role);
  return (
    <>
      {desktop ? <div className="flex-1" /> : <PhoneBaseTitle schema={schema} onDialog={onDialog} />}
      {/* Below 360 px the faces would leave the name no room at all; Members in the menu lists them. */}
      <Link to={`/workspace/${schema.workspace_id}/members`} className="shrink-0 rounded-full px-1 no-underline max-[359px]:hidden">
        <BaseAvatars people={schema.people} max={desktop ? 4 : 3} size={desktop ? "md" : "sm"} />
      </Link>
      {canShare &&
        (desktop ? (
          <Button onClick={onShare} className="h-[38px] shrink-0 gap-2 rounded-[10px] px-3.5 text-[0.875rem] font-semibold">
            <Share2 aria-hidden className="size-4" /> Share
          </Button>
        ) : (
          <button type="button" onClick={onShare} aria-label="Share" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-fg hover:bg-hover">
            <Share2 aria-hidden className="size-5" />
          </button>
        ))}
    </>
  );
}

/**
 * The phone's title: the base's tile, the workspace small over the base's name. It opens one
 * picker with the workspaces on the left and the picked one's bases on the right.
 */
function PhoneBaseTitle({ schema, onDialog }: { schema: BaseSchema; onDialog: (d: BaseDialog) => void }) {
  const { all } = useBaseWorkspace(schema);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const createWorkspace = useCreateWorkspace();
  const workspaces = all.length > 0 ? all : [{ id: schema.workspace_id, name: schema.workspace_name, role: schema.role, bases: [] as WorkspaceSummary["bases"] }];
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return (
    <h1 className="min-w-0 flex-1 text-[1.0625rem]">
      <SplitMenu
        label="Pick a workspace, then a base"
        groupsHeading="Workspaces"
        groups={workspaces.map((w) => ({ id: w.id, label: w.name, icon: <WorkspaceTile ws={w} size="sm" className="size-[22px]" /> }))}
        currentGroupId={schema.workspace_id}
        groupAction={{ label: "New workspace", icon: <Plus aria-hidden />, onSelect: () => setCreatingWorkspace(true) }}
        itemsHeading={(g) => `Bases in ${g.label}`}
        itemsTop={(g) => ({ label: "Workspace home", icon: <Home aria-hidden />, to: `/workspace/${g.id}` })}
        itemsFor={(id) =>
          (byId.get(id)?.bases.length ? byId.get(id)!.bases : id === schema.workspace_id ? [schema] : []).map((b) => ({
            id: b.id,
            label: b.name,
            icon: <EntityTile name={b.name} icon={b.icon} color={b.color} size="sm" />,
            to: `/base/${b.id}`,
            current: b.id === schema.id,
          }))
        }
        itemAction={(g) => (atLeast(byId.get(g.id)?.role ?? "", "creator") ? { label: "New base", icon: <Plus aria-hidden />, onSelect: () => onDialog({ kind: "create-base", workspaceId: g.id }) } : null)}
        className="w-[calc(100vw-1rem)]"
        trigger={
          <button
            type="button"
            aria-label={`${schema.workspace_name} workspace, ${schema.name} base. Switch workspace or base`}
            className="flex h-12 max-w-full items-center gap-2.5 rounded-[10px] pl-1 pr-2 text-left hover:bg-hover data-[state=open]:bg-hover"
          >
            <EntityTile name={schema.name} icon={schema.icon} color={schema.color} size="md" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-normal leading-tight text-muted">{schema.workspace_name}</span>
              <span className="truncate font-bold leading-tight">{schema.name}</span>
            </span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
          </button>
        }
      />
      <NameDialog open={creatingWorkspace} onOpenChange={setCreatingWorkspace} title="New workspace" submitLabel="Create workspace" withIcon onSubmit={(name, icon) => createWorkspace.mutateAsync({ name, icon })} />
    </h1>
  );
}
