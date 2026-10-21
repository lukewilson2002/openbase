/**
 * The menu of every signed-in page, below the Inbox: Workspaces, each opening into its projects
 * (what the code calls bases), each project into its tables, each table into its views. The same tree
 * shows on the home pages and inside a project. A tap on a workspace's or a project's name only folds
 * it, like its chevron; tables and views are what open pages (a table the view last used in it, without
 * unfolding its views). The drawer on a phone closes on every navigation, so folding never closes it.
 * Workspaces and projects the page is inside start open, the rest closed; tables start closed; and
 * hand-made choices are remembered per device. A project's tables are loaded when it is opened,
 * from the same query the project's page uses. The "…" menus hold the workspace's and the project's
 * actions: new project, import, members, history, trash, settings, rename, icon, share, automations, delete.
 * A right-click on any row of the tree opens its "…" menu too.
 *
 * Workspaces and, inside a workspace, projects can be put in another order: drag a row, or "Move up"
 * and "Move down" in its "…" menu (see `sortable.tsx`). A person's workspace order is their own; the
 * projects' is the workspace's, so only those who may edit projects can change it. The tables and views
 * below are ordered in `NavTables`.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, FileUp, History, Palette, Pencil, Plus, Settings, Shapes, Share2, Table2, Trash2, UserPlus, Users, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { atLeast } from "@/lib/roles";
import { useNavDialog } from "./NavDialogs";
import { NavTables } from "./NavTables";
import { RowChevron, SidebarHeading, SidebarLink, rowActionClass, rowNamePadClass } from "./Sidebar";
import { MoveItems, NO_DRAG, ReorderRoot, SortableGroup, SortableRow, useRowMenu } from "./sortable";
import { useOpenState } from "./useOpenState";
import { useReorder } from "./useReorder";

export interface NavTreeProps {
  /** The workspace the page belongs to: open by default. */
  workspaceId?: string;
  /** The open project and what is open in it. */
  baseId?: string;
  tableId?: string;
  viewId?: string;
}

export function NavTree(props: NavTreeProps) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const openDialog = useNavDialog();
  const [toggled, toggle] = useOpenState("ob-workspaces-open");
  const reorder = useReorder();

  return (
    <section aria-label="Workspaces" className="flex flex-col gap-0.5">
      <SidebarHeading
        action={
          <IconButton label="New workspace" size="sm" onClick={() => openDialog({ kind: "create-workspace" })} className="size-8 rounded-lg">
            <Plus aria-hidden className="size-4" />
          </IconButton>
        }
      >
        Workspaces
      </SidebarHeading>
      <ReorderRoot>
        <SortableGroup group="workspaces" items={workspaces.data ?? []} idOf={(ws) => ws.id} enabled onReorder={(ids) => reorder({ kind: "workspaces", ids })}>
          {(list) => (
            <ul className="flex flex-col gap-0.5">
              {list.map((ws) => (
                <WorkspaceItem
                  key={ws.id}
                  ws={ws}
                  tree={props}
                  // The open workspace is expanded unless it was closed by hand.
                  expanded={toggled[ws.id] ?? ws.id === props.workspaceId}
                  onToggle={(open) => toggle(ws.id, open)}
                />
              ))}
            </ul>
          )}
        </SortableGroup>
      </ReorderRoot>
      {workspaces.isSuccess && workspaces.data.length === 0 && <p className="px-3 py-1 text-xs text-muted">No workspaces yet.</p>}
    </section>
  );
}

/** The global Trash, pinned above the profile. */
export function NavTrashLink({ active }: { active: boolean }) {
  return (
    <SidebarLink to="/trash" muted active={active} icon={<Trash2 />}>
      Trash
    </SidebarLink>
  );
}

/** The global History (recent changes everywhere), above the Trash. */
export function NavHistoryLink({ active }: { active: boolean }) {
  return (
    <SidebarLink to="/history" muted active={active} icon={<History />}>
      History
    </SidebarLink>
  );
}

/** The pages of everything, pinned above the profile; `page` is the one showing, when it is unfiltered. */
export function NavGlobalLinks({ page }: { page: "history" | "trash" | null }) {
  return (
    <>
      <NavHistoryLink active={page === "history"} />
      <NavTrashLink active={page === "trash"} />
    </>
  );
}

/** A row's name: a tile and the text, filling the row up to the "…" button. */
const rowNameClass = cn(
  "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-1.5 text-left text-[0.875rem] text-fg no-underline transition-colors hover:bg-hover pointer-coarse:h-11",
  rowNamePadClass,
);

