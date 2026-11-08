/**
 * The workspace switcher at the top of the sidebar (NAV-1, NAV-3, NAV-4, NAV-6): the open workspace's
 * color mark, its name and "Switch workspace". Its menu starts with the OpenBase mark (the app's brand is
 * not in the switcher itself), lists every workspace by mark and name with a check on the open one, then
 * New workspace, and ends with the actions on the open workspace.
 *
 * Everyone puts their own workspaces in their own order: drag a row (hold it, on a touch screen), or
 * Alt+Up and Alt+Down on the focused one (it has no "…" menu to hold Move up and Move down).
 *
 * On a phone it opens as a bottom sheet instead of a menu (PH-3) with the same rows, and the header of
 * Home carries a compact form of it (PH-2).
 */
import { useState, type ComponentProps, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronsUpDown, History, Palette, Pencil, Plus, Settings, Trash2, UserPlus, Users, type LucideIcon } from "lucide-react";
import type { WorkspaceSummary } from "@/api/types";
import { Logo } from "@/components/Logo";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { SheetMenu, SheetMenuGroup, SheetMenuRow } from "@/components/ui/sheet-menu";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { rememberWorkspace } from "@/pages/workspace/lastWorkspace";
import { useNavDialog } from "./NavDialogs";
import { LinkItem } from "./menuItems";
import { MenuGroups } from "./NavRowMenu";
import { ReorderRoot, SortableGroup, SortableRow, useRowMove } from "./sortable";
import { useReorder } from "./useReorder";

interface WorkspaceAction {
  key: string;
  label: string;
  icon: LucideIcon;
  /** A page to go to; else `onSelect` acts. */
  to?: string;
  onSelect?: () => void;
  danger?: boolean;
}

/** What the open workspace's menu offers, in groups, for the people who may: one list for the menu and the sheet. */
function useWorkspaceActions(current: WorkspaceSummary | undefined): WorkspaceAction[][] {
  const openDialog = useNavDialog();
  if (!current) return [];
  const isOwner = atLeast(current.role, "owner");
  const id = encodeURIComponent(current.id);
  const groups: (WorkspaceAction | false)[][] = [
    [
      isOwner && { key: "rename", label: "Rename", icon: Pencil, onSelect: () => openDialog({ kind: "workspace", ws: current, dialog: "rename" }) },
      isOwner && { key: "color", label: "Color", icon: Palette, onSelect: () => openDialog({ kind: "workspace", ws: current, dialog: "color" }) },
      { key: "members", label: "Members", icon: Users, to: `/workspace/${current.id}/members` },
      isOwner && { key: "invite", label: "Invite people", icon: UserPlus, onSelect: () => openDialog({ kind: "invite", ws: current }) },
      isOwner && { key: "settings", label: "Settings", icon: Settings, to: `/workspace/${current.id}/settings` },
      { key: "history", label: "History", icon: History, to: `/history?workspace=${id}` },
      { key: "trash", label: "Trash", icon: Trash2, to: `/trash?workspace=${id}` },
    ],
    [isOwner && { key: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: () => openDialog({ kind: "workspace", ws: current, dialog: "delete" }) }],
  ];
  return groups.map((g) => g.filter((a): a is WorkspaceAction => !!a)).filter((g) => g.length > 0);
}

export interface WorkspaceSwitcherProps {
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  /** The short form for a phone's header: the mark, the name and a chevron. */
  compact?: boolean;
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return desktop ? <MenuSwitcher {...props} /> : <SheetSwitcher {...props} />;
}

/** Remembers the workspace as the one to open next time, then opens its Home. */
function useGoToWorkspace(): (id: string) => void {
  const navigate = useNavigate();
  return (id) => {
    rememberWorkspace(id);
    void navigate(`/workspace/${id}`);
  };
}

function SwitcherButton({ current, compact, className, ...props }: { current: WorkspaceSummary | undefined; compact?: boolean } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-11 min-w-0 items-center rounded-md text-left transition-colors hover:bg-hover data-[state=open]:bg-hover",
        compact ? "gap-2 px-1.5" : "w-full gap-2.5 p-1.5",
        className,
      )}
      {...props}
    >
      {current ? <ColorMark hue={current.color} name={current.name} size={compact ? 24 : 26} /> : <span aria-hidden className="size-6.5 shrink-0 rounded-md border border-line-strong" />}
      {compact ? (
        <>
          <span className="min-w-0 truncate text-sheet">{current?.name ?? "No workspace"}</span>
          <Icon icon={ChevronDown} className="text-muted" />
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-semibold">{current?.name ?? "No workspace"}</span>
            <span className="block text-meta text-muted">Switch workspace</span>
          </span>
          <Icon icon={ChevronsUpDown} className="text-muted" />
        </>
      )}
    </button>
  );
}

