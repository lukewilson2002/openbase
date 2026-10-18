/**
 * The menu of every signed-in page, below the Inbox: Workspaces, each opening into its projects
 * (what the code calls bases), each project into its tables, each table into its views. The same tree
 * shows on the home pages and inside a project, so getting anywhere is one tap on a row. A tap on a
 * name goes there (a table opens the view last used in it, a project its last table, a workspace its
 * last project); the chevron only folds the row and never navigates, which matters on a phone, where
 * the drawer closes on every navigation. Rows the page is inside start open, the rest closed, and
 * hand-made choices are remembered per device. A project's tables are loaded when it is opened,
 * from the same query the project's page uses. The "…" menus hold the workspace's and the project's
 * actions: new project, import, members, trash, settings, rename, icon, share, automations, delete.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Ellipsis, FileDown, Pencil, Plus, Settings, Shapes, Share2, Trash2, UserPlus, Users, Zap } from "lucide-react";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { BaseSummary, WorkspaceSummary } from "@/api/types";
import { useBaseDialog } from "@/base/BaseDialogs";
import { basePermissions } from "@/base/permissions";
import { EntityTile, WorkspaceTile } from "@/components/icons/EntityIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { lastBaseOf, projectPath } from "@/lib/lastPlace";
import { atLeast } from "@/lib/roles";
import { useCloseMenu } from "./AppShell";
import { useNavDialog } from "./NavDialogs";
import { NavTables } from "./NavTables";
import { RowChevron, SidebarHeading, SidebarLink, rowActionClass } from "./Sidebar";
import { useOpenState } from "./useOpenState";

export interface NavTreeProps {
  /** The workspace the page belongs to: open by default. */
  workspaceId?: string;
  /** The open project and what is open in it. */
  baseId?: string;
  tableId?: string;
  viewId?: string;
  /** The project's automations page is open. */
  automations?: boolean;
}

export function NavTree(props: NavTreeProps) {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  const openDialog = useNavDialog();
  const [toggled, toggle] = useOpenState("ob-workspaces-open");

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
      <ul className="flex flex-col gap-0.5">
        {(workspaces.data ?? []).map((ws) => (
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

/** A row's name: a tile and the text, filling the row up to the "…" button. */
const rowNameClass =
  "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-1.5 pr-8 text-left text-[0.875rem] text-fg no-underline transition-colors hover:bg-hover pointer-coarse:h-11 pointer-coarse:pr-10";

function WorkspaceItem({ ws, tree, expanded, onToggle }: { ws: WorkspaceSummary; tree: NavTreeProps; expanded: boolean; onToggle: (open: boolean) => void }) {
  const closeMenu = useCloseMenu();
  const groupId = `ws-${ws.id}-projects`;
  const current = ws.id === tree.workspaceId;
  // The workspace opens the project last opened in it, if that still exists; else its name just folds it.
  const last = ws.bases.find((b) => b.id === lastBaseOf(ws.id));
  const name = (
    <>
      <WorkspaceTile ws={ws} size="sm" className="size-[22px] text-xs" />
      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
    </>
  );
  return (
    <li className="flex flex-col gap-0.5">
      <div className="group/item relative flex items-center">
        <RowChevron expanded={expanded} label={`${expanded ? "Collapse" : "Expand"} ${ws.name}`} controls={groupId} onClick={() => onToggle(!expanded)} />
        {last ? (
          <Link to={projectPath(last.id)} onClick={closeMenu} className={cn(rowNameClass, current && "font-semibold")}>
            {name}
          </Link>
        ) : (
          <button type="button" onClick={() => onToggle(!expanded)} className={cn(rowNameClass, current && "font-semibold")}>
            {name}
          </button>
        )}
        <WorkspaceMenu ws={ws} />
      </div>
      {expanded && (
        <ul id={groupId} aria-label={`Projects in ${ws.name}`} className="flex flex-col gap-0.5 pb-1 pl-3.5">
          {ws.bases.map((b) => (
            <ProjectItem key={b.id} base={b} workspaceName={ws.name} tree={tree} />
          ))}
          {ws.bases.length === 0 && <li className="py-1 pl-[42px] text-xs text-muted">No projects yet.</li>}
        </ul>
      )}
    </li>
  );
}

/** A "…" button with its menu, in the place every tree row keeps it. */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} size="sm" noTooltip className={rowActionClass}>
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

function WorkspaceMenu({ ws }: { ws: WorkspaceSummary }) {
  const openDialog = useNavDialog();
  const isOwner = atLeast(ws.role, "owner");
  const canCreate = atLeast(ws.role, "creator");
  return (
    <RowMenu label={`Workspace options for ${ws.name}`}>
      {canCreate && (
        <>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "create-project", workspaceId: ws.id })}>
            <Plus aria-hidden className="size-4" /> New project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "import-project", workspaceId: ws.id })}>
            <FileDown aria-hidden className="size-4" /> Import a spreadsheet…
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
  const closeMenu = useCloseMenu();
  const [toggled, toggle] = useOpenState("ob-projects-open");
  const active = base.id === tree.baseId;
  const expanded = toggled[base.id] ?? active;
  const groupId = `project-${base.id}-tables`;
  // The open project keeps the table and view on screen; any other opens where it was left.
  const to = active && tree.tableId && tree.viewId ? `/base/${base.id}/${tree.tableId}/${tree.viewId}` : projectPath(base.id);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="group/item relative flex items-center">
        <RowChevron expanded={expanded} label={`${expanded ? "Collapse" : "Expand"} ${base.name}`} controls={groupId} onClick={() => toggle(base.id, !expanded)} />
        <Link to={to} onClick={closeMenu} className={cn(rowNameClass, active && "font-semibold")}>
          <EntityTile name={base.name} icon={base.icon} color={base.color} size="xs" />
          <span className="min-w-0 flex-1 truncate">{base.name}</span>
        </Link>
        <ProjectMenu base={base} workspaceName={workspaceName} />
      </div>
      {expanded && <ProjectBody id={groupId} base={base} tree={tree} />}
    </li>
  );
}

function ProjectMenu({ base, workspaceName }: { base: BaseSummary; workspaceName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const openDialog = useNavDialog();
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
    <RowMenu label={`Project options for ${base.name}`}>
      {canEdit && (
        <>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "rename-project", base })}>
            <Pencil aria-hidden className="size-4" /> Rename project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog({ kind: "project-icon", base })}>
            <Shapes aria-hidden className="size-4" /> Change icon…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => duplicate.mutate()}>
            <Copy aria-hidden className="size-4" /> Duplicate project
          </DropdownMenuItem>
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

/** What an open project holds: its tables (from its schema, the query the project's page shares) and Automations. */
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
      <p className="py-1 pl-[42px] text-xs text-muted">
        Could not load the tables.{" "}
        <button type="button" onClick={() => void schema.refetch()} className="underline hover:text-fg">
          Try again
        </button>
      </p>
    );
  } else {
    tables = <p className="py-1 pl-[42px] text-xs text-muted">Loading tables…</p>;
  }
  return (
    <div id={id} className="flex flex-col gap-0.5 pb-1 pl-3.5">
      {tables}
      {basePermissions.manageAutomations(base.role) && (
        <SidebarLink
          to={`/base/${base.id}/automations`}
          end={false}
          muted
          active={active && !!tree.automations}
          icon={<Zap />}
          className="h-[34px] pl-[34px] pointer-coarse:h-11"
          iconClassName="[&>svg]:size-4"
        >
          Automations
        </SidebarLink>
      )}
    </div>
  );
}