function WorkspaceItem({ ws, tree, expanded, onToggle }: { ws: WorkspaceSummary; tree: NavTreeProps; expanded: boolean; onToggle: (open: boolean) => void }) {
  const groupId = `ws-${ws.id}-projects`;
  const reorder = useReorder();
  const { menu, onContextMenu } = useRowMenu();
  const name = (
    <>
      <WorkspaceTile ws={ws} size="sm" className="size-[22px] text-xs" />
      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
    </>
  );
  return (
    <SortableRow
      id={ws.id}
      label={ws.name}
      className="flex flex-col gap-0.5"
      rowClassName="group/item relative flex items-center"
      onContextMenu={onContextMenu}
      row={
        <>
          <RowChevron expanded={expanded} label={`${expanded ? "Collapse" : "Expand"} ${ws.name}`} controls={groupId} onClick={() => onToggle(!expanded)} />
          {/* The name folds the workspace like its chevron: it goes nowhere. */}
          <button type="button" onClick={() => onToggle(!expanded)} className={rowNameClass}>
            {name}
          </button>
          <WorkspaceMenu ws={ws} menu={menu} />
        </>
      }
    >
      {expanded && (
        <SortableGroup group={`projects-${ws.id}`} items={ws.bases} idOf={(b) => b.id} enabled={ws.bases.every((b) => basePermissions.editBase(b.role))} onReorder={(ids) => reorder({ kind: "projects", workspaceId: ws.id, ids })}>
          {(bases) => (
            <ul id={groupId} aria-label={`Projects in ${ws.name}`} className="flex flex-col gap-0.5 pb-1 pl-[7px]">
              {bases.map((b) => (
                <ProjectItem key={b.id} base={b} workspaceName={ws.name} tree={tree} />
              ))}
              {bases.length === 0 && <li className="py-1 pl-[42px] text-xs text-muted">No projects yet.</li>}
            </ul>
          )}
        </SortableGroup>
      )}
    </SortableRow>
  );
}

type RowMenuState = ReturnType<typeof useRowMenu>["menu"];

/** A "…" button with its menu, in the place every tree row keeps it; `menu` also opens it on a right-click. */
function RowMenu({ label, menu, children }: { label: string; menu: RowMenuState; children: ReactNode }) {
  return (
    <DropdownMenu {...menu}>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" noTooltip className={rowActionClass} {...NO_DRAG}>
          <Ellipsis aria-hidden className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function LinkItem({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenuItem asChild>
      <Link to={to}>
        {icon} {children}
      </Link>
    </DropdownMenuItem>
  );
}

function WorkspaceMenu({ ws, menu }: { ws: WorkspaceSummary; menu: RowMenuState }) {
  const openDialog = useNavDialog();
  const isOwner = atLeast(ws.role, "owner");
  const canCreate = atLeast(ws.role, "creator");
  return (
    <RowMenu label={`Workspace options for ${ws.name}`} menu={menu}>
      {canCreate && (
        <>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "create-project", workspaceId: ws.id })}>
            <Plus aria-hidden className="size-4" /> New project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <LinkItem to={`/workspace/${ws.id}/members`} icon={<Users aria-hidden className="size-4" />}>
        Members
      </LinkItem>
      {isOwner && (
        <DropdownMenuItem onSelect={() => openDialog({ kind: "invite", ws })}>
          <UserPlus aria-hidden className="size-4" /> Invite people…
        </DropdownMenuItem>
      )}
      <LinkItem to={`/history?workspace=${encodeURIComponent(ws.id)}`} icon={<History aria-hidden className="size-4" />}>
        History
      </LinkItem>
      <LinkItem to={`/trash?workspace=${encodeURIComponent(ws.id)}`} icon={<Trash2 aria-hidden className="size-4" />}>
        Trash
      </LinkItem>
      {isOwner && (
        <>
          <LinkItem to={`/workspace/${ws.id}/settings`} icon={<Settings aria-hidden className="size-4" />}>
            Settings
          </LinkItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openDialog({ kind: "workspace", ws, dialog: "rename" })}>
            <Pencil aria-hidden className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "workspace", ws, dialog: "icon" })}>
            <Shapes aria-hidden className="size-4" /> Change icon…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "workspace", ws, dialog: "color" })}>
            <Palette aria-hidden className="size-4" /> Change color…
          </DropdownMenuItem>
        </>
      )}
      {/* Everyone orders their own workspaces. */}
      <MoveItems separator="before" />
      {isOwner && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => openDialog({ kind: "workspace", ws, dialog: "delete" })}>
            <Trash2 aria-hidden className="size-4" /> Delete workspace
          </DropdownMenuItem>
        </>
      )}
    </RowMenu>
  );
}

function ProjectItem({ base, workspaceName, tree }: { base: BaseSummary; workspaceName: string; tree: NavTreeProps }) {
  const [toggled, toggle] = useOpenState("ob-projects-open");
  const active = base.id === tree.baseId;
  const expanded = toggled[base.id] ?? active;
  const groupId = `project-${base.id}-tables`;
  const { menu, onContextMenu } = useRowMenu();
  return (
    <SortableRow
      id={base.id}
      label={base.name}
      className="flex flex-col gap-0.5"
      rowClassName="group/item relative flex items-center"
      onContextMenu={onContextMenu}
      row={
        <>
          <RowChevron expanded={expanded} label={`${expanded ? "Collapse" : "Expand"} ${base.name}`} controls={groupId} onClick={() => toggle(base.id, !expanded)} />
          {/* The name folds the project like its chevron; its tables are what open pages. */}
          <button type="button" onClick={() => toggle(base.id, !expanded)} className={rowNameClass}>
            <EntityTile name={base.name} icon={base.icon} color={base.color} size="xs" />
            <span className="min-w-0 flex-1 truncate">{base.name}</span>
          </button>
          <ProjectMenu base={base} workspaceName={workspaceName} open={active} menu={menu} />
        </>
      }
    >
      {expanded && <ProjectBody id={groupId} base={base} tree={tree} />}
    </SortableRow>
  );
}