function MenuSwitcher({ workspaces, current, compact }: WorkspaceSwitcherProps) {
  const openDialog = useNavDialog();
  const reorder = useReorder();
  const go = useGoToWorkspace();
  const actions = useWorkspaceActions(current);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SwitcherButton current={current} compact={compact} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[max(var(--radix-dropdown-menu-trigger-width),17rem)]">
        {/* The brand (NAV-6) is decoration here, not a menu item: hidden from assistive technology, which hears the menu's own rows. */}
        <div aria-hidden data-testid="brand" className="px-2.5 pb-1 pt-0.5">
          <Logo className="h-8" />
        </div>
        <DropdownMenuSeparator />
        <ReorderRoot inMenu>
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
              groups={actions.map((group) =>
                group.map((a) =>
                  a.to ? (
                    <LinkItem key={a.key} to={a.to} icon={a.icon}>
                      {a.label}
                    </LinkItem>
                  ) : (
                    <DropdownMenuItem key={a.key} danger={a.danger} onSelect={a.onSelect}>
                      <Icon icon={a.icon} /> {a.label}
                    </DropdownMenuItem>
                  ),
                ),
              )}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Alt+Up and Alt+Down on a focused workspace move it in this person's order. */
function useAltMove() {
  const move = useRowMove();
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!move || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    // Not the menu's own arrow-key walk: this moves the row.
    e.preventDefault();
    const item = e.currentTarget;
    move.move(e.key === "ArrowUp" ? -1 : 1);
    // The row is re-placed in the list; give it its focus back once it has been.
    requestAnimationFrame(() => item.isConnected && item.focus());
  };
  return { onKeyDown, shortcuts: move ? "Alt+ArrowUp Alt+ArrowDown" : undefined };
}

function WorkspaceOption({ ws }: { ws: WorkspaceSummary }) {
  const { onKeyDown, shortcuts } = useAltMove();
  return (
    <DropdownMenuRadioItem value={ws.id} onKeyDown={onKeyDown} aria-keyshortcuts={shortcuts} className="min-w-0 flex-1">
      <ColorMark hue={ws.color} name={ws.name} size={14} />
      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
    </DropdownMenuRadioItem>
  );
}

function SheetSwitcher({ workspaces, current, compact }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const openDialog = useNavDialog();
  const reorder = useReorder();
  const go = useGoToWorkspace();
  const actions = useWorkspaceActions(current);

  return (
    <>
      <SwitcherButton current={current} compact={compact} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      <SheetMenu open={open} onOpenChange={setOpen} title="Switch workspace">
        <div aria-hidden data-testid="brand" className="px-2.5 pb-2 pt-1">
          <Logo className="h-8" />
        </div>
        <ReorderRoot>
          <SheetMenuGroup label="Workspaces">
            <SortableGroup group="workspaces" items={workspaces} idOf={(w) => w.id} enabled onReorder={(ids) => reorder({ kind: "workspaces", ids })}>
              {(list) => list.map((w) => <SortableRow key={w.id} id={w.id} label={w.name} row={<WorkspaceChoice ws={w} selected={w.id === current?.id} onChoose={go} />} />)}
            </SortableGroup>
            <SheetMenuRow icon={Plus} onSelect={() => openDialog({ kind: "create-workspace" })}>
              New workspace
            </SheetMenuRow>
          </SheetMenuGroup>
        </ReorderRoot>
        {current &&
          actions.map((group, i) => (
            <SheetMenuGroup key={i} label={i === 0 ? current.name : undefined}>
              {group.map((a) => (
                <SheetMenuRow key={a.key} icon={a.icon} to={a.to} onSelect={a.onSelect} danger={a.danger}>
                  {a.label}
                </SheetMenuRow>
              ))}
            </SheetMenuGroup>
          ))}
      </SheetMenu>
    </>
  );
}

function WorkspaceChoice({ ws, selected, onChoose }: { ws: WorkspaceSummary; selected: boolean; onChoose: (id: string) => void }) {
  const { onKeyDown, shortcuts } = useAltMove();
  return (
    <SheetMenuRow bare lead={<ColorMark hue={ws.color} name={ws.name} size={14} />} selected={selected} onSelect={() => onChoose(ws.id)} buttonProps={{ onKeyDown, "aria-keyshortcuts": shortcuts }}>
      {ws.name}
    </SheetMenuRow>
  );
}
