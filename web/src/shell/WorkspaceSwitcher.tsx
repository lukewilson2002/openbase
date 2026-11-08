/**
 * The workspace switcher at the top of the sidebar (NAV-1, NAV-3, NAV-4, NAV-6): the open workspace's
 * color mark, its name and "Switch workspace". Its menu starts with the OpenBase mark (the app's brand is
 * not in the switcher itself), lists every workspace by mark and name with a check on the open one, then
 * New workspace, and ends with the actions on the open workspace.
 *
 * Everyone puts their own workspaces in their own order: drag a row, or Alt+Up and Alt+Down on the focused
 * one (it has no "…" menu to hold Move up and Move down).
 */
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronsUpDown, History, Palette, Pencil, Plus, Settings, Trash2, UserPlus, Users } from "lucide-react";
import type { WorkspaceSummary } from "@/api/types";
import { Logo } from "@/components/Logo";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { atLeast } from "@/lib/roles";
import { rememberWorkspace } from "@/pages/workspace/lastWorkspace";
import { useNavDialog } from "./NavDialogs";
import { LinkItem, MenuGroups } from "./NavRowMenu";
import { ReorderRoot, SortableGroup, SortableRow, useRowMove } from "./sortable";
import { useReorder } from "./useReorder";

export function WorkspaceSwitcher({ workspaces, current }: { workspaces: WorkspaceSummary[]; current: WorkspaceSummary | undefined }) {
  const navigate = useNavigate();
  const openDialog = useNavDialog();
  const reorder = useReorder();
  const isOwner = !!current && atLeast(current.role, "owner");

  const go = (id: string) => {
    rememberWorkspace(id);
    void navigate(`/workspace/${id}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover"
        >
          {current ? <ColorMark hue={current.color} name={current.name} size={26} /> : <span aria-hidden className="size-6.5 shrink-0 rounded-md border border-line-strong" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-semibold">{current?.name ?? "No workspace"}</span>
            <span className="block text-meta text-muted">Switch workspace</span>
          </span>
          <Icon icon={ChevronsUpDown} className="text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[max(var(--radix-dropdown-menu-trigger-width),17rem)]">
        {/* The brand (NAV-6) is decoration here, not a menu item: hidden from assistive technology, which hears the menu's own rows. */}
        <div aria-hidden data-testid="brand" className="px-2.5 pb-1 pt-0.5">
          <Logo className="h-8" />
        </div>
        <DropdownMenuSeparator />
        <ReorderRoot>
          <SortableGroup group="workspaces" items={workspaces} idOf={(w) => w.id} enabled onReorder={(ids) => reorder({ kind: "workspaces", ids })}>
            {(list) => (
              <DropdownMenuRadioGroup value={current?.id ?? ""} onValueChange={go} aria-label="Workspaces">
                {list.map((w) => (
                  <SortableRow key={w.id} as="div" id={w.id} label={w.name} rowClassName="flex" row={<WorkspaceOption ws={w} />} />
                ))}
              </DropdownMenuRadioGroup>
            )}
          </SortableGroup>
        </ReorderRoot>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "create-workspace" })}>
          <Icon icon={Plus} /> New workspace
        </DropdownMenuItem>
        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{current.name}</DropdownMenuLabel>
            <MenuGroups
              groups={[
                [
                  isOwner && (
                    <DropdownMenuItem key="rename" onSelect={() => openDialog({ kind: "workspace", ws: current, dialog: "rename" })}>
                      <Icon icon={Pencil} /> Rename
                    </DropdownMenuItem>
                  ),
                  isOwner && (
                    <DropdownMenuItem key="color" onSelect={() => openDialog({ kind: "workspace", ws: current, dialog: "color" })}>
                      <Icon icon={Palette} /> Color
                    </DropdownMenuItem>
                  ),
                  <LinkItem key="members" to={`/workspace/${current.id}/members`} icon={<Icon icon={Users} />}>
                    Members
                  </LinkItem>,
                  isOwner && (
                    <DropdownMenuItem key="invite" onSelect={() => openDialog({ kind: "invite", ws: current })}>
                      <Icon icon={UserPlus} /> Invite people
                    </DropdownMenuItem>
                  ),
                  isOwner && (
                    <LinkItem key="settings" to={`/workspace/${current.id}/settings`} icon={<Icon icon={Settings} />}>
                      Settings
                    </LinkItem>
                  ),
                  <LinkItem key="history" to={`/history?workspace=${encodeURIComponent(current.id)}`} icon={<Icon icon={History} />}>
                    History
                  </LinkItem>,
                  <LinkItem key="trash" to={`/trash?workspace=${encodeURIComponent(current.id)}`} icon={<Icon icon={Trash2} />}>
                    Trash
                  </LinkItem>,
                ],
                [
                  isOwner && (
                    <DropdownMenuItem key="delete" danger onSelect={() => openDialog({ kind: "workspace", ws: current, dialog: "delete" })}>
                      <Icon icon={Trash2} /> Delete
                    </DropdownMenuItem>
                  ),
                ],
              ]}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceOption({ ws }: { ws: WorkspaceSummary }) {
  const move = useRowMove();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!move || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    // Not the menu's own arrow-key walk: this moves the row.
    e.preventDefault();
    const item = e.currentTarget;
    move.move(e.key === "ArrowUp" ? -1 : 1);
    // The row is re-placed in the list; give it its focus back once it has been.
    requestAnimationFrame(() => item.isConnected && item.focus());
  };
  return (
    <DropdownMenuRadioItem value={ws.id} onKeyDown={onKeyDown} aria-keyshortcuts={move ? "Alt+ArrowUp Alt+ArrowDown" : undefined} className="min-w-0 flex-1">
      <ColorMark hue={ws.color} name={ws.name} size={14} />
      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
    </DropdownMenuRadioItem>
  );
}