function ProjectMenu({ base, workspaceName, open, menu }: { base: BaseSummary; workspaceName: string; open: boolean; menu: RowMenuState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const openDialog = useNavDialog();
  // Adding a table uses the project page's dialogs, so it is offered for the open project.
  const openBaseDialog = useBaseDialog();
  const addTable = open && openBaseDialog && basePermissions.manageTables(base.role) ? openBaseDialog : null;
  const duplicate = useMutation({
    mutationFn: () => api.bases.duplicate(base.id, { name: `${base.name} copy`, include_records: true }),
    onSuccess: () => {
      toast.toast({ title: "Project duplicated", variant: "success" });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
    onError: (e) => toast.error(e, "Could not duplicate project"),
  });
  const canEdit = basePermissions.editBase(base.role);
  return (
    <RowMenu label={`Project options for ${base.name}`} menu={menu}>
      {addTable && (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Plus aria-hidden className="size-4" /> Add table
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => addTable({ kind: "create-table" })}>
                <Table2 aria-hidden className="size-4" /> New empty table
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => addTable({ kind: "create-table-csv" })}>
                <FileUp aria-hidden className="size-4" /> New table from CSV…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </>
      )}
      {canEdit && (
        <>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "rename-project", base })}>
            <Pencil aria-hidden className="size-4" /> Rename project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "project-icon", base })}>
            <Shapes aria-hidden className="size-4" /> Change icon…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "project-color", base })}>
            <Palette aria-hidden className="size-4" /> Change color…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => duplicate.mutate()}>
            <Copy aria-hidden className="size-4" /> Duplicate project
          </DropdownMenuItem>
          <MoveItems separator="before" />
          <DropdownMenuSeparator />
        </>
      )}
      {basePermissions.manageSharing(base.role) && (
        <DropdownMenuItem onSelect={() => openDialog({ kind: "share-project", base, workspaceName })}>
          <Share2 aria-hidden className="size-4" /> Share…
        </DropdownMenuItem>
      )}
      <LinkItem to={`/workspace/${base.workspace_id}/members`} icon={<Users aria-hidden className="size-4" />}>
        Members
      </LinkItem>
      <LinkItem to={`/history?base=${encodeURIComponent(base.id)}`} icon={<History aria-hidden className="size-4" />}>
        History
      </LinkItem>
      {basePermissions.manageTables(base.role) && (
        <LinkItem to={`/trash?base=${encodeURIComponent(base.id)}`} icon={<Trash2 aria-hidden className="size-4" />}>
          Trash
        </LinkItem>
      )}
      {basePermissions.manageAutomations(base.role) && (
        <LinkItem to={`/base/${base.id}/automations`} icon={<Zap aria-hidden className="size-4" />}>
          Automations
        </LinkItem>
      )}
      {atLeast(base.role, "owner") && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => openDialog({ kind: "delete-project", base })}>
            <Trash2 aria-hidden className="size-4" /> Delete project
          </DropdownMenuItem>
        </>
      )}
    </RowMenu>
  );
}

/** What an open project holds: its tables (from its schema, the query the project's page shares). Its automations are in its menu. */
function ProjectBody({ id, base, tree }: { id: string; base: BaseSummary; tree: NavTreeProps }) {
  const openBaseDialog = useBaseDialog();
  // Fresh enough as it is: the open project's page loaded this a moment ago and keeps it current.
  const schema = useQuery({ queryKey: keys.base(base.id), queryFn: () => api.bases.get(base.id), staleTime: 30_000 });
  const active = base.id === tree.baseId;
  let tables: ReactNode;
  if (schema.data) {
    tables = (
      <NavTables
        schema={schema.data}
        activeTableId={active ? tree.tableId : undefined}
        activeViewId={active ? tree.viewId : undefined}
        // The dialogs exist only in the open project's page.
        onDialog={active ? openBaseDialog : null}
      />
    );
  } else if (schema.isError) {
    tables = (
      <p className="py-1 pl-1.5 text-xs text-muted">
        Could not load the tables.{" "}
        <button type="button" onClick={() => void schema.refetch()} className="underline hover:text-fg">
          Try again
        </button>
      </p>
    );
  } else {
    tables = <p className="py-1 pl-1.5 text-xs text-muted">Loading tables…</p>;
  }
  return (
    // One indent (7 px) in, plus the chevron's column (28 px) that tables do not have: a table's icon
    // sits just inside its project's tile, as each level of the tree sits inside the one above.
    <div id={id} className="flex flex-col gap-0.5 pb-1 pl-[35px]">
      {tables}
    </div>
  );
}
